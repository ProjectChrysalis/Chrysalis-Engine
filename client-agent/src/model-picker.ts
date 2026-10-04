import type { EngineModel } from "./api.js"

export const modelKey = (model: EngineModel): string => `${model.provider}/${model.modelId}`
const compact = (text: string): string => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "")

export function searchModels(models: readonly EngineModel[], query: string, connection: string): EngineModel[] {
  const terms = query.trim().split(/\s+/).map(compact).filter(Boolean)
  const exact = compact(query)
  const score = (model: EngineModel): number => {
    const names = [compact(model.label), compact(model.modelId)]
    return names.includes(exact) ? 0 : names.some((name) => name.startsWith(exact)) ? 1 : 2
  }
  return models.filter((model) => {
    if (connection && model.provider !== connection) return false
    const fields = [model.label, model.modelId, model.provider, model.connectionName ?? ""].map(compact)
    return terms.every((term) => fields.some((field) => field.includes(term)))
  }).sort((a, b) => (terms.length ? score(a) - score(b) : 0) || a.label.localeCompare(b.label) || modelKey(a).localeCompare(modelKey(b)))
}

export function modelGroups(models: readonly EngineModel[], selected: string | null, favorites: readonly string[], recent: readonly string[], searching: boolean): { title: string; models: EngineModel[] }[] {
  if (searching) return [{ title: "Results", models: [...models] }]
  const remaining = new Map(models.map((model) => [modelKey(model), model]))
  const take = (ids: readonly string[]) => ids.flatMap((id) => {
    const model = remaining.get(id)
    remaining.delete(id)
    return model ? [model] : []
  })
  return [
    { title: "Current", models: take(selected ? [selected] : []) },
    { title: "Favorites", models: take(favorites) },
    { title: "Recent", models: take(recent) },
    { title: "All models", models: [...remaining.values()] },
  ].filter((group) => group.models.length)
}

export function readModelList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]")
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : []
  } catch { return [] }
}

export function saveModelList(key: string, ids: readonly string[]): void {
  try { localStorage.setItem(key, JSON.stringify(ids)) } catch { /* Browser storage can be disabled. */ }
}
