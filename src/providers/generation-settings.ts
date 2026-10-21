import { clampThinkingLevel, type Api, type Model, type Provider, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { thinkingBudgetForLevel, clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { usesGoogleThinkingLevel, resolveGoogleThinkingLevel, toGoogleThinkingLevel } from "@earendil-works/pi-ai/api/google-shared";

export interface GenerationSettings {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export const GENERATION_RANGES = {
  maxTokens: { min: 1, max: Number.MAX_SAFE_INTEGER, step: 1 },
  temperature: { min: 0, max: 2, step: 0.01 },
  topP: { min: 0, max: 1, step: 0.01 },
  frequencyPenalty: { min: -2, max: 2, step: 0.01 },
  presencePenalty: { min: -2, max: 2, step: 0.01 },
} as const;

export function validateGenerationSettings(input: unknown):
  | { ok: true; value: GenerationSettings | null }
  | { ok: false; error: string } {
  if (input === null) return { ok: true, value: null };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "generation settings must be an object" };
  const result: GenerationSettings = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "reasoning") {
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value as string)) return { ok: false, error: "invalid reasoning level" };
      result.reasoning = value as GenerationSettings["reasoning"];
    } else {
      const range = Object.hasOwn(GENERATION_RANGES, key) ? GENERATION_RANGES[key as keyof typeof GENERATION_RANGES] : undefined;
      if (!range || typeof value !== "number" || !Number.isFinite(value) || value < range.min || value > range.max || (key === "maxTokens" && !Number.isSafeInteger(value))) {
        return { ok: false, error: `invalid generation setting: ${key}` };
      }
      Object.assign(result, { [key]: value });
    }
  }
  return { ok: true, value: Object.keys(result).length ? result : null };
}

export function generationSampling(settings: GenerationSettings, api: string = "openai-text"): Record<string, number | string> {
  if (api === "openai-text" || api === "openai-completions") return {
    ...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
    ...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
    ...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
    ...(api === "openai-text" && settings.reasoning !== undefined ? { reasoning_effort: settings.reasoning === "off" ? "none" : settings.reasoning } : {}),
  };
  return {};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function samplingPayload(payload: unknown, model: Model<Api>, settings: GenerationSettings): unknown {
  const body = { ...record(payload) };
  const api = model.api;
  if (settings.maxTokens !== undefined && api === "anthropic-messages") {
    body.max_tokens = Math.min(Number(body.max_tokens), settings.maxTokens);
    const thinking = record(body.thinking);
    if (thinking.type === "enabled") {
      if (Number(body.max_tokens) <= 1024) throw new Error("Output token limit must exceed 1024 with budgeted thinking.");
      body.thinking = { ...thinking, budget_tokens: Math.min(Number(thinking.budget_tokens), Number(body.max_tokens) - 1024) };
    }
  }
  if (settings.maxTokens !== undefined && api === "bedrock-converse-stream") {
    const inference = record(body.inferenceConfig);
    const maxTokens = Math.min(Number(inference.maxTokens), settings.maxTokens);
    body.inferenceConfig = { ...inference, maxTokens };
    const additional = record(body.additionalModelRequestFields);
    const thinking = record(additional.thinking);
    if (thinking.type === "enabled") {
      if (maxTokens <= 1024) throw new Error("Output token limit must exceed 1024 with budgeted thinking.");
      body.additionalModelRequestFields = { ...additional, thinking: { ...thinking, budget_tokens: Math.min(Number(thinking.budget_tokens), maxTokens - 1024) } };
    }
  }
  if (api === "google-generative-ai" || api === "google-vertex") {
    body.config = { ...record(body.config),
      ...(settings.topP !== undefined ? { topP: settings.topP } : {}),
      ...(settings.frequencyPenalty !== undefined ? { frequencyPenalty: settings.frequencyPenalty } : {}),
      ...(settings.presencePenalty !== undefined ? { presencePenalty: settings.presencePenalty } : {}),
    };
  } else if (api === "bedrock-converse-stream") {
    const inference: Record<string, unknown> = { ...record(body.inferenceConfig), ...(settings.topP !== undefined ? { topP: settings.topP } : {}) };
    const thinking = record(record(body.additionalModelRequestFields).thinking).type;
    if (thinking === "enabled" || thinking === "adaptive") { delete inference.temperature; delete inference.topP; }
    body.inferenceConfig = inference;
  } else if (api === "mistral-conversations") {
    Object.assign(body, {
      ...(settings.topP !== undefined ? { topP: settings.topP } : {}),
      ...(settings.frequencyPenalty !== undefined ? { frequencyPenalty: settings.frequencyPenalty } : {}),
      ...(settings.presencePenalty !== undefined ? { presencePenalty: settings.presencePenalty } : {}),
    });
  } else if (api === "anthropic-messages") {
    // Extended thinking does not accept temperature or top P.
    const thinking = record(body.thinking).type;
    if (settings.topP !== undefined && thinking !== "enabled" && thinking !== "adaptive") body.top_p = settings.topP;
  } else if (api === "openai-completions") {
    Object.assign(body, generationSampling(settings, api));
    // Unlisted compatible models may accept effort without advertising thinking support.
    if (!model.reasoning && settings.reasoning !== undefined) body.reasoning_effort = settings.reasoning === "off" ? "none" : settings.reasoning;
  } else if (["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(api)) {
    if (settings.topP !== undefined && api !== "openai-codex-responses") body.top_p = settings.topP;
    if (!model.reasoning && settings.reasoning !== undefined) body.reasoning = { ...record(body.reasoning), effort: settings.reasoning === "off" ? "none" : settings.reasoning };
  }
  return body;
}

function googleBudget(model: Model<Api>, level: GenerationSettings["reasoning"]): number {
  const resolved = level === "xhigh" || level === "max" || level === "off" || !level ? "high" : level;
  if (model.id.includes("2.5-pro")) return { minimal: 128, low: 2048, medium: 8192, high: 32768 }[resolved];
  if (model.id.includes("2.5-flash-lite")) return { minimal: 512, low: 2048, medium: 8192, high: 24576 }[resolved];
  if (model.id.includes("2.5-flash")) return { minimal: 128, low: 2048, medium: 8192, high: 24576 }[resolved];
  return -1;
}

function rawReasoning(model: Model<Api>, context: TranscriptContext, settings: GenerationSettings, options?: StreamOptions): Record<string, unknown> {
  if (settings.reasoning === undefined) return {};
  const level = model.reasoning ? clampThinkingLevel(model, settings.reasoning) : settings.reasoning;
  const enabled = level !== "off";
  const budget = enabled ? thinkingBudgetForLevel(level) : 0;
  const cap = clampMaxTokensToContext(model, context, settings.maxTokens ?? options?.maxTokens ?? model.maxTokens);
  const mapped = model.thinkingLevelMap?.[level];
  const effort = typeof mapped === "string" ? mapped : level === "minimal" ? "low" : level === "xhigh" || level === "max" ? "high" : level;
  if (model.api === "anthropic-messages") return { thinkingEnabled: enabled, effort, thinkingBudgetTokens: Math.min(budget, Math.max(0, cap - 1024)) };
  if (model.api === "google-generative-ai" || model.api === "google-vertex") {
    const google = model as Model<"google-generative-ai" | "google-vertex">;
    return { thinking: { enabled, ...(usesGoogleThinkingLevel(google) && enabled ? { level: toGoogleThinkingLevel(resolveGoogleThinkingLevel(google, level)) } : { budgetTokens: googleBudget(google, level) }) } };
  }
  return { reasoning: enabled ? level : undefined, reasoningEffort: enabled ? level : undefined,
    ...(model.api === "mistral-conversations" ? { promptMode: enabled && !model.thinkingLevelMap ? "reasoning" : undefined } : {}),
  };
}

/** Connection overrides also cover agent turns and calls made directly through the model registry. */
export function withGenerationSettings(provider: Provider, settings: GenerationSettings): Provider {
  const optionsFor = <T extends StreamOptions>(model: Model<Api>, context: TranscriptContext, options: T | undefined, simple: boolean) => ({
    ...options,
    ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(simple ? settings.reasoning !== undefined ? { reasoning: settings.reasoning === "off" ? undefined : settings.reasoning } : {} : rawReasoning(model, context, settings, options)),
    onPayload: async (payload: unknown, m: Model<Api>) => {
      const subscription = m.provider === "openai" && m.baseUrl === "https://api.openai.com/v1" && options?.apiKey && !options.apiKey.startsWith("sk-");
      return samplingPayload((await options?.onPayload?.(payload, m)) ?? payload, m, subscription ? { ...settings, maxTokens: undefined, temperature: undefined, topP: undefined } : settings);
    },
  });
  return {
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, optionsFor(model, context, options, false) as NonNullable<typeof options>),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, optionsFor(model, context, options, true)),
  };
}
