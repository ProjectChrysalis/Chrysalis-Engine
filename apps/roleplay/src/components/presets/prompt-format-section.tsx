import { useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useApp } from '@/lib/store'
import { fetchPromptFormatFor, fetchPromptFormats, type EnginePromptFormat, type ResolvedPromptFormat } from '@/lib/engine'
import type { Preset, PromptFormatSequences } from '@/lib/types'

const FIELDS: [keyof Omit<PromptFormatSequences, 'systemAsUser'>, string][] = [
  ['systemPrefix', 'System prefix'], ['systemSuffix', 'System suffix'],
  ['userPrefix', 'User prefix'], ['userSuffix', 'User suffix'],
  ['assistantPrefix', 'Assistant prefix'], ['assistantSuffix', 'Assistant suffix'],
]

const SOURCE_LABELS: Record<ResolvedPromptFormat['source'], string> = {
  request: 'set by this preset',
  connection: 'set on the connection',
  template: "read from the model's template",
  'model name': "guessed from the model's name",
  fallback: 'nothing detected, using the default',
}

/** Markers are edited on one line each: a typed \n is a newline. */
const escapeSeq = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
const unescapeSeq = (s: string) => s.replace(/\\(\\|n)/g, (_, ch: string) => (ch === 'n' ? '\n' : '\\'))

/**
 * How a text completion model gets the chat: one prompt written in the
 * model's instruct markers. Chat completion connections never read this.
 */
export function PromptFormatSection({ preset }: { preset: Preset }) {
  const updatePreset = useApp((s) => s.updatePreset)
  const model = useApp((s) => s.model)
  const models = useApp((s) => s.models)
  const ro = preset.readOnly
  const pf = preset.promptFormat
  const up = (patch: Partial<Preset['promptFormat']>) => updatePreset(preset.id, { promptFormat: { ...pf, ...patch } })

  const [formats, setFormats] = useState<EnginePromptFormat[]>([])
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    fetchPromptFormats().then(setFormats, (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
  }, [])

  // what the connection would pick for the default model, shown so "match
  // the model" is never a guess about a guess
  const current = models.find((m) => m.ref === model)
  const textModel = current?.api === 'openai-text' ? current : null
  const matchModel = pf.use === 'auto'
  const [resolved, setResolved] = useState<ResolvedPromptFormat | null>(null)
  const [resolveError, setResolveError] = useState('')
  useEffect(() => {
    setResolved(null)
    setResolveError('')
    if (!textModel) return
    let live = true
    fetchPromptFormatFor(textModel.ref, matchModel).then(
      (r) => { if (live) setResolved(r) },
      (e: unknown) => { if (live) setResolveError(e instanceof Error ? e.message : String(e)) },
    )
    return () => { live = false }
  }, [textModel?.ref, matchModel])

  const byId = new Map(formats.map((f) => [f.id, f]))
  const label = (id: string) =>
    id === 'connection' ? "Connection's setting" : id === 'auto' ? 'Match the model' : id === 'custom' ? 'Custom' : byId.get(id)?.name ?? id
  const pick = (use: string) => {
    // a custom format starts from the one on screen, not from blank fields
    const base = byId.get(pf.use) ?? (pf.use !== 'custom' && resolved ? byId.get(resolved.id) : undefined)
    if (use === 'custom' && base) {
      const { id: _id, name: _name, ...custom } = base
      up({ use, custom })
    } else up({ use })
  }

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <Label className="text-xs">Text completion format</Label>
      <Select value={pf.use} onValueChange={(v) => v && pick(v)} disabled={ro}>
        <SelectTrigger className="h-8 text-xs" aria-label="Text completion format">
          <SelectValue>{(v) => label(String(v))}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {['connection', 'auto', ...formats.map((f) => f.id), 'custom'].map((id) => (
              <SelectItem key={id} value={id}>{label(id)}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Only for text completion connections: the chat is written as one prompt in the model's turn markers.
      </p>
      {(loadError || resolveError) && <p className="text-[11px] text-destructive">{loadError || resolveError}</p>}
      {textModel && resolved && (pf.use === 'connection' || matchModel) && (
        <p className="text-[11px] text-muted-foreground">
          {textModel.id}: {resolved.name}, {SOURCE_LABELS[resolved.source]}
        </p>
      )}

      {pf.use === 'custom' && (
        <div className="grid grid-cols-1 gap-2 rounded-md border border-border p-3 sm:grid-cols-2">
          {FIELDS.map(([key, text]) => (
            <div key={key} className="flex flex-col gap-1">
              <Label className="text-xs">{text}</Label>
              <Input
                value={escapeSeq(pf.custom[key])}
                onChange={(e) => up({ custom: { ...pf.custom, [key]: unescapeSeq(e.target.value) } })}
                disabled={ro}
                className="h-8 font-mono text-xs"
                aria-label={text}
              />
            </div>
          ))}
          <label className="flex items-center justify-between gap-3 sm:col-span-2">
            <span className="text-sm">No system role</span>
            <Switch
              checked={pf.custom.systemAsUser}
              onCheckedChange={(systemAsUser) => up({ custom: { ...pf.custom, systemAsUser } })}
              disabled={ro}
              aria-label="No system role"
            />
          </label>
          <p className="text-[11px] leading-relaxed text-muted-foreground sm:col-span-2">
            {'\\n is a newline. With no system role, later system messages are sent as user turns.'}
          </p>
        </div>
      )}
    </section>
  )
}
