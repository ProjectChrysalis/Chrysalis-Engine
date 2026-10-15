import { useEffect, useState } from "react"
import { connectionsApi } from "./api"
import { Select } from "./ui/select"
import { tr } from "./i18n/index"
import { routingDraft, routingSelections, toggleRoutingSelection, moveRoutingSelection, type RoutingDraft } from "./openrouter-routing-state"

type Choice = { slug: string; name: string }

const quantizations: Choice[] = ["int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"].map((slug) => ({ slug, name: slug.toUpperCase() }))
const providerLabel = (provider: Choice) => provider.slug === "google-vertex" ? "Google Vertex" : provider.name

function RoutingChoices(props: { title: string; selected: string[]; choices: Choice[]; onToggle: (slug: string) => void; onMove?: (slug: string, direction: -1 | 1) => void; inputClass: string }) {
  const [search, setSearch] = useState("")
  const query = search.trim().toLowerCase()
  const choices = props.choices.filter((choice) => `${providerLabel(choice)} ${choice.slug}`.toLowerCase().includes(query))
  const label = (slug: string) => {
    const choice = props.choices.find((choice) => choice.slug === slug)
    return choice ? providerLabel(choice) : slug
  }
  return <div className="flex flex-col gap-1 text-12 text-ink-muted">
    <span className="font-medium">{props.title}</span>
    {props.selected.map((slug, index) => <div key={slug} className="flex items-center gap-2 rounded-md bg-panel px-2 py-1">
      <span className="min-w-0 flex-1 truncate">{label(slug)}</span>
      {props.onMove ? <>
        <button type="button" disabled={index === 0} className="disabled:opacity-30" aria-label={tr("Move up")} onClick={() => props.onMove?.(slug, -1)}>↑</button>
        <button type="button" disabled={index === props.selected.length - 1} className="disabled:opacity-30" aria-label={tr("Move down")} onClick={() => props.onMove?.(slug, 1)}>↓</button>
      </> : null}
      <button type="button" aria-label={tr("Remove {name}", { name: label(slug) })} onClick={() => props.onToggle(slug)}>×</button>
    </div>)}
    <details className="rounded-md border border-line p-2">
      <summary className="cursor-pointer">{tr("Choose from list")}</summary>
      <div className="mt-2 flex flex-col gap-2">
        <input className={props.inputClass} aria-label={tr("Search choices")} placeholder={tr("Search choices")} value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
          {choices.map((choice) => <label key={choice.slug} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-panel">
            <input type="checkbox" checked={props.selected.includes(choice.slug)} onChange={() => props.onToggle(choice.slug)} />
            <span>{providerLabel(choice)}</span>
          </label>)}
          {!choices.length ? <p className="text-ink-faint">{tr("No matching choices.")}</p> : null}
        </div>
      </div>
    </details>
  </div>
}

export function OpenRouterRoutingEditor(props: { value: RoutingDraft; onChange: (value: RoutingDraft) => void; inputClass: string }) {
  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<Choice[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setError("")
    connectionsApi.routingProviders().then((choices) => {
      if (active) setProviders(choices)
    }).catch((error) => {
      if (active) setError(error instanceof Error ? error.message : String(error))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open, retry])
  const update = <K extends keyof RoutingDraft>(key: K, value: RoutingDraft[K]) => props.onChange({ ...props.value, [key]: value })
  return <details className="rounded-lg border border-line p-2.5" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-12 font-medium text-ink">{tr("OpenRouter routing")}</summary>
    <div className="mt-2 flex flex-col gap-2">
      <p className="text-11 text-ink-faint">{tr("Saved fields apply to every app using this connection.")}</p>
      {loading ? <p className="text-11 text-ink-faint">{tr("Loading providers…")}</p> : null}
      {error ? <div className="text-12 text-ink-muted" role="alert"><p>{error}</p><button type="button" className="mt-1 underline" onClick={() => setRetry((value) => value + 1)}>{tr("Retry")}</button></div> : null}
      {(["order", "only", "ignore", "quantizations"] as const).map((key) => <RoutingChoices key={key}
        title={key === "order" ? tr("Provider priority") : key === "only" ? tr("Allowed providers") : key === "ignore" ? tr("Blocked providers") : tr("Quantizations")}
        selected={routingSelections(props.value[key])} choices={key === "quantizations" ? quantizations : providers}
        onToggle={(slug) => props.onChange(toggleRoutingSelection(props.value, key, slug))}
        onMove={key === "order" ? (slug, direction) => props.onChange(moveRoutingSelection(props.value, slug, direction)) : undefined}
        inputClass={props.inputClass} />)}
      <p className="text-11 text-ink-faint">{tr("Priority runs top to bottom. Empty lists use OpenRouter defaults.")}</p>
      {(["allow_fallbacks", "require_parameters", "zdr"] as const).map((key) => <label key={key} className="flex items-center justify-between gap-2 text-12 text-ink-muted">
        {key === "allow_fallbacks" ? tr("Fallback providers") : key === "require_parameters" ? tr("Parameter support, including tools") : tr("Zero data retention")}
        <Select appearance="inline" options={["default", "true", "false"] as const} current={props.value[key]} value={(value) => value}
          label={(value) => value === "default" ? tr("OpenRouter default") : key === "allow_fallbacks" ? (value === "true" ? tr("Allow") : tr("Block")) : (value === "true" ? tr("Required") : tr("Optional"))}
          onSelect={(value) => update(key, value ?? "default")} />
      </label>)}
      <label className="flex items-center justify-between gap-2 text-12 text-ink-muted">
        {tr("Data collection")}
        <Select appearance="inline" options={["default", "allow", "deny"] as const} current={props.value.data_collection} value={(value) => value}
          label={(value) => value === "default" ? tr("OpenRouter default") : value === "allow" ? tr("Allow") : tr("Deny")}
          onSelect={(value) => update("data_collection", value ?? "default")} />
      </label>
      <label className="flex items-center justify-between gap-2 text-12 text-ink-muted">
        {tr("Prefer")}
        <Select appearance="inline" options={["default", "price", "throughput", "latency"] as const} current={props.value.sort} value={(value) => value}
          label={(value) => value === "default" ? tr("OpenRouter default") : value === "price" ? tr("Lowest price") : value === "throughput" ? tr("Highest throughput") : tr("Lowest latency")}
          onSelect={(value) => update("sort", value ?? "default")} />
      </label>
      <div className="flex flex-wrap gap-2">
        {(["inputPrice", "outputPrice"] as const).map((key) => <label key={key} className="flex min-w-0 flex-1 flex-col gap-1 text-12 text-ink-muted">
          {key === "inputPrice" ? tr("Max input price ($/million tokens)") : tr("Max output price ($/million tokens)")}
          <input className={props.inputClass} inputMode="decimal" value={props.value[key]} onChange={(event) => update(key, event.currentTarget.value)} />
        </label>)}
      </div>
      <button type="button" className="self-start text-12 text-ink-muted hover:text-ink" onClick={() => props.onChange(routingDraft())}>{tr("Reset routing")}</button>
    </div>
  </details>
}
