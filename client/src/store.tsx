// The Store: apps anyone can install, listed by the engine (/v1/store). The
// launcher shows how many were added since the Store was last opened, the
// Store itself hands an install to the import preview, and a new account's
// welcome screen installs the official apps it picks in one go.
import { useCallback, useEffect, useState } from "react"
import { installFromGit, storeApi } from "./api"
import type { StoreApp, StoreList } from "./types"
import { Button } from "./ui/button"
import { IconSmall } from "./ui/icon"
import { cn } from "./ui/cn"
import { tr } from "./i18n/index"

const STORE_REPOSITORY = "https://github.com/ProjectChrysalis/app-store"

const latestAdded = (apps: StoreApp[]): string | null =>
  apps.reduce<string | null>((max, a) => (max === null || a.added > max ? a.added : max), null)

/** The Store list plus which entries are new to this account. The first time
 *  an account sees the list, everything on it counts as seen: only apps added
 *  after that are announced. */
export function useStore() {
  const [list, setList] = useState<StoreList | null>(null)
  const [seen, setSeen] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (fresh = false) => {
    setLoading(true)
    try {
      const [next, lastSeen] = await Promise.all([storeApi.list(fresh), storeApi.seen()])
      setList(next)
      const latest = latestAdded(next.apps)
      if (lastSeen === null && latest) {
        await storeApi.markSeen(latest).catch(() => undefined)
        setSeen(latest)
      } else {
        setSeen(lastSeen)
      }
    } catch (e: any) {
      setList({ enabled: true, apps: [], fetchedAt: null, error: e.message ?? String(e) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const markSeen = useCallback(async () => {
    const latest = latestAdded(list?.apps ?? [])
    if (!latest || (seen && seen >= latest)) return
    setSeen(latest)
    await storeApi.markSeen(latest).catch(() => undefined)
  }, [list, seen])

  const isNew = (a: StoreApp) => !!seen && a.added > seen && !a.installed
  const newCount = (list?.apps ?? []).filter(isNew).length

  return { list, loading, reload: load, markSeen, isNew, newCount }
}

export type StoreState = ReturnType<typeof useStore>

function OfficialBadge(props: { official: boolean }) {
  return (
    <span
      className="shrink-0 rounded-full border border-line px-1.5 py-px text-9 font-medium tracking-wide text-ink-muted"
      title={props.official ? tr("Built and maintained by the Chrysalis maintainers") : tr("Made by someone in the community")}
    >
      {props.official ? tr("Official App") : tr("Community")}
    </span>
  )
}

function NewBadge() {
  return <span className="shrink-0 rounded-full bg-accent/20 px-1.5 py-px text-9 font-medium tracking-wide text-ink">{tr("New")}</span>
}

/** The Store's list: every app on it, official ones first. */
export function StoreDialog(props: {
  store: StoreState
  onClose: () => void
  onInstall: (app: StoreApp) => void
  onOpen: (id: string) => void
}) {
  const { store } = props
  // what counted as new when the Store opened keeps its badge while it is open
  const [shownNew] = useState(() => new Set((store.list?.apps ?? []).filter(store.isNew).map((a) => a.id)))
  useEffect(() => {
    void store.markSeen()
  }, [store.markSeen])

  const apps = store.list?.apps ?? []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 max-md:items-end" onClick={props.onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 overflow-hidden rounded-xl border border-line bg-panel p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <IconSmall name="store" size="large" className="text-icon" />
          <h3 className="flex-1 text-14 font-medium text-ink">{tr("Store")}</h3>
          <button
            className="flex size-8 cursor-pointer items-center justify-center rounded-md text-ink-faint hover:bg-hover hover:text-ink disabled:opacity-50"
            title={tr("Refresh")}
            aria-label={tr("Refresh")}
            disabled={store.loading}
            onClick={() => void store.reload(true)}
          >
            <IconSmall name="rebuild" className={cn({ "animate-spin": store.loading })} />
          </button>
          <button
            className="flex size-8 cursor-pointer items-center justify-center rounded-md text-ink-faint hover:bg-hover hover:text-ink"
            title={tr("Close")}
            aria-label={tr("Close")}
            onClick={props.onClose}
          >
            <IconSmall name="outline-xmark" />
          </button>
        </div>
        {store.list?.error ? <p className="text-12 leading-4 text-danger">{store.list.error}</p> : null}
        {store.list && !store.list.enabled ? (
          <p className="text-13 text-ink-muted">{tr("The Store is turned off in this server's config.yaml.")}</p>
        ) : null}
        {store.loading && !apps.length ? <p className="text-13 text-ink-faint">{tr("Loading the Store…")}</p> : null}
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
          {apps.map((a) => (
            <li key={a.id} className="flex flex-col gap-1.5 rounded-lg border border-line p-3">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-14 font-medium text-ink">{a.name}</span>
                <OfficialBadge official={a.official} />
                {shownNew.has(a.id) ? <NewBadge /> : null}
                <span className="flex-1" />
                {a.installed ? (
                  <Button variant="ghost-muted" size="small" onClick={() => props.onOpen(a.installed!)}>
                    {tr("Open")}
                  </Button>
                ) : (
                  <Button variant="neutral" size="small" onClick={() => props.onInstall(a)}>
                    {tr("Install")}
                  </Button>
                )}
              </div>
              <p className="text-12 text-ink-muted">{tr("by {author}", { author: a.author })}</p>
              <p className="text-12 leading-4 text-ink">{a.description}</p>
              {a.tags.length ? (
                <div className="flex flex-wrap gap-1">
                  {a.tags.map((t) => (
                    <span key={t} className="rounded-full bg-pressed/50 px-1.5 py-0.5 text-10 text-ink-muted">{t}</span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="text-11 leading-4 text-ink-faint">
          {tr("Community apps are made by other people. Install only what you trust.")}{" "}
          <a href={STORE_REPOSITORY} target="_blank" rel="noreferrer noopener" className="text-ink-muted underline hover:text-ink">
            {tr("Add your app")}
          </a>
        </p>
      </div>
    </div>
  )
}

type InstallState = { state: "waiting" } | { state: "installing" } | { state: "done"; id: string } | { state: "failed"; message: string }

/** A new account's first screen: the official apps, preselected, installed
 *  with one click. */
export function WelcomeApps(props: { store: StoreState; onDone: (ids: string[]) => void; onSkip: () => void; onBrowse: () => void }) {
  const { store } = props
  const official = (store.list?.apps ?? []).filter((a) => a.official)
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [progress, setProgress] = useState<Record<string, InstallState>>({})
  const busy = Object.values(progress).some((p) => p.state === "installing" || p.state === "waiting")
  const chosen = picked ?? new Set(official.map((a) => a.id))

  const toggle = (id: string) => {
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }

  const install = async () => {
    const queue = official.filter((a) => chosen.has(a.id) && !a.installed)
    setProgress(Object.fromEntries(queue.map((a) => [a.id, { state: "waiting" } as InstallState])))
    const ids: string[] = []
    let failed = false
    for (const a of queue) {
      setProgress((prev) => ({ ...prev, [a.id]: { state: "installing" } }))
      try {
        const id = await installFromGit(a.repository, a.ref, a.id)
        ids.push(id)
        setProgress((prev) => ({ ...prev, [a.id]: { state: "done", id } }))
      } catch (e: any) {
        failed = true
        setProgress((prev) => ({ ...prev, [a.id]: { state: "failed", message: e.message ?? String(e) } }))
      }
    }
    if (!failed) props.onDone(ids)
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 pb-4">
      <p className="text-13 text-ink-muted">{tr("Pick apps to start with. You can add more from the Store any time.")}</p>
      {store.loading && !official.length ? <p className="text-13 text-ink-faint">{tr("Loading the Store…")}</p> : null}
      {store.list?.error ? (
        <div className="flex items-center gap-2">
          <p className="flex-1 text-12 leading-4 text-danger">{store.list.error}</p>
          <Button variant="ghost-muted" size="small" disabled={store.loading} onClick={() => void store.reload(true)}>
            {tr("Try again")}
          </Button>
        </div>
      ) : null}
      {store.list && !store.list.enabled ? <p className="text-13 text-ink-muted">{tr("The Store is turned off in this server's config.yaml.")}</p> : null}
      <ul className="flex flex-col gap-2">
        {official.map((a) => {
          const p = progress[a.id]
          return (
            <li key={a.id}>
              <label
                className={cn("flex cursor-pointer gap-3 rounded-lg border px-4 py-3 transition-colors hover:bg-hover", {
                  "border-line-focus": chosen.has(a.id),
                  "border-line": !chosen.has(a.id),
                })}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-current"
                  checked={chosen.has(a.id) || !!a.installed}
                  disabled={busy || !!a.installed}
                  onChange={() => toggle(a.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-14 font-medium text-ink">{a.name}</span>
                    <OfficialBadge official />
                  </span>
                  <span className="mt-0.5 block text-12 leading-4 text-ink-muted">{a.description}</span>
                  {a.installed ? <span className="mt-1 block text-11 text-ink-faint">{tr("Installed")}</span> : null}
                  {p?.state === "waiting" ? <span className="mt-1 block text-11 text-ink-faint">{tr("Waiting…")}</span> : null}
                  {p?.state === "installing" ? <span className="mt-1 block text-11 text-ink-faint">{tr("Installing…")}</span> : null}
                  {p?.state === "done" ? <span className="mt-1 block text-11 text-success">{tr("Installed")}</span> : null}
                  {p?.state === "failed" ? <span className="mt-1 block text-11 leading-4 text-danger">{p.message}</span> : null}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button className="cursor-pointer text-12 text-ink-muted underline hover:text-ink" onClick={props.onBrowse}>
          {tr("Browse the Store")}
        </button>
        <span className="flex-1" />
        <Button variant="ghost-muted" size="small" disabled={busy} onClick={props.onSkip}>
          {tr("Skip")}
        </Button>
        <Button
          variant="neutral"
          size="small"
          disabled={busy || !official.some((a) => chosen.has(a.id) && !a.installed)}
          onClick={() => void install()}
        >
          {busy ? tr("Installing…") : tr("Install")}
        </Button>
      </div>
    </div>
  )
}
