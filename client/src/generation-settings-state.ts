import type { GenerationSettings } from "../../src/providers/generation-settings.js"

export const GENERATION_RANGES = {
  maxTokens: { min: 1, max: Number.MAX_SAFE_INTEGER, step: 1 },
  temperature: { min: 0, max: 2, step: 0.01 },
  topP: { min: 0, max: 1, step: 0.01 },
  frequencyPenalty: { min: -2, max: 2, step: 0.01 },
  presencePenalty: { min: -2, max: 2, step: 0.01 },
} as const

export interface GenerationCapabilities {
  maxTokens: boolean
  temperature: boolean
  temperatureMax: number
  topP: boolean
  penalties: boolean
  reasoning: boolean
}

export function generationCapabilities(apis: string[]): GenerationCapabilities {
  return {
    maxTokens: !apis.length || apis.some((api) => api !== "openai-codex-responses"),
    temperature: !apis.length || apis.some((api) => api !== "openai-codex-responses"),
    temperatureMax: apis.length > 0 && apis.every((api) => api === "anthropic-messages") ? 1 : 2,
    topP: !apis.length || apis.some((api) => api !== "pi-messages" && api !== "openai-codex-responses"),
    penalties: !apis.length || apis.some((api) => ["openai-completions", "openai-text", "google-generative-ai", "google-vertex", "mistral-conversations"].includes(api)),
    reasoning: !apis.length || apis.some((api) => api !== "openai-text"),
  }
}

export type GenerationDraft = Record<keyof typeof GENERATION_RANGES | "reasoning", string>

export function generationDraft(value?: GenerationSettings): GenerationDraft {
  return Object.fromEntries([...Object.keys(GENERATION_RANGES), "reasoning"].map((key) => [key, String(value?.[key as keyof GenerationSettings] ?? "")])) as GenerationDraft
}

export function generationBody(draft: GenerationDraft, invalidMessage = "Check the generation settings and their allowed ranges.", apis?: string[]): GenerationSettings | null {
  const capabilities = apis ? generationCapabilities(apis) : undefined
  const filtered = { ...draft }
  if (capabilities) {
    if (!capabilities.maxTokens) filtered.maxTokens = ""
    if (!capabilities.temperature) filtered.temperature = ""
    if (!capabilities.topP) filtered.topP = ""
    if (!capabilities.penalties) { filtered.frequencyPenalty = ""; filtered.presencePenalty = "" }
    if (!capabilities.reasoning) filtered.reasoning = ""
  }
  const input = Object.fromEntries(Object.entries(filtered).filter(([, value]) => value.trim()).map(([key, value]) => [key, key === "reasoning" ? value : Number(value)]))
  for (const [key, value] of Object.entries(input)) {
    if (key === "reasoning") {
      if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value))) continue
    } else {
      const range = Object.hasOwn(GENERATION_RANGES, key) ? GENERATION_RANGES[key as keyof typeof GENERATION_RANGES] : undefined
      if (range && typeof value === "number" && Number.isFinite(value) && value >= range.min && value <= (key === "temperature" && capabilities ? capabilities.temperatureMax : range.max) && (key !== "maxTokens" || Number.isSafeInteger(value))) continue
    }
    throw new Error(invalidMessage)
  }
  return Object.keys(input).length ? input as GenerationSettings : null
}
