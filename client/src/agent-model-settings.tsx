import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { AgentModelOverrides } from "../../src/agent/model-settings"
import type { GenerationSettings } from "../../src/providers/generation-settings"
import { api } from "./api"
import { AgentModelScopePicker } from "./agent-model-scope-picker"
import type { AgentCatalogModel } from "./agent-model-scopes"
import { GenerationSettingsEditor } from "./generation-settings"
import { generationBody, generationDraft, type GenerationDraft } from "./generation-settings-state"
import { tr } from "./i18n/index"
import { Button } from "./ui/button"
import { Select } from "./ui/select"

type Model = AgentCatalogModel
type Settings = { agentGeneration: GenerationSettings; reasoning: GenerationSettings["reasoning"] | null; autoCompact: boolean | number | null; agentModels: Record<string, AgentModelOverrides> }
type Draft = { generation: GenerationDraft; contextWindow: string; compact: "inherit" | "auto" | "off" | "custom"; threshold: string }
const draftOf = (profile: AgentModelOverrides, defaults: boolean): Draft => ({
  generation: generationDraft(profile.generation),
  contextWindow: String(profile.contextWindow ?? ""),
  compact: typeof profile.autoCompact === "number" ? "custom" : profile.autoCompact === false ? "off" : profile.autoCompact === true || defaults ? "auto" : "inherit",
  threshold: typeof profile.autoCompact === "number" ? String(profile.autoCompact) : "",
})
const State = createContext<ReturnType<typeof useSettings> | null>(null)

function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [models, setModels] = useState<Model[]>([])
  const [scope, setScope] = useState("")
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    let cancelled = false
    Promise.all([api<Settings>("GET", "/v1/settings"), api<{ models: Model[] }>("GET", "/v1/models")])
      .then(([value, catalog]) => { if (!cancelled) { setSettings(value); setModels(catalog.models) } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [])
  const defaults = { generation: { ...settings?.agentGeneration, ...(settings?.reasoning ? { reasoning: settings.reasoning } : {}) }, autoCompact: settings?.autoCompact ?? true }
  const baseline = draftOf(scope ? settings?.agentModels[scope] ?? {} : defaults, !scope)
  const draft = drafts[scope] ?? baseline
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  const change = (value: Partial<Draft>) => setDrafts((previous) => ({ ...previous, [scope]: { ...draft, ...value } }))
  const discard = () => setDrafts((previous) => { const next = { ...previous }; delete next[scope]; return next })
  const save = async () => {
    if (!settings) return
    setBusy(true)
    setError("")
    try {
      const generation = generationBody(draft.generation, tr("Check the generation settings and their allowed ranges."))
      const contextWindow = draft.contextWindow.trim() ? Number(draft.contextWindow) : undefined
      if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || contextWindow > 1e9)) throw new Error(tr("Enter a positive whole number up to 1,000,000,000."))
      const autoCompact = draft.compact === "inherit" ? undefined : draft.compact === "off" ? false : draft.compact === "auto" ? true : Number(draft.threshold)
      if (typeof autoCompact === "number" && (!Number.isFinite(autoCompact) || autoCompact < 1000 || autoCompact > 10_000_000)) throw new Error(tr("threshold must be ≥ 1000 tokens"))
      const profile: AgentModelOverrides = { ...(generation ? { generation } : {}), ...(contextWindow !== undefined ? { contextWindow } : {}), ...(autoCompact !== undefined ? { autoCompact } : {}) }
      if (scope) {
        await api("PUT", "/v1/settings", { agentModel: { ref: scope, settings: profile } })
        setSettings({ ...settings, agentModels: { ...settings.agentModels, [scope]: profile } })
      } else {
        const { reasoning, ...sampling } = generation ?? {}
        await api("PUT", "/v1/settings", { agentGeneration: Object.keys(sampling).length ? sampling : null, reasoning: reasoning ?? null, autoCompact: autoCompact ?? true })
        setSettings({ ...settings, agentGeneration: sampling, reasoning: reasoning ?? null, autoCompact: autoCompact ?? true })
      }
      discard()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return { settings, models, scope, setScope, baseline, draft, dirty, change, discard, busy, error, setError, save, defaults }
}

export function AgentSettingsProvider({ children }: { children: ReactNode }) {
  return <State.Provider value={useSettings()}>{children}</State.Provider>
}

export function AgentModelSettings({ section, inputClass }: { section: "generation" | "context"; inputClass: string }) {
  const state = useContext(State)
  if (!state) return null
  const { settings, models, scope, setScope, draft, dirty, change, discard, busy, error, setError, save, defaults } = state
  const key = (model: Model) => `${model.provider}/${model.modelId}`
  const model = models.find((item) => key(item) === scope)
  if (!settings) return <p role={error ? "alert" : "status"} className={error ? "text-12 text-danger" : "text-12 text-ink-muted"}>{error || tr("Loading…")}</p>
  return <section className="flex flex-col gap-4">
    <label className="flex min-w-0 flex-col gap-1 text-12 text-ink-muted">
      {tr("Settings for")}
      <AgentModelScopePicker models={models} saved={Object.keys(settings.agentModels).filter((ref) => Object.keys(settings.agentModels[ref] ?? {}).length > 0)} value={scope} disabled={busy} onChange={(value) => { setScope(value); setError("") }} />
    </label>
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4 border-0 p-0">
    {section === "generation" ? <GenerationSettingsEditor value={draft.generation} inherited={scope ? generationDraft(defaults.generation) : undefined} onChange={(generation) => change({ generation })} inputClass={inputClass} apis={[]} /> : <>
      {scope ? <label className="flex min-w-0 flex-col gap-1 text-12 text-ink-muted">
        {tr("Context window")}
        <input className={`${inputClass} w-full sm:max-w-xs`} inputMode="numeric" value={draft.contextWindow} placeholder={model?.contextWindow ? model.contextWindow.toLocaleString() : tr("Unchanged")} onChange={(event) => change({ contextWindow: event.currentTarget.value })} />
      </label> : null}
      <div className="flex flex-col gap-2">
        <h3 className="text-13 font-medium text-ink">{tr("Auto-compact long sessions")}</h3>
        <p className="text-12 text-ink-muted">{tr("Summarize older messages to make room in long sessions.")}</p>
        <Select options={scope ? ["inherit", "auto", "off", "custom"] as const : ["auto", "off", "custom"] as const} current={draft.compact} label={(value) => ({ inherit: tr("Use agent defaults"), auto: tr("auto (80% of context window)"), off: tr("Off"), custom: tr("Threshold (tokens)") })[value]} onSelect={(value) => { if (value) change({ compact: value }) }} />
        {draft.compact === "custom" ? <label className="flex flex-col gap-1 text-12 text-ink-muted">{tr("Threshold (tokens)")}<input className={`${inputClass} w-full sm:max-w-xs`} inputMode="numeric" value={draft.threshold} onChange={(event) => change({ threshold: event.currentTarget.value })} /></label> : null}
      </div>
    </>}
    </fieldset>
    {error ? <p role="alert" className="text-12 text-danger">{error}</p> : null}
    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
      <Button variant="neutral" size="normal" disabled={!dirty || busy} onClick={save}>{busy ? tr("Saving…") : tr("Save")}</Button>
      {dirty ? <Button variant="ghost" size="normal" disabled={busy} onClick={discard}>{tr("Discard")}</Button> : null}
      {scope && JSON.stringify(draft) !== JSON.stringify(draftOf({}, false)) ? <Button variant="ghost" size="normal" className="ml-auto" disabled={busy} onClick={() => change(draftOf({}, false))}>{tr("Use agent defaults")}</Button> : null}
      {!scope && section === "generation" && Object.values(draft.generation).some(Boolean) ? <Button variant="ghost" size="normal" className="ml-auto" disabled={busy} onClick={() => change({ generation: generationDraft() })}>{tr("Clear overrides")}</Button> : null}
    </div>
  </section>
}
