import { tr } from "./i18n/index"
import { Button } from "./ui/button"
import { Select } from "./ui/select"

import { GENERATION_RANGES, generationCapabilities, generationDraft, type GenerationDraft } from "./generation-settings-state"

type NumericKey = keyof typeof GENERATION_RANGES
const labels = {
  maxTokens: "Output token limit",
  temperature: "Temperature",
  topP: "Top P",
  frequencyPenalty: "Frequency penalty",
  presencePenalty: "Presence penalty",
} as const satisfies Record<NumericKey, string>

export function GenerationSettingsEditor(props: { value: GenerationDraft; onChange: (value: GenerationDraft) => void; inputClass: string; apis: string[] }) {
  const capabilities = generationCapabilities(props.apis)
  const keys = (Object.keys(GENERATION_RANGES) as NumericKey[]).filter((key) => key === "maxTokens" ? capabilities.maxTokens : key === "temperature" ? capabilities.temperature : key === "topP" ? capabilities.topP : key === "frequencyPenalty" || key === "presencePenalty" ? capabilities.penalties : true)
  const count = [...keys, ...(capabilities.reasoning ? ["reasoning" as const] : [])].filter((key) => props.value[key] !== "").length
  return (
    <details className="rounded-lg border border-line p-2.5" open={count > 0 || undefined}>
      <summary className="cursor-pointer text-12 font-medium text-ink">{tr("Generation settings")}{count ? ` (${count})` : ""}</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-11 leading-4 text-ink-faint">{tr("Set values override app and agent requests. Leave blank to use their settings.")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {keys.map((key) => (
            <label key={key} className="flex min-w-0 flex-col gap-1 text-12 text-ink-muted">
              <span className="flex items-center justify-between gap-2"><span>{tr(labels[key])}</span>{key !== "maxTokens" ? <span className="text-11 text-ink-faint">{GENERATION_RANGES[key].min}–{(key === "temperature" ? capabilities.temperatureMax : GENERATION_RANGES[key].max)}</span> : null}</span>
              <input className={props.inputClass} type="number" {...GENERATION_RANGES[key]} max={key === "temperature" ? capabilities.temperatureMax : GENERATION_RANGES[key].max} placeholder={tr("Unchanged")} value={props.value[key]} onChange={(event) => props.onChange({ ...props.value, [key]: event.currentTarget.value })} />
            </label>
          ))}
          {capabilities.reasoning ? <label className="flex min-w-0 flex-col gap-1 text-12 text-ink-muted">
            {tr("Reasoning effort")}
            <Select className="w-full" options={["", "off", "minimal", "low", "medium", "high", "xhigh", "max"]} current={props.value.reasoning} value={(value) => value} label={(value) => ({ "": tr("Unchanged"), off: tr("Off"), minimal: tr("Minimal"), low: tr("Low"), medium: tr("Medium"), high: tr("High"), xhigh: tr("Extra high"), max: tr("Maximum") })[value] ?? value} onSelect={(value) => props.onChange({ ...props.value, reasoning: value ?? "" })} />
          </label> : null}
        </div>
        <p className="text-11 leading-4 text-ink-faint">{tr("Supported values depend on your endpoint and model.")}</p>
        {count ? <Button variant="ghost" size="small" className="self-start" onClick={() => props.onChange(generationDraft())}>{tr("Clear overrides")}</Button> : null}
      </div>
    </details>
  )
}
