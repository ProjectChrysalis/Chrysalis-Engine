import { tr } from "./i18n/index"
import { Select } from "./ui/select"

import { GENERATION_RANGES, generationCapabilities, type GenerationDraft } from "./generation-settings-state"

type NumericKey = keyof typeof GENERATION_RANGES
const labels = {
  maxTokens: "Output token limit",
  temperature: "Temperature",
  topP: "Top P",
  frequencyPenalty: "Frequency penalty",
  presencePenalty: "Presence penalty",
} as const satisfies Record<NumericKey, string>

export function GenerationSettingsEditor(props: { value: GenerationDraft; inherited?: GenerationDraft; onChange: (value: GenerationDraft) => void; inputClass: string; apis: string[] }) {
  const capabilities = generationCapabilities(props.apis)
  const keys = (Object.keys(GENERATION_RANGES) as NumericKey[]).filter((key) => key === "maxTokens" ? capabilities.maxTokens : key === "temperature" ? capabilities.temperature : key === "topP" ? capabilities.topP : key === "frequencyPenalty" || key === "presencePenalty" ? capabilities.penalties : true)
  const advanced = keys.filter((key) => key !== "maxTokens" && key !== "temperature")
  const advancedCount = advanced.filter((key) => props.value[key] !== "").length
  const field = (key: NumericKey) => (
    <label key={key} className="flex min-w-0 flex-col gap-1 text-12 text-ink-muted">
      <span className="flex items-center justify-between gap-2"><span>{tr(labels[key])}</span>{key !== "maxTokens" ? <span className="text-11 text-ink-faint">{GENERATION_RANGES[key].min}–{key === "temperature" ? capabilities.temperatureMax : GENERATION_RANGES[key].max}</span> : null}</span>
      <input className={props.inputClass} type="number" {...GENERATION_RANGES[key]} max={key === "temperature" ? capabilities.temperatureMax : GENERATION_RANGES[key].max} placeholder={props.inherited?.[key] || tr("Unchanged")} value={props.value[key]} onChange={(event) => props.onChange({ ...props.value, [key]: event.currentTarget.value })} />
    </label>
  )
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-13 font-medium text-ink">{tr("Generation settings")}</h3>
        <p className="text-12 leading-4 text-ink-muted">{tr("Applies only to the built-in agent. Blank fields use defaults.")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {keys.filter((key) => key === "maxTokens" || key === "temperature").map(field)}
          {capabilities.reasoning ? <label className="flex min-w-0 flex-col gap-1 text-12 text-ink-muted">
            {tr("Reasoning effort")}
            <Select className="w-full" options={["", "off", "minimal", "low", "medium", "high", "xhigh", "max"]} current={props.value.reasoning} value={(value) => value} label={(value) => ({ "": props.inherited ? tr("Use agent defaults") : tr("Unchanged"), off: tr("Off"), minimal: tr("Minimal"), low: tr("Low"), medium: tr("Medium"), high: tr("High"), xhigh: tr("Extra high"), max: tr("Maximum") })[value] ?? value} onSelect={(value) => props.onChange({ ...props.value, reasoning: value ?? "" })} />
          </label> : null}
      </div>
      {advanced.length ? <details className="border-t border-line pt-3">
        <summary className="cursor-pointer text-12 font-medium text-ink-muted">{tr("Advanced sampling")}{advancedCount ? ` (${advancedCount})` : ""}</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{advanced.map(field)}</div>
      </details> : null}
      <p className="text-11 leading-4 text-ink-faint">{tr("Supported values depend on your endpoint and model.")}</p>
    </div>
  )
}
