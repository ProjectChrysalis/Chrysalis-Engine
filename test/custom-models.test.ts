import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { createConnection, readAuth, readConnections, updateConnection, validateConnectionInput } from "../src/connections.js";
import { UserModelService } from "../src/models.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir } from "../src/paths.js";

let dataDir: string;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-models-")); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

const custom = { id: "custom-google-model", contextWindow: 1048576, maxTokens: 65536, reasoning: true };

describe("custom models on builtin connections", () => {
  it("adds a native Google model to the shared catalog without replacing existing models or credentials", async () => {
    const paths = bootstrapUserDir(dataDir, "alice");
    const imageModels = new UserModelService("alice", paths, defaultInstanceConfig()).models.getModelsOfType("image");
    const parsed = validateConnectionInput({ name: "Google", providerId: "google", key: "test-key", models: [custom] });
    if (!parsed.ok) throw new Error(parsed.error);
    const connection = createConnection(paths, parsed.value);
    expect(readConnections(paths).connections[connection.id]?.models).toEqual([custom]);
    expect(readAuth(paths).google?.key).toBe("test-key");
    const service = new UserModelService("alice", paths, defaultInstanceConfig());
    const available = await service.available();
    expect(available.find((model) => model.modelId === custom.id)).toMatchObject({
      provider: "google", api: "google-generative-ai", contextWindow: custom.contextWindow, reasoning: true, pricing: null,
    });
    expect(service.models.getModels("google").length).toBe(googleProvider().getModels().length + 1);
    expect(service.models.getModel("google", custom.id)?.maxTokens).toBe(custom.maxTokens);
    expect(service.models.getModelsOfType("image")).toEqual(imageModels);
  });

  it("overrides an existing ID once and restores the catalog when custom models are removed", () => {
    const paths = bootstrapUserDir(dataDir, "alice");
    const original = googleProvider().getModels()[0]!;
    const connection = createConnection(paths, { name: "Google", providerId: "google", key: "test-key" });
    updateConnection(paths, connection.id, { models: [{ id: original.id, contextWindow: 123456, reasoning: false }] });
    let service = new UserModelService("alice", paths, defaultInstanceConfig());
    expect(service.models.getModel("google", original.id)).toMatchObject({ contextWindow: 123456, reasoning: false, maxTokens: original.maxTokens });
    expect(service.models.getModels("google").length).toBe(googleProvider().getModels().length);
    updateConnection(paths, connection.id, { models: "auto" });
    service = new UserModelService("alice", paths, defaultInstanceConfig());
    expect(service.models.getModel("google", original.id)?.contextWindow).toBe(original.contextWindow);
    expect(readAuth(paths).google?.key).toBe("test-key");
  });

  it("rejects missing limits, duplicate IDs and invalid token values", () => {
    const input = { name: "Google", providerId: "google" };
    for (const models of [[{ id: custom.id }], [{ ...custom, maxTokens: Infinity }], [{ ...custom, contextWindow: 1.5 }], [{ ...custom, id: " " }], [custom, { ...custom }]]) {
      expect(validateConnectionInput({ ...input, models }).ok).toBe(false);
    }
    expect(validateConnectionInput({ ...input, models: [{ ...custom, id: ` ${custom.id} ` }] })).toMatchObject({ ok: true, value: { models: [custom] } });
    expect(validateConnectionInput({ ...input, models: "auto" }).ok).toBe(true);
  });

  it("sends an added model ID through Google's native streaming API", async () => {
    const paths = bootstrapUserDir(dataDir, "alice");
    createConnection(paths, { name: "Google", providerId: "google", key: "test-key", models: [custom] });
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Custom reply"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }, { preconnect: originalFetch.preconnect });
    try {
      const service = new UserModelService("alice", paths, defaultInstanceConfig());
      const result = await service.generate({ model: `google/${custom.id}`, messages: [{ role: "user", content: "Hello" }] });
      expect(result.text).toBe("Custom reply");
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain(`/models/${custom.id}:streamGenerateContent`);
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe("Google prompt feedback", () => {
  it.each(["PROHIBITED_CONTENT", "SAFETY"])("reports %s with the response ID when Google returns no candidates", async (blockReason) => {
    const paths = bootstrapUserDir(dataDir, "alice");
    createConnection(paths, { name: "Google", providerId: "google", key: "test-key", models: [custom] });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response(`data: ${JSON.stringify({ responseId: "blocked-123", promptFeedback: { blockReason } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } }), { preconnect: originalFetch.preconnect });
    try {
      const service = new UserModelService("alice", paths, defaultInstanceConfig());
      await expect(service.generate({ model: `google/${custom.id}`, messages: [{ role: "user", content: "Hello" }] }))
        .rejects.toThrow(`stop_reason: ${blockReason}; response: blocked-123`);
      const model = service.models.getModel("google", custom.id)!;
      let observed = 0;
      const result = await service.streamFn(model, { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] }, { onProviderStreamEvent: () => { observed++; } }).result();
      expect(result).toMatchObject({ stopReason: "error", rawStopReason: blockReason, responseId: "blocked-123", errorMessage: `Google blocked the prompt: ${blockReason}` });
      expect(observed).toBe(1);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("keeps a genuinely unfinished stream as an error without inventing a block reason", async () => {
    const paths = bootstrapUserDir(dataDir, "alice");
    createConnection(paths, { name: "Google", providerId: "google", key: "test-key", models: [custom] });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response('data: {"responseId":"unfinished-123","promptFeedback":{"blockReason":"BLOCK_REASON_UNSPECIFIED"}}\n\n', { headers: { "Content-Type": "text/event-stream" } }), { preconnect: originalFetch.preconnect });
    try {
      const service = new UserModelService("alice", paths, defaultInstanceConfig());
      const model = service.models.getModel("google", custom.id)!;
      const result = await service.streamFn(model, { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] }).result();
      expect(result.errorMessage).toBe("Google stream ended without a finish reason");
      expect(result.rawStopReason).toBeUndefined();
    } finally { globalThis.fetch = originalFetch; }
  });
});
