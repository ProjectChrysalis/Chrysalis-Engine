
import { useState } from 'react'
import { Plus, ArrowCounterClockwise, Trash } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { j } from '@/lib/engine'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { cn } from '@/lib/utils'

/** A plugin ships its own UI as a declarative panel (uiPanel hook →
 *  /__panels): the shape below is the whole contract. The plugin owns the
 *  labels, rows, fields and action URLs; this renderer just draws them. */

export interface PanelField {
  key: string
  label: string
  kind: 'text' | 'number' | 'textarea' | 'code'
  value: string | number
}

export interface PanelItem {
  id: string
  title: string
  subtitle?: string
  badge?: string
  enabled: boolean
  saveUrl: string
  deleteUrl?: string
  deleteLabel?: string
  fields?: PanelField[]
  /** small muted footnote under the fields (constraints the plugin wants stated) */
  note?: string
}

export interface PluginPanelDescriptor {
  label: string
  icon?: string
  hint?: string
  items: PanelItem[]
  create?: { url: string; label: string }
}

/** Panel action URLs arrive from PLUGIN code: confine them to plain relative
 *  app paths — no traversal, no protocol-relative tricks, no query strings.
 *  A malicious app must not steer a panel button at engine-level routes. */
function safePanelUrl(u: string): string | null {
  return /^\/[a-zA-Z0-9/_-]*$/.test(u) ? u : null
}

function ItemEditor({ item, onSaved, onDeleted }: { item: PanelItem; onSaved: () => void; onDeleted: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((item.fields ?? []).map((f) => [f.key, String(f.value)])),
  )
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const url = safePanelUrl(item.saveUrl)
    if (!url) return toast.error('Blocked an unsafe panel action')
    setBusy(true)
    try {
      await j(url, { method: 'PUT', body: JSON.stringify({ enabled: item.enabled, values }) })
      toast.success('Saved')
      onSaved()
    } catch (e) {
      toast.error('Save failed', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const url = item.deleteUrl ? safePanelUrl(item.deleteUrl) : null
    if (item.deleteUrl && !url) return toast.error('Blocked an unsafe panel action')
    try {
      if (url) await j(url, { method: 'DELETE' })
      toast.success(item.deleteLabel || 'Deleted')
      onDeleted()
    } catch (e) {
      toast.error('Delete failed', { description: (e as Error).message })
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-border bg-muted/20 p-3">
      {item.fields?.length ? (
        <FieldGroup>
          {(item.fields ?? []).map((f) => (
            <Field key={f.key}>
              <FieldLabel>{f.label}</FieldLabel>
              {f.kind === 'text' || f.kind === 'number' ? (
                <Input
                  value={values[f.key] ?? ''}
                  inputMode={f.kind === 'number' ? 'numeric' : undefined}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              ) : (
                <Textarea
                  value={values[f.key] ?? ''}
                  rows={f.kind === 'code' ? 5 : 3}
                  className={cn(f.kind === 'code' && 'font-mono text-xs')}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              )}
            </Field>
          ))}
        </FieldGroup>
      ) : (
        <p className="text-xs text-muted-foreground">{item.subtitle}</p>
      )}
      {item.note && <p className="mt-2 text-xs text-muted-foreground/80">{item.note}</p>}
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={save} disabled={busy}>Save</Button>
        {item.deleteUrl && (
          <Button size="sm" variant="ghost" onClick={remove}>
            {item.deleteLabel ? <ArrowCounterClockwise className="size-3.5" aria-hidden="true" /> : <Trash className="size-3.5" aria-hidden="true" />}
            {item.deleteLabel || 'Delete'}
          </Button>
        )}
      </div>
    </div>
  )
}

export function PluginPanelView({ panel, reload }: { panel: PluginPanelDescriptor; reload: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<PanelItem | null>(null)

  const toggle = async (item: PanelItem, enabled: boolean) => {
    const url = safePanelUrl(item.saveUrl)
    if (!url) return toast.error('Blocked an unsafe panel action')
    try {
      await j(url, { method: 'PUT', body: JSON.stringify({ enabled }) })
      reload()
    } catch (e) {
      toast.error('Could not save', { description: (e as Error).message })
    }
  }

  const create = async () => {
    if (!panel.create) return
    const url = safePanelUrl(panel.create.url)
    if (!url) return toast.error('Blocked an unsafe panel action')
    try {
      const r = await j<PanelItem>(url, { method: 'POST', body: JSON.stringify({}) })
      setDraft(r)
      setOpenId(r.id)
    } catch (e) {
      toast.error('Could not start a new item', { description: (e as Error).message })
    }
  }

  const items = draft ? [...panel.items, draft] : panel.items

  return (
    <div className="flex max-w-lg flex-col gap-3">
      {panel.hint && <p className="text-sm text-muted-foreground">{panel.hint}</p>}
      {items.map((item) => (
        <div key={item.id} className={cn('rounded-lg border border-border', openId === item.id && 'bg-muted/10')}>
          <div className="flex items-center gap-3 px-3 py-2">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenId(openId === item.id ? null : item.id)}>
              <span className="block truncate text-sm font-medium">{item.title}</span>
              {item.subtitle && <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>}
            </button>
            {item.badge && <span className="rounded border border-border px-1 text-[9px] uppercase text-muted-foreground">{item.badge}</span>}
            <Switch checked={item.enabled} onCheckedChange={(v) => { if (item !== draft) void toggle(item, v) }} aria-label={`Enable ${item.title}`} />
          </div>
          {openId === item.id && (
            <ItemEditor
              item={item}
              onSaved={() => { setDraft(null); setOpenId(null); reload() }}
              onDeleted={() => { setDraft(null); setOpenId(null); reload() }}
            />
          )}
        </div>
      ))}
      {panel.create && (
        <Button variant="outline" size="sm" className="w-fit" onClick={create}>
          <Plus className="size-3.5" aria-hidden="true" /> {panel.create.label}
        </Button>
      )}
    </div>
  )
}
