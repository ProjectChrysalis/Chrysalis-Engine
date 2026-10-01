/**
 * Prompt cache placement: an app asks for a history breakpoint a set number
 * of role runs back; the kernel rewrites the provider payload's
 * cache_control markers there. Only Anthropic-format transports take
 * markers; the placement reuses the library marker's TTL.
 */
import { describe, it, expect } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { applyDepthMarkers, cacheStreamOptions, supportsAnthropicCache } from "../src/providers/prompt-cache.js";

type Rec = Record<string, unknown>;

function model(api: string, provider = "custom", id = "m", compat?: Record<string, unknown>): Model<Api> {
  return {
    id,
    provider,
    api,
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    ...(compat ? { compat } : {}),
  } as unknown as Model<Api>;
}

function collectMarkers(node: unknown, out: Rec[] = []): Rec[] {
  if (Array.isArray(node)) {
    for (const item of node) collectMarkers(item, out);
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  const rec = node as Rec;
  if (typeof rec.cache_control === "object" && rec.cache_control !== null) out.push(rec);
  for (const value of Object.values(rec)) collectMarkers(value, out);
  return out;
}

const ttl1h = { type: "ephemeral", ttl: "1h" };

describe("supportsAnthropicCache", () => {
  it("covers the Anthropic transports and nothing else", () => {
    expect(supportsAnthropicCache(model("anthropic-messages"))).toBe(true);
    expect(supportsAnthropicCache(model("openai-completions", "custom", "claude-x", { cacheControlFormat: "anthropic" }))).toBe(true);
    expect(supportsAnthropicCache(model("openai-completions", "openrouter", "anthropic/claude-sonnet-4"))).toBe(true);
    expect(supportsAnthropicCache(model("openai-completions", "openrouter", "openai/gpt-5"))).toBe(false);
    expect(supportsAnthropicCache(model("openai-completions", "custom", "gpt-x"))).toBe(false);
    expect(supportsAnthropicCache(model("google-generative-ai"))).toBe(false);
    expect(supportsAnthropicCache(model("openai-responses"))).toBe(false);
  });
});

describe("cacheStreamOptions", () => {
  it("passes retention through and adds the payload rewrite for depth", () => {
    const options = cacheStreamOptions(model("anthropic-messages"), { depth: 0, retention: "long" });
    expect(options.cacheRetention).toBe("long");
    expect(typeof options.onPayload).toBe("function");
    const payload = { messages: [{ role: "user", content: "hi" }] };
    expect(options.onPayload!(payload)).toBe(payload);
    expect(collectMarkers(payload)).toHaveLength(1);
  });

  it("keeps retention on non-Anthropic providers but drops the depth", () => {
    const options = cacheStreamOptions(model("openai-completions"), { depth: 2, retention: "long" });
    expect(options.cacheRetention).toBe("long");
    expect(options.onPayload).toBeUndefined();
  });

  it("retention none turns caching off and drops depth placement", () => {
    const options = cacheStreamOptions(model("anthropic-messages"), { depth: 0, retention: "none" });
    expect(options.cacheRetention).toBe("none");
    expect(options.onPayload).toBeUndefined();
  });

  it("ignores an invalid depth", () => {
    for (const depth of [-1, 1.5, Number.NaN]) {
      const options = cacheStreamOptions(model("anthropic-messages"), { depth });
      expect(options.onPayload).toBeUndefined();
    }
  });

  it("adds nothing when the request asks for nothing", () => {
    const options = cacheStreamOptions(model("anthropic-messages"), {});
    expect(options.cacheRetention).toBeUndefined();
    expect(options.onPayload).toBeUndefined();
  });
});

describe("applyDepthMarkers", () => {
  it("preserves schema and tool-result properties named cache_control", () => {
    const schema = { type: "object", properties: { cache_control: { type: "string", ttl: "fake" } }, required: ["cache_control"] };
    const toolResult = { cache_control: { type: "ephemeral", ttl: "fake" }, nested: { cache_control: "data" } };
    const payload = {
      tools: [{ name: "test", input_schema: structuredClone(schema) }],
      system: [{ type: "text", text: "sys", cache_control: { ...ttl1h } }],
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: structuredClone(toolResult), cache_control: { ...ttl1h } }, { type: "text", text: "go" }] }],
    };
    applyDepthMarkers(payload, 0);
    expect(payload.tools[0]!.input_schema).toEqual(schema);
    expect(payload.messages[0]!.content[0]!.content).toEqual(toolResult);
    expect((payload.tools[0] as unknown as Rec).cache_control).toEqual(ttl1h);
    expect((payload.messages[0]!.content[1] as Rec).cache_control).toEqual(ttl1h);
  });

  it("marks the system prompt, the last tool, and the depth runs with the library's TTL", () => {
    const payload: Rec = {
      system: [{ type: "text", text: "sys", cache_control: { ...ttl1h } }],
      tools: [{ name: "a", description: "" }, { name: "b", description: "", cache_control: { ...ttl1h } }],
      // the library had marked the last user message and left an old marker on
      // the first one; both placements are rewritten here
      messages: [
        { role: "user", content: [{ type: "text", text: "one", cache_control: { ...ttl1h } }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: "two" },
        { role: "assistant", content: [{ type: "text", text: "a2" }] },
        { role: "user", content: [{ type: "text", text: "three", cache_control: { ...ttl1h } }] },
      ],
    };
    applyDepthMarkers(payload, 0);
    const system = payload.system as Rec[];
    const tools = payload.tools as Rec[];
    const messages = payload.messages as Rec[];
    expect(system[0]!.cache_control).toEqual(ttl1h);
    expect(tools[1]!.cache_control).toEqual(ttl1h);
    expect(tools[0]!.cache_control).toBeUndefined();
    // run 0 = the last turn, run 2 = two role switches back
    expect(messages[4]!.content).toEqual([{ type: "text", text: "three", cache_control: ttl1h }]);
    expect(messages[2]!.content).toEqual([{ type: "text", text: "two", cache_control: ttl1h }]);
    expect(messages[1]!.content).toEqual([{ type: "text", text: "a1" }]);
    expect(messages[3]!.content).toEqual([{ type: "text", text: "a2" }]);
    expect(collectMarkers(payload)).toHaveLength(4);
    for (const marked of collectMarkers(payload)) expect(marked.cache_control).toEqual(ttl1h);
  });

  it("skips a trailing assistant prefill when counting runs", () => {
    const payload: Rec = {
      system: [{ type: "text", text: "sys" }],
      tools: [{ name: "a", description: "" }],
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: [{ type: "text", text: "Sure, I" }] },
      ],
    };
    applyDepthMarkers(payload, 0);
    const messages = payload.messages as Rec[];
    expect(messages[0]!.content).toEqual([{ type: "text", text: "question", cache_control: { type: "ephemeral" } }]);
    expect(messages[1]!.content).toEqual([{ type: "text", text: "Sure, I" }]);
    // system + tool + the one run that exists
    expect(collectMarkers(payload)).toHaveLength(3);
  });

  it("system and tool turns neither take a marker nor advance the run count", () => {
    const payload: Rec = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "one" },
        { role: "assistant", content: "a1" },
        { role: "tool", content: "result" },
        { role: "user", content: "two" },
      ],
      tools: [{ type: "function", function: { name: "a" } }],
    };
    applyDepthMarkers(payload, 0);
    const messages = payload.messages as Rec[];
    const marker = { type: "ephemeral" };
    expect(messages[0]!.content).toEqual([{ type: "text", text: "sys", cache_control: marker }]);
    expect(messages[1]!.content).toEqual([{ type: "text", text: "one", cache_control: marker }]);
    expect(messages[3]!.content).toBe("result");
    expect(messages[4]!.content).toEqual([{ type: "text", text: "two", cache_control: marker }]);
    expect((payload.tools as Rec[])[0]!.cache_control).toEqual(marker);
    expect(collectMarkers(payload)).toHaveLength(4);
  });

  it("marks the last text part of multi-part content, not the image", () => {
    const payload: Rec = {
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "a1" },
        {
          role: "user",
          content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,x" } }],
        },
      ],
    };
    applyDepthMarkers(payload, 0);
    const last = (payload.messages as Rec[])[2]!.content as Rec[];
    expect(last[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(last[1]!.cache_control).toBeUndefined();
  });

  it("places nothing when no run is deep enough for the second breakpoint", () => {
    const payload: Rec = {
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
      ],
    };
    applyDepthMarkers(payload, 5);
    expect(collectMarkers(payload)).toHaveLength(0);
  });

  it("leaves non-object payloads alone", () => {
    expect(() => applyDepthMarkers(undefined, 0)).not.toThrow();
    expect(() => applyDepthMarkers("nope", 0)).not.toThrow();
  });
});
