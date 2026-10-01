import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/server/app.js";
import { defaultInstanceConfig } from "../src/config.js";
import { createConnection } from "../src/connections.js";
import { bootstrapUserDir } from "../src/paths.js";
import { UserService } from "../src/users.js";
import { SessionService } from "../src/sessions.js";
import { EventBus } from "../src/server/ws.js";
import { invalidatePluginCache } from "../src/plugins/runtime.js";

let dataDir: string;
let endpoint: ReturnType<typeof Bun.serve>;
let modelsSent: string[];
let summariesStarted: number;
let releaseSummary: (() => void) | undefined;
let holdSummary = false;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-http-"));
  modelsSent = [];
  summariesStarted = 0;
  holdSummary = false;
  releaseSummary = undefined;
  endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const body = await req.json() as { model: string; messages: { content: unknown }[] };
      modelsSent.push(body.model);
      if (JSON.stringify(body.messages).includes("Summarize the conversation below")) {
        summariesStarted++;
        if (holdSummary) await new Promise<void>(resolve => { releaseSummary = resolve; });
      }
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "saved summary" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
});
afterEach(() => {
  releaseSummary?.();
  endpoint.stop(true);
  invalidatePluginCache();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  const users = new UserService(dataDir);
  users.create("admin", "admin", { password: "admin-pass-1" });
  const token = users.create("alice", "user", { password: "test-pass-1" }).token;
  const p = bootstrapUserDir(dataDir, "alice");
  const connection = createConnection(p, { name: "Local compaction test", api: "openai-completions", baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, key: "test-only-key", models: [{ id: "first", contextWindow: 32768, maxTokens: 4096 }, { id: "second", contextWindow: 32768, maxTokens: 4096 }] });
  const freshApp = () => buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = (app: ReturnType<typeof freshApp>, route: string, body: unknown, method = "POST") => app.request(route, { method, headers, body: JSON.stringify(body) });
  return { p, provider: connection.effectiveProviderId, freshApp, post };
}

it("compaction after service restart keeps the recorded model and refuses an unavailable one", async () => {
  const { p, provider, freshApp, post } = setup();
  let app = freshApp();
  expect((await post(app, "/v1/agent", { sessionId: "saved", model: `${provider}/first`, message: "Remember this session" })).status).toBe(200);
  const file = path.join(p.root, "agent/sessions/saved.jsonl");
  const records = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as { type: string; model?: string });
  expect(records.find(r => r.type === "run")?.model).toBe(`${provider}/first`);
  expect((await post(app, "/v1/settings", { model: `${provider}/second`, autoCompact: false }, "PUT")).status).toBe(200);
  app = freshApp();
  expect((await post(app, "/v1/agent/sessions/saved/compact", {})).status).toBe(200);
  expect(modelsSent.at(-1)).toBe("first");
  fs.writeFileSync(path.join(p.root, "agent/sessions/missing.jsonl"), JSON.stringify({ type: "run", model: "missing/model", at: 1, user: "do not switch connections", assistant: "saved", tools: [] }) + "\n");
  const before = modelsSent.length;
  expect((await post(app, "/v1/agent/sessions/missing/compact", {})).status).toBe(503);
  expect(modelsSent.length).toBe(before);
  expect((await post(app, "/v1/agent/sessions/missing/compact", { model: `${provider}/second` })).status).toBe(200);
  expect(modelsSent.at(-1)).toBe("second");
}, 30_000);

it("a second compaction cannot overwrite a session while its first summary is pending", async () => {
  const { p, provider, freshApp, post } = setup();
  const app = freshApp();
  expect((await post(app, "/v1/agent", { sessionId: "parallel", model: `${provider}/first`, message: "Keep this original run" })).status).toBe(200);
  holdSummary = true;
  const pending = post(app, "/v1/agent/sessions/parallel/compact", {});
  for (let i = 0; i < 100 && !summariesStarted; i++) await Bun.sleep(10);
  expect(summariesStarted).toBe(1);
  const second = await post(app, "/v1/agent/sessions/parallel/compact", {});
  releaseSummary?.();
  expect((await pending).status).toBe(200);
  expect(second.status).toBe(409);
  expect(summariesStarted).toBe(1);
  const saved = fs.readFileSync(path.join(p.root, "agent/sessions/parallel.jsonl"), "utf8");
  expect(saved).toContain("Keep this original run");
  expect(saved.split("\n").filter(line => line.includes('"type":"compact"'))).toHaveLength(1);
}, 30_000);
