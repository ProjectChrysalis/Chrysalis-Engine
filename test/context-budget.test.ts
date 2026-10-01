/**
 * Context budget: the agent never asks for more than the window holds,
 * trims old bulk instead of overflowing, retries once after a provider
 * overflow, and compaction fits the model it runs on.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  TRIM_NOTICE,
  clampMaxTokens,
  estimateContextTokens,
  estimateTextTokens,
  fitContext,
  inputBudget,
  newTrimState,
  outputCap,
} from "../src/agent/context-budget.js";
import { compactionInput, lastSessionModel, summarizeSession } from "../src/agent/compact.js";
import { UserAgent, windowFromError } from "../src/agent/agent.js";
import { UserModelService } from "../src/models.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";
import { UserService } from "../src/users.js";
import { invalidatePluginCache } from "../src/plugins/runtime.js";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;
const assistant = (content: unknown[], extra: Record<string, unknown> = {}): AgentMessage =>
  ({ role: "assistant", content, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, timestamp: 1, ...extra }) as unknown as AgentMessage;
const call = (id: string, args: Record<string, unknown>): AgentMessage => assistant([{ type: "toolCall", id, name: "read_file", arguments: args }], { stopReason: "toolUse" });
const result = (id: string, text: string): AgentMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "read_file", content: [{ type: "text", text }], isError: false, timestamp: 1 }) as unknown as AgentMessage;

describe("token estimate", () => {
  it("counts Cyrillic at about two chars a token, well above chars/4", () => {
    const uk = "Крісаліс".repeat(100);
    expect(estimateTextTokens(uk)).toBe(uk.length / 2);
    expect(estimateTextTokens("hello world")).toBe(Math.ceil(11 / 3.5));
  });

  it("never reports less than the provider's last reading plus what came after", () => {
    const messages = [user("hi"), assistant([{ type: "text", text: "ok" }], { usage: { input: 50_000, output: 10, cacheRead: 0, cacheWrite: 0 } }), user("more")];
    expect(estimateContextTokens({ messages })).toBeGreaterThanOrEqual(50_010);
  });
});

describe("max_tokens clamp", () => {
  it("screenshot 1: a 1M window with max output = window no longer asks for the whole remainder", () => {
    const model = { contextWindow: 1_048_576, maxTokens: 1_048_576 };
    const ctx = { systemPrompt: "x".repeat(20_000), messages: [user("a".repeat(350_000))] };
    const max = clampMaxTokens(model, ctx)!;
    expect(max).toBeLessThanOrEqual(outputCap(model));
    expect(outputCap(model)).toBe(262_144);
    expect(estimateContextTokens(ctx) + max).toBeLessThan(1_048_576);
  });

  it("screenshot 2: 32k window, Cyrillic history — input + output stays inside the window", () => {
    const model = { contextWindow: 32_768, maxTokens: 8192 };
    const ctx = { messages: [user("Опиши персонажа детально. ".repeat(1500))] };
    const est = estimateContextTokens(ctx);
    const max = clampMaxTokens(model, ctx)!;
    expect(est + max).toBeLessThanOrEqual(32_768);
  });

  it("an unknown window leaves the request alone", () => {
    expect(clampMaxTokens({ contextWindow: 0, maxTokens: 8192 }, { messages: [user("hi")] }, 1000)).toBe(1000);
  });
});

describe("fitContext", () => {
  const model = { contextWindow: 32_768, maxTokens: 8192 };

  it("sends the history untouched while it fits", () => {
    const messages = [user("hi"), assistant([{ type: "text", text: "hello" }])];
    const fit = fitContext(model, { messages });
    expect(fit.trimmed).toBe(false);
    expect(fit.messages).toEqual(messages);
  });

  it("clips old tool output and file bodies first, keeping the recent tail whole", () => {
    const big = "line of file content\n".repeat(3000); // ~18k tokens each
    const messages = [
      user("fix the app"),
      call("a", { path: "a.ts" }),
      result("a", big),
      call("b", { path: "b.ts", content: big }),
      result("b", "written"),
      call("c", { path: "c.ts" }),
      result("c", "short"),
      call("d", { path: "d.ts" }),
      result("d", "short"),
      call("e", { path: "e.ts" }),
      result("e", "short"),
      assistant([{ type: "text", text: "done" }]),
    ];
    const fit = fitContext(model, { messages });
    expect(fit.trimmed).toBe(true);
    expect(fit.after).toBeLessThanOrEqual(inputBudget(model));
    const oldResult = fit.messages[2] as unknown as { content: { text: string }[] };
    expect(oldResult.content[0]!.text).toContain("chars trimmed to save context");
    // the task and the protected tail are unchanged
    expect(fit.messages[0]).toBe(messages[0]);
    expect(fit.messages.at(-1)).toBe(messages.at(-1));
    // nothing was dropped, so every tool result still has its call
    expect(fit.messages.length).toBe(messages.length);
  });

  it("drops the oldest history behind a notice, keeping the task and every result's call", () => {
    const messages: AgentMessage[] = [user("build a visual novel app")];
    for (let i = 0; i < 400; i++) {
      messages.push(call(`t${i}`, { path: `f${i}.ts` }), result(`t${i}`, "x".repeat(900)));
    }
    messages.push(assistant([{ type: "text", text: "halfway" }]));
    const fit = fitContext(model, { messages });
    expect(fit.trimmed).toBe(true);
    const first = fit.messages[0] as unknown as { role: string; content: { text: string }[] };
    expect(first.role).toBe("user");
    expect(first.content[0]!.text).toContain(TRIM_NOTICE);
    expect(first.content.map((b) => b.text).join(" ")).toContain("build a visual novel app");
    expect((fit.messages[1] as { role: string }).role).toBe("assistant");
    const callIds = new Set<string>();
    for (const m of fit.messages) {
      const content = (m as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const b of content as { type?: string; id?: string }[]) if (b.type === "toolCall" && b.id) callIds.add(b.id);
    }
    for (const m of fit.messages) {
      if ((m as { role: string }).role === "toolResult") expect(callIds.has((m as { toolCallId: string }).toolCallId)).toBe(true);
    }
    expect(fit.after).toBeLessThanOrEqual(inputBudget(model));
  });

  it("preserves transcript instruction and tool updates when dropping old history", () => {
    const initial: AgentMessage = {
      role: "system", content: "Keep the agent instructions.", timestamp: 1,
      toolsAdded: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
      sections: { rules: "Keep this section." },
    };
    const update: AgentMessage = { role: "system", content: "Additional instructions.", timestamp: 2, toolsRemoved: [{ name: "read_file" }] };
    const messages: AgentMessage[] = [initial, user("build the app")];
    for (let i = 0; i < 400; i++) {
      if (i === 2) messages.push(update);
      messages.push(call(`t${i}`, {}), result(`t${i}`, "x".repeat(900)));
    }
    const state = newTrimState();
    const fit = fitContext(model, { messages }, { state });
    expect(state.cut).toBeGreaterThan(10);
    expect(fit.messages.slice(0, 2)).toEqual([initial, update]);
    expect(fit.after).toBeLessThanOrEqual(inputBudget(model));
    const heavy: AgentMessage = { ...initial, toolsAdded: [{ name: "large", description: "界".repeat(20_000), parameters: {} }] };
    expect(estimateContextTokens({ messages: [heavy] })).toBeGreaterThan(20_000);
    expect(messages[0]).toBe(initial);
  });

  it("does not clamp a trimmed request against usage from the old oversized prefix", () => {
    const messages: AgentMessage[] = [user("keep working")];
    for (let i = 0; i < 20; i++) messages.push(call(`t${i}`, {}), result(`t${i}`, "x".repeat(8000)));
    messages.push(assistant([{ type: "text", text: "continue" }], { usage: { input: 30_000, output: 500, cacheRead: 0, cacheWrite: 0 } }));
    const state = newTrimState();
    const fit = fitContext(model, { messages }, { state });
    expect(clampMaxTokens(model, { messages: fit.messages })).toBeGreaterThan(4096);
    const stable = fitContext(model, { messages }, { state });
    expect(stable.advanced).toBe(false);
    expect(stable.messages).toEqual(fit.messages);
    expect((messages.at(-1) as { usage: { input: number } }).usage.input).toBe(30_000);
  });

  it("trims oldest first, only as far as needed: recent reads stay whole", () => {
    const messages: AgentMessage[] = [user("map the app")];
    for (let i = 0; i < 12; i++) messages.push(call(`r${i}`, { path: `f${i}.ts` }), result(`r${i}`, `file ${i}\n`.padEnd(8000, "x")));
    messages.push(assistant([{ type: "text", text: "reading" }]));
    const fit = fitContext(model, { messages });
    expect(fit.trimmed).toBe(true);
    const text = (m: AgentMessage) => ((m as unknown as { content: { text?: string }[] }).content[0]!.text ?? "");
    // the oldest read is clipped, a read just before the protected tail is not
    expect(text(fit.messages[2]!)).toContain("chars trimmed to save context");
    expect(text(fit.messages[messages.length - 8]!)).not.toContain("chars trimmed");
    expect(fit.messages.length).toBe(messages.length);
  });

  it("keeps sending the same trimmed prefix until the budget is outgrown again", () => {
    const messages: AgentMessage[] = [user("map the app")];
    for (let i = 0; i < 12; i++) messages.push(call(`r${i}`, { path: `f${i}.ts` }), result(`r${i}`, "x".repeat(8000)));
    messages.push(assistant([{ type: "text", text: "reading" }]));
    const state = newTrimState();
    const first = fitContext(model, { messages }, { state });
    expect(first.advanced).toBe(true);
    const grown = [...messages, user("and one more thing"), assistant([{ type: "text", text: "sure" }])];
    const second = fitContext(model, { messages: grown }, { state });
    expect(second.advanced).toBe(false);
    expect(JSON.stringify(second.messages.slice(0, 10))).toBe(JSON.stringify(first.messages.slice(0, 10)));
  });

  it("a single read bigger than the window is clipped with a hint to read in parts", () => {
    const messages = [user("look at the lore"), call("a", { path: "lore.md" }), result("a", "Лор світу. ".repeat(25_000))];
    const fit = fitContext(model, { messages });
    expect(fit.after).toBeLessThanOrEqual(inputBudget(model));
    const last = fit.messages.at(-1) as unknown as { content: { text: string }[] };
    expect(last.content[0]!.text).toContain("Read it in smaller parts");
  });

  it("force trims deeper even when the estimate says it fits", () => {
    const messages = [user("hi"), call("a", { path: "a" }), result("a", "y".repeat(8000)), user("next"), assistant([{ type: "text", text: "ok" }])];
    expect(fitContext(model, { messages }).trimmed).toBe(false);
    expect(fitContext(model, { messages }, { force: true }).trimmed).toBe(true);
  });
});

describe("overflow message parsing", () => {
  it("reads the window a provider names", () => {
    expect(windowFromError("This endpoint's maximum context length is 1048576 tokens. However, you requested about 1048883 tokens")).toBe(1_048_576);
    expect(windowFromError('{"message":"Your prompt exceeds the model\'s context length. Max context tokens: 32768."}')).toBe(32_768);
    expect(windowFromError("rate limit exceeded")).toBeUndefined();
  });
});

describe("compaction", () => {
  it("restores the latest recorded model while tolerating legacy and invalid metadata", () => {
    expect(lastSessionModel([{ type: "run", model: "local/old" }, { type: "compact", model: "local/new" }, { type: "rename", model: "wrong/metadata" }])).toBe("local/new");
    expect(lastSessionModel([{ type: "run" }, { type: "run", model: {} }, { type: "compact", model: "invalid" }])).toBeUndefined();
  });

  it("folds every run even when the transcript needs more than six chunks", async () => {
    const prompts: string[] = [];
    const records = Array.from({ length: 14 }, (_, i) => ({ type: "run", user: `TASK_${i}: ${"a".repeat(20_000)}`, assistant: `done ${i}` }));
    const out = await summarizeSession({ model: { contextWindow: 8192, maxTokens: 4096 }, records, generate: async (prompt, max) => {
      prompts.push(prompt);
      expect(estimateTextTokens(prompt) + max).toBeLessThanOrEqual(8192);
      return "folded";
    } });
    expect(out.chunks).toBeGreaterThan(6);
    expect(out.droppedRuns).toBe(0);
    const transcript = prompts.map((p) => p.split("<conversation>\n")[1]!.split("\n</conversation>")[0]!).join("");
    expect(transcript).toBe(compactionInput(records).runs.join("\n\n"));
  });

  it("fits a small window with a large previous summary and CJK transcript", async () => {
    const out = await summarizeSession({
      model: { contextWindow: 8192, maxTokens: 4096 },
      records: [{ type: "compact", summary: "界".repeat(4000) }, { type: "run", user: "界".repeat(6000), assistant: "done" }],
      generate: async (prompt, max) => {
        expect(estimateTextTokens(prompt) + max).toBeLessThanOrEqual(8192);
        return "界".repeat(max);
      },
    });
    expect(out.chunks).toBeGreaterThan(1);
    expect(out.droppedRuns).toBe(0);
  });

  it("starts from the last marker and lists the files each run touched", () => {
    const input = compactionInput([
      { type: "run", user: "old", assistant: "old answer", tools: [] },
      { type: "compact", summary: "EARLIER" },
      { type: "run", user: "edit it", assistant: "edited", turns: [{ tools: [{ name: "edit_file", ok: true, args: { path: "apps/rp/src/App.tsx" } }] }] },
    ]);
    expect(input.earlier).toBe("EARLIER");
    expect(input.runs).toHaveLength(1);
    expect(input.runs[0]).toContain("edit_file apps/rp/src/App.tsx");
    expect(input.runs[0]).not.toContain("old answer");
  });

  it("folds a transcript bigger than the window in chunks, each carrying the summary so far", async () => {
    const records = Array.from({ length: 30 }, (_, i) => ({ type: "run", user: `task ${i} ${"слово ".repeat(800)}`, assistant: `done ${i}` }));
    const prompts: string[] = [];
    const model = { contextWindow: 16_384, maxTokens: 4096 };
    const out = await summarizeSession({
      model,
      records,
      generate: async (prompt, max) => {
        prompts.push(prompt);
        expect(estimateTextTokens(prompt) + max).toBeLessThanOrEqual(16_384);
        return `summary ${prompts.length}`;
      },
    });
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[1]).toContain("<earlier_summary>\nsummary 1");
    expect(out.summary).toBe(`summary ${prompts.length}`);
  });

  it("refuses when nothing happened since the last marker", async () => {
    await expect(
      summarizeSession({ model: { contextWindow: 0 }, records: [{ type: "compact", summary: "s" }], generate: async () => "x" }),
    ).rejects.toThrow("nothing to compact");
  });
});

describe("agent loop under a tight window (faux provider)", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-"));
  });
  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
    invalidatePluginCache();
  });

  function setup(window: number) {
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    users.create("dana", "user", { password: "test-pass-1" });
    const p = bootstrapUserDir(dataDir, "dana");
    const svc = new UserModelService("dana", p, defaultInstanceConfig());
    const handle = fauxProvider({ models: [{ id: "faux-agent", contextWindow: window, maxTokens: window }] });
    svc.models.setProvider(handle.provider);
    return { users, svc, handle, p: userPaths(dataDir, "dana") };
  }

  it("asks for no more output than the window has left", async () => {
    const { users, svc, handle, p } = setup(32_768);
    const seen: number[] = [];
    handle.setResponses([
      (ctx, opts) => {
        seen.push(estimateContextTokens({ messages: ctx.messages as AgentMessage[] }) + (opts?.maxTokens ?? 0));
        return fauxAssistantMessage("ok");
      },
    ]);
    const agent = await UserAgent.create("dana", svc, p, users, defaultInstanceConfig());
    const r = await agent.run("Розкажи про застосунки. ".repeat(300));
    expect(r.error).toBeUndefined();
    expect(seen[0]).toBeLessThanOrEqual(32_768);
  }, 30_000);

  it("a provider overflow is retried once with a deep trim and the named window", async () => {
    const { users, svc, handle, p } = setup(0);
    const maxSeen: (number | undefined)[] = [];
    handle.setResponses([
      (_ctx, opts) => {
        maxSeen.push(opts?.maxTokens);
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "This endpoint's maximum context length is 20000 tokens. However, you requested about 25000 tokens" });
      },
      (_ctx, opts) => {
        maxSeen.push(opts?.maxTokens);
        return fauxAssistantMessage("recovered");
      },
    ]);
    const agent = await UserAgent.create("dana", svc, p, users, defaultInstanceConfig());
    const r = await agent.run("hello");
    expect(r.finalText).toBe("recovered");
    expect(r.error).toBeUndefined();
    expect(r.contextOverflow).toBeUndefined();
    // the retry learned the 20k window from the refusal and budgeted for it
    expect(r.contextWindow).toBe(20_000);
    expect(maxSeen[1]!).toBeLessThanOrEqual(20_000);
  }, 30_000);

  it("a bodiless 400 is not taken for an overflow", async () => {
    const { users, svc, handle, p } = setup(524_288);
    let calls = 0;
    handle.setResponses([
      () => {
        calls++;
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 status code (no body)" });
      },
      () => {
        calls++;
        return fauxAssistantMessage("should not be reached");
      },
    ]);
    const agent = await UserAgent.create("dana", svc, p, users, defaultInstanceConfig());
    const r = await agent.run("hello");
    expect(calls).toBe(1);
    expect(r.error).toBeDefined();
    expect(r.contextOverflow).toBeUndefined();
  }, 30_000);

  it("an overflow the retry cannot absorb is reported for compaction", async () => {
    const { users, svc, handle, p } = setup(20_000);
    const refuse = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "context_length_exceeded" });
    handle.setResponses([refuse, refuse]);
    const agent = await UserAgent.create("dana", svc, p, users, defaultInstanceConfig());
    const r = await agent.run("hello");
    expect(r.error).toBeDefined();
    expect(r.contextOverflow).toBe(true);
  }, 30_000);
});
