import fs from "node:fs";
import { validAgentModelOverrides, type AgentModelOverrides } from "./model-settings.js";
import type { UserPaths } from "../paths.js";
import { validateGenerationSettings, type GenerationSettings } from "../providers/generation-settings.js";

export function readAgentGeneration(paths: UserPaths, ref?: string): GenerationSettings {
  try {
    const settings = JSON.parse(fs.readFileSync(paths.settings, "utf8"));
    const checked = validateGenerationSettings({ ...(settings.agentGeneration ?? {}), ...(ref ? readAgentModels(paths)[ref]?.generation : {}) });
    if (checked.ok && checked.value) {
      const { reasoning: _reasoning, ...sampling } = checked.value;
      return sampling;
    }
  } catch { /* unset */ }
  return {};
}

export function readAgentModels(paths: UserPaths): Record<string, AgentModelOverrides> {
  try {
    const value = JSON.parse(fs.readFileSync(paths.settings, "utf8")).agentModels;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, AgentModelOverrides] => entry[0].includes("/") && validAgentModelOverrides(entry[1])));
  } catch { return {}; }
}
