import fs from "node:fs";
import path from "node:path";
import type { UserPaths } from "../paths.js";
import { BUILTIN_SECTIONS, LOCKED_SECTIONS, MAIN, MARKER_MACROS, MARKERS, type AgentPrompt, type AgentPromptPreset, type AgentPromptsFile, type BuiltinSection, type Marker } from "./prompt-preset-types.js";

export type { AgentPrompt, AgentPromptPreset, AgentPromptsFile, BuiltinSection, Marker, PromptPlacement } from "./prompt-preset-types.js";

/** The main prompt as it ships (with {{user}} in place) and each marker's text right now. */
export interface PromptParts {
  main: string;
  markers: Record<Marker, string>;
}

/**
 * Prompt presets for the agent: ordered lists of prompts, one list active at
 * a time. The main prompt is ordinary text the user may rewrite ("" keeps
 * the text as it ships). Markers stand for content the engine fills in
 * (installed apps, notes, the shell guide...) and can be moved or switched
 * off; the same content is available as {{macros}} inside any prompt. A
 * prompt placed on each message is written into the message the model
 * receives, so earlier turns keep the text they were sent with and the
 * history stays a stable cached prefix when the preset changes.
 */

export const PROMPTS_FILE = "agent-prompts.json";
const MAX_PRESETS = 50;
const MAX_PROMPTS = 100;
const MAX_CONTENT = 64_000;
const MAX_FILE = 512 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const builtinEntry = (section: BuiltinSection): AgentPrompt => ({ id: `builtin-${section}`, name: "", enabled: true, placement: "system", content: "", builtin: section });

export function defaultPreset(id = "default", name = "Default"): AgentPromptPreset {
  return { id, name, prompts: BUILTIN_SECTIONS.map(builtinEntry) };
}

/** Every built-in part present once, near where the default order puts it; locked parts on. */
function withBuiltins(prompts: AgentPrompt[]): AgentPrompt[] {
  const out = prompts.filter((p, i) => !p.builtin || prompts.findIndex((q) => q.builtin === p.builtin) === i)
    .map((p) => (p.builtin ? { ...builtinEntry(p.builtin), enabled: LOCKED_SECTIONS.includes(p.builtin) || p.enabled, content: p.builtin === MAIN ? p.content : "" } : p));
  BUILTIN_SECTIONS.forEach((section, order) => {
    if (out.some((p) => p.builtin === section)) return;
    const before = BUILTIN_SECTIONS.slice(0, order).reverse().map((s) => out.findIndex((p) => p.builtin === s)).find((i) => i >= 0);
    out.splice(before === undefined ? 0 : before + 1, 0, builtinEntry(section));
  });
  return out;
}

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
    if (!Array.isArray(preset.prompts) || preset.prompts.length > MAX_PROMPTS + BUILTIN_SECTIONS.length) return { ok: false, error: `a preset holds at most ${MAX_PROMPTS} prompts` };
    presetIds.add(preset.id);
    const promptIds = new Set<string>();
    const prompts: AgentPrompt[] = [];
    for (const q of preset.prompts) {
      if (!q || typeof q !== "object") return { ok: false, error: "a prompt must be an object" };
      const prompt = q as Partial<Record<keyof AgentPrompt, unknown>>;
      if (prompt.builtin !== undefined && !BUILTIN_SECTIONS.includes(prompt.builtin as BuiltinSection)) return { ok: false, error: `unknown built-in part "${String(prompt.builtin)}"` };
      if (typeof prompt.id !== "string" || !ID.test(prompt.id) || promptIds.has(prompt.id)) return { ok: false, error: `each prompt in "${preset.name}" needs its own id` };
      if (typeof prompt.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
      promptIds.add(prompt.id);
      if (prompt.builtin !== undefined && prompt.builtin !== MAIN) {
        prompts.push({ ...builtinEntry(prompt.builtin as BuiltinSection), enabled: prompt.enabled });
        continue;
      }
      if (typeof prompt.name !== "string" || prompt.name.length > 120) return { ok: false, error: "a prompt name must be at most 120 characters" };
      if (typeof prompt.content !== "string" || prompt.content.length > MAX_CONTENT) return { ok: false, error: `a prompt must be text of at most ${MAX_CONTENT} characters` };
      if (prompt.placement !== "system" && prompt.placement !== "message") return { ok: false, error: "placement must be \"system\" or \"message\"" };
      prompts.push(prompt.builtin === MAIN
        ? { ...builtinEntry(MAIN), enabled: prompt.enabled, content: prompt.content }
        : { id: prompt.id, name: prompt.name, enabled: prompt.enabled, placement: prompt.placement, content: prompt.content });
    }
    if (prompts.filter((q) => !q.builtin).length > MAX_PROMPTS) return { ok: false, error: `a preset holds at most ${MAX_PROMPTS} prompts` };
    presets.push({ id: preset.id, name: preset.name.trim(), prompts: withBuiltins(prompts) });
  }
  if (raw.active !== undefined && raw.active !== null && (typeof raw.active !== "string" || !presetIds.has(raw.active))) return { ok: false, error: "active must name a preset" };
  // no active preset means the agent's own prompt as it ships
  let active = typeof raw.active === "string" ? raw.active : "";
  if (!active) {
    const fallback = presets.find((p) => p.id === "default") ?? defaultPreset(presetIds.has("default") ? `default-${presets.length}` : "default");
    if (!presets.includes(fallback)) presets.unshift(fallback);
    active = fallback.id;
  }
  const value = { active, presets };
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_FILE) return { ok: false, error: "the presets are larger than 512 KB" };
  return { ok: true, value };
}

/** The user's presets; a Default preset that holds the agent's own prompt when there are none. */
export function readPrompts(paths: UserPaths): AgentPromptsFile {
  try {
    const checked = validatePromptsFile(JSON.parse(fs.readFileSync(path.join(paths.root, PROMPTS_FILE), "utf8")));
    if (checked.ok) return checked.value;
  } catch { /* none saved yet */ }
  return { active: "default", presets: [defaultPreset()] };
}

export function writePrompts(paths: UserPaths, file: AgentPromptsFile): void {
  const target = path.join(paths.root, PROMPTS_FILE);
  fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
  fs.renameSync(`${target}.tmp`, target);
}

export function activePreset(paths: UserPaths): AgentPromptPreset {
  const file = readPrompts(paths);
  return file.presets.find((p) => p.id === file.active) ?? file.presets[0] ?? defaultPreset();
}

/** Prompt text with its macros filled in; an unknown {{name}} stays as written. */
export function fillMacros(text: string, username: string, parts: PromptParts): string {
  const values = new Map<string, string>([["user", username], ["date", new Date().toLocaleDateString("en-CA")]]);
  for (const marker of MARKERS) values.set(MARKER_MACROS[marker], parts.markers[marker]);
  return text.replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (whole, name: string) => values.get(name.toLowerCase()) ?? whole).trim();
}

/**
 * The system prompt in a preset's order: the main prompt and each marker
 * under their own names, each of the user's system prompts under its id.
 */
export function presetSections(preset: AgentPromptPreset, username: string, parts: PromptParts): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of preset.prompts) {
    if (!p.enabled) continue;
    if (p.builtin === MAIN) out[MAIN] = fillMacros(p.content.trim() ? p.content : parts.main, username, parts);
    else if (p.builtin) out[p.builtin] = parts.markers[p.builtin];
    else if (p.placement === "system") {
      const text = fillMacros(p.content, username, parts);
      if (text) out[`prompt-${p.id}`] = p.name.trim() ? `# ${p.name.trim()}\n${text}` : text;
    }
  }
  return out;
}

/** What a preset adds to each message the user sends, or "" for nothing. */
export function presetMessage(preset: AgentPromptPreset, username: string, parts: PromptParts): string {
  const texts = preset.prompts.filter((p) => !p.builtin && p.enabled && p.placement === "message").map((p) => fillMacros(p.content, username, parts)).filter(Boolean);
  if (!texts.length) return "";
  return `<user-prompts preset="${preset.name.replace(/"/g, "'")}">\n${texts.join("\n\n")}\n</user-prompts>`;
}

export const orderedSections = (paths: UserPaths, username: string, parts: PromptParts) => presetSections(activePreset(paths), username, parts);
export const messagePrompts = (paths: UserPaths, username: string, parts: PromptParts) => presetMessage(activePreset(paths), username, parts);
