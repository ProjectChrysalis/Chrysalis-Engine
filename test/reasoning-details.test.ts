import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { reasoningDetailsFetch } from "../src/providers/reasoning-details.js";

/** Thinking in two deltas, then its signature as a delta of its own. */
const CHUNKS = [
  { delta: { reasoning: "Thinking", reasoning_details: [{ type: "reasoning.text", text: "Thinking", format: "anthropic-claude-v1", index: 0 }] } },
  { delta: { reasoning: " it over", reasoning_details: [{ type: "reasoning.text", text: " it over", format: "anthropic-claude-v1", index: 0 }] } },
  { delta: { reasoning_details: [{ type: "reasoning.text", signature: "SIG-123", format: "anthropic-claude-v1", index: 0 }] } },
  { delta: { content: "Hello" } },
  { delta: {}, finish_reason: "stop" },
];

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  // one byte per network chunk would be slow; split mid-line instead so the
  // repair has to carry partial lines across chunks
  const body = CHUNKS.map((c) => `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, ...c }] })}\n\n`).join("") + "data: [DONE]\n\n";
  server = Bun.serve({
    port: 0,
    fetch: () => new Response(new ReadableStream({
      start(ctl) {
        for (let at = 0; at < body.length; at += 37) ctl.enqueue(new TextEncoder().encode(body.slice(at, at + 37)));
        ctl.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
});
afterAll(() => server.stop(true));

const signatureOf = async (fetch?: typeof globalThis.fetch): Promise<unknown> => {
  const model = {
    id: "anthropic/test", name: "test", api: "openai-completions", provider: "c_test", baseUrl: `http://127.0.0.1:${server.port}/v1`,
    reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
  };
  const s = stream(model as never, { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never, { apiKey: "k", ...(fetch ? { fetch } : {}) } as never);
  for await (const _ of s) { /* drain */ }
  const final = await s.result();
  const thinking = final.content.find((b) => b.type === "thinking") as { thinking: string; thinkingSignature?: string } | undefined;
  expect(thinking?.thinking).toBe("Thinking it over");
  expect(final.content.some((b) => b.type === "text" && b.text === "Hello")).toBe(true);
  return JSON.parse(thinking?.thinkingSignature ?? "[]");
};

describe("signed reasoning on OpenAI-compatible streams", () => {
  it("keeps a signature that arrives in a delta without text", async () => {
    expect(await signatureOf(reasoningDetailsFetch())).toEqual([
      { type: "reasoning.text", text: "Thinking it over", format: "anthropic-claude-v1", index: 0, signature: "SIG-123" },
    ]);
  });

  it("is what the plain stream loses", async () => {
    const details = (await signatureOf()) as { signature?: string }[];
    expect(details[0]?.signature).toBeUndefined();
  });
});
