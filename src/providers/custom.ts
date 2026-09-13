/**
 * Custom + curated providers.
 *
 * Custom (user-editable, git-tracked): providers.json describes endpoints.
 *   - models: explicit list, OR "auto" → dynamic discovery via GET {baseUrl}/models
 *     (OpenAI-compatible standard; cached + refreshed by pi-ai's catalog store).
 * Curated (shipped by Chrysalis): well-known aggregators users just add a key for.
 * API keys live in the user's auth.json (OUTSIDE git) — never in providers.json.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { createProvider, type Api, type Model, type Provider, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { stream as streamOai, streamSimple as streamSimpleOai } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamAnth, streamSimple as streamSimpleAnth } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOaiResponses, streamSimple as streamSimpleOaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as streamGoogle, streamSimple as streamSimpleGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { log } from "../logger.js";
import { isPrivateAddress } from "../net-guard.js";

export interface CustomModelDef {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** Accepts image parts in the prompt. */
  vision?: boolean;
  /** Per-million-token rates, when the endpoint quotes them. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface CustomProviderDef {
  name?: string;
  api: "openai-completions" | "anthropic-messages" | "openai-responses" | "google-generative-ai";
  baseUrl: string;
  headers?: Record<string, string>;
  /** Explicit model list, or "auto" to discover from GET {baseUrl}/models. */
  models: CustomModelDef[] | "auto";
  /** Query string for discovery, for catalogs that only quote sizes and
   *  prices when asked. */
  modelsQuery?: string;
  /** Wire format for the reasoning effort ("openrouter": reasoning: {effort}). */
  thinkingFormat?: "openai" | "openrouter";
  /** Extra request-body fields per model, merged over the built body. */
  extraBody?: (modelId: string) => Record<string, unknown> | undefined;
}

export interface ProvidersFile {
  providers: Record<string, CustomProviderDef>;
}

/**
 * Curated providers (no keys shipped — each appears in /v1/models only once
 * its key exists in the user's auth.json): widely used OpenAI-compatible
 * gateways. The catalog comes from the endpoint's own /models route where one
 * exists; a static list means the endpoint has no discovery route. A private
 * or experimental endpoint belongs in the user's providers.json instead.
 */
/** Claude routes on NanoGPT cache only through its own body switch: the
 *  endpoint places the breakpoints itself and pins the upstream so the cache
 *  is hit on the next turn. Other routes cache implicitly, and sending the
 *  switch for them steers routing off subscription-covered upstreams. */
const NANOGPT_CLAUDE = /(?:^|\/)(?:anthropic\/)?claude[-_]/i;
const nanoGptBody = (modelId: string): Record<string, unknown> | undefined =>
  NANOGPT_CLAUDE.test(modelId) ? { prompt_caching: { enabled: true, ttl: "5m", stickyProvider: true } } : undefined;

export const CURATED_PROVIDERS: Record<string, CustomProviderDef & { docsUrl: string }> = {
  aimlapi: {
    name: "AI/ML API",
    api: "openai-completions",
    baseUrl: "https://api.aimlapi.com/v1",
    models: "auto",
    docsUrl: "https://docs.aimlapi.com",
  },
  chutes: {
    name: "Chutes",
    api: "openai-completions",
    baseUrl: "https://llm.chutes.ai/v1",
    models: "auto",
    docsUrl: "https://docs.chutes.ai",
  },
  cohere: {
    name: "Cohere",
    api: "openai-completions",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    models: "auto",
    docsUrl: "https://docs.cohere.com/docs/compatibility-api",
  },
  cometapi: {
    name: "CometAPI",
    api: "openai-completions",
    baseUrl: "https://api.cometapi.com/v1",
    models: "auto",
    docsUrl: "https://www.cometapi.com/",
  },
  deepinfra: {
    name: "DeepInfra",
    api: "openai-completions",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    models: "auto",
    docsUrl: "https://deepinfra.com/docs/openai_api",
  },
  dreamgen: {
    name: "DreamGen",
    api: "openai-completions",
    baseUrl: "https://dreamgen.com/api/openai/v1",
    models: "auto",
    docsUrl: "https://dreamgen.com/docs",
  },
  electronhub: {
    name: "ElectronHub",
    api: "openai-completions",
    baseUrl: "https://api.electronhub.ai/v1",
    models: "auto",
    docsUrl: "https://docs.electronhub.ai",
  },
  featherless: {
    name: "Featherless AI",
    api: "openai-completions",
    baseUrl: "https://api.featherless.ai/v1",
    models: "auto",
    docsUrl: "https://featherless.ai/docs",
  },
  infermatic: {
    name: "Infermatic",
    api: "openai-completions",
    baseUrl: "https://api.totalgpt.ai/v1",
    models: "auto",
    docsUrl: "https://infermatic.ai",
  },
  nanogpt: {
    name: "NanoGPT",
    api: "openai-completions",
    baseUrl: "https://nano-gpt.com/api/v1",
    models: "auto",
    modelsQuery: "detailed=true",
    thinkingFormat: "openrouter",
    extraBody: nanoGptBody,
    docsUrl: "https://nano-gpt.com/api",
  },
  "nanogpt-subscription": {
    name: "NanoGPT (subscription models only)",
    api: "openai-completions",
    baseUrl: "https://nano-gpt.com/api/subscription/v1",
    models: "auto",
    modelsQuery: "detailed=true",
    thinkingFormat: "openrouter",
    extraBody: nanoGptBody,
    docsUrl: "https://docs.nano-gpt.com/api-reference/endpoint/chat-completion",
  },
  novita: {
    name: "Novita",
    api: "openai-completions",
    baseUrl: "https://api.novita.ai/openai/v1",
    models: "auto",
    docsUrl: "https://novita.ai/docs/guides/llm-api",
  },
  "ollama-cloud": {
    name: "Ollama Cloud",
    api: "openai-completions",
    baseUrl: "https://ollama.com/v1",
    models: "auto",
    docsUrl: "https://docs.ollama.com/cloud",
  },
  perplexity: {
    name: "Perplexity",
    api: "openai-completions",
    baseUrl: "https://api.perplexity.ai",
    // Perplexity serves no /models route: the model list is fixed
    models: [
      { id: "sonar" },
      { id: "sonar-pro" },
      { id: "sonar-reasoning", reasoning: true },
      { id: "sonar-reasoning-pro", reasoning: true },
      { id: "sonar-deep-research", reasoning: true },
      { id: "r1-1776", reasoning: true },
    ],
    docsUrl: "https://docs.perplexity.ai",
  },
  siliconflow: {
    name: "SiliconFlow",
    api: "openai-completions",
    baseUrl: "https://api.siliconflow.com/v1",
    models: "auto",
    docsUrl: "https://docs.siliconflow.com",
  },
  "siliconflow-cn": {
    name: "SiliconFlow (China)",
    api: "openai-completions",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: "auto",
    docsUrl: "https://docs.siliconflow.cn",
  },
  umans: {
    name: "Umans AI Coding Plan",
    api: "openai-completions",
    baseUrl: "https://api.code.umans.ai/v1",
    models: "auto",
    docsUrl: "https://umans.ai",
  },
  venice: {
    name: "Venice",
    api: "openai-completions",
    baseUrl: "https://api.venice.ai/api/v1",
    models: "auto",
    docsUrl: "https://docs.venice.ai",
  },
  zenmux: {
    name: "ZenMux",
    api: "openai-completions",
    baseUrl: "https://zenmux.ai/api/v1",
    models: "auto",
    docsUrl: "https://docs.zenmux.ai",
  },
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Sent as the bearer of an endpoint saved without a key. The client library
 *  refuses to build a request without one; a server that runs keyless ignores
 *  it and one that wants a key answers 401, which is the error to show. */
const NO_KEY = "no-key";

/** A model server on this machine or the home network: localhost, a LAN name
 *  (single label or .local), or a private address literal. These serve over
 *  plain http and usually without a key. Link-local is not a LAN host: it is
 *  where cloud metadata services live. */
export function isLocalEndpoint(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (!net.isIP(host)) return !host.includes(".");
  if (host.startsWith("169.254.") || /^fe[89ab]/.test(host)) return false;
  return isPrivateAddress(host);
}

/** May this stored key be sent to `url`? Only a key saved FOR that endpoint.
 *  Custom endpoints live in user-editable files (providers.json in the
 *  workspace, connections.json with the credentials), so a key without a
 *  binding would follow an edited URL anywhere. */
export function keyBoundTo(credential: unknown, url: string): boolean {
  const bound = (credential as { boundBaseUrl?: unknown } | undefined)?.boundBaseUrl;
  return typeof bound === "string" && normalizeUrl(bound) === normalizeUrl(url);
}

/** Provider ids whose endpoint is defined in code. A workspace file may not
 *  reuse one: its credential is unbound, so the redefinition would carry the
 *  real provider's key to whatever URL the file names. */
export function reservedProviderIds(): Set<string> {
  return new Set<string>([...getBuiltinProviders(), "radius", ...Object.keys(CURATED_PROVIDERS)]);
}

/** api_key credential with optional endpoint binding (SPEC-v2 §S2.3). */
export type CredentialWithBinding = { key?: string; boundBaseUrl?: string } | undefined;

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** A positive finite number from a field endpoints send as either a number or
 *  a decimal string. */
function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Per-token rates as quoted by aggregator catalogs, converted to the
 *  per-million-token rates the cost math uses. All four keys are required
 *  downstream, so a quote with only prompt/completion still yields a complete
 *  record (an uncharged cache tier is genuinely 0, not unknown). A catalog
 *  that quotes nothing at all returns undefined so the model reads as
 *  "no price known" rather than "free". */
function mapPricing(v: unknown): CustomModelDef["cost"] {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Record<string, unknown>;
  // the base fields are per token unless the catalog labels its unit
  const scale = p.unit === "per_million_tokens" ? 1 : 1_000_000;
  const perM = (...keys: string[]): number => {
    for (const k of keys) {
      const n = num(p[k]);
      if (n !== undefined) return n * scale;
    }
    return 0;
  };
  const per1k = (key: string): number => {
    const n = num(p[key]);
    return n === undefined ? 0 : n * 1_000;
  };
  const cost = {
    input: perM("prompt", "input"),
    output: perM("completion", "output"),
    cacheRead: perM("input_cache_read", "cache_read", "cached_input") || per1k("cacheReadInputPer1kTokens"),
    cacheWrite: perM("input_cache_write", "cache_write") || per1k("cacheWriteInputPer1kTokens"),
  };
  if (!(cost.input || cost.output || cost.cacheRead || cost.cacheWrite)) return undefined;
  // Unlabelled fields are quoted per TOKEN. A catalog that quoted per million
  // instead would land here a million times too high, and every cost the user
  // is shown would be fiction — report the model as unpriced rather than
  // that. No real model costs four figures per million tokens.
  if (Math.max(cost.input, cost.output, cost.cacheRead, cost.cacheWrite) > 10_000) return undefined;
  return cost;
}

/** Map an OpenAI-compatible GET /models response to model defs. The spec only
 *  guarantees `id`; aggregator catalogs also quote a display name, context
 *  size and token prices, and those are the numbers the client reports as
 *  context pressure and spend, so take them wherever they are offered. */
export function mapOpenAiModelsResponse(data: unknown): CustomModelDef[] {
  const arr = (data as { data?: unknown[] })?.data;
  if (!Array.isArray(arr)) return [];
  const out: CustomModelDef[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = raw.id;
    if (typeof id !== "string" || !id) continue;
    const top = (raw.top_provider ?? {}) as Record<string, unknown>;
    const name = typeof raw.name === "string" && raw.name ? raw.name : undefined;
    const contextWindow = num(raw.context_length) ?? num(raw.context_window) ?? num(top.context_length);
    const maxTokens = num(raw.max_completion_tokens) ?? num(raw.max_output_tokens) ?? num(top.max_completion_tokens);
    const cost = mapPricing(raw.pricing);
    const params = raw.supported_parameters;
    const caps = (raw.capabilities ?? {}) as Record<string, unknown>;
    const reasoning = (Array.isArray(params) && params.includes("reasoning")) || caps.reasoning === true;
    const modalities = ((raw.architecture ?? {}) as Record<string, unknown>).input_modalities;
    const vision = caps.vision === true || (Array.isArray(modalities) && modalities.includes("image"));
    out.push({
      id,
      ...(name ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(vision ? { vision } : {}),
      ...(cost ? { cost } : {}),
    });
  }
  return out;
}

/** Anthropic models reached through an OpenAI-compatible aggregator, by the
 *  vendor-prefixed ids those catalogs use ("anthropic/claude-…") or a bare
 *  "claude-…". Deliberately narrow: the marker below is meaningless to every
 *  other vendor. */
const ANTHROPIC_MODEL = /(^|\/)anthropic[/.]|^claude-/i;

/**
 * Prompt caching for Anthropic models on an OpenAI-compatible endpoint.
 *
 * Caching there is opt-in per request: without `cache_control` markers on the
 * prompt, every turn re-reads the whole context at full price and the cached
 * token count is always zero. The library adds the markers when the model's
 * compat says so, but only auto-detects that for its own built-in aggregator
 * entry, so a connection the USER pointed at the same aggregator never caches.
 * Setting it here is what turns caching on for those connections.
 *
 * Only the flag is set; every other compat key stays auto-detected. An
 * endpoint with its own caching switch (extraBody) places the breakpoints
 * itself, so no markers are added there.
 */
function compatFor(api: Api, modelId: string, baseUrl: string, cachesItself: boolean): { cacheControlFormat: "anthropic" } | undefined {
  if (api !== "openai-completions" || cachesItself || !ANTHROPIC_MODEL.test(modelId)) return undefined;
  // a local model stack never serves Anthropic, and is the one kind of
  // endpoint likely to choke on a content-part key it doesn't know
  if (isLocalEndpoint(baseUrl)) return undefined;
  return { cacheControlFormat: "anthropic" };
}

/** An endpoint's identity for catalog matching: the same host serves the same
 *  models whether or not the configured URL carries the /v1 suffix. */
const endpointKey = (url: string): string => normalizeUrl(url).replace(/\/v1$/, "");

let catalogByEndpoint: Map<string, Model<Api>> | null = null;

/** The built-in catalog's entry for this exact model at this exact endpoint.
 *  Many OpenAI-compatible endpoints list bare ids with no sizes; when the user
 *  points a custom connection at an endpoint the catalog already describes,
 *  the catalog's numbers are the real ones for that model. A different
 *  endpoint serving the same id is NOT consulted: sizes vary per host. */
function catalogEntry(baseUrl: string, id: string): Model<Api> | undefined {
  if (!catalogByEndpoint) {
    catalogByEndpoint = new Map();
    for (const provider of getBuiltinProviders()) {
      for (const cm of getBuiltinModels(provider) as Model<Api>[]) {
        catalogByEndpoint.set(`${endpointKey(cm.baseUrl)}\n${cm.id}`, cm);
      }
    }
  }
  return catalogByEndpoint.get(`${endpointKey(baseUrl)}\n${id}`);
}

function toModel(m: CustomModelDef, providerId: string, api: Api, def: CustomProviderDef): Model<Api> {
  const { baseUrl, headers } = def;
  const cacheCompat = compatFor(api, m.id, baseUrl, !!def.extraBody);
  const compat = def.thinkingFormat && api === "openai-completions" ? { ...cacheCompat, thinkingFormat: def.thinkingFormat } : cacheCompat;
  const known = catalogEntry(baseUrl, m.id);
  const model: Model<Api> = {
    id: m.id,
    name: m.name ?? known?.name ?? m.id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: m.reasoning === true || known?.reasoning === true,
    input: m.vision || known?.input.includes("image") ? ["text", "image"] : ["text"],
    cost: m.cost ?? known?.cost ?? ZERO_COST,
    // 0 = unknown: the library skips its context clamp, and the client hides
    // the context meter instead of measuring against an invented window
    contextWindow: m.contextWindow ?? known?.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? known?.maxTokens ?? 8192,
    ...(headers ? { headers } : {}),
  };
  // `compat` is typed per-api on Model; it is only built for the
  // openai-completions branch, and that is the branch this model is on.
  if (compat) (model as Model<"openai-completions">).compat = compat;
  return model;
}

const API_WIRING: Record<CustomProviderDef["api"], { api: Api; stream: never; streamSimple: never }> = {
  "openai-completions": { api: "openai-completions", stream: streamOai as never, streamSimple: streamSimpleOai as never },
  "anthropic-messages": { api: "anthropic-messages", stream: streamAnth as never, streamSimple: streamSimpleAnth as never },
  "openai-responses": { api: "openai-responses", stream: streamOaiResponses as never, streamSimple: streamSimpleOaiResponses as never },
  "google-generative-ai": { api: "google-generative-ai", stream: streamGoogle as never, streamSimple: streamSimpleGoogle as never },
};

export function buildProvider(
  id: string,
  def: CustomProviderDef,
  opts: {
    codeDefined?: boolean;
    /** The user saved this endpoint themselves and may have saved it without
     *  a key (a local model server): no stored key still resolves. */
    keyless?: boolean;
    readCredential?: (id: string) => CredentialWithBinding;
  } = {},
): Provider {
  const wiring = API_WIRING[def.api] ?? API_WIRING["openai-completions"];
  const api = wiring.api;
  const staticModels: Model<Api>[] = Array.isArray(def.models)
    ? def.models.filter((m) => m?.id).map((m) => toModel(m, id, api, def))
    : [];
  if (Array.isArray(def.models) && staticModels.length === 0) throw new Error("no valid models listed");

  // SECURITY (SPEC-v2 §S2.3): keys are bound to the endpoint they were
  // configured for. If providers.json later points elsewhere (agent edit /
  // typo / attack), resolution REFUSES instead of sending the key to a new
  // host. Only a code-defined endpoint (curated) may use an unbound key.
  const credentialUsable = (credential: NonNullable<CredentialWithBinding>): boolean =>
    opts.codeDefined === true ? !credential.boundBaseUrl || keyBoundTo(credential, def.baseUrl) : keyBoundTo(credential, def.baseUrl);

  return createProvider({
    id,
    name: def.name ?? id,
    baseUrl: def.baseUrl,
    auth: {
      apiKey: {
        name: `${def.name ?? id} API key`,
        resolve: async ({ credential }: { credential?: CredentialWithBinding }) => {
          if (!credential?.key) return opts.keyless ? { auth: { apiKey: NO_KEY }, source: "no key" } : undefined;
          if (!credentialUsable(credential)) {
            log.warn(
              `[custom-provider:${id}] key ${credential.boundBaseUrl ? `bound to ${credential.boundBaseUrl}` : "has no endpoint binding"} but provider points at ${def.baseUrl} — refusing (re-add key for the new endpoint)`,
            );
            return undefined;
          }
          return { auth: { apiKey: credential.key }, source: "auth.json" };
        },
      },
    },
    models: staticModels,
    // "auto": dynamic catalog via GET {baseUrl}/models (OpenAI-compatible standard)
    ...(def.models === "auto"
      ? {
          fetchModels: async (context: RefreshModelsContext) => {
            // pi-ai hands the RESOLVED credential here (key without the
            // endpoint binding that was just validated), so re-read the stored
            // one and apply the same rule: discovery may only use a key that
            // is bound to this exact endpoint.
            const stored = opts.readCredential ? opts.readCredential(id) : (context.credential as CredentialWithBinding | undefined);
            const key = stored?.key === NO_KEY ? undefined : stored?.key;
            if (stored && key ? !credentialUsable(stored) : !opts.keyless) return [];
            const auth: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
            const url = def.baseUrl.replace(/\/$/, "") + "/models" + (def.modelsQuery ? `?${def.modelsQuery}` : "");
            const res = await fetch(url, {
              headers: { ...auth, ...def.headers },
              signal: AbortSignal.timeout(15_000),
            });
            // error text must not echo the URL's query string — a key pasted
            // into a baseUrl (?key=…) would otherwise ride back to the client
            if (!res.ok) throw new Error(`${url.replace(/[?#].*$/, "")} → HTTP ${res.status}`);
            const listed = mapOpenAiModelsResponse(await res.json());
            const only = listed.length === 1 ? listed[0] : undefined;
            if (only && !only.contextWindow && isLocalEndpoint(def.baseUrl)) {
              const n = await loadedContextSize(def.baseUrl, { ...auth, ...def.headers });
              if (n) only.contextWindow = n;
            }
            return listed.map((m) => toModel(m, id, api, def));
          },
        }
      : {}),
    api: def.extraBody ? withExtraBody(wiring, def.extraBody) : { stream: wiring.stream, streamSimple: wiring.streamSimple },
  });
}

/** The context size a local server actually loaded the model with. Its
 *  /models list names the model only; llama.cpp's server and KoboldCpp report
 *  the running n_ctx at /props. Asked only when the server lists a single
 *  model: with several, the answer belongs to whichever one is loaded. */
async function loadedContextSize(baseUrl: string, headers: Record<string, string>): Promise<number | undefined> {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/props", {
      headers,
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return undefined;
    const props = (await res.json()) as { default_generation_settings?: { n_ctx?: unknown }; n_ctx?: unknown };
    return num(props.default_generation_settings?.n_ctx) ?? num(props.n_ctx);
  } catch {
    return undefined;
  }
}

/** Stop a local server's generation. Closing the stream is not enough for
 *  KoboldCpp: it keeps generating to the end of max tokens and holds the GPU
 *  until then, unless told to abort. Other servers stop on disconnect and
 *  answer this route with a 404, which is ignored. */
export function abortLocalGeneration(baseUrl: string): void {
  if (!isLocalEndpoint(baseUrl)) return;
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  fetch(root + "/api/extra/abort", { method: "POST", signal: AbortSignal.timeout(5_000) }).catch(() => {});
}

type StreamFn = (model: Model<Api>, context: unknown, options?: { onPayload?: (payload: unknown, model: Model<Api>) => unknown }) => unknown;

/** Merge per-model body fields into the finished request, after any payload
 *  hook the caller passed. */
function withExtraBody(
  wiring: { stream: never; streamSimple: never },
  extraBody: NonNullable<CustomProviderDef["extraBody"]>,
): { stream: never; streamSimple: never } {
  const wrap = (base: StreamFn): StreamFn => (model, context, options) =>
    base(model, context, {
      ...options,
      onPayload: async (payload, m) => {
        const next = (await options?.onPayload?.(payload, m)) ?? payload;
        const extra = extraBody(m.id);
        return extra && next && typeof next === "object" ? { ...next, ...extra } : next;
      },
    });
  return { stream: wrap(wiring.stream) as never, streamSimple: wrap(wiring.streamSimple) as never };
}

export function loadCustomProviders(providersJsonPath: string, readCredential?: (id: string) => CredentialWithBinding): Provider[] {
  let file: ProvidersFile;
  try {
    file = JSON.parse(readFileSync(providersJsonPath, "utf8")) as ProvidersFile;
  } catch {
    return [];
  }
  const out: Provider[] = [];
  const reserved = reservedProviderIds();
  for (const [id, def] of Object.entries(file.providers ?? {})) {
    if (reserved.has(id)) {
      log.warn(`[custom-provider:${id}] skipped: that id belongs to a built-in provider`);
      continue;
    }
    if (!def?.baseUrl || (Array.isArray(def.models) ? def.models.length === 0 : def.models !== "auto")) {
      log.warn(`[custom-provider:${id}] skipped: needs baseUrl and models (list or "auto")`);
      continue;
    }
    try {
      out.push(buildProvider(id, def, readCredential ? { readCredential } : {}));
    } catch (e) {
      log.warn(`[custom-provider:${id}] failed: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Curated providers (always registered; inert until their key exists in auth.json). */
export function curatedProviders(): Provider[] {
  const out: Provider[] = [];
  for (const [id, def] of Object.entries(CURATED_PROVIDERS)) {
    try {
      out.push(buildProvider(id, def, { codeDefined: true }));
    } catch (e) {
      log.warn(`[curated-provider:${id}] failed: ${(e as Error).message}`);
    }
  }
  return out;
}
