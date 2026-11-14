import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { UserAgent } from "../src/agent/agent.js";
import { PROMPTS_FILE, readPrompts, validatePromptsFile, writePrompts, type AgentPromptsFile } from "../src/agent/prompt-presets.js";
import { BUILTIN_SECTIONS } from "../src/agent/prompt-preset-types.js";
import { defaultInstanceConfig } from "../src/config.js";
import { UserModelService } from "../src/models.js";
import { bootstrapUserDir } from "../src/paths.js";
import { UserService } from "../src/users.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-prompts-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const presets = (active: string): AgentPromptsFile => ({
  active,
  presets: [
    { id: "terse", name: "Terse", prompts: [
      { id: "style", name: "Style", enabled: true, placement: "system", content: "Talk like a pirate to {{user}}." },
      { id: "off", name: "Off", enabled: false, placement: "system", content: "DISABLED PROMPT" },
      { id: "each", name: "Each", enabled: true, placement: "message", content: "End every reply with ARR." },
    ] },
    { id: "plain", name: "Plain", prompts: [{ id: "x", name: "", enabled: true, placement: "message", content: "Be plain." }] },
  ],
});

it("sends the active preset's prompts: system ones in the instructions, message ones with each message", async () => {
  const users = new UserService(root);
  users.create("alice", "user", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice");
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "preset-model" }] });
  svc.models.setProvider(faux.provider);
  const requests: string[] = [];
  const reply = (text: string) => (context: { messages: readonly unknown[]; systemPrompt?: string }) => { requests.push(JSON.stringify(context)); return fauxAssistantMessage(text); };

  writePrompts(p, presets("terse"));
  faux.setResponses([reply("Ahoy. ARR.")]);
  const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "presets" });
  const first = await agent.run("Hello");
  const sent = requests[0]!;
  expect(sent).toContain("Talk like a pirate to alice.");
  expect(sent).toContain("End every reply with ARR.");
  expect(sent).not.toContain("DISABLED PROMPT");
  // the transcript keeps what was typed
  expect(JSON.stringify(first.transcript.filter((m) => m.role === "user"))).toContain("Hello");

  // switching presets: the earlier message keeps what it was sent with
  writePrompts(p, presets("plain"));
  faux.setResponses([reply("Plainly.")]);
  const next = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "presets" });
  await next.run("Again");
  const second = requests[1]!;
  expect(second).toContain("Be plain.");
  expect(second.split("End every reply with ARR.").length).toBe(2);
  expect(second.indexOf("Be plain.")).toBeGreaterThan(second.indexOf("Again"));
}, 20_000);

it("orders the system prompt by the preset, fills macros, and keeps the mode on", async () => {
  const users = new UserService(root);
  users.create("alice", "user", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice");
  fs.writeFileSync(p.persona, "PERSONA TEXT");
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "order-model" }] });
  svc.models.setProvider(faux.provider);
  let system = "";
  faux.setResponses([(context: unknown) => { system = JSON.stringify(context); return fauxAssistantMessage("ok"); }]);
  writePrompts(p, { active: "first", presets: [{ id: "first", name: "First", prompts: [
    { id: "lead", name: "Lead", enabled: true, placement: "system", content: "LEAD PROMPT" },
    { id: "builtin-base", name: "", enabled: true, placement: "system", content: "MY MAIN for {{user}}. Rules: {{instructions}} {{unknown}}", builtin: "base" },
    { id: "builtin-persona", name: "", enabled: false, placement: "system", content: "", builtin: "persona" },
    { id: "builtin-mode", name: "", enabled: false, placement: "system", content: "", builtin: "mode" },
  ] }] });
  const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "order" });
  await agent.run("Hi");
  expect(system.indexOf("LEAD PROMPT")).toBeLessThan(system.indexOf("MY MAIN"));
  // the main prompt is the user's text, with macros filled and unknown ones left alone
  expect(system).toContain("MY MAIN for alice. Rules: # Personal instructions from alice\\nPERSONA TEXT {{unknown}}");
  expect(system).not.toContain("You are the personal agent");
  // the persona marker is off, so its text appears only where the macro put it
  expect(system.split("PERSONA TEXT").length).toBe(2);
  // the mode cannot be switched off
  expect(readPrompts(p).presets[0]?.prompts.find((q) => q.builtin === "mode")?.enabled).toBe(true);
}, 20_000);

it("starts from a Default preset holding every part of the agent's own prompt", () => {
  const p = bootstrapUserDir(root, "bob");
  const file = readPrompts(p);
  expect(file.active).toBe("default");
  expect(file.presets[0]?.prompts.map((q) => q.builtin)).toEqual([...BUILTIN_SECTIONS]);
  // a saved preset missing parts gets them back in their usual places
  const filled = validatePromptsFile({ active: "a", presets: [{ id: "a", name: "A", prompts: [{ id: "x", name: "", enabled: true, placement: "system", content: "X" }] }] });
  expect(filled.ok && filled.value.presets[0]?.prompts.map((q) => q.builtin ?? q.id)).toEqual([...BUILTIN_SECTIONS, "x"]);
  // a file with nothing active keeps its presets and runs the shipped prompt
  const none = validatePromptsFile({ active: null, presets: [{ id: "a", name: "A", prompts: [] }] });
  expect(none.ok && [none.value.active, none.value.presets.map((q) => q.id)]).toEqual(["default", ["default", "a"]]);
});

it("refuses a malformed presets file", () => {
  expect(validatePromptsFile(presets("terse")).ok).toBe(true);
  expect(validatePromptsFile({ ...presets("terse"), active: "missing" }).ok).toBe(false);
  expect(validatePromptsFile({ active: "a", presets: [{ id: "a", name: "A", prompts: [{ id: "q", name: "", enabled: true, placement: "depth", content: "" }] }] }).ok).toBe(false);
  expect(validatePromptsFile({ active: "a", presets: [{ id: "a", name: "A", prompts: [] }, { id: "a", name: "B", prompts: [] }] }).ok).toBe(false);
  expect(validatePromptsFile({ active: "a", presets: [{ id: "a", name: "A", prompts: [{ id: "b", name: "", enabled: true, placement: "system", content: "", builtin: "everything" }] }] }).ok).toBe(false);
  expect(PROMPTS_FILE).toBe("agent-prompts.json");
});

it("imports a roleplay preset's prompts in order, with their on/off state and placement", async () => {
  const { importPromptPreset } = await import("../client/src/agent-prompt-import.js");
  const preset = importPromptPreset({
    name: "Story",
    prompts: [
      { identifier: "main", name: "Main Prompt", content: "Write the next reply.", marker: true },
      { identifier: "chatHistory", name: "Chat History", marker: true },
      { identifier: "jailbreak", name: "Post-History", content: "Stay in character." },
      { identifier: "extra", name: "Extra", content: "Use vivid prose." },
      { identifier: "unlisted", name: "Unlisted", content: "Not in the order." },
    ],
    prompt_order: [{ character_id: 100001, order: [
      { identifier: "extra", enabled: false }, { identifier: "main", enabled: true },
      { identifier: "chatHistory", enabled: true }, { identifier: "jailbreak", enabled: true },
    ] }],
  }, "file", BUILTIN_SECTIONS);
  expect(preset?.name).toBe("Story");
  // imported prompts sit after what the agent knows and before its mode
  expect(preset?.prompts.map((p) => p.builtin ?? "x")).toEqual([...BUILTIN_SECTIONS.filter((s) => s !== "mode"), "x", "x", "x", "x", "mode"]);
  expect(preset?.prompts.filter((p) => !p.builtin).map((p) => [p.name, p.enabled, p.placement])).toEqual([
    ["Extra", false, "system"], ["Main Prompt", true, "system"], ["Post-History", true, "message"], ["Unlisted", false, "system"],
  ]);
  expect(validatePromptsFile({ active: preset!.id, presets: [preset] }).ok).toBe(true);
  expect(importPromptPreset({ prompts: [{ identifier: "chatHistory", marker: true }] }, "x", BUILTIN_SECTIONS)).toBeNull();
});

it("shows the shipped main prompt and each marker, and previews an unsaved preset through the settings API", async () => {
  const { buildApp } = await import("../src/server/app.js");
  const { EventBus } = await import("../src/server/ws.js");
  const { SessionService } = await import("../src/sessions.js");
  const users = new UserService(root);
  users.create("admin", "admin", { password: "admin-pass-1" });
  const token = users.create("alice", "user", { password: "test-pass-1" }).token;
  const p = bootstrapUserDir(root, "alice");
  fs.writeFileSync(p.persona, "PERSONA TEXT");
  const app = buildApp({ users, sessions: new SessionService(root), config: defaultInstanceConfig(), dataDir: root, bus: new EventBus() });
  const send = (method: string, route: string, body?: unknown) => app.request(route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  type View = AgentPromptsFile & { parts: { main: string; markers: Record<string, string> }; order: string[]; macros: Record<string, string> };
  const view = await (await send("GET", "/v1/settings/agent-prompts")).json() as View;
  expect(view.active).toBe("default");
  expect(view.order).toEqual([...BUILTIN_SECTIONS]);
  expect(view.parts.main).toContain('You are the personal agent of "{{user}}"');
  expect(view.parts.markers.persona).toContain("PERSONA TEXT");
  expect(view.macros.persona).toBe("instructions");
  const draft = { ...view.presets[0]!, prompts: [
    { id: "each", name: "", enabled: true, placement: "message", content: "Reply to {{user}} briefly." },
    ...view.presets[0]!.prompts.map((q) => (q.builtin === "persona" ? { ...q, enabled: false } : q)),
  ] };
  const preview = await (await send("POST", "/v1/settings/agent-prompts/preview", { preset: draft })).json() as { system: string; message: string };
  expect(preview.system).toContain('You are the personal agent of "alice"');
  expect(preview.system).not.toContain("PERSONA TEXT");
  expect(preview.message).toContain("Reply to alice briefly.");
  expect((await send("POST", "/v1/settings/agent-prompts/preview", { preset: { id: "x" } })).status).toBe(400);
});
