import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createConnection, readConnections, readAuth, writeAuth } from "../src/connections.js";
import { agentGenerationOptions, validateGenerationSettings, type GenerationSettings } from "../src/providers/generation-settings.js";
import { generationBody, generationDraft, generationCapabilities } from "../client/src/generation-settings-state.js";
import { UserAgent } from "../src/agent/agent.js";
import { readAgentGeneration } from "../src/agent/generation.js";
import { UserModelService } from "../src/models.js";
import { bootstrapUserDir } from "../src/paths.js";
import { defaultInstanceConfig } from "../src/config.js";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";

let dataDir: string;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "generation-settings-")); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });
const generation: GenerationSettings = { maxTokens: 123, temperature: 0, topP: 0.8, frequencyPenalty: -0.5, presencePenalty: 0, reasoning: "high" };

it("preserves zero values and rejects malformed overrides without inventing defaults", () => {
  expect(generationBody(generationDraft())).toBeNull();
  expect(generationBody(generationDraft(generation))).toEqual(generation);
  for (const input of [[], 0, { maxTokens: 0 }, { maxTokens: 1.5 }, { temperature: NaN }, { temperature: 2.1 }, { topP: -1 }, { presencePenalty: 3 }, { reasoning: "invalid" }, { unknown: 1 }, { toString: 1 }]) {
    expect(validateGenerationSettings(input).ok).toBe(false);
  }
  expect(() => generationBody({ ...generationDraft(), temperature: "bad" })).toThrow();
});

it("keeps the agent output limit within the remaining context budget", () => {
  expect(agentGenerationOptions({ maxTokens: 4096 }, { maxTokens: 2048 }).maxTokens).toBe(2048);
  expect(agentGenerationOptions({ maxTokens: 1024 }, { maxTokens: 2048 }).maxTokens).toBe(1024);
});

it("saves, validates and clears agent-only settings without changing connection data", async () => {
  const users = new UserService(dataDir);
  const token = users.create("alice", "user", { password: "test-pass-1" }).token;
  const paths = bootstrapUserDir(dataDir, "alice");
  const app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
  const send = (body: unknown) => app.request("/v1/settings", { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const { reasoning, ...sampling } = generation;
  expect((await send({ agentGeneration: sampling, reasoning })).status).toBe(200);
  expect(readAgentGeneration(paths)).toEqual(sampling);
  const response = await app.request("/v1/settings", { headers: { authorization: `Bearer ${token}` } });
  expect(await response.json()).toMatchObject({ agentGeneration: sampling, reasoning });
  expect((await send({ agentGeneration: { temperature: 100 } })).status).toBe(400);
  expect(readAgentGeneration(paths)).toEqual(sampling);
  expect((await send({ model: "custom/model" })).status).toBe(200);
  expect(readAgentGeneration(paths)).toEqual(sampling);
  expect(readConnections(paths).connections).toEqual({});
  expect((await send({ agentGeneration: null, reasoning: null })).status).toBe(200);
  expect(readAgentGeneration(paths)).toEqual({});
});

it.each(["saved", "off", "defaults", "legacy"] as const)("keeps app requests independent of %s agent settings", async (mode) => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const users = new UserService(dataDir);
    users.create("alice", "user", { password: "test-pass-1" });
    const paths = bootstrapUserDir(dataDir, "alice");
    const connection = createConnection(paths, { name: "Custom", api: "openai-completions", baseUrl: `http://127.0.0.1:${server.port}/v1`, key: "test-key", models: [{ id: "unlisted", contextWindow: 32000, maxTokens: 4096 }] });
    const { reasoning: _reasoning, ...sampling } = generation;
    fs.writeFileSync(paths.settings, JSON.stringify({ ...(mode !== "defaults" ? { agentGeneration: sampling, reasoning: mode === "off" ? "off" : "high" } : {}) }));
    if (mode === "legacy") {
      const saved = readConnections(paths);
      const def = saved.connections[connection.id];
      if (!def) throw new Error("Connection missing");
      Object.assign(def, { generation });
      fs.writeFileSync(paths.connections, JSON.stringify(saved));
    }
    const service = new UserModelService("alice", paths, defaultInstanceConfig());
    const ref = `${connection.id}/unlisted`;
    const agent = await UserAgent.create("alice", service, paths, users, defaultInstanceConfig(), { model: ref });
    expect((await agent.run("Hello")).finalText).toBe("OK");
    const agentRequest = requests.at(-1);
    if (!agentRequest) throw new Error("Agent request missing");
    if (mode === "defaults") {
      expect(agentRequest.temperature).toBeUndefined();
      expect(agentRequest.top_p).toBeUndefined();
      expect(agentRequest.reasoning_effort).toBe("none");
    } else {
      expect(agentRequest).toMatchObject({ temperature: 0, top_p: 0.8, frequency_penalty: -0.5, presence_penalty: 0, reasoning_effort: mode === "off" ? "none" : "high" });
      expect(agentRequest.max_tokens ?? agentRequest.max_completion_tokens).toBe(123);
    }
    const appRequest = { model: ref, messages: [{ role: "user" as const, content: "Hello" }], presetParams: { max_tokens: 333, temperature: 1.7, params: { top_p: 0.1, seed: 42 } } };
    expect((await service.generate(appRequest)).text).toBe("OK");
    expect(requests.at(-1)).toMatchObject({ temperature: 1.7, top_p: 0.1, seed: 42 });
    expect(requests.at(-1)?.max_tokens ?? requests.at(-1)?.max_completion_tokens).toBe(333);
    const context = { messages: [{ role: "user" as const, content: "Hi", timestamp: Date.now() }] };
    const turn = await service.turn({ model: ref, maxTokens: 333, temperature: 1.7, params: { top_p: 0.1 }, build: () => ({ context }) });
    expect((await turn?.stream.result())?.stopReason).toBe("stop");
    expect(requests.at(-1)).toMatchObject({ temperature: 1.7, top_p: 0.1 });
    const model = service.models.getModel(connection.id, "unlisted");
    if (!model) throw new Error("App model missing");
    expect((await service.models.streamSimple(model, context, { maxTokens: 333, temperature: 1.7 }).result()).stopReason).toBe("stop");
    expect(requests.at(-1)).toMatchObject({ temperature: 1.7 });
    expect(requests.at(-1)?.top_p).toBeUndefined();
  } finally { server.stop(true); }
});

it.each(["anthropic", "google", "google-vertex", "openai", "mistral", "openai-codex", "openai-subscription"])("maps agent-only %s settings without leaking OpenAI fields", async (providerId) => {
  const paths = bootstrapUserDir(dataDir, "alice");
  const id = providerId === "openai-subscription" ? "openai" : providerId;
  const subscription = providerId === "openai-codex" || providerId === "openai-subscription";
  const key = subscription ? `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }))}.signature` : "sk-test-key";
  createConnection(paths, { name: providerId, providerId: id, key });
  if (subscription) writeAuth(paths, { ...readAuth(paths), [id]: { type: "oauth", access: key, refresh: "test-refresh", expires: Date.now() + 3600000 } });
  const service = new UserModelService("alice", paths, defaultInstanceConfig());
  const provider = service.models.getProvider(id);
  const model = provider?.getModels().find((model) => model.reasoning && !(model.compat && "supportsMidConvoEffort" in model.compat && model.compat.supportsMidConvoEffort));
  if (!model) throw new Error(`No reasoning model for ${providerId}`);
  const original = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const body = request.headers.get("content-encoding") === "zstd" ? JSON.parse(zstdDecompressSync(Buffer.from(await request.arrayBuffer())).toString()) : await request.json();
    requests.push(body as Record<string, unknown>);
    return Response.json({ error: { message: "test upstream rejection", type: "invalid_request_error" } }, { status: 400 });
  }, { preconnect: original.preconnect });
  try {
    const context = { messages: [{ role: "user" as const, content: "Hello", timestamp: Date.now() }] };
    {
      const options = { maxTokens: 1000, temperature: 1, reasoning: "low" as const, transport: "sse" as const, onPayload: (payload: unknown) => ({ ...payload as object, custom_field: "preserved" }) };
      const result = await service.agentStreamFn(model, context, { ...options, maxTokens: 4096, ...(subscription ? { temperature: undefined } : {}) }, "test-session", { ...generation, temperature: 0.4, maxTokens: 4096 }).result();
      expect(result.stopReason).toBe("error");
      const body = requests.at(-1);
      if (!body) throw new Error(`No request captured: ${result.errorMessage}`);
      if (providerId !== "google" && providerId !== "google-vertex") expect(body.custom_field).toBe("preserved");
      if (providerId !== "mistral") {
        expect(body.reasoning_effort).toBeUndefined();
        expect(body.frequency_penalty).toBeUndefined();
        expect(body.presence_penalty).toBeUndefined();
      }
      if (providerId === "google" || providerId === "google-vertex") {
        expect(body.generationConfig).toMatchObject({ maxOutputTokens: 4096, temperature: 0.4, topP: 0.8, frequencyPenalty: -0.5, presencePenalty: 0 });
        expect((body.generationConfig as Record<string, unknown>).thinkingConfig).toBeDefined();
        expect(body.top_p).toBeUndefined();
      } else if (providerId === "anthropic") {
        expect(body.max_tokens).toBe(4096);
        expect(body.thinking).toMatchObject({ type: model.compat && "forceAdaptiveThinking" in model.compat && model.compat.forceAdaptiveThinking ? "adaptive" : "enabled" });
        expect(body.top_p).toBeUndefined();
        expect(body.temperature).toBeUndefined();
      } else if (providerId === "mistral") {
        expect(body).toMatchObject({ max_tokens: 4096, temperature: 0.4, top_p: 0.8, frequency_penalty: -0.5, presence_penalty: 0 });
        expect(body.reasoning_effort ?? body.prompt_mode).toBeDefined();
      } else {
        if (subscription) {
          expect(body.temperature).toBeUndefined();
          expect(body.top_p).toBeUndefined();
          expect(body.max_output_tokens).toBeUndefined();
        } else expect(body).toMatchObject({ temperature: 0.4, top_p: 0.8 });
        expect(body.reasoning).toMatchObject({ effort: model.thinkingLevelMap?.high ?? "high" });
        if (providerId === "openai") expect(body.max_output_tokens).toBe(4096);
      }
    }
    expect(requests).toHaveLength(1);
  } finally { globalThis.fetch = original; }
});

it("offers API-specific controls and removes hidden draft fields when the source changes", () => {
  expect(generationCapabilities(["anthropic-messages"])).toMatchObject({ maxTokens: true, topP: true, penalties: false, temperatureMax: 1, reasoning: true });
  expect(generationCapabilities(["google-generative-ai"])).toMatchObject({ maxTokens: true, topP: true, penalties: true, temperatureMax: 2, reasoning: true });
  expect(generationCapabilities(["openai-responses"])).toMatchObject({ maxTokens: true, topP: true, penalties: false, reasoning: true });
  expect(generationCapabilities(["openai-codex-responses"])).toMatchObject({ maxTokens: false, temperature: false, topP: false, penalties: false, reasoning: true });
  expect(generationCapabilities(["pi-messages"])).toMatchObject({ maxTokens: true, temperature: true, topP: false, penalties: false, reasoning: true });
  expect(generationCapabilities(["openai-text"])).toMatchObject({ topP: true, penalties: true, reasoning: false });
  expect(generationBody(generationDraft(generation), "invalid", ["openai-codex-responses"])).toEqual({ reasoning: "high" });
  expect(generationBody(generationDraft(generation), "invalid", ["anthropic-messages"])).toEqual({ maxTokens: 123, temperature: 0, topP: 0.8, reasoning: "high" });
  expect(() => generationBody(generationDraft({ temperature: 1.5 }), "invalid", ["anthropic-messages"])).toThrow("invalid");
});

it("keeps the Bedrock output ceiling while mapping native inference and thinking settings", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    return Response.json({ message: "test upstream rejection" }, { status: 400 });
  } });
  try {
    const paths = bootstrapUserDir(dataDir, "alice");
    createConnection(paths, { name: "Bedrock", providerId: "amazon-bedrock", key: "test-key" });
    const service = new UserModelService("alice", paths, defaultInstanceConfig());
    const catalog = service.models.getModels("amazon-bedrock").find((model) => model.id.includes("claude") && model.reasoning);
    if (!catalog) throw new Error("Bedrock test model missing");
    const model = { ...catalog, baseUrl: `http://127.0.0.1:${server.port}` };
    const context = { messages: [{ role: "user" as const, content: "Hello", timestamp: Date.now() }] };
    const result = await service.agentStreamFn(model, context, { env: { AWS_BEDROCK_SKIP_AUTH: "1", AWS_BEDROCK_FORCE_HTTP1: "1" }, maxRetries: 0 }, "test-session", { ...generation, maxTokens: 4096 }).result();
    expect(result.stopReason).toBe("error");
    if (!requests.length) throw new Error(result.errorMessage);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.inferenceConfig).toEqual({ maxTokens: 4096 });
    expect(requests[0]?.top_p).toBeUndefined();
    expect(requests[0]?.reasoning_effort).toBeUndefined();
  } finally { server.stop(true); }
});

it("applies agent settings to gateway requests", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    return Response.json({ error: { message: "test upstream rejection" } }, { status: 400 });
  } });
  try {
    const paths = bootstrapUserDir(dataDir, "alice");
    const gateway = `http://127.0.0.1:${server.port}`;
    createConnection(paths, { name: "Gateway", oauthProvider: "radius", gateway });
    writeAuth(paths, { radius: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600000, boundBaseUrl: gateway,
      gatewayConfig: { baseUrl: gateway, models: [{ id: "local-model", name: "Local", input: ["text"], reasoning: true, contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
    } });
    const service = new UserModelService("alice", paths, defaultInstanceConfig());
    await service.models.refresh({ allowNetwork: false });
    const model = service.models.getModel("radius", "local-model");
    if (!model) throw new Error("Gateway model missing");
    const result = await service.agentStreamFn(model, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] }, {}, "test-session", { maxTokens: 512, temperature: 0.4, reasoning: "high" }).result();
    expect(result.stopReason).toBe("error");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.options).toMatchObject({ maxTokens: 512, temperature: 0.4, reasoning: "high" });
    expect(requests[0]?.reasoning_effort).toBeUndefined();
  } finally { server.stop(true); }
});
