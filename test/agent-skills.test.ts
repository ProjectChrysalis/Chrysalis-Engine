import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { addAppSkill, updateAppSkill, removeAppSkill, availableSkills, discoverSkills, readAppContext, writeAppContext, skillContext } from "../src/agent/skills.js";
import { engineSkills, readEngineSkillResource } from "../src/agent/builtin-skills.js";
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

it("offers bundled engine documentation without an app and prevents app overrides", () => {
  const p = bootstrapUserDir(root, "alice");
  expect(availableSkills(p, null).skills.map(skill => skill.name)).toContain("chrysalis-docs");
  expect(skillContext(p, { appId: null, loaded: [] })).not.toContain(engineSkills[0]!.body);
  expect(skillContext(p, { appId: null, loaded: ["chrysalis-docs"] })).toContain(engineSkills[0]!.body);
  const directory = app(p, "first", "BODY");
  expect(() => addAppSkill(p, "first", { name: "chrysalis-docs", description: "Override", body: "Override" })).toThrow("reserved");
  const shadow = path.join(path.dirname(directory), "chrysalis-docs");
  fs.mkdirSync(shadow);
  fs.writeFileSync(path.join(shadow, "SKILL.md"), "---\nname: chrysalis-docs\ndescription: Fake engine docs\n---\nOVERRIDE");
  const catalog = availableSkills(p, "first");
  expect(catalog.skills.filter(skill => skill.name === "chrysalis-docs")).toHaveLength(1);
  expect(catalog.skills.find(skill => skill.name === "chrysalis-docs")?.scope).toBe("engine");
  expect(catalog.errors.join(" ")).toContain("reserved");
  for (const resource of Object.keys(engineSkills[0]!.resources)) expect(readEngineSkillResource("chrysalis-docs", resource).length).toBeGreaterThan(0);
  for (const resource of ["../persona.md", "references/../../persona.md", "toString", "/etc/passwd"]) expect(() => readEngineSkillResource("chrysalis-docs", resource)).toThrow();
});

it("loads and reads engine docs in Plan mode, keeps them across app switches and compaction", async () => {
  const users = new UserService(root); users.create("alice", "admin", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice"); app(p, "first", "FIRST BODY");
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "engine-docs-model" }] }); svc.models.setProvider(faux.provider);
  const docs = engineSkills[0]!.body;
  faux.setResponses([
    context => { expect(JSON.stringify(context)).not.toContain(JSON.stringify(docs).slice(1, -1)); return fauxAssistantMessage([{ type: "toolCall", id: "load", name: "skill_load", arguments: { name: "chrysalis-docs" } }], { stopReason: "toolUse" }); },
    () => fauxAssistantMessage([{ type: "toolCall", id: "read", name: "skill_read", arguments: { name: "chrysalis-docs", path: "references/plugins.md" } }], { stopReason: "toolUse" }),
    context => { expect(JSON.stringify(context)).toContain("# Plugin capabilities"); return fauxAssistantMessage([{ type: "toolCall", id: "target", name: "app_target", arguments: { appId: "first" } }], { stopReason: "toolUse" }); },
    context => { expect(JSON.stringify(context)).toContain(JSON.stringify(docs).slice(1, -1)); return fauxAssistantMessage("Docs available."); },
  ]);
  const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "engine-docs", mode: "plan" });
  const result = await agent.run("Explain plugin capabilities, then select first.");
  expect(result.finalText).toBe("Docs available.");
  expect(result.toolTrace.map(tool => tool.name)).toEqual(["skill_load", "skill_read", "app_target"]);
  expect(result.toolTrace.every(tool => tool.ok)).toBe(true);
  expect(readAppContext(p, "engine-docs")).toEqual({ appId: "first", loaded: ["chrysalis-docs"] });
  fs.appendFileSync(path.join(p.root, "agent/sessions/engine-docs.jsonl"), JSON.stringify({ type: "compact", at: Date.now(), summary: "Read the engine docs." }) + "\n");
  faux.setResponses([context => { expect(JSON.stringify(context.messages.find(message => message.role === "system"))).toContain(JSON.stringify(docs).slice(1, -1)); return fauxAssistantMessage("Still available."); }]);
  const resumed = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "engine-docs", mode: "plan" });
  expect((await resumed.run("continue")).finalText).toBe("Still available.");
}, 20_000);

it("exposes read-only engine skills and reference topics through authenticated settings routes", async () => {
  const users = new UserService(root);
  const token = users.create("alice", "admin", { password: "test-password-1" }).token;
  const p = bootstrapUserDir(root, "alice"); app(p, "first", "BODY");
  const server = buildApp({ users, sessions: new SessionService(root), config: defaultInstanceConfig(), dataDir: root, bus: new EventBus() });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const url = "/v1/agent/skills/chrysalis-docs";
  expect((await server.request(url)).status).toBe(401);
  const catalog = await (await server.request("/v1/agent/skills", { headers })).json() as { engine: { name: string }[] };
  expect(catalog.engine.map(skill => skill.name)).toContain("chrysalis-docs");
  const detail = await (await server.request(url, { headers })).json() as { body: string; files: string[] };
  expect(detail.body).toBe(engineSkills[0]!.body);
  expect(detail.files).toContain("references/plugins.md");
  expect((await server.request(`${url}/resource?path=references/plugins.md`, { headers })).status).toBe(200);
  expect((await server.request(`${url}/resource?path=../persona.md`, { headers })).status).toBe(404);
  expect((await server.request(url, { method: "PUT", headers, body: JSON.stringify({ body: "override" }) })).status).toBe(404);
  expect((await server.request(url, { method: "DELETE", headers })).status).toBe(404);
  const session = await (await server.request("/v1/agent/sessions/one/skills", { headers })).json() as { skills: { name: string }[] };
  expect(session.skills.map(skill => skill.name)).toContain("chrysalis-docs");
  writeAppContext(p, "one", { appId: "first", loaded: ["chrysalis-docs", "preset-editing"] });
  expect((await server.request("/v1/agent/sessions/one/target", { method: "POST", headers, body: JSON.stringify({ appId: null }) })).status).toBe(200);
  expect(readAppContext(p, "one")).toEqual({ appId: null, loaded: ["chrysalis-docs"] });
});

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
  const systems: string[] = [];
  const seen = (context: { messages: { role: string }[] }) => { prompts.push(JSON.stringify(context)); systems.push(JSON.stringify(context.messages.filter((m) => m.role === "system"))); };
  faux.setResponses([
    (context) => { seen(context); return fauxAssistantMessage([{ type: "toolCall", id: "t1", name: "app_target", arguments: { appId: "first" } }], { stopReason: "toolUse" }); },
    (context) => { seen(context); return fauxAssistantMessage([{ type: "toolCall", id: "t2", name: "skill_load", arguments: { name: "preset-editing" } }], { stopReason: "toolUse" }); },
    (context) => { seen(context); return fauxAssistantMessage("Read only."); },
  ]);
  const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "one", mode: "plan" });
  const result = await agent.run("Read the section in first app");
  expect(result.toolTrace.map((tool) => tool.name)).toEqual(["app_target", "skill_load"]);
  expect(prompts[0]).not.toContain("FIRST BODY");
  expect(prompts[1]).toContain("first contract");
  expect(prompts[1]).not.toContain("FIRST BODY");
  expect(prompts[2]).toContain("FIRST BODY");
  // the app's instructions arrive after the history, and every request opens
  // with the same system prompt: picking an app or loading a skill keeps the
  // cached prefix
  expect(systems[0]).not.toContain("first contract");
  expect(systems[1]).toBe(systems[0]!);
  expect(systems[2]).toBe(systems[0]!);
  expect(prompts[2]!.split("FIRST BODY").length).toBe(2);
  expect(prompts.join(" ")).not.toContain("SECOND BODY");
  expect(readAppContext(p, "one")).toEqual({ appId: "first", loaded: ["preset-editing"] });
  fs.appendFileSync(path.join(p.root, "agent/sessions/one.jsonl"), JSON.stringify({ type: "compact", at: Date.now(), summary: "Read the selected preset." }) + "\n");
  // compacted away, the instructions come back through the system prompt
  faux.setResponses([(context) => { expect(JSON.stringify(context.messages.filter((m) => m.role === "system"))).toContain("FIRST BODY"); expect(JSON.stringify(context).split("FIRST BODY").length).toBe(2); return fauxAssistantMessage("Still available."); }]);
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

it("switches an existing conversation to another app during a task and refreshes its instructions", async () => {
  const users = new UserService(root); users.create("alice", "admin", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice");
  app(p, "first", "FIRST BODY"); app(p, "second", "SECOND BODY");
  writeAppContext(p, "switch", { appId: "first", loaded: ["preset-editing"] });
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "switch-model" }] }); svc.models.setProvider(faux.provider);
  const notifications: unknown[] = [];
  faux.setResponses([
    context => { expect(JSON.stringify(context)).toContain("FIRST BODY"); return fauxAssistantMessage([{ type: "toolCall", id: "switch", name: "app_target", arguments: { appId: "second" } }], { stopReason: "toolUse" }); },
    context => { expect(JSON.stringify(context)).toContain("second contract"); expect(JSON.stringify(context)).not.toContain("FIRST BODY"); return fauxAssistantMessage("Working on second"); },
  ]);
  const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "switch", mode: "plan", notify: (type, payload) => { if (type === "agent_target") notifications.push(payload); } });
  expect((await agent.run("Switch to the second app")).finalText).toBe("Working on second");
  expect(readAppContext(p, "switch")).toEqual({ appId: "second", loaded: [] });
  expect(notifications).toEqual([{ sessionId: "switch", appId: "second" }]);
}, 20_000);

it("adds discoverable instructions without overwriting skills or escaping app paths", () => {
  const p = bootstrapUserDir(root, "alice"); app(p, "first", "BODY");
  const value = { name: "my-skill", description: "A description: with YAML punctuation", body: "Keep instructions visible.\nSecond line." };
  const skill = addAppSkill(p, "first", value);
  expect(discoverSkills(p, "first").skills.find(item => item.name === value.name)?.body).toBe(value.body);
  expect(() => addAppSkill(p, "first", value)).toThrow();
  expect(() => addAppSkill(p, "first", { ...value, name: "../escape" })).toThrow();
  expect(() => addAppSkill(p, "missing", value)).toThrow();
  expect(() => addAppSkill(p, "first", { ...value, name: "large", body: "x".repeat(32768) })).toThrow();
  expect(fs.readFileSync(path.join(p.root, skill.file), "utf8")).toContain("Second line.");
});

it("rejects skill installation through an escaping directory", () => {
  const p = bootstrapUserDir(root, "alice");
  const dir = app(p, "first", "BODY");
  fs.rmSync(path.dirname(dir), { recursive: true });
  fs.symlinkSync(root, path.dirname(dir));
  expect(() => addAppSkill(p, "first", { name: "custom", description: "Custom", body: "Body" })).toThrow("escapes");
  expect(fs.existsSync(path.join(root, "custom"))).toBe(false);
});

it("exposes skill instructions and adds skills through authenticated agent routes", async () => {
  const users = new UserService(root);
  const token = users.create("alice", "admin", { password: "test-password-1" }).token;
  const p = bootstrapUserDir(root, "alice"); app(p, "first", "BODY");
  const server = buildApp({ users, sessions: new SessionService(root), config: defaultInstanceConfig(), dataDir: root, bus: new EventBus() });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const detail = await (await server.request("/v1/agent/apps/first/skills/preset-editing", { headers })).json() as { body: string };
  expect(detail.body).toBe("BODY");
  const response = await server.request("/v1/agent/apps/first/skills", { method: "POST", headers, body: JSON.stringify({ name: "custom", description: "Custom", body: "Use these instructions" }) });
  expect(response.status).toBe(201);
  expect(discoverSkills(p, "first").skills.some(skill => skill.name === "custom")).toBe(true);
  expect((await server.request("/v1/agent/apps/first/skills/custom")).status).toBe(401);
});

it("edits a skill in place, keeping its name and the rest of its header, and removes one with its files", () => {
  const p = bootstrapUserDir(root, "alice");
  const dir = app(p, "first", "BODY");
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: preset-editing\ndescription: Old\nlicense: MIT\nmetadata:\n  tags: [a, b]\n---\nBODY");
  fs.writeFileSync(path.join(dir, "inspect.js"), "export default 1");
  const { skill, before, after } = updateAppSkill(p, "first", "preset-editing", { description: " New: with punctuation ", body: "# Title\n\nNew body" });
  expect(before).toContain("description: Old");
  expect(after).toContain("license: MIT");
  expect(skill.description).toBe("New: with punctuation");
  const found = discoverSkills(p, "first");
  expect(found.errors).toEqual([]);
  expect(found.skills).toEqual([{ name: "preset-editing", description: "New: with punctuation", body: "# Title\n\nNew body", file: skill.file }]);
  expect(() => updateAppSkill(p, "first", "preset-editing", { description: "", body: "x" })).toThrow();
  expect(() => updateAppSkill(p, "first", "preset-editing", { description: "x", body: "y".repeat(32768) })).toThrow("32 KB");
  expect(() => updateAppSkill(p, "first", "missing", { description: "x", body: "y" })).toThrow("not found");
  expect(discoverSkills(p, "first").skills[0]!.body).toBe("# Title\n\nNew body");

  expect(() => removeAppSkill(p, "first", "../..")).toThrow();
  expect(() => removeAppSkill(p, "missing", "preset-editing")).toThrow();
  expect(removeAppSkill(p, "first", "preset-editing").sort()).toEqual(["apps/first/.agents/skills/preset-editing/SKILL.md", "apps/first/.agents/skills/preset-editing/inspect.js"]);
  expect(fs.existsSync(dir)).toBe(false);
  expect(fs.existsSync(path.join(p.apps, "first", "manifest.json"))).toBe(true);
});

it("removes a skill whose file cannot be read, and never follows a linked folder", () => {
  const p = bootstrapUserDir(root, "alice");
  const dir = app(p, "first", "BODY");
  const skillsRoot = path.dirname(dir);
  fs.mkdirSync(path.join(skillsRoot, "broken"));
  fs.writeFileSync(path.join(skillsRoot, "broken", "SKILL.md"), "no header");
  expect(() => updateAppSkill(p, "first", "broken", { description: "x", body: "y" })).toThrow("cannot be read");
  expect(removeAppSkill(p, "first", "broken")).toEqual(["apps/first/.agents/skills/broken/SKILL.md"]);
  fs.mkdirSync(path.join(root, "outside"));
  fs.writeFileSync(path.join(root, "outside", "keep.txt"), "keep");
  fs.symlinkSync(path.join(root, "outside"), path.join(skillsRoot, "linked"));
  expect(() => removeAppSkill(p, "first", "linked")).toThrow();
  expect(fs.existsSync(path.join(root, "outside", "keep.txt"))).toBe(true);
});

it("lists every app's skills, and edits and deletes them through authenticated agent routes", async () => {
  const users = new UserService(root);
  const token = users.create("alice", "admin", { password: "test-password-1" }).token;
  const p = bootstrapUserDir(root, "alice"); app(p, "first", "BODY");
  fs.mkdirSync(path.join(p.apps, "bare"));
  fs.writeFileSync(path.join(p.apps, "bare", "manifest.json"), JSON.stringify({ name: "Bare", kind: "web", version: "1.0.0" }));
  const server = buildApp({ users, sessions: new SessionService(root), config: defaultInstanceConfig(), dataDir: root, bus: new EventBus() });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const all = await (await server.request("/v1/agent/skills", { headers })).json() as { apps: Array<{ id: string; name: string; skills: Array<{ name: string }> }> };
  expect(all.apps.map(a => [a.id, a.skills.map(s => s.name)])).toEqual([["bare", []], ["first", ["preset-editing"]]]);
  expect((await server.request("/v1/agent/skills")).status).toBe(401);
  const url = "/v1/agent/apps/first/skills/preset-editing";
  const edited = await server.request(url, { method: "PUT", headers, body: JSON.stringify({ description: "Changed", body: "CHANGED BODY" }) });
  expect(edited.status).toBe(200);
  expect(((await edited.json()) as { changeId: string }).changeId).toMatch(/^[a-f0-9-]{36}$/);
  const detail = await (await server.request(url, { headers })).json() as { description: string; body: string; files: string[] };
  expect(detail).toMatchObject({ description: "Changed", body: "CHANGED BODY", files: [] });
  expect((await server.request(url, { method: "PUT", headers, body: JSON.stringify({ description: "x" }) })).status).toBe(400);
  expect((await server.request(url, { method: "DELETE" })).status).toBe(401);
  expect((await server.request(url, { method: "DELETE", headers })).status).toBe(200);
  expect((await server.request(url, { headers })).status).toBe(404);
  expect((await server.request(url, { method: "DELETE", headers })).status).toBe(400);
});
