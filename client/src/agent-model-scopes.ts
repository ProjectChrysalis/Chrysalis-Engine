export type AgentCatalogModel = { provider: string; modelId: string; label: string; connectionName: string | null; contextWindow: number | null }
export type AgentModelScope = { ref: string; label: string; detail: string; search: string }
const compact = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "")

export function agentModelScopes(models: readonly AgentCatalogModel[], saved: readonly string[], selected: string, defaultsLabel: string): AgentModelScope[] {
  const catalog = new Map(models.map((model) => [`${model.provider}/${model.modelId}`, model]))
  const configured = new Set(saved)
  const refs = new Set([...catalog.keys(), ...saved])
  const priority = (ref: string) => ref === selected ? 0 : configured.has(ref) ? 1 : 2
  const scopes = [...refs].map((ref) => {
    const model = catalog.get(ref)
    const label = model?.label ?? ref
    const detail = model ? `${model.connectionName ?? model.provider} · ${model.modelId}` : ref
    return { ref, label, detail, search: compact(`${label} ${detail} ${ref}`) }
  }).sort((a, b) => priority(a.ref) - priority(b.ref) || a.label.localeCompare(b.label) || a.ref.localeCompare(b.ref))
  return [{ ref: "", label: defaultsLabel, detail: "", search: compact(defaultsLabel) }, ...scopes]
}

export function searchAgentModelScopes(scopes: readonly AgentModelScope[], query: string): AgentModelScope[] {
  const terms = query.trim().split(/\s+/).map(compact).filter(Boolean)
  if (!terms.length) return [...scopes]
  const exact = compact(query)
  const rank = (scope: AgentModelScope) => compact(scope.label) === exact || compact(scope.ref) === exact ? 0 : 1
  return scopes.filter((scope) => terms.every((term) => scope.search.includes(term))).sort((a, b) => rank(a) - rank(b))
}
