import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { bootstrapUserDir } from "../src/paths.js";
import { UserService } from "../src/users.js";
import { UserModelService } from "../src/models.js";
import { defaultInstanceConfig } from "../src/config.js";
import { buildUserTools } from "../src/agent/tools.js";
import { buildSkillTools } from "../src/agent/skill-tools.js";
import { AgentPolicy } from "../src/agent/policy.js";
import { revisionOf, recordChange, undoChange } from "../src/agent/changes.js";
import { RunJournal, recoverRun } from "../src/agent/journal.js";
import { outputTool, spillOutput } from "../src/agent/artifacts.js";
import { UserAgent, buildMcpTools } from "../src/agent/agent.js";
import type { McpRegistry } from "../src/mcp/registry.js";
import { inspectionTool } from "../src/agent/inspection.js";
import { createConnection } from "../src/connections.js";
import { buildApp } from "../src/server/app.js";
import { SessionService } from "../src/sessions.js";
import { EventBus } from "../src/server/ws.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const text = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;

function fixture() {
  const p = bootstrapUserDir(root, "alice");
  const app = path.join(p.apps, "studio");
  const skill = path.join(app, ".agents/skills/preset-editing");
  fs.mkdirSync(path.join(app, "data/presets"), { recursive: true });
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(app, "manifest.json"), '{"name":"Studio","kind":"web","version":"1.0.0"}');
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: preset-editing\ndescription: Inspect and edit presets\n---\nInspect before editing.");
  for (const name of ["inspect.js", "edit.js"]) fs.copyFileSync(path.resolve("../chrysalis-roleplay/.agents/skills/preset-editing", name), path.join(skill, name));
  const file = path.join(app, "data/presets/example.json");
  const record = { id: "example", name: "Example", opaque: { future: [1, 2] }, prompts: [{ identifier: "main", name: "Main", role: "system", content: "before" }], prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }], studio: { sections: [{ id: "main", name: "Main", role: "system", content: "before", enabled: true }] } };
  fs.writeFileSync(file, JSON.stringify(record));
  return { p, skill, file, record };
}

it("runs actual app helpers in Plan, preserves paired fields, and safely undoes only its own edit", async () => {
  const { p, file, record } = fixture();
  const context = { appId: "studio", loaded: ["preset-editing"] };
  const approvals: string[] = [];
  const tools = buildSkillTools(p, "alice", context, false, async (_tool, args) => { approvals.push(String(args.path)); });
  const inspect = tools.find(tool => tool.name === "skill_inspect")!;
  const edit = tools.find(tool => tool.name === "skill_edit")!;
  expect(buildSkillTools(p, "alice", context, true, async () => {}).map(tool => tool.name)).toEqual(["skill_inspect"]);
  const result = JSON.parse(text(await inspect.execute("read", { name: "preset-editing", args: { preset: "example", section: "main" } })));
  const revision = result.matches[0].revision;
  expect(revision).toBe(revisionOf(JSON.stringify(record)));
  const saved = JSON.parse(text(await edit.execute("edit", { name: "preset-editing", args: { preset: "example", section: "main", revision, patch: { content: "after" } } })));
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(after.prompts[0].content).toBe("after");
  expect(after.studio.sections[0].content).toBe("after");
  expect(after.opaque).toEqual(record.opaque);
  expect(approvals).toEqual(["apps/studio/data/presets/example.json"]);
  await undoChange(p.root, saved.changeId);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(record);
  await expect(edit.execute("stale", { name: "preset-editing", args: { preset: "example", section: "main", revision: "old", patch: { content: "bad" } } })).rejects.toThrow("revision");
}, 20_000);

it("skill helpers cannot write directly, escape data, or skip shared approvals", async () => {
  const { p, file, skill } = fixture();
  const context = { appId: "studio", loaded: ["preset-editing"] };
  const tools = buildSkillTools(p, "alice", context, false, async () => { throw new Error("declined"); });
  const inspect = tools[0]!;
  const edit = tools[1]!;
  const before = fs.readFileSync(file, "utf8");
  await expect(edit.execute("decline", { name: "preset-editing", args: { preset: "example", section: "main", revision: revisionOf(before), patch: { content: "bad" } } })).rejects.toThrow("declined");
  fs.writeFileSync(path.join(skill, "inspect.js"), 'export function inspect(args, host) { host.fs.write("presets/example.json", "bad"); }');
  await expect(inspect.execute("direct", { name: "preset-editing", args: {} })).rejects.toThrow();
  fs.writeFileSync(path.join(skill, "inspect.js"), 'export function inspect(args, host) { return host.fs.read("../../../../persona.md"); }');
  await expect(inspect.execute("escape", { name: "preset-editing", args: {} })).rejects.toThrow();
  fs.writeFileSync(path.join(skill, "edit.js"), 'export function edit() { return {writes:[{path:"../../persona.json",expectedRevision:null,content:"{}"}]}; }');
  await expect(edit.execute("escape", { name: "preset-editing", args: {} })).rejects.toThrow("path");
  expect(fs.readFileSync(file, "utf8")).toBe(before);
}, 20_000);

it("validates every planned revision before changing any file", async () => {
  const { p, file, skill } = fixture();
  const before = fs.readFileSync(file, "utf8");
  fs.writeFileSync(path.join(skill, "edit.js"), `export function edit() { return {writes:[{path:"presets/new.json",expectedRevision:null,content:"{}"},{path:"presets/example.json",expectedRevision:"stale",content:"{}"}]}; }`);
  const edit = buildSkillTools(p, "alice", { appId: "studio", loaded: ["preset-editing"] }, false, async () => {})[1]!;
  await expect(edit.execute("stale", { name: "preset-editing", args: {} })).rejects.toThrow("Stale");
  expect(fs.existsSync(path.join(path.dirname(file), "new.json"))).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe(before);
}, 20_000);

it("refuses stale file replacement and all-or-nothing undo over newer user changes", async () => {
  const p = bootstrapUserDir(root, "alice");
  const file = path.join(p.root, "notes/test.txt"); fs.writeFileSync(file, "first");
  const tools = buildUserTools("alice", p, { dataDir: p.root });
  await tools.find(tool => tool.name === "read_file")!.execute("read", { path: "notes/test.txt" });
  fs.writeFileSync(file, "user edit");
  await expect(tools.find(tool => tool.name === "write_file")!.execute("write", { path: "notes/test.txt", content: "stale edit" })).rejects.toThrow("changed");
  fs.writeFileSync(path.join(p.root, "notes/other.txt"), "after");
  const id = recordChange(p.root, [{ path: "notes/other.txt", before: "before", after: "after" }, { path: "notes/test.txt", before: "first", after: "agent edit" }]);
  await expect(undoChange(p.root, id)).rejects.toThrow("Nothing was undone");
  expect(fs.readFileSync(path.join(p.root, "notes/other.txt"), "utf8")).toBe("after");
  expect(fs.readFileSync(file, "utf8")).toBe("user edit");
});

it("Accept permissions apply to file, package and remote tools, with scoped persistent grants", async () => {
  const p = bootstrapUserDir(root, "alice");
  let prompts = 0;
  const ask = async () => { prompts++; return "Allow for this chat"; };
  const policy = new AgentPolicy(p.root, "one", "accept", () => "studio", ask);
  await policy.check("read_file", { path: "notes/test" });
  await policy.check("write_file", { path: "apps/studio/src/a.ts" });
  await policy.check("write_file", { path: "apps/studio/src/a.ts" });
  const resumed = new AgentPolicy(p.root, "one", "accept", () => "studio", ask);
  await resumed.check("write_file", { path: "apps/studio/src/a.ts" });
  expect(prompts).toBe(1);
  await resumed.check("write_file", { path: "apps/studio/src/b.ts" });
  await resumed.check("app_deps", { id: "studio" });
  await resumed.check("mcp_server_write", { item: "one" });
  expect(prompts).toBe(4);
  await expect(new AgentPolicy(p.root, "two", "accept", () => null).check("write_file", { path: "notes/new" })).rejects.toThrow("unavailable");
  const plan = new AgentPolicy(p.root, "three", "plan", () => null, ask);
  await plan.check("grep", {});
  await expect(plan.check("skill_edit", {})).rejects.toThrow("Plan");
  await expect(plan.check("mcp_unknown", {})).rejects.toThrow("Plan");
});

it("Plan exposes only remote tools explicitly declaring read-only behavior and preserves remote errors", async () => {
  const registry = { listTools: () => [{ name: "mcp_one_read", serverId: "one", toolName: "read", description: "read", inputSchema: { type: "object" }, readOnly: true }, { name: "mcp_one_write", serverId: "one", toolName: "write", inputSchema: { type: "object" } }], callTool: async () => ({ ok: false, content: [{ type: "text", text: "failed" }] }) } as unknown as McpRegistry;
  const tools = await buildMcpTools(registry, true);
  expect(tools.map(tool => tool.name)).toEqual(["mcp_one_read"]);
  expect((await tools[0]!.execute("t", {} ) as { isError: boolean }).isError).toBe(true);
});

it("recovers completed native output and warns about unresolved side effects without replaying them", () => {
  const p = bootstrapUserDir(root, "alice");
  const file = path.join(p.root, "agent/sessions/one.jsonl");
  const journal = new RunJournal(file, "change it", "faux/test");
  const assistant = fauxAssistantMessage([{ type: "thinking", thinking: "reason", thinkingSignature: "opaque-signature" }, { type: "toolCall", id: "one", name: "write_file", arguments: { path: "notes/a" } }, { type: "toolCall", id: "two", name: "read_file", arguments: { path: "notes/b" } }], { stopReason: "toolUse" });
  journal.message(assistant);
  journal.message({ role: "toolResult", toolCallId: "two", toolName: "read_file", content: [{ type: "text", text: "full result ".repeat(100) }], isError: false, timestamp: 1 });
  journal.event({ type: "queue_added", id: "queued", text: "next task" }); journal.flush();
  recoverRun(file); recoverRun(file);
  const records = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(records).toHaveLength(1);
  expect(records[0].interrupted).toBe(true);
  expect(records[0].assistant).toContain("next task");
  expect(records[0].native[1].content[0].thinkingSignature).toBe("opaque-signature");
  expect(records[0].native.find((message: { toolCallId?: string }) => message.toolCallId === "two").content[0].text.length).toBeGreaterThan(300);
  expect(records[0].native.find((message: { toolCallId?: string }) => message.toolCallId === "one").content[0].text).toContain("may have already happened");
  expect(fs.existsSync(file + ".active.json")).toBe(false);
});

it("keeps signatures and complete tool results across resume, and strips incompatible signatures on model change", async () => {
  const users = new UserService(root); users.create("alice", "admin", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice");
  fs.writeFileSync(path.join(p.root, "notes/long.txt"), "context-marker ".repeat(80));
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "first" }, { id: "second" }] }); svc.models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([{ type: "thinking", thinking: "reason", thinkingSignature: "opaque-signature" }, { type: "toolCall", id: "read", name: "read_file", arguments: { path: "notes/long.txt" } }], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  await (await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "one", model: "first" })).run("inspect");
  faux.setResponses([(context) => { expect(JSON.stringify(context)).toContain("opaque-signature"); expect(JSON.stringify(context)).toContain("context-marker ".repeat(80)); return fauxAssistantMessage("Resumed"); }]);
  await (await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "one", model: "first" })).run("continue");
  faux.setResponses([(context) => { expect(JSON.stringify(context)).not.toContain("opaque-signature"); return fauxAssistantMessage("Changed model"); }]);
  await (await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "one", model: "second" })).run("continue");
}, 20_000);

it("stores large tool output for bounded retrieval and keeps inspection images separate from text", async () => {
  const p = bootstrapUserDir(root, "alice");
  const original = "abc".repeat(20000);
  const preview = spillOutput(p.root, original);
  const id = preview.match(/Full output saved: ([a-f0-9-]+)/)![1]!;
  const result = JSON.parse(text(await outputTool(p.root).execute("read", { id, offset: 15000, limit: 16000 })));
  expect(result.text).toBe(original.slice(15000, 31000)); expect(result.nextOffset).toBe(31000);
  await expect(outputTool(p.root).execute("escape", { id: "../../persona" })).rejects.toThrow("Invalid");
  const inspection = await inspectionTool(() => "studio", async () => ({ text: "Hello", screenshot: { data: "abcd", mimeType: "image/png" } })).execute("inspect", {});
  expect(inspection.content.map(block => block.type)).toEqual(["text", "image"]);
  await expect(inspectionTool(() => null).execute("inspect", {})).rejects.toThrow("Open");
});

it("stops repeating an identical failing action after three attempts", async () => {
  const users = new UserService(root); users.create("alice", "admin", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice");
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "test" }] }); svc.models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 5 }, (_, index) => fauxAssistantMessage([{ type: "toolCall", id: `attempt${index}`, name: "read_file", arguments: { path: "notes/missing" } }], { stopReason: "toolUse" })));
  const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "failures" });
  const result = await agent.run("read it");
  expect(result.toolTrace).toHaveLength(4);
  expect(result.toolTrace[3]!.summary).toContain("failed three times");
  expect(result.finalText).toContain("failed three times");
}, 20_000);

it("follow-up messages wait until the current task settles and cancelled messages stay cancelled", async () => {
  const users = new UserService(root); users.create("alice", "admin", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice");
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "test" }] }); svc.models.setProvider(faux.provider);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  faux.setResponses([
    fauxAssistantMessage([{ type: "toolCall", id: "ask", name: "ask_user", arguments: { question: "Continue?" } }], { stopReason: "toolUse" }),
    (context) => { expect(JSON.stringify(context)).not.toContain("after-current-task"); return fauxAssistantMessage("Current task done"); },
    (context) => { expect(JSON.stringify(context)).toContain("after-current-task"); expect(JSON.stringify(context)).not.toContain("cancelled-followup"); return fauxAssistantMessage("Follow-up done"); },
  ]);
  const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "follow", ask: async () => { started(); await waiting; return "yes"; } });
  const run = agent.run("current task"); await entered;
  agent.steer("after-current-task", "after", "followUp");
  agent.steer("cancelled-followup", "cancel", "followUp");
  expect(agent.cancelQueued("cancel")).toBe(true);
  expect(agent.queuedMessages()).toEqual([{ id: "after", text: "after-current-task", mode: "followUp" }]);
  release();
  const result = await run;
  expect(result.finalText).toBe("Follow-up done");
  expect(result.turns.some(turn => turn.text === "Current task done")).toBe(true);
}, 20_000);

it("bounds model steps even when tool validation fails before execution hooks", async () => {
  const users = new UserService(root); users.create("alice", "admin", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice");
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "test" }] }); svc.models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 101 }, (_, index) => fauxAssistantMessage([{ type: "toolCall", id: `invalid${index}`, name: "read_file", arguments: {} }], { stopReason: "toolUse" })));
  const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "invalid" });
  const result = await agent.run("inspect");
  expect(result.toolTrace).toHaveLength(100);
  expect(result.error).toContain("Model step limit reached");
}, 20_000);

it("a cancelled approval waiter cannot let later prompts overlap an active question", async () => {
  const p = bootstrapUserDir(root, "alice");
  const resolvers: ((answer: string) => void)[] = [];
  const policy = new AgentPolicy(p.root, "serial", "accept", () => null, async () => new Promise<string>(resolve => { resolvers.push(resolve); }));
  const first = policy.check("write_file", { path: "notes/one" });
  await Promise.resolve(); await Promise.resolve();
  const controller = new AbortController();
  const second = policy.check("write_file", { path: "notes/two" }, controller.signal).catch(error => error);
  controller.abort(); await second;
  const third = policy.check("write_file", { path: "notes/three" });
  await Promise.resolve(); await Promise.resolve();
  expect(resolvers).toHaveLength(1);
  resolvers[0]!("Allow once"); await first;
  for (let i = 0; i < 10 && resolvers.length < 2; i++) await Promise.resolve();
  expect(resolvers).toHaveLength(2);
  resolvers[1]!("Allow once"); await third;
});

it("inspection responses stay owned by the requesting account and conversation", async () => {
  const users = new UserService(root);
  const token = users.create("alice", "admin", { password: "test-password-1" }).token;
  const other = users.create("bob", "user", { password: "test-password-2" }).token;
  const { p } = fixture();
  fs.writeFileSync(p.mcp, '{"servers":{}}');
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { messages: { role: string }[] };
    const inspected = body.messages.some(message => message.role === "tool");
    const delta = inspected ? { role: "assistant", content: "Inspected" } : { role: "assistant", tool_calls: [{ index: 0, id: "inspect", type: "function", function: { name: "app_inspect", arguments: "{}" } }] };
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, inspected ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const connection = createConnection(p, { name: "Inspection test", api: "openai-completions", baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, key: "test-only-key", models: [{ id: "test", contextWindow: 32768, maxTokens: 4096 }] });
    const bus = new EventBus();
    const app = buildApp({ users, sessions: new SessionService(root), config: defaultInstanceConfig(), dataDir: root, bus });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    let answered: Promise<void> | undefined;
    bus.emit = (username, type, payload) => {
      if (type !== "agent_inspect") return;
      const inspection = payload as { id: string; appId: string; sessionId: string };
      answered = (async () => {
        expect(username).toBe("alice"); expect(inspection.sessionId).toBe("inspect-session");
        const route = `/v1/agent/inspect/${inspection.id}`;
        const body = JSON.stringify({ appId: "studio", text: "visible app", controls: [] });
        expect((await app.request(route, { method: "POST", headers: { ...headers, authorization: `Bearer ${other}` }, body })).status).toBe(404);
        expect((await app.request(route, { method: "POST", headers: { ...headers, "x-chrysalis-app": "studio" }, body })).status).toBe(403);
        expect((await app.request(route, { method: "POST", headers, body: JSON.stringify({ appId: "other" }) })).status).toBe(400);
        expect((await app.request(route, { method: "POST", headers, body })).status).toBe(200);
      })();
    };
    const response = await app.request("/v1/agent", { method: "POST", headers, body: JSON.stringify({ sessionId: "inspect-session", appId: "studio", model: `${connection.effectiveProviderId}/test`, message: "Inspect the open app" }) });
    await answered;
    expect(response.status).toBe(200);
    const result = await response.json() as { finalText: string };
    expect(result.finalText).toBe("Inspected");
    const history = await (await app.request("/v1/agent/sessions/inspect-session", { headers })).json() as { runs: { native?: unknown }[] };
    expect(history.runs[0]!.native).toBeUndefined();
  } finally { endpoint.stop(true); }
}, 20_000);
