import { validateGenerationSettings, type GenerationSettings } from "../providers/generation-settings.js";

export interface AgentModelOverrides {
  generation?: GenerationSettings;
  contextWindow?: number;
  autoCompact?: boolean | number;
}

export function validAgentModelOverrides(value: unknown): value is AgentModelOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  if (Object.keys(profile).some((key) => !["generation", "contextWindow", "autoCompact"].includes(key))) return false;
  if (profile.generation !== undefined && (profile.generation === null || !validateGenerationSettings(profile.generation).ok)) return false;
  if (profile.contextWindow !== undefined && !(typeof profile.contextWindow === "number" && Number.isSafeInteger(profile.contextWindow) && profile.contextWindow > 0 && profile.contextWindow <= 1e9)) return false;
  if (profile.autoCompact !== undefined && typeof profile.autoCompact !== "boolean" && !(typeof profile.autoCompact === "number" && Number.isFinite(profile.autoCompact) && profile.autoCompact >= 1000 && profile.autoCompact <= 10_000_000)) return false;
  return true;
}
