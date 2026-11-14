import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { UserAgent } from "../src/agent/agent.js";
import { PROMPTS_FILE, validatePromptsFile, writePrompts, type AgentPromptsFile } from "../src/agent/prompt-presets.js";
import { defaultInstanceConfig } from "../src/config.js";
import { UserModelService } from "../src/models.js";
import { bootstrapUserDir } from "../src/paths.js";
import { UserService } from "../src/users.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-prompts-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const presets = (active: string | null): AgentPromptsFile => ({
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

it("refuses a malformed presets file", () => {
  expect(validatePromptsFile(presets("terse")).ok).toBe(true);
  expect(validatePromptsFile({ ...presets("terse"), active: "missing" }).ok).toBe(false);
  expect(validatePromptsFile({ active: null, presets: [{ id: "a", name: "A", prompts: [{ id: "q", name: "", enabled: true, placement: "depth", content: "" }] }] }).ok).toBe(false);
  expect(validatePromptsFile({ active: null, presets: [{ id: "a", name: "A", prompts: [] }, { id: "a", name: "B", prompts: [] }] }).ok).toBe(false);
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
  }, "file");
  expect(preset?.name).toBe("Story");
  expect(preset?.prompts.map((p) => [p.name, p.enabled, p.placement])).toEqual([
    ["Extra", false, "system"], ["Main Prompt", true, "system"], ["Post-History", true, "message"], ["Unlisted", false, "system"],
  ]);
  expect(validatePromptsFile({ active: preset!.id, presets: [preset] }).ok).toBe(true);
  expect(importPromptPreset({ prompts: [{ identifier: "chatHistory", marker: true }] }, "x")).toBeNull();
});
