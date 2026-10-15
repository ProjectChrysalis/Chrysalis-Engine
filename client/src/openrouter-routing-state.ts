import type { OpenRouterRouting } from "../../src/providers/openrouter-routing.js"

export interface RoutingDraft {
  order: string
  only: string
  ignore: string
  quantizations: string
  allow_fallbacks: "default" | "true" | "false"
  require_parameters: "default" | "true" | "false"
  zdr: "default" | "true" | "false"
  data_collection: "default" | "allow" | "deny"
  sort: "default" | "price" | "throughput" | "latency"
  inputPrice: string
  outputPrice: string
}

export function routingSelections(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))]
}

export function toggleRoutingSelection(draft: RoutingDraft, key: "order" | "only" | "ignore" | "quantizations", slug: string): RoutingDraft {
  const selected = routingSelections(draft[key])
  const adding = !selected.includes(slug)
  const next = { ...draft, [key]: (adding ? [...selected, slug] : selected.filter((value) => value !== slug)).join(", ") }
  if (adding && (key === "only" || key === "ignore")) {
    const opposite = key === "only" ? "ignore" : "only"
    next[opposite] = routingSelections(next[opposite]).filter((value) => value !== slug).join(", ")
  }
  return next
}

export function moveRoutingSelection(draft: RoutingDraft, slug: string, direction: -1 | 1): RoutingDraft {
  const selected = routingSelections(draft.order)
  const index = selected.indexOf(slug)
  const target = index + direction
  if (index < 0 || target < 0 || target >= selected.length) return draft
  selected.splice(index, 1)
  selected.splice(target, 0, slug)
  return { ...draft, order: selected.join(", ") }
}

export function routingDraft(value?: OpenRouterRouting): RoutingDraft {
  const choice = (value: boolean | undefined) => value === undefined ? "default" as const : value ? "true" as const : "false" as const
  return {
    order: value?.order?.join(", ") ?? "", only: value?.only?.join(", ") ?? "", ignore: value?.ignore?.join(", ") ?? "",
    quantizations: value?.quantizations?.join(", ") ?? "",
    allow_fallbacks: choice(value?.allow_fallbacks), require_parameters: choice(value?.require_parameters), zdr: choice(value?.zdr),
    data_collection: value?.data_collection ?? "default", sort: value?.sort ?? "default",
    inputPrice: value?.max_price?.prompt === undefined ? "" : String(value.max_price.prompt),
    outputPrice: value?.max_price?.completion === undefined ? "" : String(value.max_price.completion),
  }
}

export function routingBody(draft: RoutingDraft, priceError = "Price caps must be non-negative numbers."): OpenRouterRouting | null {
  const value: OpenRouterRouting = {}
  for (const key of ["order", "only", "ignore", "quantizations"] as const) {
    const slugs = routingSelections(draft[key])
    if (slugs.length) value[key] = slugs
  }
  for (const key of ["allow_fallbacks", "require_parameters", "zdr"] as const) {
    if (draft[key] !== "default") value[key] = draft[key] === "true"
  }
  if (draft.data_collection !== "default") value.data_collection = draft.data_collection
  if (draft.sort !== "default") value.sort = draft.sort
  const price: NonNullable<OpenRouterRouting["max_price"]> = {}
  for (const [key, text] of [["prompt", draft.inputPrice], ["completion", draft.outputPrice]] as const) {
    if (!text.trim()) continue
    const amount = Number(text)
    if (!Number.isFinite(amount) || amount < 0) throw new Error(priceError)
    price[key] = amount
  }
  if (Object.keys(price).length) value.max_price = price
  return Object.keys(value).length ? value : null
}

export function isOpenRouterConnection(connection: { providerId?: string; proxyOf?: string; baseUrl?: string; api?: string }): boolean {
  if (connection.api === "openai-text") return false
  if (connection.providerId === "openrouter" || connection.proxyOf === "openrouter") return true
  try {
    const hostname = new URL(connection.baseUrl ?? "").hostname
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai")
  } catch { return false }
}

