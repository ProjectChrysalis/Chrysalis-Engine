import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { supportsOpenRouterRouting, validateOpenRouterRouting, type OpenRouterRouting } from "../src/providers/openrouter-routing.js";
import { createConnection, readAuth, readConnections, updateConnection, validateConnectionInput } from "../src/connections.js";
import { UserModelService } from "../src/models.js";
import { bootstrapUserDir } from "../src/paths.js";
import { defaultInstanceConfig } from "../src/config.js";
import { routingBody, routingDraft, isOpenRouterConnection } from "../client/src/openrouter-routing-state.js";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";

let dataDir: string;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrouter-routing-")); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

const routing: OpenRouterRouting = { order: ["google-vertex", "deepinfra"], only: ["google-vertex"], ignore: ["other-provider"], allow_fallbacks: false, require_parameters: true, data_collection: "deny", zdr: true, sort: "latency", quantizations: ["bf16"], max_price: { prompt: 2, completion: 10 } };

it("normalizes routing and rejects contradictory or malformed restrictions", () => {
  expect(validateOpenRouterRouting({ ...routing, order: [" google-vertex ", "google-vertex"] })).toEqual({ ok: true, value: { ...routing, order: ["google-vertex"] } });
  expect(validateOpenRouterRouting({})).toEqual({ ok: true, value: null });
  expect(validateOpenRouterRouting(null)).toEqual({ ok: true, value: null });
  for (const value of [[], { only: "google" }, { only: [" "] }, { only: ["a"], ignore: ["a"] }, { zdr: "true" }, { data_collection: "maybe" }, { sort: "cheap" }, { max_price: { prompt: -1 } }, { max_price: { completion: Infinity } }, { max_price: { unknown: 1 } }, { unknown: true }]) {
    expect(validateOpenRouterRouting(value).ok).toBe(false);
  }
});

it("keeps default fields unset, preserves false and zero, and resets without changing credentials", () => {
  expect(routingBody(routingDraft())).toBeNull();
  expect(routingBody(routingDraft(routing))).toEqual(routing);
  expect(routingBody({ ...routingDraft(), allow_fallbacks: "false", inputPrice: "0" })).toEqual({ allow_fallbacks: false, max_price: { prompt: 0 } });
  expect(() => routingBody({ ...routingDraft(), inputPrice: "bad" })).toThrow();
  const paths = bootstrapUserDir(dataDir, "alice");
  const parsed = validateConnectionInput({ name: "OpenRouter", providerId: "openrouter", key: "test-key", openRouterRouting: routing });
  if (!parsed.ok) throw new Error(parsed.error);
  const connection = createConnection(paths, parsed.value);
  expect(readConnections(paths).connections[connection.id]?.openRouterRouting).toEqual(routing);
  updateConnection(paths, connection.id, { openRouterRouting: null });
  expect(readConnections(paths).connections[connection.id]?.openRouterRouting).toBeUndefined();
  expect(readAuth(paths).openrouter?.key).toBe("test-key");
});

it("shows routing only on supported connections and rejects it on other providers", () => {
  for (const connection of [{ providerId: "openrouter" }, { proxyOf: "openrouter", baseUrl: "https://my-proxy.example" }, { baseUrl: "https://us.openrouter.ai/api/v1" }, { baseUrl: "https://openrouter.ai/api/v1" }]) {
    expect(supportsOpenRouterRouting(connection)).toBe(true);
    expect(isOpenRouterConnection(connection)).toBe(true);
  }
  for (const connection of [{ providerId: "google" }, { baseUrl: "https://openrouter.ai.evil.example/api/v1" }, { baseUrl: "https://fakeopenrouter.ai/api/v1" }, { baseUrl: "https://openrouter.ai/api/v1", api: "openai-text" }]) {
    expect(supportsOpenRouterRouting(connection)).toBe(false);
    expect(isOpenRouterConnection(connection)).toBe(false);
  }
  expect(validateConnectionInput({ name: "Google", providerId: "google", openRouterRouting: routing }).ok).toBe(false);
});

it("validates create, edit and reset through the settings API without touching live accounts", async () => {
  const users = new UserService(dataDir);
  users.create("admin", "admin", { password: "admin-pass-1" });
  const token = users.create("alice", "user", { password: "test-pass-1" }).token;
  const paths = bootstrapUserDir(dataDir, "alice");
  const app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
  const send = (method: string, route: string, body: unknown) => app.request(route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const created = await send("POST", "/v1/settings/connections", { name: "OpenRouter", providerId: "openrouter", key: "test-key", openRouterRouting: routing });
  expect(created.status).toBe(201);
  const { connection } = await created.json() as { connection: { id: string } };
  const route = `/v1/settings/connections/${connection.id}`;
  expect((await send("PATCH", route, { openRouterRouting: { only: ["google-vertex"], ignore: ["google-vertex"] } })).status).toBe(400);
  expect(readConnections(paths).connections[connection.id]?.openRouterRouting).toEqual(routing);
  expect((await send("PATCH", route, { openRouterRouting: { zdr: true } })).status).toBe(200);
  expect(readConnections(paths).connections[connection.id]?.openRouterRouting).toEqual({ zdr: true });
  expect((await send("PATCH", route, { openRouterRouting: null })).status).toBe(200);
  expect(readConnections(paths).connections[connection.id]?.openRouterRouting).toBeUndefined();
});

describe("routing reaches the provider", () => {
  it.each([
    ["openai-completions", "simple"], ["anthropic-messages", "simple"],
    ["openai-completions", "raw"], ["anthropic-messages", "raw"],
  ] as const)("enforces saved restrictions on native %s %s requests and preserves request options", async (api, method) => {
    const paths = bootstrapUserDir(dataDir, "alice");
    createConnection(paths, { name: "OpenRouter", providerId: "openrouter", key: "test-key", openRouterRouting: routing });
    const service = new UserModelService("alice", paths, defaultInstanceConfig());
    const provider = service.models.getProvider("openrouter")!;
    const model = provider.getModels().find((model) => model.api === api)!;
    expect(model).toBeDefined();
    const original = globalThis.fetch;
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      requests.push(await request.json() as Record<string, unknown>);
      return new Response(JSON.stringify({ error: { message: "test upstream failure", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
    }, { preconnect: original.preconnect });
    try {
      const context = { messages: [{ role: "user" as const, content: "Hello", timestamp: Date.now() }] };
      const options = { maxTokens: 123, onPayload: (payload: unknown) => ({ ...payload as object, provider: { only: ["unwanted"], zdr: false, allow_fallbacks: true }, custom_field: "preserved" }) };
      const stream = method === "simple" ? service.streamFn(model, context, options) : service.models.stream(model, context, options);
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.provider).toEqual(routing);
      expect(requests[0]?.custom_field).toBe("preserved");
      expect(requests[0]?.model).toBe(model.id);
    } finally { globalThis.fetch = original; }
  });
});

it("applies saved restrictions to native image generation", async () => {
  const paths = bootstrapUserDir(dataDir, "alice");
  createConnection(paths, { name: "OpenRouter", providerId: "openrouter", key: "test-key", openRouterRouting: { only: ["google-vertex"], zdr: true } });
  const service = new UserModelService("alice", paths, defaultInstanceConfig());
  const model = service.models.getProvider("openrouter")?.getAllModels?.().find((model) => model.type === "image");
  if (!model || model.type !== "image") throw new Error("OpenRouter image model is missing");
  const original = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    requests.push(await request.json() as Record<string, unknown>);
    return new Response(JSON.stringify({ error: { message: "test upstream failure" } }), { status: 400, headers: { "content-type": "application/json" } });
  }, { preconnect: original.preconnect });
  try {
    const result = await service.models.generateImages(model, { input: [{ type: "text", text: "Draw a tree" }] });
    expect(result.stopReason).toBe("error");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.provider).toEqual({ only: ["google-vertex"], zdr: true });
  } finally { globalThis.fetch = original; }
});
