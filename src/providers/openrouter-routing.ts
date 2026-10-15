import type { Provider } from "@earendil-works/pi-ai";

export interface OpenRouterRouting {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
  zdr?: boolean;
  sort?: "price" | "throughput" | "latency";
  quantizations?: string[];
  max_price?: { prompt?: number; completion?: number };
}

export function supportsOpenRouterRouting(connection: { providerId?: unknown; proxyOf?: unknown; baseUrl?: unknown; api?: unknown }): boolean {
  if (connection.api === "openai-text") return false;
  if (connection.providerId === "openrouter" || connection.proxyOf === "openrouter") return true;
  if (typeof connection.baseUrl !== "string") return false;
  try {
    const url = new URL(connection.baseUrl);
    return url.hostname === "openrouter.ai" || url.hostname.endsWith(".openrouter.ai");
  } catch { return false; }
}

export function validateOpenRouterRouting(input: unknown):
  | { ok: true; value: OpenRouterRouting | null }
  | { ok: false; error: string } {
  if (input === null) return { ok: true, value: null };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "OpenRouter routing must be an object" };
  const result: OpenRouterRouting = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "order" || key === "only" || key === "ignore" || key === "quantizations") {
      if (!Array.isArray(value) || value.length > 100 || !value.every((slug) => typeof slug === "string" && slug.trim() && slug.length <= 200 && !/\s/.test(slug.trim()))) {
        return { ok: false, error: `${key} must be a list of provider or quantization slugs` };
      }
      const slugs = [...new Set(value.map((slug: string) => slug.trim()))];
      if (slugs.length) result[key] = slugs;
    } else if (key === "allow_fallbacks" || key === "require_parameters" || key === "zdr") {
      if (typeof value !== "boolean") return { ok: false, error: `${key} must be true or false` };
      result[key] = value;
    } else if (key === "data_collection") {
      if (value !== "allow" && value !== "deny") return { ok: false, error: "data_collection must be allow or deny" };
      result[key] = value;
    } else if (key === "sort") {
      if (value !== "price" && value !== "throughput" && value !== "latency") return { ok: false, error: "sort must be price, throughput or latency" };
      result[key] = value;
    } else if (key === "max_price") {
      if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "max_price must contain input or output prices" };
      const price: NonNullable<OpenRouterRouting["max_price"]> = {};
      for (const [side, amount] of Object.entries(value)) {
        if ((side !== "prompt" && side !== "completion") || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
          return { ok: false, error: "maximum prices must be finite non-negative numbers" };
        }
        price[side] = amount;
      }
      if (Object.keys(price).length) result.max_price = price;
    } else return { ok: false, error: `unknown OpenRouter routing field: ${key}` };
  }
  if (result.only?.some((slug) => result.ignore?.includes(slug))) return { ok: false, error: "a provider cannot be both allowed and blocked" };
  return { ok: true, value: Object.keys(result).length ? result : null };
}

function routedPayload(payload: unknown, routing: OpenRouterRouting): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("OpenRouter request payload is missing");
  const request = payload as Record<string, unknown>;
  const existing = request.provider && typeof request.provider === "object" && !Array.isArray(request.provider)
    ? request.provider as Record<string, unknown> : {};
  const prices = existing.max_price && typeof existing.max_price === "object" && !Array.isArray(existing.max_price)
    ? existing.max_price as Record<string, unknown> : {};
  return { ...request, provider: { ...existing, ...routing, ...(routing.max_price ? { max_price: { ...prices, ...routing.max_price } } : {}) } };
}

/** Saved connection restrictions apply after per-request payload changes. */
export function withOpenRouterRouting(provider: Provider, routing: OpenRouterRouting): Provider {
  return {
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, {
      ...options,
      onPayload: async (payload, m) => routedPayload((await options?.onPayload?.(payload, m)) ?? payload, routing),
    } as NonNullable<typeof options>),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, {
      ...options,
      onPayload: async (payload, m) => routedPayload((await options?.onPayload?.(payload, m)) ?? payload, routing),
    }),
    ...(provider.generateImages ? { generateImages: (model, context, options) => provider.generateImages!(model, context, {
      ...options,
      onPayload: async (payload, m) => routedPayload((await options?.onPayload?.(payload, m)) ?? payload, routing),
    }) } satisfies Pick<Provider, "generateImages"> : {}),
  };
}
