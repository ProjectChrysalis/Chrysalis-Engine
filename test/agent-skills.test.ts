import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { discoverSkills, readAppContext, writeAppContext, skillContext } from "../src/agent/skills.js";
import { UserAgent, instructionDocsStamp } from "../src/agent/agent.js";
import { bootstrapUserDir } from "../src/paths.js";
import { UserService } from "../src/users.js";
import { UserModelService } from "../src/models.js";
import { defaultInstanceConfig } from "../src/config.js";
import { buildApp } from "../src/server/app.js";
import { SessionService } from "../src/sessions.js";
import { EventBus } from "../src/server/ws.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function app(p: ReturnType<typeof bootstrapUserDir>, id: string, instructions: string) {
  const dir = path.join(p.apps, id, ".agents/skills/preset-editing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(p.apps, id, "manifest.json"), JSON.stringify({ name: id, kind: "web", version: "1.0.0" }));
  fs.writeFileSync(path.join(p.apps, id, "AGENTS.md"), `${id} contract`);
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: preset-editing\ndescription: Inspect and edit presets\n---\n${instructions}`);
  return dir;
}

it("keeps conversation targets independent of tab activation and refreshes changed skill bodies", () => {
  const p = bootstrapUserDir(root, "alice");
  app(p, "first", "FIRST BODY");
  const dir = app(p, "second", "SECOND BODY");
  writeAppContext(p, "one", { appId: "first", loaded: [] });
  writeAppContext(p, "two", { appId: "second", loaded: ["preset-editing"] });
  fs.writeFileSync(p.settings, JSON.stringify({ activeApp: "second" }));
  expect(skillContext(p, readAppContext(p, "one"))).not.toContain("SECOND BODY");
  expect(skillContext(p, readAppContext(p, "one"))).not.toContain("FIRST BODY");
  expect(skillContext(p, readAppContext(p, "two"))).toContain("SECOND BODY");
  const stamp = instructionDocsStamp(p, "two");
  fs.appendFileSync(path.join(dir, "SKILL.md"), "\nUPDATED");
  expect(instructionDocsStamp(p, "two")).not.toBe(stamp);
  expect(readAppContext(p, "legacy")).toEqual({ appId: null, loaded: [] });
});

it("rejects escaping paths, malformed and oversized files without losing valid skills", () => {
  const p = bootstrapUserDir(root, "alice");
  const dir = app(p, "first", "VALID");
  const skillsRoot = path.dirname(dir);
  for (const [name, text] of [["bad", "missing metadata"], ["large", "x".repeat(32769)]]) {
    fs.mkdirSync(path.join(skillsRoot, name!)); fs.writeFileSync(path.join(skillsRoot, name!, "SKILL.md"), text!);
  }
  fs.mkdirSync(path.join(skillsRoot, "escape"));
  fs.writeFileSync(path.join(root, "outside.md"), "secret");
  fs.symlinkSync(path.join(root, "outside.md"), path.join(skillsRoot, "escape/SKILL.md"));
  const result = discoverSkills(p, "first");
  expect(result.skills.map((skill) => skill.name)).toEqual(["preset-editing"]);
  expect(result.errors.length).toBe(3);
  expect(result.errors.join(" ")).toContain("escapes");
  expect(() => writeAppContext(p, "../bad", { appId: null, loaded: [] })).toThrow();
  expect(() => writeAppContext(p, "one", { appId: "missing", loaded: [] })).toThrow();
});

it("agent selects an app, loads its skill, and keeps current instructions after resume and compaction", async () => {
  const users = new UserService(root);
  users.create("alice", "admin", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice");
  app(p, "first", "FIRST BODY"); app(p, "second", "SECOND BODY");
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "skills-model" }] });
  svc.models.setProvider(faux.provider);
  const prompts: string[] = [];
  faux.setResponses([
    (context) => { prompts.push(JSON.stringify(context)); return fauxAssistantMessage([{ type: "toolCall", id: "t1", name: "app_target", arguments: { appId: "first" } }], { stopReason: "toolUse" }); },
    (context) => { prompts.push(JSON.stringify(context)); return fauxAssistantMessage([{ type: "toolCall", id: "t2", name: "skill_load", arguments: { name: "preset-editing" } }], { stopReason: "toolUse" }); },
    (context) => { prompts.push(JSON.stringify(context)); return fauxAssistantMessage("Read only."); },
  ]);
  const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "one", mode: "plan" });
  const result = await agent.run("Read the section in first app");
  expect(result.toolTrace.map((tool) => tool.name)).toEqual(["app_target", "skill_load"]);
  expect(prompts[0]).not.toContain("FIRST BODY");
  expect(prompts[1]).toContain("first contract");
  expect(prompts[1]).not.toContain("FIRST BODY");
  expect(prompts[2]).toContain("FIRST BODY");
  expect(prompts.join(" ")).not.toContain("SECOND BODY");
  expect(readAppContext(p, "one")).toEqual({ appId: "first", loaded: ["preset-editing"] });
  fs.appendFileSync(path.join(p.root, "agent/sessions/one.jsonl"), JSON.stringify({ type: "compact", at: Date.now(), summary: "Read the selected preset." }) + "\n");
  faux.setResponses([(context) => { expect(JSON.stringify(context)).toContain("FIRST BODY"); return fauxAssistantMessage("Still available."); }]);
  const resumed = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "one" });
  expect((await resumed.run("continue")).finalText).toBe("Still available.");
}, 20_000);

it("target APIs persist, fork, clear, and delete context without activating an app globally", async () => {
  const users = new UserService(root);
  const token = users.create("alice", "admin", { password: "test-password-1" }).token;
  const p = bootstrapUserDir(root, "alice"); app(p, "first", "BODY");
  const server = buildApp({ users, sessions: new SessionService(root), config: defaultInstanceConfig(), dataDir: root, bus: new EventBus() });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const request = (url: string, body: unknown) => server.request(url, { method: "POST", headers, body: JSON.stringify(body) });
  expect((await request("/v1/agent/sessions/one/target", { appId: "first" })).status).toBe(200);
  fs.writeFileSync(path.join(p.root, "agent/sessions/one.jsonl"), JSON.stringify({ type: "run", at: 1, user: "test", assistant: "ok", tools: [] }) + "\n");
  const fork = await (await request("/v1/agent/sessions/one/fork", {})).json() as { sessionId: string };
  expect(readAppContext(p, fork.sessionId).appId).toBe("first");
  expect((await request("/v1/agent/sessions/one/target", { appId: null })).status).toBe(200);
  expect(readAppContext(p, "one").appId).toBeNull();
  expect((await request("/v1/agent/sessions/one/target", { appId: "missing" })).status).toBe(400);
  await server.request(`/v1/agent/sessions/${fork.sessionId}`, { method: "DELETE", headers });
  expect(readAppContext(p, fork.sessionId)).toEqual({ appId: null, loaded: [] });
});
