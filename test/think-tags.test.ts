// Inline thinking tags: split live on every transport, and when the block was
// opened before the reply began (by the prefill or the chat template).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { ThinkTagStream, UserModelService, opensThinking, splitThinkingTags, type GenerateRequest } from "../src/models.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir } from "../src/paths.js";

const OPEN = "<think>";
const CLOSE = "</think>";
const tags = { open: OPEN, close: CLOSE };

describe("splitThinkingTags", () => {
  it("splits a closed block anywhere in the reply", () => {
    expect(splitThinkingTags("<think>plan</think>\n\nHello.", OPEN, CLOSE)).toEqual({ reasoning: "plan", text: "Hello." });
    expect(splitThinkingTags("Hi <think>plan</think> there", OPEN, CLOSE)).toEqual({ reasoning: "plan", text: "Hi  there" });
  });

  it("keeps an unclosed block as thinking", () => {
    expect(splitThinkingTags("<think>still going", OPEN, CLOSE)).toEqual({ reasoning: "still going", text: "" });
  });

  it("treats text before a lone close tag as thinking", () => {
    expect(splitThinkingTags("plan it out\n</think>\n\nHello.", OPEN, CLOSE)).toEqual({ reasoning: "plan it out", text: "Hello." });
  });

  it("starts inside when the prefill opened the block", () => {
    expect(splitThinkingTags("plan", OPEN, CLOSE, true)).toEqual({ reasoning: "plan", text: "" });
    expect(splitThinkingTags("plan</think>Hello.", OPEN, CLOSE, true)).toEqual({ reasoning: "plan", text: "Hello." });
    // a server that ignores the prefill writes the open tag itself
    expect(splitThinkingTags("<think>plan</think>Hello.", OPEN, CLOSE, true)).toEqual({ reasoning: "plan", text: "Hello." });
  });

  it("leaves text without tags alone", () => {
    expect(splitThinkingTags("  Hello.  ", OPEN, CLOSE)).toEqual({ reasoning: "", text: "  Hello.  " });
  });
});

describe("opensThinking", () => {
  it("is true only when the seed leaves a block open", () => {
    expect(opensThinking("<think>\n", OPEN, CLOSE)).toBe(true);
    expect(opensThinking("Sure. <think>Let me", OPEN, CLOSE)).toBe(true);
    expect(opensThinking("<think>a</think>b", OPEN, CLOSE)).toBe(false);
    expect(opensThinking("Hello", OPEN, CLOSE)).toBe(false);
    expect(opensThinking(undefined, OPEN, CLOSE)).toBe(false);
  });
});

describe("ThinkTagStream", () => {
  const run = (chunks: string[], inside = false) => {
    const out = { text: "", thinking: "" };
    const s = new ThinkTagStream(OPEN, CLOSE, inside, (d) => { out.text += d; }, (d) => { out.thinking += d; });
    for (const c of chunks) s.push(c);
    s.flush();
    return out;
  };

  it("routes deltas with tags split across chunk boundaries", () => {
    expect(run(["<th", "ink>pla", "n</thi", "nk>Hel", "lo."])).toEqual({ thinking: "plan", text: "Hello." });
  });

  it("starts inside after a prefilled open tag", () => {
    expect(run(["pl", "an</th", "ink>Hello."], true)).toEqual({ thinking: "plan", text: "Hello." });
  });

  it("drops a repeated open tag inside and a stray close tag outside", () => {
    expect(run(["<think>plan</think>Hello."], true)).toEqual({ thinking: "plan", text: "Hello." });
    expect(run(["plan</think>Hello."])).toEqual({ thinking: "", text: "planHello." });
  });

  it("flushes a held tail that never became a tag", () => {
    expect(run(["a <"])).toEqual({ thinking: "", text: "a <" });
  });
});

describe("chat completion streams", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "think-tags-")); });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  const setup = () => {
    const svc = new UserModelService("dana", bootstrapUserDir(dataDir, "dana"), defaultInstanceConfig());
    const handle = fauxProvider({ models: [{ id: "faux-chat" }], tokenSize: { min: 1, max: 3 } });
    svc.models.setProvider(handle.provider);
    const m = handle.getModel();
    return { svc, handle, model: `${m.provider}/${m.id}` };
  };

  const generate = async (svc: UserModelService, req: GenerateRequest) => {
    const live = { text: "", thinking: "" };
    const result = await svc.generate(req, (d) => { live.text += d; }, (d) => { live.thinking += d; });
    return { live, result };
  };

  it("splits inline tags live and in the result", async () => {
    const { svc, handle, model } = setup();
    handle.setResponses([fauxAssistantMessage("<think>\nplan the scene\n</think>\n\nEmber waves.")]);
    const { live, result } = await generate(svc, { model, messages: [{ role: "user", content: "hi" }], reasoningTags: tags });
    expect(live.thinking.trim()).toBe("plan the scene");
    expect(live.text.trim()).toBe("Ember waves.");
    expect(result.reasoning).toBe("plan the scene");
    expect(result.text).toBe("Ember waves.");
  });

  it("starts inside the block when the prefill opened it", async () => {
    const { svc, handle, model } = setup();
    handle.setResponses([fauxAssistantMessage("plan the scene\n</think>\n\nEmber waves.")]);
    const { live, result } = await generate(svc, {
      model,
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "<think>\n" }],
      assistantPrefill: "<think>\n",
      reasoningTags: tags,
    });
    expect(live.thinking.trim()).toBe("plan the scene");
    expect(live.text).not.toContain(CLOSE);
    expect(result.reasoning).toBe("plan the scene");
    expect(result.text).toBe("Ember waves.");
  });

  it("ignores a prefill the chat request does not carry", async () => {
    const { svc, handle, model } = setup();
    handle.setResponses([fauxAssistantMessage("I open the door.")]);
    const { live, result } = await generate(svc, {
      model,
      messages: [{ role: "user", content: "hi" }],
      assistantPrefill: "<think>\n",
      reasoningTags: tags,
    });
    expect(live.text).toBe("I open the door.");
    expect(result.text).toBe("I open the door.");
    expect(result.reasoning ?? "").toBe("");
  });

  it("splits a block the chat template opened (close tag only)", async () => {
    const { svc, handle, model } = setup();
    handle.setResponses([fauxAssistantMessage("plan the scene\n</think>\n\nEmber waves.")]);
    const { live, result } = await generate(svc, { model, messages: [{ role: "user", content: "hi" }], reasoningTags: tags });
    expect(live.text).not.toContain(CLOSE);
    expect(result.reasoning).toBe("plan the scene");
    expect(result.text).toBe("Ember waves.");
  });

  it("splits inline tags even when the provider reports thinking too", async () => {
    const { svc, handle, model } = setup();
    handle.setResponses([fauxAssistantMessage([fauxThinking("native"), fauxText("<think>inline</think>Ember waves.")])]);
    const { result } = await generate(svc, { model, messages: [{ role: "user", content: "hi" }], reasoningTags: tags });
    expect(result.reasoning).toBe("native\ninline");
    expect(result.text).toBe("Ember waves.");
  });

  it("streams text untouched without tags", async () => {
    const { svc, handle, model } = setup();
    handle.setResponses([fauxAssistantMessage("<think>kept</think>Ember.")]);
    const { live, result } = await generate(svc, { model, messages: [{ role: "user", content: "hi" }] });
    expect(live.text).toBe("<think>kept</think>Ember.");
    expect(result.text).toBe("<think>kept</think>Ember.");
    expect(result.reasoning ?? "").toBe("");
  });
});
