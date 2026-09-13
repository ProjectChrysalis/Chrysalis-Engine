
import { useMemo, useState } from 'react'
import { ArrowRight, GitDiff } from '@phosphor-icons/react'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useApp } from '@/lib/store'
import type { Preset } from '@/lib/types'
import { cn } from '@/lib/utils'

type Row = { label: string; left: string; right: string }
type Group = { title: string; rows: Row[] }

const NONE = '—'

function fmt(v: unknown): string {
  if (v === undefined || v === null) return NONE
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000)
  return String(v)
}

/** Flattens a sampler value (scalar-with-enabled, or a nested feature object) into readable text. */
function samplerText(v: unknown): string {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('value' in o) return `${fmt(o.value)}${o.enabled === false ? ' (off)' : ''}`
    const enabled = o.enabled !== false
    const inner = Object.entries(o)
      .filter(([k]) => k !== 'enabled')
      .map(([k, val]) => `${k}: ${fmt(val)}`)
      .join(', ')
    return enabled ? inner || 'on' : 'off'
  }
  return fmt(v)
}

function buildGroups(a: Preset, b: Preset): Group[] {
  const groups: Group[] = []

  const meta: Row[] = [
    { label: 'Name', left: a.name, right: b.name },
    { label: 'Read-only', left: fmt(a.readOnly), right: fmt(b.readOnly) },
    { label: 'Prompt sections', left: String(a.sections.length), right: String(b.sections.length) },
  ]
  groups.push({ title: 'Overview', rows: meta })

  const samplerKeys = Array.from(
    new Set([...Object.keys(a.samplers), ...Object.keys(b.samplers)]),
  ) as (keyof Preset['samplers'])[]
  groups.push({
    title: 'Samplers',
    rows: samplerKeys.map((k) => ({
      label: String(k).replace(/_/g, ' '),
      left: samplerText(a.samplers[k]),
      right: samplerText(b.samplers[k]),
    })),
  })

  const utilKeys = Array.from(
    new Set([...Object.keys(a.utilityPrompts), ...Object.keys(b.utilityPrompts)]),
  ) as (keyof Preset['utilityPrompts'])[]
  groups.push({
    title: 'Utility prompts',
    rows: utilKeys.map((k) => ({
      label: String(k).replace(/([A-Z])/g, ' $1'),
      left: a.utilityPrompts[k] || NONE,
      right: b.utilityPrompts[k] || NONE,
    })),
  })

  const sectionNames = Array.from(
    new Set([...a.sections.map((s) => s.name), ...b.sections.map((s) => s.name)]),
  )
  groups.push({
    title: 'Prompt manager',
    rows: sectionNames.map((name) => {
      const sa = a.sections.find((s) => s.name === name)
      const sb = b.sections.find((s) => s.name === name)
      const describe = (s: typeof sa) =>
        !s ? NONE : `${s.enabled ? 'enabled' : 'disabled'} · ${s.role} · ${s.position}${s.position === 'in-chat' ? ` @${s.depth}` : ''}`
      return { label: name, left: describe(sa), right: describe(sb) }
    }),
  })

  return groups
}

export function PresetDiffDialog({
  open, onOpenChange, preset,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  preset: Preset
}) {
  const presets = useApp((s) => s.presets)
  const others = presets.filter((p) => p.id !== preset.id)
  const [otherId, setOtherId] = useState<string>(others[0]?.id ?? '')
  const [changedOnly, setChangedOnly] = useState(true)

  const other = presets.find((p) => p.id === otherId)
  const groups = useMemo(() => (other ? buildGroups(preset, other) : []), [preset, other])
  const changedCount = groups.reduce((n, g) => n + g.rows.filter((r) => r.left !== r.right).length, 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitDiff className="size-4" aria-hidden="true" /> Compare presets
          </DialogTitle>
          <DialogDescription>
            See exactly how this preset differs from another before you switch or copy settings.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium">{preset.name}</span>
          <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <Select value={otherId} onValueChange={(v) => v && setOtherId(v)}>
            <SelectTrigger className="h-8 w-56 text-xs" aria-label="Compare against preset">
              {/* Render the preset's name rather than its raw id. */}
              <SelectValue placeholder="Choose a preset">{other?.name ?? 'Choose a preset'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {others.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Badge variant={changedCount ? 'default' : 'secondary'} className="ml-auto">
            {changedCount} difference{changedCount === 1 ? '' : 's'}
          </Badge>
          <button
            type="button"
            onClick={() => setChangedOnly((v) => !v)}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {changedOnly ? 'Show all rows' : 'Show only differences'}
          </button>
        </div>

        {/* a plain scroller, not ScrollArea: the dialog only caps its height
            (max-h, no definite height), so the ScrollArea viewport's 100%
            resolves to content height — it clips with nothing scrollable.
            An overflow-y-auto flex child scrolls against the flexed size. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 pr-3">
            {!other ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Choose a preset to compare against.</p>
            ) : (
              groups.map((g) => {
                const rows = changedOnly ? g.rows.filter((r) => r.left !== r.right) : g.rows
                if (rows.length === 0) return null
                return (
                  <section key={g.title} className="flex flex-col gap-1.5">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</h4>
                    <div className="overflow-hidden rounded-lg border border-border">
                      {rows.map((r, i) => {
                        const changed = r.left !== r.right
                        return (
                          <div
                            key={r.label}
                            className={cn(
                              'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 px-3 py-1.5 text-xs',
                              i > 0 && 'border-t border-border',
                              changed && 'bg-primary/5',
                            )}
                          >
                            <span className="min-w-0 truncate capitalize text-muted-foreground">{r.label}</span>
                            <span className={cn('min-w-0 truncate font-mono', changed && 'text-foreground')}>{r.left}</span>
                            <span className={cn('min-w-0 truncate font-mono', changed ? 'text-primary' : 'text-muted-foreground')}>
                              {r.right}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )
              })
            )}
            {other && changedOnly && changedCount === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                These presets are identical.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
