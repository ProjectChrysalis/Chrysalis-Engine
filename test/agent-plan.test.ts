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
let requests: { planning: boolean; tools: string[]; text: string }[];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-http-"));
  requests = [];
  endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const body = await req.json() as { model: string; messages: unknown[]; tools?: { function: { name: string } }[] };
      const text = JSON.stringify(body.messages);
      const planning = text.includes("[PLAN MODE ACTIVE]");
      requests.push({ planning, tools: (body.tools ?? []).map(tool => tool.function.name), text });
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      // the plan is presented once; after an answer the model writes a reply
      const presented = text.includes("Accept the first step only") || text.includes("The user accepted the plan");
      const stream = planning && !presented
        ? chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_plan", type: "function", function: { name: "present_plan", arguments: JSON.stringify({ plan: "# Plan\n1. Write the note" }) } }] }, null) + chunk({}, "tool_calls")
        : chunk({ role: "assistant", content: planning ? "Revised." : "Carried out." }, null) + chunk({}, "stop");
      return new Response(stream + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
});
afterEach(() => {
  endpoint.stop(true);
  invalidatePluginCache();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  const users = new UserService(dataDir);
  const token = users.create("alice", "admin", { password: "test-pass-1" }).token;
  const p = bootstrapUserDir(dataDir, "alice");
  const connection = createConnection(p, { name: "Local plan test", api: "openai-completions", baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, key: "test-only-key", models: [{ id: "first", contextWindow: 32768, maxTokens: 4096 }] });
  const bus = new EventBus();
  const events: { type: string; payload: unknown }[] = [];
  const emit = bus.emit.bind(bus);
  bus.emit = (username, type, payload) => { events.push({ type, payload }); emit(username, type, payload); };
  const app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = (route: string, body: unknown) => app.request(route, { method: "POST", headers, body: JSON.stringify(body) });
  const answer = async (sessionId: string, text: string) => {
    for (let n = 0; n < 200; n++) {
      const state = await (await app.request(`/v1/agent/state?sessionId=${sessionId}`, { headers })).json() as { ask: { id: string; question: string; options?: string[] } | null };
      if (state.ask) {
        expect(state.ask.question).toBe("Accept this plan?");
        expect(state.ask.options).toEqual(["Accept plan", "Keep planning"]);
        expect((await post("/v1/agent/answer", { sessionId, id: state.ask.id, answer: text })).status).toBe(200);
        return;
      }
      await Bun.sleep(10);
    }
    throw new Error("the plan was never presented");
  };
  return { p, model: `${connection.effectiveProviderId}/first`, post, answer, events };
}

it("an accepted plan is carried out in the working mode within the same request", async () => {
  const { p, model, post, answer, events } = setup();
  const pending = post("/v1/agent", { sessionId: "plan", model, mode: "plan", planExit: "accept", message: "Plan a note" });
  await answer("plan", "Accept plan");
  const res = await pending;
  expect(res.status).toBe(200);
  const body = await res.json() as { finalText: string; planAccepted?: boolean };
  expect(body.finalText).toBe("Carried out.");
  expect(body.planAccepted).toBe(true);
  expect(requests.map(request => request.planning)).toEqual([true, false]);
  expect(requests[0]!.tools).toContain("present_plan");
  expect(requests[0]!.tools).not.toContain("write_file");
  expect(requests[1]!.tools).toContain("write_file");
  expect(requests[1]!.tools).not.toContain("present_plan");
  expect(requests[1]!.text).toContain("Write the note");
  expect(events.find(event => event.type === "agent_mode")?.payload).toEqual({ sessionId: "plan", mode: "accept" });
  const runs = fs.readFileSync(path.join(p.root, "agent/sessions/plan.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(record => record.type === "run");
  expect(runs.map(run => run.user)).toEqual(["Plan a note", "The plan is accepted. Carry it out."]);
  expect(events.filter(event => event.type === "agent_settled").length).toBe(1);
}, 20_000);

it("a plan that is not accepted stays in plan mode with the user's answer", async () => {
  const { model, post, answer, events } = setup();
  const pending = post("/v1/agent", { sessionId: "revise", model, mode: "plan", message: "Plan a note" });
  await answer("revise", "Accept the first step only");
  const body = await (await pending).json() as { finalText: string; planAccepted?: boolean };
  expect(body.finalText).toBe("Revised.");
  expect(body.planAccepted).toBeUndefined();
  expect(requests.map(request => request.planning)).toEqual([true, true]);
  expect(requests[1]!.text).toContain("Accept the first step only");
  expect(events.some(event => event.type === "agent_mode")).toBe(false);
}, 20_000);
