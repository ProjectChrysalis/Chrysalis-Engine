import fs from "node:fs";
import path from "node:path";
import type { UserPaths } from "../paths.js";
import type { AgentPrompt, AgentPromptPreset, AgentPromptsFile, PromptPlacement } from "./prompt-preset-types.js";

/**
 * Prompt presets for the agent: named sets of prompts the user writes, one
 * set active at a time. A prompt goes either into the system prompt, where
 * it stays cached with the rest of the instructions, or onto every message
 * the user sends. Message prompts are written into the message the model
 * receives, so earlier turns keep the text they were sent with and the
 * history stays a stable cached prefix when the preset changes later.
 */

export type { AgentPrompt, AgentPromptPreset, AgentPromptsFile, PromptPlacement } from "./prompt-preset-types.js";

export const PROMPTS_FILE = "agent-prompts.json";
const MAX_PRESETS = 50;
const MAX_PROMPTS = 100;
const MAX_CONTENT = 32_000;
const MAX_FILE = 512 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const EMPTY: AgentPromptsFile = { active: null, presets: [] };

/** A prompts file from untrusted input, or the reason it is refused. */
export function validatePromptsFile(input: unknown): { ok: true; value: AgentPromptsFile } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "expected { active, presets }" };
  const raw = input as { active?: unknown; presets?: unknown };
  if (!Array.isArray(raw.presets)) return { ok: false, error: "presets must be a list" };
  if (raw.presets.length > MAX_PRESETS) return { ok: false, error: `at most ${MAX_PRESETS} presets` };
  const presets: AgentPromptPreset[] = [];
  const presetIds = new Set<string>();
  for (const p of raw.presets) {
    if (!p || typeof p !== "object") return { ok: false, error: "a preset must be an object" };
    const preset = p as { id?: unknown; name?: unknown; prompts?: unknown };
    if (typeof preset.id !== "string" || !ID.test(preset.id) || presetIds.has(preset.id)) return { ok: false, error: "each preset needs its own id" };
    if (typeof preset.name !== "string" || !preset.name.trim() || preset.name.length > 120) return { ok: false, error: "a preset name must be 1-120 characters" };
    if (!Array.isArray(preset.prompts) || preset.prompts.length > MAX_PROMPTS) return { ok: false, error: `a preset holds at most ${MAX_PROMPTS} prompts` };
    presetIds.add(preset.id);
    const promptIds = new Set<string>();
    const prompts: AgentPrompt[] = [];
    for (const q of preset.prompts) {
      if (!q || typeof q !== "object") return { ok: false, error: "a prompt must be an object" };
      const prompt = q as Partial<Record<keyof AgentPrompt, unknown>>;
      if (typeof prompt.id !== "string" || !ID.test(prompt.id) || promptIds.has(prompt.id)) return { ok: false, error: `each prompt in "${preset.name}" needs its own id` };
      if (typeof prompt.name !== "string" || prompt.name.length > 120) return { ok: false, error: "a prompt name must be at most 120 characters" };
      if (typeof prompt.content !== "string" || prompt.content.length > MAX_CONTENT) return { ok: false, error: `a prompt must be text of at most ${MAX_CONTENT} characters` };
      if (prompt.placement !== "system" && prompt.placement !== "message") return { ok: false, error: "placement must be \"system\" or \"message\"" };
      if (typeof prompt.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
      promptIds.add(prompt.id);
      prompts.push({ id: prompt.id, name: prompt.name, enabled: prompt.enabled, placement: prompt.placement, content: prompt.content });
    }
    presets.push({ id: preset.id, name: preset.name.trim(), prompts });
  }
  const active = raw.active === null || raw.active === undefined ? null : raw.active;
  if (active !== null && (typeof active !== "string" || !presetIds.has(active))) return { ok: false, error: "active must name a preset or be null" };
  const value = { active, presets };
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_FILE) return { ok: false, error: "the presets are larger than 512 KB" };
  return { ok: true, value };
}

export function readPrompts(paths: UserPaths): AgentPromptsFile {
  try {
    const checked = validatePromptsFile(JSON.parse(fs.readFileSync(path.join(paths.root, PROMPTS_FILE), "utf8")));
    return checked.ok ? checked.value : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function writePrompts(paths: UserPaths, file: AgentPromptsFile): void {
  const target = path.join(paths.root, PROMPTS_FILE);
  fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
  fs.renameSync(`${target}.tmp`, target);
}

function activePrompts(paths: UserPaths, placement: PromptPlacement): { preset: string; prompts: AgentPrompt[] } | null {
  const file = readPrompts(paths);
  const preset = file.presets.find((p) => p.id === file.active);
  if (!preset) return null;
  const prompts = preset.prompts.filter((p) => p.enabled && p.placement === placement && p.content.trim());
  return prompts.length ? { preset: preset.name, prompts } : null;
}

const fill = (text: string, username: string) => text.replace(/\{\{user\}\}/gi, username).trim();

/** The system prompt section for the active preset, empty when it adds nothing there. */
export function presetSection(paths: UserPaths, username: string): string {
  const active = activePrompts(paths, "system");
  if (!active) return "";
  const body = active.prompts.map((p) => (p.name.trim() ? `## ${p.name.trim()}\n${fill(p.content, username)}` : fill(p.content, username))).join("\n\n");
  return `# Prompts from ${username}'s preset "${active.preset}"\n${body}`;
}

/** What the active preset adds to each message the user sends, or "" for nothing. */
export function messagePrompts(paths: UserPaths, username: string): string {
  const active = activePrompts(paths, "message");
  if (!active) return "";
  return `<user-prompts preset="${active.preset.replace(/"/g, "'")}">\n${active.prompts.map((p) => fill(p.content, username)).join("\n\n")}\n</user-prompts>`;
}
