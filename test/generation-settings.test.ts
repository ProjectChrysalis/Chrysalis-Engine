import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createConnection, updateConnection, readConnections, readAuth, writeAuth, validateConnectionInput } from "../src/connections.js";
import { validateGenerationSettings, type GenerationSettings } from "../src/providers/generation-settings.js";
import { generationBody, generationDraft, generationCapabilities } from "../client/src/generation-settings-state.js";
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
  expect(validateConnectionInput({ name: "Google", providerId: "google", generation }).ok).toBe(true);
});

it("creates, edits and clears settings through HTTP, preserving credentials and unrelated fields", async () => {
  const users = new UserService(dataDir);
  users.create("admin", "admin", { password: "admin-pass-1" });
  const token = users.create("alice", "user", { password: "test-pass-1" }).token;
  const paths = bootstrapUserDir(dataDir, "alice");
  const app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
  const send = (method: string, route: string, body: unknown) => app.request(route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const created = await send("POST", "/v1/settings/connections", { name: "Custom", api: "openai-completions", baseUrl: "http://localhost:1234/v1", key: "test-key", generation });
  expect(created.status).toBe(201);
  const { connection } = await created.json() as { connection: { id: string } };
  const route = `/v1/settings/connections/${connection.id}`;
  expect(readConnections(paths).connections[connection.id]?.generation).toEqual(generation);
  expect((await send("PATCH", route, { generation: { temperature: 100 } })).status).toBe(400);
  expect(readConnections(paths).connections[connection.id]?.generation).toEqual(generation);
  expect((await send("PATCH", route, { name: "Renamed" })).status).toBe(200);
  expect(readConnections(paths).connections[connection.id]?.generation).toEqual(generation);
  expect((await send("PATCH", route, { generation: { temperature: 0.4 } })).status).toBe(200);
  expect(readConnections(paths).connections[connection.id]?.generation).toEqual({ temperature: 0.4 });
  expect((await send("PATCH", route, { generation: null })).status).toBe(200);
  expect(readConnections(paths).connections[connection.id]?.generation).toBeUndefined();
  const listed = await app.request("/v1/settings/connections", { headers: { authorization: `Bearer ${token}` } });
  expect(JSON.stringify(await listed.json())).not.toContain("test-key");
});

it.each(["generate", "agent", "turn", "raw", "text", "off", "unchanged", "cleared", "error"] as const)("sends saved overrides in real %s requests and streams the answer", async (mode) => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response("{}", { headers: { "content-type": "application/json" } });
    requests.push(await request.json() as Record<string, unknown>);
    if (mode === "error") return Response.json({ error: { message: "reasoning is mandatory", type: "invalid_request_error" } }, { status: 400 });
    const data = mode === "text"
      ? [{ choices: [{ text: "OK", finish_reason: null }] }, { choices: [{ text: "", finish_reason: "stop" }] }]
      : [{ id: "test", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] }, { id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
    return new Response(`${data.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const paths = bootstrapUserDir(dataDir, "alice");
    const connection = createConnection(paths, { name: "Custom", api: mode === "text" ? "openai-text" : "openai-completions", baseUrl: `http://127.0.0.1:${server.port}/v1`, promptFormat: "chatml", key: "test-key", models: [{ id: "unlisted", contextWindow: 32000, maxTokens: 4096 }], ...(mode === "unchanged" ? {} : { generation: { ...generation, ...(mode === "off" || mode === "error" ? { reasoning: "off" as const } : {}) } }) });
    if (mode === "cleared") updateConnection(paths, connection.id, { generation: null });
    const service = new UserModelService("alice", paths, defaultInstanceConfig());
    const ref = `${connection.id}/unlisted`;
    const context = { messages: [{ role: "user" as const, content: "Hi", timestamp: Date.now() }] };
    const options = { maxTokens: 333, temperature: 1.7, samplingParams: { top_p: 0.1, seed: 42 } };
    if (mode === "error") {
      await expect(service.generate({ model: ref, messages: [{ role: "user", content: "Hi" }] })).rejects.toThrow("reasoning is mandatory");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.reasoning_effort).toBe("none");
      return;
    }
    if (mode === "generate" || mode === "text") {
      const chunks: string[] = [];
      const result = await service.generate({ model: ref, messages: [{ role: "user", content: "Hi" }], presetParams: { max_tokens: 333, temperature: 1.7, params: { top_p: 0.1, seed: 42 } } }, (chunk) => chunks.push(chunk));
      expect(result.text).toBe("OK");
      expect(chunks.join("")).toBe("OK");
      expect(result.requestParams).toMatchObject({ temperature: 0, max_tokens: 123, params: { top_p: 0.8 } });
    } else {
      const model = service.models.getModel(connection.id, "unlisted");
      if (!model) throw new Error("test model missing");
      const stream = mode === "turn" ? (await service.turn({ model: ref, maxTokens: 333, temperature: 1.7, params: options.samplingParams, build: () => ({ context }) }))?.stream
        : mode === "agent" ? service.streamFn(model, context, options)
        : service.models.stream(model, context, options);
      if (!stream) throw new Error("test stream missing");
      const result = await stream.result();
      expect(result.stopReason).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "OK" });
    }
    expect(requests).toHaveLength(1);
    if (mode === "unchanged" || mode === "cleared") {
      expect(requests[0]).toMatchObject({ temperature: 1.7, top_p: 0.1, seed: 42 });
      expect(requests[0]?.max_tokens ?? requests[0]?.max_completion_tokens).toBe(333);
      expect(requests[0]?.presence_penalty).toBeUndefined();
      return;
    }
    expect(requests[0]).toMatchObject({ temperature: 0, top_p: 0.8, frequency_penalty: -0.5, presence_penalty: 0, reasoning_effort: mode === "off" ? "none" : "high", seed: 42 });
    expect(requests[0]?.max_tokens ?? requests[0]?.max_completion_tokens).toBe(123);
  } finally { server.stop(true); }
});

it.each(["anthropic", "google", "openai", "openrouter", "mistral", "openai-codex"])("saves generation overrides for the builtin %s connection", (providerId) => {
  const paths = bootstrapUserDir(dataDir, "alice");
  const parsed = validateConnectionInput({ name: providerId, providerId, key: "test-key", generation });
  if (!parsed.ok) throw new Error(parsed.error);
  const connection = createConnection(paths, parsed.value);
  expect(connection.generationApis.length).toBeGreaterThan(0);
  expect(readConnections(paths).connections[connection.id]?.generation).toEqual(generation);
  updateConnection(paths, connection.id, { generation: { reasoning: "off", maxTokens: 512 } });
  const service = new UserModelService("alice", paths, defaultInstanceConfig());
  expect(service.models.getProvider(providerId)).toBeDefined();
  updateConnection(paths, connection.id, { generation: null });
  expect(readConnections(paths).connections[connection.id]?.generation).toBeUndefined();
});

it.each(["anthropic", "google", "google-vertex", "openai", "mistral", "openai-codex"])("maps native %s settings on simple and raw requests without leaking OpenAI fields", async (providerId) => {
  const paths = bootstrapUserDir(dataDir, "alice");
  const key = providerId === "openai-codex" ? `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }))}.signature` : "sk-test-key";
  const connection = createConnection(paths, { name: providerId, providerId, key, generation: { ...generation, temperature: 0.4, maxTokens: 4096 } });
  if (providerId === "openai-codex") writeAuth(paths, { ...readAuth(paths), [providerId]: { type: "oauth", access: key, refresh: "test-refresh", expires: Date.now() + 3600000 } });
  const service = new UserModelService("alice", paths, defaultInstanceConfig());
  const provider = service.models.getProvider(providerId);
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
    for (const method of ["simple", "raw"] as const) {
      const options = { maxTokens: 1000, temperature: 1, reasoning: "low" as const, transport: "sse" as const, onPayload: (payload: unknown) => ({ ...payload as object, custom_field: "preserved" }) };
      const result = await (method === "simple" ? service.streamFn(model, context, options) : service.models.stream(model, context, options)).result();
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
        expect(body).toMatchObject(providerId === "openai-codex" ? { temperature: 0.4 } : { temperature: 0.4, top_p: 0.8 });
        expect(body.reasoning).toMatchObject({ effort: model.thinkingLevelMap?.high ?? "high" });
        if (providerId === "openai") expect(body.max_output_tokens).toBe(4096);
      }
    }
    expect(requests).toHaveLength(2);
    expect(connection.generationApis).toContain(model.api);
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
    createConnection(paths, { name: "Bedrock", providerId: "amazon-bedrock", key: "test-key", generation: { ...generation, maxTokens: 4096 } });
    const service = new UserModelService("alice", paths, defaultInstanceConfig());
    const catalog = service.models.getModels("amazon-bedrock").find((model) => model.id.includes("claude") && model.reasoning);
    if (!catalog) throw new Error("Bedrock test model missing");
    const model = { ...catalog, baseUrl: `http://127.0.0.1:${server.port}` };
    const context = { messages: [{ role: "user" as const, content: "Hello", timestamp: Date.now() }] };
    const result = await service.streamFn(model, context, { env: { AWS_BEDROCK_SKIP_AUTH: "1", AWS_BEDROCK_FORCE_HTTP1: "1" }, maxRetries: 0 }).result();
    expect(result.stopReason).toBe("error");
    if (!requests.length) throw new Error(result.errorMessage);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.inferenceConfig).toEqual({ maxTokens: 4096 });
    expect(requests[0]?.top_p).toBeUndefined();
    expect(requests[0]?.reasoning_effort).toBeUndefined();
  } finally { server.stop(true); }
});

it("applies gateway connection overrides to the gateway's effective provider ID", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    return Response.json({ error: { message: "test upstream rejection" } }, { status: 400 });
  } });
  try {
    const paths = bootstrapUserDir(dataDir, "alice");
    const gateway = `http://127.0.0.1:${server.port}`;
    const connection = createConnection(paths, { name: "Gateway", oauthProvider: "radius", gateway, generation: { maxTokens: 512, temperature: 0.4, reasoning: "high" } });
    expect(connection.generationApis).toEqual(["pi-messages"]);
    writeAuth(paths, { radius: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600000, boundBaseUrl: gateway,
      gatewayConfig: { baseUrl: gateway, models: [{ id: "local-model", name: "Local", input: ["text"], reasoning: true, contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
    } });
    const service = new UserModelService("alice", paths, defaultInstanceConfig());
    await service.models.refresh({ allowNetwork: false });
    const model = service.models.getModel("radius", "local-model");
    if (!model) throw new Error("Gateway model missing");
    const result = await service.streamFn(model, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] }).result();
    expect(result.stopReason).toBe("error");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.options).toMatchObject({ maxTokens: 512, temperature: 0.4, reasoning: "high" });
    expect(requests[0]?.reasoning_effort).toBeUndefined();
  } finally { server.stop(true); }
});
