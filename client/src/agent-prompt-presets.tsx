import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { agentPromptsApi, type AgentPrompt, type AgentPromptPreset, type AgentPromptsFile, type AgentPromptsView, type BuiltinSection, type Marker } from "./api"
import { importPromptPreset, withAgentParts } from "./agent-prompt-import"
import { tr } from "./i18n"
import { Button, IconButton } from "./ui/button"
import { cn } from "./ui/cn"
import { Dialog, ModalDialog } from "./ui/dialog"
import { Icon, IconSmall } from "./ui/icon"
import { Select } from "./ui/select"
import { useResource } from "./use-resource"

const MAIN = "base"

const partLabel = (part: BuiltinSection): string => ({
  base: tr("Main prompt"),
  shell: tr("Shell guide"),
  apps: tr("Installed apps"),
  app: tr("App skills"),
  docs: tr("Workspace rules"),
  notes: tr("Notes"),
  persona: tr("Agent instructions"),
  mode: tr("Work or plan mode"),
})[part]

const markerHint = (marker: Marker): string => ({
  shell: tr("How to use the shell. Empty while the shell is off."),
  apps: tr("The apps you have installed."),
  app: tr("Skills of the app a conversation is about. Empty outside an app."),
  docs: tr("AGENTS.md and the open app's instructions."),
  notes: tr("The list of files in notes/."),
  persona: tr("The text in the Agent instructions box above."),
  mode: tr("How to act in Work or Plan mode. Always on."),
})[marker]

const isMarker = (p: AgentPrompt): p is AgentPrompt & { builtin: Marker } => !!p.builtin && p.builtin !== MAIN
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const chars = (n: number) => (n ? tr("{n} chars", { n: n.toLocaleString() }) : tr("Empty"))

/**
 * The agent's prompt presets: the main prompt (editable, with a reset to the
 * shipped text), markers for the content the engine fills in, and the user's
 * own prompts, in the order the agent reads them.
 */
export function AgentPromptPresets() {
  const saved = useResource(() => agentPromptsApi.get())
  const [draft, setDraft] = useState<AgentPromptsFile | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [preview, setPreview] = useState<{ system: string; message: string } | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)
  const view = saved.data
  if (!view) return null
  const file: AgentPromptsFile = draft ?? view
  const preset = file.presets.find((p) => p.id === file.active) ?? file.presets[0]
  if (!preset) return null

  const edit = (next: AgentPromptsFile) => { setDraft({ active: next.active, presets: next.presets }); setDone(false); setErr("") }
  const editPreset = (change: (p: AgentPromptPreset) => AgentPromptPreset) =>
    edit({ ...file, presets: file.presets.map((p) => (p.id === preset.id ? change(p) : p)) })
  const editPrompt = (id: string, patch: Partial<AgentPrompt>) =>
    editPreset((p) => ({ ...p, prompts: p.prompts.map((q) => (q.id === id ? { ...q, ...patch } : q)) }))
  const move = (from: number, to: number) => editPreset((p) => {
    if (to < 0 || to >= p.prompts.length) return p
    const prompts = [...p.prompts]
    const [item] = prompts.splice(from, 1)
    if (item) prompts.splice(to, 0, item)
    return { ...p, prompts }
  })
  const add = (next: AgentPromptPreset) => edit({ active: next.id, presets: [...file.presets, next] })
  const textOf = (q: AgentPrompt) => (q.builtin === MAIN ? q.content || view.parts.main : isMarker(q) ? view.parts.markers[q.builtin] : q.content)

  const addPrompt = () => {
    const id = crypto.randomUUID()
    editPreset((p) => {
      const mode = p.prompts.findIndex((x) => x.builtin === "mode")
      const prompts = [...p.prompts]
      prompts.splice(mode < 0 ? prompts.length : mode, 0, { id, name: "", enabled: true, placement: "system", content: "" })
      return { ...p, prompts }
    })
    setEditing(id)
  }

  const importFile = async (picked: File | undefined) => {
    if (!picked) return
    try {
      const imported = importPromptPreset(JSON.parse(await picked.text()), picked.name.replace(/\.json$/i, ""), view.order)
      if (!imported) setErr(tr("That file has no prompts to import."))
      else add(imported)
    } catch {
      setErr(tr("That file has no prompts to import."))
    }
  }

  const exportPreset = () => {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify({ name: preset.name, prompts: preset.prompts }, null, 2)}\n`], { type: "application/json" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `${preset.name.replace(/[\\/:*?"<>|]/g, "_") || "preset"}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const showPreview = async () => {
    try {
      setPreview(await agentPromptsApi.preview(preset))
    } catch (e) {
      setErr(message(e))
    }
  }

  const save = async () => {
    if (!draft) return
    setBusy(true)
    setErr("")
    try {
      const stored = await agentPromptsApi.put(draft)
      saved.mutate({ ...view, ...stored })
      setDraft(null)
      setDone(true)
      setTimeout(() => setDone(false), 1500)
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }

  // reorder by dragging the grip; pointer events so it works with touch too
  const dragMove = (e: ReactPointerEvent) => {
    if (dragging === null) return
    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-prompt-index]")
    const over = row ? Number(row.dataset.promptIndex) : dragging
    if (over !== dragging) {
      move(dragging, over)
      setDragging(over)
    }
  }

  const open = editing ? preset.prompts.find((q) => q.id === editing) : undefined

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-13 font-medium text-ink">{tr("Prompt presets")}</h3>
      <p className="text-12 text-ink-muted">{tr("Everything the agent is told, in order. New conversations use the active preset.")}</p>
      <div className="flex flex-wrap items-center gap-1">
        {renaming ? (
          <input
            className="prompt-preset-name"
            aria-label={tr("Preset name")}
            value={preset.name}
            maxLength={120}
            autoFocus
            onChange={(e) => { const name = e.currentTarget.value; editPreset((p) => ({ ...p, name })) }}
            onBlur={() => { if (!preset.name.trim()) editPreset((p) => ({ ...p, name: tr("New preset") })); setRenaming(false) }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur() }}
          />
        ) : (
          <Select
            appearance="inline"
            className="min-w-40 max-w-full"
            options={file.presets.map((p) => p.id)}
            current={preset.id}
            label={(id) => file.presets.find((p) => p.id === id)?.name ?? id}
            onSelect={(id) => id && edit({ ...file, active: id })}
          />
        )}
        <span className="grow" />
        <IconButton icon={<Icon name="plus" />} variant="ghost-muted" size="small" title={tr("New preset")} onClick={() => add({ id: crypto.randomUUID(), name: tr("New preset"), prompts: withAgentParts([], view.order) })} />
        <IconButton icon={<Icon name="copy" />} variant="ghost-muted" size="small" title={tr("Duplicate")} onClick={() => add({ ...preset, id: crypto.randomUUID(), name: `${preset.name} 2`, prompts: preset.prompts.map((q) => (q.builtin ? q : { ...q, id: crypto.randomUUID() })) })} />
        <IconButton icon={<Icon name="cloud-upload" />} variant="ghost-muted" size="small" title={tr("Import")} onClick={() => fileInput.current?.click()} />
        <IconButton icon={<Icon name="download" />} variant="ghost-muted" size="small" title={tr("Export")} onClick={exportPreset} />
        <IconButton icon={<Icon name="pencil-line" />} variant="ghost-muted" size="small" title={tr("Rename")} onClick={() => setRenaming(true)} />
        <IconButton icon={<Icon name="trash" />} variant="ghost-muted" size="small" title={tr("Delete preset")} disabled={file.presets.length < 2} onClick={() => { const presets = file.presets.filter((p) => p.id !== preset.id); edit({ active: presets[0]?.id ?? "", presets }) }} />
        <IconButton icon={<Icon name="eye" />} variant="ghost-muted" size="small" title={tr("Show full prompt")} onClick={() => void showPreview()} />
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { void importFile(e.currentTarget.files?.[0]); e.currentTarget.value = "" }} />
      </div>
      <div className="prompt-list" onPointerMove={dragMove} onPointerUp={() => setDragging(null)} onPointerCancel={() => setDragging(null)}>
        {preset.prompts.map((q, i) => {
          const locked = !!q.builtin && view.locked.includes(q.builtin)
          const badge = q.builtin === MAIN ? (q.content ? tr("Edited") : tr("Default")) : q.builtin ? tr("Marker") : q.placement === "system" ? tr("System prompt") : tr("After your message")
          return (
            <div key={q.id} data-prompt-index={i} className="prompt-row" data-off={!q.enabled || undefined} data-dragging={dragging === i || undefined}>
              <button
                type="button"
                className="prompt-grip"
                aria-label={tr("Move")}
                title={tr("Drag to move. Arrow keys work too.")}
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(i) }}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
                  e.preventDefault()
                  move(i, e.key === "ArrowUp" ? i - 1 : i + 1)
                }}
              >
                <IconSmall name="grip" />
              </button>
              <input type="checkbox" className="size-4 shrink-0 accent-[var(--c-contrast)]" aria-label={tr("On")} title={locked ? tr("Always on") : undefined} checked={q.enabled} disabled={locked} onChange={(e) => editPrompt(q.id, { enabled: e.currentTarget.checked })} />
              <button type="button" className="prompt-name" onClick={() => setEditing(q.id)}>
                <span className="truncate">{q.builtin ? partLabel(q.builtin) : q.name.trim() || tr("Untitled prompt")}</span>
                <span className="prompt-badge" data-kind={q.builtin === MAIN ? "main" : q.builtin ? "marker" : "prompt"}>{badge}</span>
              </button>
              <span className="prompt-size">{locked ? tr("Always on") : chars(textOf(q).length)}</span>
            </div>
          )
        })}
        <button type="button" className="prompt-add" disabled={preset.prompts.filter((q) => !q.builtin).length >= 100} onClick={addPrompt}>
          <IconSmall name="plus" /> {tr("Add prompt")}
        </button>
      </div>
      {draft || done || err ? (
        <div className="prompt-savebar">
          {err ? <span className="min-w-0 flex-1 text-12 text-danger">{err}</span> : done ? <span className="flex-1 text-12 text-success">{tr("Saved")}</span> : <span className="flex-1 text-12 text-ink-muted">{tr("Unsaved changes")}</span>}
          {draft ? <Button variant="ghost" size="normal" onClick={() => { setDraft(null); setErr("") }}>{tr("Discard")}</Button> : null}
          {draft ? <Button variant="neutral" size="normal" disabled={busy} onClick={save}>{busy ? tr("Saving…") : tr("Save")}</Button> : null}
        </div>
      ) : null}

      <ModalDialog open={!!open} onClose={() => setEditing(null)}>
        {open ? <PromptEditor key={open.id} prompt={open} view={view} onChange={(patch) => editPrompt(open.id, patch)} onDelete={() => { editPreset((p) => ({ ...p, prompts: p.prompts.filter((x) => x.id !== open.id) })); setEditing(null) }} onClose={() => setEditing(null)} /> : null}
      </ModalDialog>
      <ModalDialog open={!!preview} onClose={() => setPreview(null)}>
        {preview ? (
          <Dialog title={tr("Full prompt")} size="large" className="skill-dialog">
            <p className="text-12 text-ink-muted">{tr("What a new conversation outside any app receives with this preset.")}</p>
            <span className="text-12 text-ink-muted">{tr("System prompt, {n} chars", { n: preview.system.length.toLocaleString() })}</span>
            <pre className="skill-body whitespace-pre-wrap text-12 leading-5 text-ink">{preview.system}</pre>
            <span className="text-12 text-ink-muted">{preview.message ? tr("Added after each message, {n} chars", { n: preview.message.length.toLocaleString() }) : tr("Nothing is added to your messages.")}</span>
            {preview.message ? <pre className="skill-body whitespace-pre-wrap text-12 leading-5 text-ink">{preview.message}</pre> : null}
          </Dialog>
        ) : null}
      </ModalDialog>
    </div>
  )
}

function PromptEditor(props: { prompt: AgentPrompt; view: AgentPromptsView; onChange: (patch: Partial<AgentPrompt>) => void; onDelete: () => void; onClose: () => void }) {
  const { prompt, view, onChange } = props
  const area = useRef<HTMLTextAreaElement>(null)
  const main = prompt.builtin === MAIN
  const text = main ? prompt.content || view.parts.main : prompt.content
  // an unchanged main prompt stays on the shipped text, so engine updates reach it
  const setText = (value: string) => onChange({ content: main && value === view.parts.main ? "" : value })
  const insert = (macro: string) => {
    const el = area.current
    const token = `{{${macro}}}`
    const at = el ? el.selectionStart : text.length
    const end = el ? el.selectionEnd : text.length
    setText(text.slice(0, at) + token + text.slice(end))
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + token.length, at + token.length) })
  }

  if (isMarker(prompt)) {
    const content = view.parts.markers[prompt.builtin]
    return (
      <Dialog title={partLabel(prompt.builtin)} size="large" className="skill-dialog">
        <p className="text-13 text-ink">{markerHint(prompt.builtin)}</p>
        <p className="text-12 text-ink-muted">{tr("Filled in when a conversation starts. To place it inside a prompt instead, switch this off and write {macro} there.", { macro: `{{${view.macros[prompt.builtin]}}}` })}</p>
        {content ? <pre className="skill-body whitespace-pre-wrap text-12 leading-5 text-ink">{content}</pre> : <p className="text-12 text-ink-muted">{tr("Empty right now.")}</p>}
      </Dialog>
    )
  }

  const macros: Array<[string, string]> = [
    ["user", tr("your name")],
    ["date", tr("today's date")],
    ...(Object.keys(view.macros) as Marker[]).map((m): [string, string] => [view.macros[m], partLabel(m)]),
  ]
  return (
    <Dialog title={main ? tr("Main prompt") : tr("Edit prompt")} size="large" className="skill-dialog">
      <div className="skill-form">
        {main ? (
          <p className="text-12 text-ink-muted">{tr("The agent's core rules and tools. Editing can break how it works; Reset brings back the shipped text.")}</p>
        ) : (
          <div className="skill-form-pair">
            <label>
              {tr("Name")}
              <input className="skill-field" value={prompt.name} maxLength={120} placeholder={tr("Untitled prompt")} autoFocus onChange={(e) => onChange({ name: e.currentTarget.value })} />
            </label>
            <label>
              {tr("Where")}
              <Select
                options={["system", "message"] as AgentPrompt["placement"][]}
                current={prompt.placement}
                label={(x) => (x === "system" ? tr("System prompt") : tr("After your message"))}
                onSelect={(x) => x && onChange({ placement: x })}
              />
            </label>
          </div>
        )}
        <div className="skill-form-body">
          <label htmlFor="prompt-text">{tr("Text")}</label>
          <textarea id="prompt-text" ref={area} className="skill-field skill-editor" value={text} maxLength={64_000} spellCheck={false} placeholder={tr("What the agent should be told.")} onChange={(e) => setText(e.currentTarget.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-12 text-ink-muted">{tr("Insert")}</span>
          <div className="skill-files">
            {macros.map(([name, label]) => (
              <Button key={name} size="small" variant="ghost" title={label} onClick={() => insert(name)}>{`{{${name}}}`}</Button>
            ))}
          </div>
        </div>
        <div className="skill-actions">
          {main ? <Button variant="ghost" disabled={!prompt.content} onClick={() => onChange({ content: "" })}>{tr("Reset to default")}</Button> : <Button variant="ghost" onClick={props.onDelete}>{tr("Delete prompt")}</Button>}
          <span className="grow" />
          <span className={cn("text-12 text-ink-faint")}>{chars(text.length)}</span>
          <Button variant="neutral" onClick={props.onClose}>{tr("Done")}</Button>
        </div>
      </div>
    </Dialog>
  )
}
