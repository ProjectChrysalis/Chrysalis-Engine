/**
 * OpenRouter's live model list, between catalog updates.
 *
 * OpenRouter publishes every model it serves, with limits and prices, at a
 * public endpoint that needs no key. The engine reads it once an hour while
 * model updates are on. A model the shipped catalog knows takes the live
 * context window, output limit and price; a model it lacks joins on the
 * chat-completions route, with the request settings of a shipped model from
 * the same vendor.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { openRouterCost, type OpenRouterPricing } from "@earendil-works/pi-ai/providers/openrouter-api";
import { log } from "../logger.js";

type Provider = import("@earendil-works/pi-ai").Provider;
type AnyModel = Model<Api> & { type?: string };

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const ROUTE = { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" } as const;
const HOUR = 60 * 60 * 1000;

export interface LiveModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: Model<Api>["cost"];
}

let live: Map<string, LiveModel> | null = null;
let fetchedAt = 0;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Chat models from the /models response; entries without a context window are left out. */
export function parseOpenRouterModels(body: unknown): LiveModel[] {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  const out: LiveModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as {
      id?: unknown; name?: unknown; context_length?: unknown; supported_parameters?: unknown; pricing?: OpenRouterPricing;
      architecture?: { input_modalities?: unknown; output_modalities?: unknown };
      top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
    };
    if (typeof e.id !== "string" || !e.id || e.id.length > 200) continue;
    const outputs: unknown = e.architecture?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes("text")) continue;
    const contextWindow = num(e.top_provider?.context_length) || num(e.context_length);
    if (!contextWindow) continue;
    const inputs: unknown = e.architecture?.input_modalities;
    out.push({
      id: e.id,
      name: typeof e.name === "string" && e.name ? e.name : e.id,
      contextWindow,
      // a missing output limit means the reply may fill whatever the context leaves
      maxTokens: num(e.top_provider?.max_completion_tokens) || contextWindow,
      reasoning: Array.isArray(e.supported_parameters) && e.supported_parameters.includes("reasoning"),
      input: Array.isArray(inputs) && inputs.includes("image") ? ["text", "image"] : ["text"],
      cost: openRouterCost(e.pricing),
    });
  }
  return out;
}

/** Use this list in place of the last one; true when anything in it changed. */
export function setOpenRouterModels(models: LiveModel[] | null): boolean {
  const next = models ? new Map(models.map((m) => [m.id, m])) : null;
  const same = JSON.stringify(live ? [...live.values()] : null) === JSON.stringify(next ? [...next.values()] : null);
  live = next;
  return !same;
}

/** Fetch the list when the last one is an hour old; true when it changed. */
export async function refreshOpenRouterModels(fetchImpl: typeof fetch = fetch, force = false): Promise<boolean> {
  if (!force && live && Date.now() - fetchedAt < HOUR - 60_000) return false;
  const res = await fetchImpl(MODELS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`OpenRouter's model list answered ${res.status}`);
  const models = parseOpenRouterModels(await res.json());
  if (!models.length) throw new Error("OpenRouter's model list was empty");
  fetchedAt = Date.now();
  return setOpenRouterModels(models);
}

/** The OpenRouter provider with the live list folded in; other providers pass through. */
export function withLiveOpenRouter(provider: Provider): Provider {
  if (provider.id !== "openrouter") return provider;
  const merge = (models: readonly AnyModel[]): AnyModel[] => {
    if (!live) return [...models];
    const seen = new Set<string>();
    const out = models.map((m) => {
      if ((m.type ?? "chat") !== "chat") return m;
      seen.add(m.id);
      const l = live!.get(m.id);
      return l ? { ...m, contextWindow: l.contextWindow, maxTokens: l.maxTokens, cost: l.cost } : m;
    });
    const routed = models.filter((m) => (m.type ?? "chat") === "chat" && m.api === ROUTE.api && m.baseUrl === ROUTE.baseUrl);
    const fallback = routed[0];
    if (!fallback) return out;
    for (const l of live.values()) {
      if (seen.has(l.id)) continue;
      const vendor = l.id.split("/")[0];
      const sibling = routed.find((m) => m.id.split("/")[0] === vendor) ?? fallback;
      out.push({
        type: "chat",
        id: l.id,
        name: l.name,
        api: ROUTE.api,
        baseUrl: ROUTE.baseUrl,
        provider: provider.id,
        reasoning: l.reasoning,
        input: l.input,
        cost: l.cost,
        contextWindow: l.contextWindow,
        maxTokens: l.maxTokens,
        ...("compat" in sibling && sibling.compat ? { compat: sibling.compat } : {}),
      } as AnyModel);
    }
    return out;
  };
  return {
    ...provider,
    getModels: () => merge(provider.getModels() as readonly AnyModel[]) as never,
    ...(provider.getAllModels ? { getAllModels: () => merge(provider.getAllModels!() as readonly AnyModel[]) as never } : {}),
  } as Provider;
}

/** Keep the list fresh while `enabled` says so, calling `onChanged` when it moved. */
export function startOpenRouterModels(opts: { enabled: () => boolean; onChanged: () => void }): () => void {
  const tick = () => {
    if (!opts.enabled()) {
      if (setOpenRouterModels(null)) opts.onChanged();
      return;
    }
    refreshOpenRouterModels()
      .then((changed) => { if (changed) opts.onChanged(); })
      .catch((e) => log.warn(`[models] OpenRouter model list: ${(e as Error).message}`));
  };
  const first = setTimeout(tick, 25_000);
  const timer = setInterval(tick, 10 * 60 * 1000);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
