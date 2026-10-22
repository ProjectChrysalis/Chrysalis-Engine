import { useEffect, useMemo, useState } from "react"
import { Button } from "./ui/button"
import { Dialog, ModalDialog } from "./ui/dialog"
import { Icon } from "./ui/icon"
import { Markdown } from "./ui/markdown"
import { Select } from "./ui/select"
import { tr } from "./i18n"
import { api } from "./api"
import { useResource } from "./use-resource"

type Skill = { name: string; description: string }
type AppSkills = { id: string; name: string; skills: Skill[]; errors: string[] }
type Detail = Skill & { body: string; files: string[] }
type Draft = { appId: string; name: string; description: string; body: string }
type Open = { mode: "view" | "edit"; appId: string | null; name: string } | { mode: "add" }

const skillsOf = (id: string) => `/v1/agent/apps/${encodeURIComponent(id)}/skills`
const skillOf = (id: string | null, name: string) => id === null ? `/v1/agent/skills/${encodeURIComponent(name)}` : `${skillsOf(id)}/${encodeURIComponent(name)}`
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** What a skill's folder may be called: typing "My skill" gives "my-skill". */
const slug = (text: string) => text.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").replace(/^-/, "").slice(0, 64)

/** Every app's skills on one page: read one, add one, change or delete one. */
export function AgentSkills() {
  const catalog = useResource(() => api<{ engine: Skill[]; apps: AppSkills[] }>("GET", "/v1/agent/skills"))
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState<Open | null>(null)
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({})
  const apps = catalog.data?.apps ?? []
  const engine = catalog.data?.engine ?? []
  const total = engine.length + apps.reduce((n, app) => n + app.skills.length, 0)
  const needle = query.trim().toLowerCase()
  const groups = [...(engine.length ? [{ id: null, name: tr("Engine"), skills: engine, errors: [] }] : []), ...apps]
    .map((app) => ({ ...app, shown: app.skills.filter((s) => !needle || `${s.name} ${s.description} ${app.name}`.toLowerCase().includes(needle)) }))
    .filter((app) => app.shown.length || app.errors.length)
  const without = apps.filter((app) => !app.skills.length && !app.errors.length)
  // a short list is shown whole; a long one starts folded to one line per app
  const isOpen = (id: string | null) => !!needle || (unfolded[id === null ? "engine" : `app:${id}`] ?? total <= 6)

  const changed = (appId: string) => {
    // open chats pick the change up without a reload
    const channel = new BroadcastChannel("chrysalis-skills")
    channel.postMessage({ appId })
    channel.close()
    return catalog.refetch()
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-13 font-medium text-ink">{tr("Skills")}</h3>
        <Button size="small" icon="plus" disabled={!apps.length} onClick={() => setOpen({ mode: "add" })}>{tr("Add skill")}</Button>
      </div>
      <p className="text-12 leading-4 text-ink-muted">{tr("Engine and app instructions, loaded when a task calls for them.")}</p>
      {total > 6 ? (
        <input className="skill-field" aria-label={tr("Search skills")} placeholder={tr("Search skills…")} value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      ) : null}
      {catalog.loading && !catalog.data ? <p className="text-12 text-ink-muted" role="status">{tr("Loading…")}</p> : null}
      {catalog.data && !apps.length ? <p className="text-12 text-ink-muted">{tr("No apps installed yet.")}</p> : null}
      {apps.length && !total && !groups.length ? <p className="text-12 text-ink-muted">{tr("No skills yet. Add one, or install an app that brings its own.")}</p> : null}
      {total && needle && !groups.some((g) => g.shown.length) ? <p className="text-12 text-ink-muted">{tr("No matching skills.")}</p> : null}
      {groups.map((app) => (
        <div key={app.id === null ? "engine" : `app:${app.id}`} className="skill-group">
          <button type="button" className="skill-group-head" aria-expanded={isOpen(app.id)} disabled={!!needle} onClick={() => setUnfolded((u) => ({ ...u, [app.id === null ? "engine" : `app:${app.id}`]: !isOpen(app.id) }))}>
            <Icon name={isOpen(app.id) ? "chevron-down" : "chevron-right"} size={12} />
            <span className="grow text-left">{app.name}</span>
            <span>{app.skills.length}</span>
          </button>
          {(isOpen(app.id) ? app.shown : []).map((skill) => (
            <button key={skill.name} type="button" className="skill-row" onClick={() => setOpen({ mode: "view", appId: app.id, name: skill.name })}>
              <span className="skill-row-text">
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
              </span>
              <Icon name="chevron-right" size={14} />
            </button>
          ))}
          {app.errors.map((error) => <p key={error} className="skill-group-error" role="alert">{error}</p>)}
        </div>
      ))}
      {without.length && total ? <p className="text-12 text-ink-faint">{tr("No skills yet: {apps}", { apps: without.map((app) => app.name).join(", ") })}</p> : null}
      <ModalDialog open={open !== null} onClose={() => setOpen(null)}>
        {open ? <SkillDialog key={open.mode === "add" ? "add" : `${open.appId}/${open.name}`} open={open} apps={apps} setOpen={setOpen} changed={changed} /> : null}
      </ModalDialog>
    </section>
  )
}

function SkillDialog(props: { open: Open; apps: AppSkills[]; setOpen: (open: Open | null) => void; changed: (appId: string) => Promise<void> }) {
  const { open, apps, setOpen } = props
  const adding = open.mode === "add"
  const appId = adding ? "" : open.appId
  const name = adding ? "" : open.name
  const builtin = !adding && appId === null
  const [resource, setResource] = useState("")
  const [resourceText, setResourceText] = useState("")
  const [detail, setDetail] = useState<Detail | null>(null)
  const [draft, setDraft] = useState<Draft>({ appId: apps[0]?.id ?? "", name: "", description: "", body: "" })
  const [preview, setPreview] = useState(false)
  const [ask, setAsk] = useState<"delete" | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const app = apps.find((a) => a.id === (adding ? draft.appId : appId))
  // the value is read before the update is queued: the event is gone by the time an updater runs
  const set = (part: Partial<Draft>) => setDraft((d) => ({ ...d, ...part }))

  useEffect(() => {
    if (adding) return
    let live = true
    void api<Detail>("GET", skillOf(appId, name))
      .then((d) => {
        if (!live) return
        setDetail(d)
        setDraft({ appId: appId ?? "", name, description: d.description, body: d.body })
      })
      .catch((e) => live && setError(message(e)))
    return () => {
      live = false
    }
  }, [adding, appId, name])

  useEffect(() => {
    if (!builtin || !resource) { setResourceText(""); return }
    let live = true
    setResourceText("")
    setError("")
    void api<{ text: string }>("GET", `${skillOf(null, name)}/resource?path=${encodeURIComponent(resource)}`)
      .then((result) => { if (live) setResourceText(result.text) })
      .catch((e) => { if (live) setError(message(e)) })
    return () => { live = false }
  }, [builtin, name, resource])

  const editing = adding || (!builtin && open.mode === "edit")
  const ready = useMemo(() => !!draft.appId && !!draft.name && !!draft.description.trim() && !!draft.body.trim(), [draft])

  const run = async (work: () => Promise<{ warning?: string } | void>, after: () => void) => {
    setBusy(true)
    setError("")
    try {
      const result = await work()
      await props.changed(draft.appId)
      if (result?.warning) setError(result.warning)
      after()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const save = () =>
    adding
      ? run(
          () => api<{ warning?: string }>("POST", skillsOf(draft.appId), { name: draft.name, description: draft.description, body: draft.body }),
          () => setOpen({ mode: "view", appId: draft.appId, name: draft.name }),
        )
      : run(
          () => api<{ warning?: string }>("PUT", skillOf(appId, name), { description: draft.description, body: draft.body }),
          () => {
            setDetail((d) => d && { ...d, description: draft.description.trim(), body: draft.body.trim() })
            setOpen({ mode: "view", appId, name })
          },
        )
  const remove = () => run(() => api<{ warning?: string }>("DELETE", skillOf(appId, name)), () => setOpen(null))
  const cancel = () => {
    if (adding) return setOpen(null)
    if (detail) setDraft({ appId: appId ?? "", name, description: detail.description, body: detail.body })
    setPreview(false)
    setOpen({ mode: "view", appId, name })
  }

  return (
    <Dialog title={adding ? tr("Add skill") : editing ? tr("Edit skill") : name} size="large" className="skill-dialog">
      {error ? <p className="text-12 text-danger" role="alert">{error}</p> : null}
      {editing ? (
        <form
          className="skill-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready && !busy) void save()
          }}
        >
          {adding ? (
            <div className="skill-form-pair">
              <label>
                {tr("App")}
                <Select options={apps} current={app} value={(a) => a.id} label={(a) => a.name} onSelect={(a) => a && set({ appId: a.id })} disabled={busy} />
              </label>
              <label>
                {tr("Name")}
                <input className="skill-field font-mono" value={draft.name} maxLength={64} placeholder="my-skill" autoFocus required onChange={(e) => set({ name: slug(e.currentTarget.value) })} />
              </label>
            </div>
          ) : null}
          <label>
            {tr("Description")}
            <input className="skill-field" value={draft.description} maxLength={1024} required placeholder={tr("Tells the agent when to use this skill.")} onChange={(e) => set({ description: e.currentTarget.value })} />
          </label>
          <div className="skill-form-body">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="skill-body">{tr("Instructions")}</label>
              <div className="skill-toggle" role="tablist">
                <button type="button" role="tab" aria-selected={!preview} onClick={() => setPreview(false)}>{tr("Write")}</button>
                <button type="button" role="tab" aria-selected={preview} onClick={() => setPreview(true)}>{tr("Preview")}</button>
              </div>
            </div>
            {preview ? (
              <div className="skill-body">{draft.body.trim() ? <Markdown text={draft.body} /> : <p className="text-12 text-ink-muted">{tr("Nothing to preview yet.")}</p>}</div>
            ) : (
              <textarea id="skill-body" className="skill-field skill-editor" value={draft.body} maxLength={32768} required spellCheck={false} placeholder={tr("Markdown works here.")} onChange={(e) => set({ body: e.currentTarget.value })} />
            )}
          </div>
          <div className="skill-actions">
            <span className="grow" />
            <Button variant="ghost" disabled={busy} onClick={cancel}>{tr("Cancel")}</Button>
            <Button type="submit" variant="neutral" disabled={busy || !ready}>{busy ? tr("Saving…") : adding ? tr("Add skill") : tr("Save")}</Button>
          </div>
        </form>
      ) : !detail ? (
        error ? null : <p className="text-12 text-ink-muted" role="status">{tr("Loading…")}</p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-13 text-ink">{detail.description}</p>
            <p className="text-12 text-ink-muted">
              {builtin ? tr("Engine") : app?.name} · {tr("Type /skill {name} in a chat to load it yourself.", { name })}
            </p>
          </div>
          <div className="skill-body"><Markdown text={detail.body} /></div>
          {detail.files.length ? (
            <div className="flex flex-col gap-1">
              <span className="text-12 text-ink-muted">{tr("Files in this skill")}</span>
              <div className="skill-files">{detail.files.map((file) => builtin ? <Button key={file} size="small" variant="ghost" onClick={() => setResource(file)}>{file}</Button> : <code key={file}>{file}</code>)}</div>
            </div>
          ) : null}
          {builtin && resource ? <div className="skill-body">{resourceText ? <Markdown text={resourceText} /> : !error ? <p role="status">{tr("Loading…")}</p> : null}</div> : null}
          {builtin ? <p className="text-12 text-ink-muted">{tr("Built into Chrysalis. Available in every chat.")}</p> : ask === "delete" ? (
            <div className="skill-actions">
              <span className="grow text-12 text-ink">{tr("Delete this skill? Its folder is deleted with everything in it.")}</span>
              <Button variant="ghost" disabled={busy} onClick={() => setAsk(null)}>{tr("Cancel")}</Button>
              <Button variant="danger" disabled={busy} onClick={() => void remove()}>{busy ? tr("Deleting…") : tr("Delete")}</Button>
            </div>
          ) : (
            <div className="skill-actions">
              <Button variant="ghost" onClick={() => setAsk("delete")}>{tr("Delete")}</Button>
              <span className="grow" />
              <Button icon="pencil-line" onClick={() => setOpen({ mode: "edit", appId, name })}>{tr("Edit")}</Button>
            </div>
          )}
        </>
      )}
    </Dialog>
  )
}
