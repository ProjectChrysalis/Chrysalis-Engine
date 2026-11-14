import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { GenerateRequest, GenerateResult } from "../src/models.js";
import { capCacheRefreshPayload, PromptRefreshes } from "../src/providers/cache-refresh.js";

const model = { api: "anthropic-messages", provider: "anthropic", id: "test" } as Model<Api>;
const reply = (cacheRead = 100): GenerateResult => ({ text: "ignored", model: "anthropic/test", startedAt: 1000,
  usage: { input: 2, output: 1, cacheRead, cacheWrite: 0, costTotal: 0, priced: false } });
const request = (): GenerateRequest => ({ messages: [{ role: "user", content: "Exact prompt" }], sessionId: "chat",
  cache: { depth: 2, retention: "short" }, presetParams: { temperature: 0.8, max_tokens: 1000 }, model: "anthropic/test" });

describe("cache request snapshots", () => {
  it("keeps an immutable prompt and cache identity, caps output, and does not retain tool executors", async () => {
    const store = new PromptRefreshes(() => 2000);
    const req = request();
    req.tools = [{ name: "do_work", description: "A tool", parameters: { type: "object", properties: {} } }];
    req.executeTool = async () => { throw new Error("must never execute"); };
    const info = store.remember("app-a", req, reply(), model);
    req.messages[0]!.content = "Changed later";
    let captured: GenerateRequest | undefined;
    const result = await store.refresh("app-a", info.token!, async (r) => { captured = r; return reply(); });
    expect(captured).toMatchObject({ messages: [{ role: "user", content: "Exact prompt" }], model: "anthropic/test", sessionId: "chat",
      cache: { depth: 2, retention: "short" }, refreshOnly: true, captureCache: false, presetParams: { max_tokens: 1000, temperature: 0.8 }, tools: req.tools });
    await expect(captured!.executeTool!("do_work", {})).rejects.toThrow("cannot execute tools");
    expect(result.cacheRefresh?.expiresAt).toBe(302000);
  });

  it("rejects another app and expired snapshots without invoking a model", async () => {
    let now = 2000;
    const store = new PromptRefreshes(() => now);
    const info = store.remember("app-a", request(), reply(), model);
    const never = async (): Promise<GenerateResult> => { throw new Error("model called"); };
    await expect(store.refresh("app-b", info.token!, never)).rejects.toThrow("unavailable");
    now = 301000;
    await expect(store.refresh("app-a", info.token!, never)).rejects.toThrow("expired");
  });

  it("locks overlapping requests and retires a cache miss", async () => {
    const store = new PromptRefreshes(() => 2000);
    const info = store.remember("app-a", request(), reply(), model);
    let finish!: (r: GenerateResult) => void;
    const pending = store.refresh("app-a", info.token!, () => new Promise((resolve) => { finish = resolve; }));
    await expect(store.refresh("app-a", info.token!, async () => reply())).rejects.toThrow("already running");
    finish(reply(0));
    await pending;
    await expect(store.refresh("app-a", info.token!, async () => reply())).rejects.toThrow("unavailable");
  });

  it("declines unsupported requests, missing cache evidence, and elapsed windows", () => {
    const store = new PromptRefreshes(() => 2000);
    expect(store.remember("a", { ...request(), reasoning: "low" }, reply(), model).token).toBeUndefined();
    expect(store.remember("a", request(), { ...reply(), reasoningEnabled: true }, model).token).toBeUndefined();
    expect(store.remember("a", request(), reply(0), model).reason).toContain("No cache usage");
    expect(store.remember("a", request(), reply(), { ...model, api: "openai-codex-responses" }).token).toBeUndefined();
    expect(new PromptRefreshes(() => 400000).remember("a", request(), reply(), model).reason).toContain("elapsed");
    expect(store.remember("a", request(), { ...reply(), toolTrace: [{ name: "tool", args: {}, resultText: "result", isError: false }] }, model).token).toBeUndefined();
  });

  it("does not retry provider errors and bounds the snapshot count", async () => {
    const store = new PromptRefreshes(() => 2000);
    const first = store.remember("a", request(), reply(), model);
    await expect(store.refresh("a", first.token!, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await expect(store.refresh("a", first.token!, async () => reply())).rejects.toThrow("unavailable");
    const old = store.remember("a", request(), reply(), model);
    for (let i = 0; i < 32; i++) store.remember("a", request(), reply(), model);
    await expect(store.refresh("a", old.token!, async () => reply())).rejects.toThrow("unavailable");
  });
});


it("refreshes automatic caches across chat APIs while retaining thinking configuration", async () => {
  for (const api of ["openai-completions", "openai-responses", "azure-openai-responses", "google-generative-ai", "google-vertex"] as const) {
    const store = new PromptRefreshes(() => 2000);
    const req = { ...request(), reasoning: "medium" as const, thinkingBudget: 2048 };
    const info = store.remember("a", req, { ...reply(), reasoningEnabled: true }, { ...model, api, provider: "custom" });
    expect(info.token).toBeString();
    let captured: GenerateRequest | undefined;
    await store.refresh("a", info.token!, async (r) => { captured = r; return reply(); });
    expect(captured?.reasoning).toBe("medium");
    expect(captured?.thinkingBudget).toBe(2048);
    expect(captured?.presetParams?.max_tokens).toBe(1000);
  }
});

it("caps each provider payload without adding fields from another API or changing thinking", () => {
  expect(capCacheRefreshPayload("openai-completions", { max_tokens: 500, n: 20, best_of: 20 })).toEqual({ max_tokens: 1, n: 1, best_of: 1 });
  const google = { config: { maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 2048 } }, contents: [] };
  expect(capCacheRefreshPayload("google-generative-ai", google)).toEqual({ config: { maxOutputTokens: 16, thinkingConfig: { thinkingBudget: 2048 } }, contents: [] });
  expect(capCacheRefreshPayload("google-vertex", structuredClone(google))).toEqual(google);
  expect(capCacheRefreshPayload("openai-responses", { max_output_tokens: 4096, reasoning: { effort: "high" } })).toEqual({ max_output_tokens: 16, reasoning: { effort: "high" } });
  expect(capCacheRefreshPayload("azure-openai-responses", { max_output_tokens: 500 })).toEqual({ max_output_tokens: 16 });
  expect(capCacheRefreshPayload("openai-completions", { max_completion_tokens: 500, reasoning_effort: "high" })).toEqual({ max_completion_tokens: 1, reasoning_effort: "high" });
  expect(capCacheRefreshPayload("anthropic-messages", { max_tokens: 500, cache_control: { type: "ephemeral" } })).toEqual({ max_tokens: 1, cache_control: { type: "ephemeral" } });
  expect(capCacheRefreshPayload("bedrock-converse-stream", { inferenceConfig: { maxTokens: 500, temperature: 0.5 } })).toEqual({ inferenceConfig: { maxTokens: 1, temperature: 0.5 } });
});


it("replays the effective thinking level after an automatic provider retry", async () => {
  const store = new PromptRefreshes(() => 2000);
  const info = store.remember("a", { ...request(), reasoning: "off" }, { ...reply(), reasoningEnabled: true, effectiveReasoning: "low" }, { ...model, api: "openai-responses" });
  let level: GenerateRequest["reasoning"];
  await store.refresh("a", info.token!, async (r) => { level = r.reasoning; return reply(); });
  expect(level!).toBe("low");
});


it("rejects invalid cache evidence and retires invalid refresh reports", async () => {
  for (const count of [undefined, NaN, Infinity, -1, 0]) {
    const store = new PromptRefreshes(() => 2000);
    const invalid = reply();
    invalid.usage.cacheRead = count as number;
    expect(store.remember("a", request(), invalid, model).token).toBeUndefined();
    const info = store.remember("a", request(), reply(), model);
    await store.refresh("a", info.token!, async () => invalid);
    await expect(store.refresh("a", info.token!, async () => reply())).rejects.toThrow("unavailable");
  }
});

it("stress-tests snapshot eviction and 500 concurrent replay attempts without extra model calls", async () => {
  const store = new PromptRefreshes(() => 2000);
  const tokens: string[] = [];
  for (let i = 0; i < 2000; i++) tokens.push(store.remember("a", request(), reply(), model).token!);
  let calls = 0;
  const generate = async () => { calls++; return reply(); };
  for (const token of tokens.slice(0, -32)) {
    await expect(store.refresh("a", token, generate)).rejects.toThrow("unavailable");
  }
  let release!: (r: GenerateResult) => void;
  const last = tokens.at(-1)!;
  const pending = store.refresh("a", last, () => { calls++; return new Promise((resolve) => { release = resolve; }); });
  const duplicates = await Promise.allSettled(Array.from({ length: 500 }, () => store.refresh("a", last, generate)));
  expect(duplicates.every((r) => r.status === "rejected")).toBe(true);
  expect(calls).toBe(1);
  release(reply());
  await pending;
  await store.refresh("a", last, generate);
  expect(calls).toBe(2);
});
