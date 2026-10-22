import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultInstanceConfig } from "../src/config.js";
import { createConnection } from "../src/connections.js";
import { UserModelService } from "../src/models.js";
import { bootstrapUserDir } from "../src/paths.js";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import { validAgentModelOverrides } from "../src/agent/model-settings.js";
import { readAgentGeneration, readAgentModels } from "../src/agent/generation.js";

let dataDir: string;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-model-settings-")); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

it("rejects malformed model profiles while preserving explicit zero and false", () => {
  expect(validAgentModelOverrides({ generation: { temperature: 0, topP: 0, reasoning: "off" }, autoCompact: false })).toBe(true);
  for (const value of [null, [], { generation: null }, { generation: { temperature: 4 } }, { contextWindow: 0 }, { contextWindow: 1.5 }, { autoCompact: null }, { autoCompact: 999 }, { unknown: true }]) {
    expect(validAgentModelOverrides(value)).toBe(false);
  }
});

it("inherits defaults, isolates per-model budgets from apps, and keeps the latest dialogue when switching back", async () => {
  const requests: Record<string, unknown>[] = [];
  let inputTokens = 200;
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"Acknowledged."},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":1,"total_tokens":201}}\n\ndata: [DONE]\n\n'.replace('"prompt_tokens":200', `"prompt_tokens":${inputTokens}`), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const users = new UserService(dataDir);
    const token = users.create("alice", "user", { password: "test-pass-1" }).token;
    const paths = bootstrapUserDir(dataDir, "alice");
    const connection = createConnection(paths, { name: "Local", api: "openai-completions", baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, key: "test-only-key", models: [{ id: "a", contextWindow: 64000, maxTokens: 4096 }, { id: "b", contextWindow: 32000, maxTokens: 4096 }] });
    const a = `${connection.id}/a`, b = `${connection.id}/b`;
    const app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const put = (body: unknown) => app.request("/v1/settings", { method: "PUT", headers, body: JSON.stringify(body) });
    const run = async (model: string, message: string) => {
      const response = await app.request("/v1/agent", { method: "POST", headers, body: JSON.stringify({ sessionId: "switching", model, message }) });
      const body = await response.json() as { contextWindow: number; autoCompacted?: boolean; error?: string };
      expect(response.status, body.error).toBe(200);
      return body;
    };
    expect((await put({ agentGeneration: { temperature: 0.7, topP: 0.8, maxTokens: 256 }, reasoning: "high", autoCompact: false })).status).toBe(200);
    expect((await put({ agentModel: { ref: a, settings: { generation: { temperature: 0, reasoning: "off" }, contextWindow: 24000 } } })).status).toBe(200);
    expect((await put({ agentModel: { ref: b, settings: { generation: { temperature: 1.4, maxTokens: 512 }, autoCompact: true } } })).status).toBe(200);
    expect(readAgentGeneration(paths, a)).toEqual({ temperature: 0, topP: 0.8, maxTokens: 256 });
    expect((await run(a, "Remember the first note.")).contextWindow).toBe(24000);
    expect(requests.at(-1)).toMatchObject({ model: "a", temperature: 0, top_p: 0.8, reasoning_effort: "none" });
    expect((await run(b, "Remember the second note.")).contextWindow).toBe(32000);
    expect(requests.at(-1)).toMatchObject({ model: "b", temperature: 1.4, reasoning_effort: "high" });
    expect(requests.at(-1)?.max_tokens ?? requests.at(-1)?.max_completion_tokens).toBe(512);
    await run(a, "What were the notes?");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Remember the second note.");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Remember the first note.");
    const service = new UserModelService("alice", paths, defaultInstanceConfig());
    expect((await service.available()).find((model) => model.modelId === "a")?.contextWindow).toBe(64000);
    const appTurn = await service.turn({ model: a, temperature: 1.8, maxTokens: 333, build: (model) => {
      expect(model.contextWindow).toBe(64000);
      return { context: { messages: [{ role: "user", content: "App request", timestamp: Date.now() }] } };
    } });
    await appTurn?.stream.result();
    expect(requests.at(-1)).toMatchObject({ temperature: 1.8 });
    expect(requests.at(-1)?.top_p).toBeUndefined();
    expect((await put({ agentModel: { ref: a, settings: { autoCompact: 900 } } })).status).toBe(400);
    expect(readAgentModels(paths)[a]?.contextWindow).toBe(24000);
    expect((await put({ agentModel: { ref: a, settings: null } })).status).toBe(200);
    expect(readAgentModels(paths)[a]).toBeUndefined();
    expect(readAgentModels(paths)[b]?.generation?.temperature).toBe(1.4);
    expect((await run(a, "After reset.")).contextWindow).toBe(64000);
    expect(requests.at(-1)).toMatchObject({ temperature: 0.7, top_p: 0.8, reasoning_effort: "high" });
    inputTokens = 1500;
    expect((await put({ autoCompact: 1000, agentModel: { ref: a, settings: { autoCompact: false } } })).status).toBe(200);
    expect((await run(a, "Keep the full conversation.")).autoCompacted).toBeUndefined();
    expect((await put({ autoCompact: false, agentModel: { ref: a, settings: { autoCompact: 1000 } } })).status).toBe(200);
    expect((await run(a, "Summarize when this model reaches its threshold.")).autoCompacted).toBe(true);

  } finally { endpoint.stop(true); }
});
