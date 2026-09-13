// Chrysalis shell: logo, tabs, theme toggle, auth, launch picker.
import { Fragment, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { createPortal } from "react-dom"
import { ModalDialog } from "./ui/dialog"
import { cn } from "./ui/cn"
import { useResource } from "./use-resource"
import { TextShimmer } from "./ui/text-shimmer"
import { IconSmall } from "./ui/icon"
import { Icon } from "./ui/icon"
import { IconButton } from "./ui/button"
import { Button } from "./ui/button"
import { api, prefs, authApi, appPluginsApi, type AuthUser } from "./api"
import { SettingsBody, type TabValue } from "./settings"
import type { LaunchInfo, Me } from "./types"
import { tr, useLocale } from "./i18n/index"

type Tab = { id: string; kind: "agent" | "app" | "new"; name: string }
const AGENT_TAB_ID = "__agent"
const agentTab = (): Tab => ({ id: AGENT_TAB_ID, kind: "agent", name: tr("Agent") })
/** A New tab is a REAL tab: it has its own id, survives a refresh, and closes
 * only when the user closes it. Picking a destination in one turns THAT tab
 * into the destination, in place. */
let newTabSeq = 0
const newTab = (): Tab => ({ id: `__new:${Date.now().toString(36)}${newTabSeq++}`, kind: "new", name: tr("New tab") })
const isNewTabId = (id: string) => id.startsWith("__new")
/** the open strip + active tab + pinned pane, so a refresh lands back where
 * you were instead of the picker (cleared by logout) */
const SESSION_TABS_KEY = "chrysalis-session-tabs"

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" stroke="currentColor" />
      <path
        d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.2 9.8A5.7 5.7 0 0 1 6.2 2.8 5.7 5.7 0 1 0 13.2 9.8Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Logo(props: { size?: number }) {
  return (
    <img
      src="/client/chrysalis_logo.png"
      alt="Chrysalis"
      width={props.size ?? 20}
      height={props.size ?? 20}
      className="rounded-[4px]"
      style={{ width: `${props.size ?? 20}px`, height: `${props.size ?? 20}px` }}
    />
  )
}

export default function App() {
  useLocale() // subscribe here so a language switch re-renders the whole shell
  const [theme, setTheme] = useState<"light" | "dark">(prefs.get("chrysalis-theme") === "light" ? "light" : "dark")
  useEffect(() => {
    prefs.set("chrysalis-theme", theme)
    document.documentElement.setAttribute("data-color-scheme", theme)
  }, [theme])

  return (
    <Shell theme={theme} onTheme={() => setTheme(theme === "dark" ? "light" : "dark")} />
  )
}

function Shell(props: { theme: "light" | "dark"; onTheme: () => void }) {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [user, setUser] = useState<Me | null>(null)
  const [launch, setLaunch] = useState<LaunchInfo | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<Tab | null>(null)
  /** split-screen: an app tab pinned to the RIGHT half (agent left) — the
   * iframe keeps its DOM node, only the grid column changes (no reload) */
  const [pinned, setPinned] = useState<Tab | null>(null)
  const [splitPct, setSplitPct] = useState(Number(prefs.get("chrysalis-split-pct")) || 50)
  const [splitActive, setSplitActive] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  /** flipped once enter() has restored the stored strip — the write-through
   * below must stay silent until then, or the empty pre-restore mount state
   * clobbers the session before it's read back */
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [settingsTab, setSettingsTab] = useState<TabValue | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // one plugins dialog for the whole shell: the app toolbar opens it on
  // desktop, the account menu on phones. The id outlives the close so the
  // exit animation still shows the app it was about.
  const [pluginsFor, setPluginsFor] = useState("")
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const openPlugins = (appId: string) => {
    setPluginsFor(appId)
    setPluginsOpen(true)
  }
  // write-through session save: the whole strip (New tabs included), the
  // active tab and the pinned pane survive refreshes; logout wipes the key
  useEffect(() => {
    if (!sessionLoaded) return
    prefs.set(
      SESSION_TABS_KEY,
      JSON.stringify({ tabs, active: active?.id ?? null, pinned: pinned?.id ?? null }),
    )
  }, [sessionLoaded, tabs, active, pinned])
  const openSettings = (tab?: TabValue) => {
    setSettingsTab(tab ?? null)
    setSettingsOpen(true)
  }

  useEffect(() => {
    void (async () => {
      try {
        setUser(await api<Me>("GET", "/v1/me"))
        return enter()
      } catch {
        // a bearer token stored by an older shell is never sent again
        prefs.remove("chrysalis-token")
      }
      setAuthed(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot, once
  }, [])

  async function enter() {
    setAuthed(true)
    const l = await api<LaunchInfo>("GET", "/v1/launch")
    setLaunch(l)
    // Land on the launcher — the "where to" picker IS the default surface.
    // Apps (including the engine default) open on click, never automatically.
    // A stored strip from this browser session comes back instead: apps that
    // were uninstalled since are dropped, and a dead active/pinned id falls
    // back to the picker.
    let strip: Tab[] = []
    let activeId: string | null = null
    let pinnedId: string | null = null
    try {
      const saved = JSON.parse(prefs.get(SESSION_TABS_KEY) ?? "null") as
        | { tabs?: Tab[]; active?: string | null; pinned?: string | null }
        | null
      for (const t of saved?.tabs ?? []) {
        if (t.kind === "agent") {
          if (!strip.some((x) => x.id === AGENT_TAB_ID)) strip.push(agentTab())
        } else if (t.kind === "new" && typeof t.id === "string" && isNewTabId(t.id)) {
          strip.push({ id: t.id, kind: "new", name: tr("New tab") })
        } else if (t.kind === "app" && l.apps.some((a) => a.id === t.id)) {
          strip.push({ id: t.id, kind: "app", name: appName(t.id, l) })
        }
      }
      activeId = saved?.active ?? null
      pinnedId = saved?.pinned ?? null
    } catch {
      /* corrupt payload — start from the picker */
    }
    // The strip comes back exactly as it was left. Nothing is appended to it:
    // a New tab is only ever there because the user opened one.
    const restored = strip.length ? strip : [agentTab(), newTab()]
    setTabs(restored)
    const activeTab = restored.find((t) => t.id === activeId) ?? restored[restored.length - 1] ?? null
    setActive(activeTab)
    const pinnedTab = strip.find((t) => t.kind === "app" && t.id === pinnedId) ?? null
    setPinned(pinnedTab)
    // the restored active app is what the user is looking at — agent tooling
    // should follow it, same as an explicit open
    if (activeTab?.kind === "app") {
      void api("POST", `/v1/apps/${encodeURIComponent(activeTab.id)}/activate`).catch(() => undefined)
    }
    setSessionLoaded(true)
  }

  async function login(username: string, password?: string) {
    await authApi.login(username, password)
    setUser(await api<Me>("GET", "/v1/me"))
    await enter()
  }

  async function logout() {
    try {
      await authApi.logout()
    } catch {}
    setSessionLoaded(false)
    prefs.remove("chrysalis-session")
    prefs.remove(SESSION_TABS_KEY)
    setUser(null)
    setTabs([])
    setActive(null)
    setPinned(null)
    setLaunch(null)
    setAuthed(false)
  }

  /** Put `t` where the New tab the user launched from sits, so choosing a
   * destination navigates that tab instead of moving the strip around. Falls
   * back to appending. When the destination is ALREADY open, its live tab
   * wins and the New tab is spent on the trip. */
  function placeTab(t: Tab): void {
    const strip = tabs
    const from = active
    const launchedFromNew = from?.kind === "new" ? from.id : null
    const existing = strip.findIndex((x) => x.id === t.id)
    if (existing >= 0) {
      if (launchedFromNew) setTabs(strip.filter((x) => x.id !== launchedFromNew))
      focusTab(strip[existing]!)
      return
    }
    const at = launchedFromNew ? strip.findIndex((x) => x.id === launchedFromNew) : -1
    if (at >= 0) {
      const next = strip.slice()
      next[at] = t
      setTabs(next)
    } else {
      setTabs([...strip, t])
    }
    focusTab(t)
  }
  function openAgent() {
    placeTab(agentTab())
  }
  // a prompt for the agent waits until its frame says it is listening: the
  // frame may not exist yet when the agent tab was closed
  const agentFrame = useRef<HTMLIFrameElement | null>(null)
  const agentReady = useRef(false)
  const pendingAgentPrompt = useRef<string | null>(null)
  const bindAgentFrame = useCallback((el: HTMLIFrameElement | null) => {
    agentFrame.current = el
    // a remounted frame announces itself again
    if (!el) agentReady.current = false
  }, [])
  const deliverAgentPrompt = () => {
    const text = pendingAgentPrompt.current
    const target = agentFrame.current?.contentWindow
    if (!text || !target || !agentReady.current) return
    pendingAgentPrompt.current = null
    target.postMessage({ __chrysalisAgent: "start", text }, location.origin)
  }
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== agentFrame.current?.contentWindow) return
      if ((e.data as { __chrysalisAgent?: unknown } | null)?.__chrysalisAgent !== "ready") return
      agentReady.current = true
      deliverAgentPrompt()
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])
  /** Open the agent on a fresh chat that starts with `prompt`. */
  function askAgent(prompt: string) {
    pendingAgentPrompt.current = prompt
    openAgent()
    deliverAgentPrompt()
  }
  /** Manifest name when known (launch list), else the id. Callers inside
   *  enter() pass the freshly fetched list — the `launch` state is still null
   *  in that closure, so trusting it named restored tabs by raw id. */
  function appName(id: string, from: LaunchInfo | null = launch): string {
    return from?.apps.find((a) => a.id === id)?.name || id
  }
  function openApp(id: string) {
    placeTab({ id, kind: "app", name: appName(id) })
  }
  /** Clicking a tab in the strip only switches to it — it never rearranges or
   * consumes anything, whatever tab you were on. */
  function focusTab(t: Tab) {
    setActive(t)
    // the app you are looking at is the active app (agent tools + pipeline
    // follow it); fire-and-forget and idempotent when already active
    if (t.kind === "app") void api("POST", `/v1/apps/${encodeURIComponent(t.id)}/activate`).catch(() => undefined)
  }
  /** The + button: one more New tab, focused. It stays in the strip until the
   * user closes it or picks a destination in it. */
  function openNewTab() {
    const t = newTab()
    setTabs([...tabs, t])
    setActive(t)
  }
  /** Closing the active tab lands on its neighbor — or the picker when the
   * strip is empty (the launch screen IS the no-tabs state). */
  function closeTab(t: Tab) {
    const rest = tabs.filter((x) => x.id !== t.id)
    setTabs(rest)
    if (pinned?.id === t.id) setPinned(null)
    if (active?.id === t.id) setActive(rest[rest.length - 1] ?? null)
  }
  /** Divider drag: window-level move listeners (the proven pattern — pointer
   * capture alone breaks under synthesized/remote input). Persists the ratio. */
  const startSplitDrag = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault()
    // capture keeps REAL drags alive while the cursor crosses the app iframe;
    // the window listeners below cover environments without capture support
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* untrusted/synthetic pointers — listeners still work */
    }
    const main = (e.currentTarget as HTMLElement).parentElement
    if (!main) return
    const r = main.getBoundingClientRect()
    setSplitActive(true)
    // the listeners outlive the render that created them, so the ratio to
    // persist is tracked here rather than read back off state
    let latest = splitPct
    const move = (ev: PointerEvent) => {
      const pct = ((ev.clientX - r.left) / r.width) * 100
      latest = Math.min(82, Math.max(18, pct))
      setSplitPct(latest)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setSplitActive(false)
      prefs.set("chrysalis-split-pct", String(latest))
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  /** Pin an app to the right half and bring the agent up on the left — the
   * watch-live-changes flow (agent edits hot-reload into the pinned pane). */
  function splitWith(t: Tab) {
    if (pinned?.id === t.id) {
      setPinned(null)
      setActive(t)
      return
    }
    setPinned(t)
    if (active?.id === t.id) openAgent()
  }

  return (
    <>
      {authed === null ? <SplashScreen /> : null}
      {authed === false ? <AuthScreen onLogin={login} onSetupDone={async () => {
        setUser(await api<Me>("GET", "/v1/me"))
        await enter()
      }} /> : null}
      {authed === true && user ? <div className="relative flex h-full min-h-0 min-w-0 flex-1 select-none flex-col bg-deep [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text">
          <header className="flex h-11 shrink-0 items-center gap-2 px-2 max-md:gap-1 max-md:px-1">
            <div className="flex items-center gap-2 pl-1 max-md:pl-0.5">
              <Logo />
              <span className="text-14 font-medium text-ink max-md:hidden">Chrysalis</span>
            </div>
            <nav className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pt-1" aria-label={tr("Tabs")}>
              {tabs.map((t, i) => (
                  <div key={t.id}
                    className="group/tab relative flex shrink-0 items-end"
                    draggable={true}
                    onDragStart={() => setDragIdx(i)}
                    onDragEnd={() => setDragIdx(null)}
                    onDragOver={(e) => {
                      e.preventDefault()
                      const from = dragIdx
                      if (from === null || from === i) return
                      const next = tabs.slice()
                      const [moved] = next.splice(from, 1)
                      next.splice(i, 0, moved!)
                      setTabs(next)
                      setDragIdx(i)
                    }}
                  >
                    <button
                      className="flex h-8 max-w-48 cursor-pointer select-none items-center gap-1.5 rounded-t-lg border border-b-0 border-transparent py-0 pl-2.5 pr-1.5 text-13 text-ink-muted transition-all duration-150 hover:bg-hover data-[active=true]:max-w-64 data-[active=true]:border-line data-[active=true]:bg-base data-[active=true]:pl-3 data-[active=true]:font-medium data-[active=true]:text-ink data-[dragging=true]:opacity-40"
                      data-active={active?.id === t.id}
                      data-dragging={dragIdx === i}
                      onClick={() => {
                        if (t.kind === "app" && pinned?.id === t.id) splitWith(t) // unsplit + focus
                        else focusTab(t)
                      }}
                      title={t.name}
                    >
                      <span className="truncate">{t.name}</span>
                      <span
                        role="button"
                        aria-label={tr("Close {name}", { name: t.name })}
                        className={"flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-ink-muted transition-all hover:bg-pressed hover:text-ink " + (active?.id === t.id ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100 pointer-coarse:opacity-100")}
                        onClick={(e) => {
                          e.stopPropagation()
                          closeTab(t)
                        }}
                        title={tr("Close {name}", { name: t.name })}
                      >
                        <IconSmall name="xmark-small" />
                      </span>
                    </button>
                  </div>
                ))}
              <button
                className="mb-0.5 ml-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                onClick={openNewTab}
                title={tr("New tab")}
              >
                <IconSmall name="plus" />
              </button>
            </nav>
            <div className="ml-auto flex items-center gap-1">
              <UserMenu
                username={user!.username}
                hasAvatar={user!.hasAvatar !== false}
                onLogout={() => void logout()}
                theme={props.theme}
                onTheme={props.onTheme}
                onSettings={() => openSettings()}
                app={active?.kind === "app" ? { id: active.id, name: active.name, onPlugins: () => openPlugins(active.id) } : null}
              />
            </div>
          </header>
          <main
            className="grid min-h-0 min-w-0 flex-1"
            style={{
              gridTemplateColumns: pinned
                ? `minmax(0, ${splitPct}fr) 12px minmax(0, ${100 - splitPct}fr)`
                : "minmax(0, 1fr)",
            }}
          >
            {/* no active tab = the launch screen (also what closing every tab
                lands on); it renders INSIDE main so the shell never splits */}
            {active === null || active?.kind === "new" ? <LaunchPicker
                launch={launch}
                onAgent={openAgent}
                onAskAgent={askAgent}
                onApp={openApp}
                onRefresh={() => api<LaunchInfo>("GET", "/v1/launch").then(setLaunch).catch(() => undefined)}
                onCloseTab={(id) => {
                  const t = tabs.find((x) => x.id === id)
                  if (t) closeTab(t)
                }}
              /> : null}
            {/* every tab stays MOUNTED (hidden by CSS) — switching never reloads
                an app iframe or drops the agent's live state */}
            <div className="flex min-h-0 min-w-0 flex-1" style={{ display: active?.kind === "agent" ? "flex" : "none", gridColumn: "1", gridRow: 1 }}>
              <iframe
                ref={bindAgentFrame}
                src="/agent"
                title={tr("Agent")}
                className="h-full w-full border-0"
              />
            </div>
            {pinned ? <div
                className="group relative z-10 cursor-col-resize"
                style={{ gridColumn: "2", gridRow: 1, touchAction: "none" }}
                title={tr("Drag to resize")}
                onPointerDown={(e) => startSplitDrag(e)}
              >
                <div
                  className={"pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 rounded-full transition-all " + (splitActive ? "w-[3px] bg-emerald-500" : "w-px bg-line group-hover:w-[2px] group-hover:bg-emerald-500/70")}
                />
              </div> : null}
            {(tabs.filter((t) => t.kind === "app")).map((t) => (
                <div key={t.id}
                  className="flex min-h-0 min-w-0 flex-col"
                  style={{
                    display: pinned?.id === t.id || active?.id === t.id ? "flex" : "none",
                    gridColumn: pinned?.id === t.id ? "3" : "1",
                    // every pane lives in row 1: with auto rows the browser's
                    // placement cursor moves forward, so a pane back at column
                    // 1 after one at column 3 was bumped to a second row
                    gridRow: 1,
                  }}
                >
                  <AppCanvas
                    username={user.username}
                    tab={t}
                    trusted={launch?.apps.find((a) => a.id === t.id)?.official === true}
                    onAskAgent={askAgent}
                    split={pinned?.id === t.id}
                    onSplit={() => splitWith(t)}
                    onPlugins={() => openPlugins(t.id)}
                  />
                </div>
              ))}
          </main>
          <AppPluginsDialog appId={pluginsFor} open={pluginsOpen} onClose={() => setPluginsOpen(false)} />
        </div> : null}
      {user ? (
        <ModalDialog open={settingsOpen} onClose={() => setSettingsOpen(false)}>
          <SettingsBody onClose={() => setSettingsOpen(false)} me={user} initialTab={settingsTab} onLogout={() => { setSettingsOpen(false); void logout() }} />
        </ModalDialog>
      ) : null}
    </>
  )
}

/** Boot splash: logo + shimmer while the session is being checked. */
function SplashScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-deep">
      <img src="/client/chrysalis_logo.png" alt="Chrysalis" width={56} height={56} className="rounded-[10px]" style={{ width: "56px", height: "56px" }} />
      <TextShimmer text="Loading…" />
    </div>
  )
}

/** Header chip: avatar/username → menu with settings, theme, and log out. On
 *  phones it also carries the open app's toolbar (standalone, plugins), which
 *  is hidden there so the shell is one bar. Split has no room at that width,
 *  and the agent is already a tab. */
function UserMenu(props: {
  username: string
  hasAvatar: boolean
  onLogout: () => void
  theme: "light" | "dark"
  onTheme: () => void
  onSettings: () => void
  app: { id: string; name: string; onPlugins: () => void } | null
}) {
  const [open, setOpen] = useState(false)
  const [avatarOk, setAvatarOk] = useState(true)
  const app = props.app
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: string; right: string } | null>(null)
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setPos({ top: `${r.bottom + 6}px`, right: `${window.innerWidth - r.right}px` })
    }
    setOpen(!open)
  }
  return (
    <div className="shrink-0">
      <Button
        ref={btnRef}
        variant="ghost-muted"
        size="normal"
        style={{ height: "28px" }}
        className="max-w-[140px] gap-1"
        title={tr("Account")}
        aria-haspopup="menu"
        aria-expanded={open ? "true" : "false"}
        onClick={toggle}
      >
        {avatarOk && props.hasAvatar ? <img
            src={`/v1/auth/avatar/${encodeURIComponent(props.username)}?v=${prefs.get("chrysalis-avatar-v") ?? "0"}`}
            alt=""
            className="size-4 shrink-0 rounded-full object-cover"
            onError={() => setAvatarOk(false)}
          /> : <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-pressed text-10 font-medium uppercase">
              {props.username.slice(0, 1)}
            </span>}
        <span className="truncate text-12 leading-4">{props.username}</span>
      </Button>
      {open ? createPortal(
        <>
          <button className="fixed inset-0 z-40 cursor-default" aria-label={tr("Close account menu")} onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label={tr("Account")}
            style={{ position: "fixed", top: pos?.top ?? "3rem", right: pos?.right ?? "1rem" }}
            className="z-50 flex w-44 flex-col rounded-lg border border-line bg-panel-raised p-1 shadow-[var(--s-raised)]"
          >
            {app ? <div className="flex flex-col border-b border-line pb-1 mb-1 md:hidden">
                <div className="truncate px-2 py-1.5 text-11 text-ink-muted">{app.name}</div>
                <button
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-13 transition-colors hover:bg-hover"
                  onClick={() => {
                    setOpen(false)
                    window.open(`/standalone?app=${encodeURIComponent(app.id)}`, "_blank", "noopener")
                  }}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <IconSmall name="outline-square-arrow" />
                  </span>
                  {tr("Fullscreen")}
                </button>
                <button
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-13 transition-colors hover:bg-hover"
                  onClick={() => {
                    setOpen(false)
                    app.onPlugins()
                  }}
                >
                  <Icon name="providers" size="small" />
                  {tr("Plugins")}
                </button>
                <button
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-13 transition-colors hover:bg-hover"
                  onClick={() => {
                    setOpen(false)
                    void window.ChrysalisBuilder?.rebuild(app.id).catch(() => undefined)
                  }}
                >
                  <Icon name="rebuild" size="small" />
                  {tr("Rebuild")}
                </button>
              </div> : null}
            <div className="truncate px-2 py-1.5 text-11 text-ink-muted">{tr("signed in as {username}", { username: props.username })}</div>
            <button
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-13 transition-colors hover:bg-hover"
              onClick={() => {
                setOpen(false)
                props.onSettings()
              }}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                <IconSmall name="settings-gear" />
              </span>
              {tr("Settings")}
            </button>
            <button
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-13 transition-colors hover:bg-hover"
              onClick={() => {
                setOpen(false)
                props.onTheme()
              }}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">{props.theme === "dark" ? <SunIcon /> : <MoonIcon />}</span>
              {props.theme === "dark" ? tr("Light mode") : tr("Dark mode")}
            </button>
            <button
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-13 transition-colors hover:bg-hover"
              onClick={() => {
                setOpen(false)
                props.onLogout()
              }}
            >
              <Icon name="logout" />
              {tr("Log out")}
            </button>
          </div>
        </>,
        document.body,
      ) : null}
    </div>
  )
}

function AppCanvas(props: { username: string; tab: Tab; trusted?: boolean; onAskAgent: (prompt: string) => void; split?: boolean; onSplit: () => void; onPlugins: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [build, setBuild] = useState<AppBuildStatus>({ phase: "checking" })
  const [loaded, setLoaded] = useState(false)
  const [hideErrors, setHideErrors] = useState(false)
  // the dev runtime's own failures (missing import, throw on load) surface
  // in-frame; the pane mirrors them so the agent button lives OUT here where
  // only a user click can reach it (an app frame must not prompt the agent)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    setLoaded(false)
    const unserve = window.ChrysalisBridgeHost.serve(frame, props.tab.id, props.username, props.trusted === true)
    let alive = true
    let w: { ready: Promise<void>; dispose: () => void } | undefined
    let readyTimer: number | undefined
    // user-scoped, cookieless frame URL; the app's localStorage rides the hash.
    // The pane keeps its overlay up until the app says it painted (or the
    // frame loaded and stayed quiet: production bundles have no dev runtime).
    const load = () => {
      setLoaded(false)
      setRuntimeError(null)
      frame.src = window.ChrysalisBridgeHost.frameSrc(props.tab.id, props.username)
    }
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return
      const d = e.data as { __chrysalisRuntime?: unknown; t?: unknown; text?: unknown; events?: unknown }
      if (!d || d.__chrysalisRuntime !== 1) return
      if (d.t === "ready") {
        if (readyTimer !== undefined) window.clearTimeout(readyTimer)
        setLoaded(true)
      } else if (d.t === "error") {
        setRuntimeError(typeof d.text === "string" && d.text.trim() ? d.text : null)
      } else if (d.t === "app-errors") {
        // the app frame caught runtime errors; the engine stores them per
        // source rev so the agent's app_check can see what broke after a
        // clean build (fire-and-forget: this must never disturb the app)
        const events = Array.isArray(d.events) ? d.events.slice(0, 100) : []
        if (events.length) void api("POST", `/v1/apps/${encodeURIComponent(props.tab.id)}/client-errors`, { events }).catch(() => undefined)
      } else if (d.t === "app-logs") {
        // console prints ride the same path; the agent reads them via app_console
        const events = Array.isArray(d.events) ? d.events.slice(0, 100) : []
        if (events.length) void api("POST", `/v1/apps/${encodeURIComponent(props.tab.id)}/client-logs`, { events }).catch(() => undefined)
      }
    }
    const onFrameLoad = () => {
      if (readyTimer !== undefined) window.clearTimeout(readyTimer)
      readyTimer = window.setTimeout(() => { if (alive) setLoaded(true) }, 250)
    }
    window.addEventListener("message", onMessage)
    frame.addEventListener("load", onFrameLoad)
    if (window.ChrysalisBuilder) {
      // the app is built in this browser (a sandboxed builder frame) before
      // it first shows, and kept up to date while it is on screen
      w = window.ChrysalisBuilder.watch(
        props.tab.id,
        (s) => {
          setBuild(s)
          if (s.phase !== "error") setHideErrors(false)
        },
        () => alive && load(),
      )
      void w.ready.finally(() => alive && load())
    } else {
      load()
    }
    return () => {
      alive = false
      w?.dispose()
      window.removeEventListener("message", onMessage)
      frame.removeEventListener("load", onFrameLoad)
      if (readyTimer !== undefined) window.clearTimeout(readyTimer)
      unserve()
    }
  }, [props.tab.id, props.username, props.trusted])
  return (
    // phones: the app fills the pane edge to edge under the one shell bar;
    // this toolbar's actions ride in the account menu there (see UserMenu)
    <div className="m-2 ml-0 flex min-h-0 min-w-0 flex-1 flex-col self-stretch overflow-hidden rounded-[10px] bg-base shadow-[var(--s-raised)] max-md:m-0 max-md:rounded-none max-md:border-t max-md:border-line max-md:shadow-none">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2 max-md:hidden">
        <span className="truncate px-1 text-13 text-ink-muted">{props.tab.name}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            className={"flex items-center gap-1 rounded-md px-2 py-1 text-12 transition-colors hover:bg-hover hover:text-ink " + (props.split ? "text-ink" : "text-ink-muted")}
            title={props.split ? tr("Unsplit, back to full width") : tr("Split right: agent left, this app live on the right")}
            onClick={props.onSplit}
          >
            <IconSmall name="split" size="small" />
            <span>{props.split ? tr("Unsplit") : tr("Split")}</span>
          </button>
          <button
            className="flex items-center gap-1 rounded-md px-2 py-1 text-12 text-ink-muted transition-colors hover:bg-hover hover:text-ink"
            title={tr("Open in a full browser tab (installable as an app)")}
            onClick={() => window.open(`/standalone?app=${encodeURIComponent(props.tab.id)}`, "_blank", "noopener")}
          >
            <IconSmall name="outline-square-arrow" size="small" />
            <span>{tr("Fullscreen")}</span>
          </button>
          <button
            className="flex items-center gap-1 rounded-md px-2 py-1 text-12 text-ink-muted transition-colors hover:bg-hover hover:text-ink"
            title={tr("Plugins for this app: import from git, permissions, removal")}
            onClick={props.onPlugins}
          >
            <Icon name="providers" size="small" />
            <span>{tr("Plugins")}</span>
          </button>
          <button
            className="flex items-center gap-1 rounded-md px-2 py-1 text-12 text-ink-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
            title={tr("Rebuild this app now")}
            disabled={build.phase === "building" || build.phase === "checking"}
            onClick={() => void window.ChrysalisBuilder?.rebuild(props.tab.id).catch(() => undefined)}
          >
            <Icon name="rebuild" size="small" />
            <span>{build.phase === "building" || build.phase === "checking" ? tr("Building…") : tr("Rebuild")}</span>
          </button>
        </div>
      </div>
      {runtimeError ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger-soft/10 px-3 py-1.5 text-12">
          <span className="min-w-0 flex-1 truncate text-ink" title={runtimeError}>{runtimeError.split("\n")[0]}</span>
          <button
            className="shrink-0 rounded-md px-2 py-0.5 text-12 text-ink-muted transition-colors hover:bg-hover hover:text-ink"
            onClick={() => props.onAskAgent(agentErrorPrompt(props.tab.name, props.tab.id, runtimeError))}
          >
            {tr("Ask the agent")}
          </button>
        </div>
      ) : null}
      {/* the app is its OWN page served by the engine — the client is a dumb
          renderer and never bakes app looks into itself (SPEC-v2) */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <iframe
          ref={frameRef}
          title={props.tab.name}
          sandbox="allow-scripts allow-popups allow-downloads allow-forms"
          className="min-h-0 w-full flex-1 border-0 bg-transparent"
        />
        {!loaded ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-base text-13 text-ink-muted">
            <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink-muted" aria-hidden="true" />
            {build.phase === "building" ? tr("Building the app…") : build.phase === "waiting" ? (build.message ?? tr("Waiting for the build…")) : tr("Opening…")}
          </div>
        ) : null}
        {build.phase === "error" && !hideErrors ? <BuildErrors status={build} onClose={() => setHideErrors(true)} onAskAgent={(text) => props.onAskAgent(agentErrorPrompt(props.tab.name, props.tab.id, text))} /> : null}
      </div>
    </div>
  )
}

/** The agent prompt for an app failure card. The error text is DATA reported
 *  by an app frame, so it is framed as the thing to fix, never as orders. */
function agentErrorPrompt(name: string, id: string, text: string): string {
  const body = text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text
  return `The "${name}" app (apps/${id}/) has a failure that needs fixing. Investigate and fix it.\n\nFailure:\n${body}`
}

/** Why the last build of the app failed, over the app pane (the app keeps
 *  running its previous build underneath). */
function BuildErrors(props: { status: AppBuildStatus; onClose: () => void; onAskAgent: (text: string) => void }) {
  const lines = props.status.errors?.length
    ? props.status.errors.slice(0, 6).map((e) => `${e.file ?? ""}${e.line ? `:${e.line}:${e.column ?? 0}` : ""}\n  ${e.text}`)
    : [props.status.message ?? tr("The build failed")]
  return (
    <div className="absolute inset-x-2 top-2 max-h-[45%] overflow-auto rounded-md border border-line bg-base p-3 font-mono text-12 text-ink shadow-[var(--s-raised)]">
      <div className="mb-1 flex items-center gap-2 font-sans text-12 text-ink-muted">
        <span>{tr("Build failed. The app shows its last good build")}</span>
        <button className="ml-auto rounded px-1.5 py-0.5 hover:bg-hover hover:text-ink" onClick={() => props.onAskAgent(lines.join("\n\n"))}>
          {tr("Ask the agent")}
        </button>
        <button className="rounded px-1.5 py-0.5 hover:bg-hover hover:text-ink" onClick={props.onClose}>
          {tr("Dismiss")}
        </button>
      </div>
      <pre className="whitespace-pre-wrap">{lines.join("\n\n")}</pre>
    </div>
  )
}

/** Login-screen user row: name + lock when passworded. Avatars only show
 *  once you're signed in — the pre-auth screen stays faceless. */
function UserButton(props: { u: AuthUser; disabled: boolean; onPick: () => void }) {
  return (
    <button
      className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-left transition-colors hover:bg-hover disabled:opacity-50"
      disabled={props.disabled || !props.u.enabled}
      title={props.u.enabled ? "" : "disabled"}
      onClick={props.onPick}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-pressed text-13 font-medium uppercase text-ink">
        {props.u.username.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-14 text-ink">{props.u.username}</span>
        <span className="block text-11 text-ink-muted">
          {props.u.role === "admin" ? tr("admin") + " · " : ""}
          {props.u.enabled ? tr("password required") : "disabled"}
        </span>
      </span>
      {props.u.hasPassword ? <Icon name="lock" className="size-4 shrink-0 text-icon-muted" /> : null}
    </button>
  )
}

/** The setup token from a first-run link (…/#setup=TOKEN), if this page was
 *  opened with one. */
function setupTokenFromUrl(): string {
  const m = /(?:^#|&)setup=([A-Za-z0-9_-]+)/.exec(window.location.hash)
  return m?.[1] ?? ""
}

/** First run: nobody has an account yet. The person who started Chrysalis
 *  got a link carrying a one-time token; it creates the admin account. */
function SetupForm(props: { onDone: () => Promise<void> }) {
  const fromUrl = setupTokenFromUrl()
  const [token, setToken] = useState(fromUrl)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const inputClass =
    "w-full rounded-lg border border-line bg-panel px-3 py-2 text-13 text-ink outline-none placeholder:text-ink-muted focus:border-line-focus"
  const mismatch = confirm.length > 0 && confirm !== password
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setErr("")
        try {
          // a pasted link works as well as the bare code
          const code = /setup=([A-Za-z0-9_-]+)/.exec(token)?.[1] ?? token.trim()
          await authApi.setup(code, username.trim(), password)
          history.replaceState(null, "", window.location.pathname + window.location.search)
          await props.onDone()
        } catch (e: any) {
          setErr(e.message ?? String(e))
        } finally {
          setBusy(false)
        }
      }}
    >
      <p className="text-13 leading-5 text-ink-muted">{tr("Create the first account. It can add more people later in Settings.")}</p>
      {!fromUrl ? <>
          <input className={inputClass} placeholder={tr("setup link or code")} autoComplete="off" value={token} onChange={(e) => setToken(e.currentTarget.value)} />
          <p className="-mt-1.5 text-12 leading-4 text-ink-muted">{tr("Chrysalis shows this link where it started, and in its log file.")}</p>
        </> : null}
      <input className={inputClass} placeholder={tr("username")} autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
      <input className={inputClass} type="password" placeholder={tr("password")} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
      <input className={inputClass} type="password" placeholder={tr("confirm password")} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} />
      {mismatch ? <div className="text-12 text-danger">{tr("Passwords do not match")}</div> : null}
      <button
        type="submit"
        data-component="button-v2"
        data-size="normal"
        data-variant="neutral"
        className="rounded-lg px-3 py-1.5 text-13 text-ink-inverse disabled:opacity-50"
        disabled={busy || !token.trim() || !username.trim() || password.length < 4 || confirm !== password}
      >
        {tr("Create account")}
      </button>
      {err ? <div className="text-12 text-danger">{err}</div> : null}
    </form>
  )
}

/** Sign-in: pick your account, enter its password; forgot password → a
 *  one-time code printed where the engine runs (and in its log file). */
function AuthScreen(props: { onLogin: (username: string, password?: string) => Promise<void>; onSetupDone: () => Promise<void> }) {
  const [users, setUsers] = useState<AuthUser[]>([])
  const [setup, setSetup] = useState(false)
  const [selected, setSelected] = useState<AuthUser | null>(null)
  const [mode, setMode] = useState<"pick" | "password" | "forgot">("pick")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [codeSent, setCodeSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  useEffect(() => {
    void (async () => {
      try {
        const r = await authApi.users()
        setUsers(r.users)
        setSetup(r.setup)
      } catch (e: any) {
        setErr(e.message ?? String(e))
      }
    })()
  }, [])

  const signIn = async (u: AuthUser, pw?: string) => {
    setBusy(true)
    setErr("")
    try {
      await props.onLogin(u.username, pw)
    } catch (e: any) {
      setErr(e.message ?? String(e))
      setPassword("")
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    "w-full rounded-lg border border-line bg-panel px-3 py-2 text-13 text-ink outline-none placeholder:text-ink-muted focus:border-line-focus"

  return (
    <div className="flex h-full items-center justify-center bg-deep p-4">
      <div className="flex w-full max-w-[380px] flex-col gap-4 rounded-[10px] bg-base p-6 shadow-[var(--s-raised)]">
        <div className="flex items-center gap-3">
          <Logo size={36} />
          <div>
            <div className="text-16 font-medium text-ink">Chrysalis</div>
            <div className="text-12 text-ink-muted">{setup ? tr("Welcome") : tr("Pick your user to continue")}</div>
          </div>
        </div>

        {setup ? <SetupForm onDone={props.onSetupDone} /> : null}

        {!setup && mode === "pick" ? users.length > 0 ? <div className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto">
              {users.map((u) => (
                  <UserButton key={u.username} u={u} disabled={busy} onPick={() => {
                    setSelected(u)
                    setMode("password")
                  }} />
                ))}
            </div> : <div className="py-6 text-center text-13 text-ink-muted">{err || tr("Loading users…")}</div>: null}

        {mode === "password" && selected ? <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (selected) void signIn(selected!, password)
            }}
          >
            <div className="flex items-center gap-2">
              <IconButton icon={<Icon name="arrow-left" />} variant="ghost-muted" size="small" title={tr("Back")} onClick={() => { setMode("pick"); setPassword(""); setErr("") }} />
              <span className="text-13 text-ink-muted">
                {tr("Password for {username}", { username: selected!.username })}
              </span>
            </div>
            <input ref={(el) => { if (el) setTimeout(() => el.focus(), 0) }} type="password" placeholder={tr("password")} autoComplete="current-password" className={inputClass} value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
            <button
              type="submit"
              data-component="button-v2"
              data-size="normal"
              data-variant="neutral"
              className="rounded-lg px-3 py-1.5 text-13 text-ink-inverse disabled:opacity-50"
              disabled={busy || !password}
            >
              {tr("Enter")}
            </button>
            <button type="button" className="self-start text-12 text-accent underline" onClick={() => { setMode("forgot"); setCodeSent(false); setErr("") }}>
              {tr("Forgot password?")}
            </button>
          </form> : null}

        {mode === "forgot" && selected ? <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault()
              if (!selected) return
              setBusy(true)
              setErr("")
              try {
                if (!codeSent) {
                  await authApi.forgot(selected!.username)
                  setCodeSent(true)
                } else {
                  await authApi.reset(selected!.username, code.trim(), newPassword)
                  await props.onLogin(selected!.username, newPassword)
                }
              } catch (e: any) {
                setErr(e.message ?? String(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            <div className="flex items-center gap-2">
              <IconButton icon={<Icon name="arrow-left" />} variant="ghost-muted" size="small" title={tr("Back")} onClick={() => { setMode("password"); setErr("") }} />
              <span className="text-13 text-ink-muted">{tr("Reset {username}'s password", { username: selected!.username })}</span>
            </div>
            {codeSent ? <><p className="text-12 leading-4 text-ink-muted">
                {tr("The code is in the Chrysalis window or its log file. It works for 10 minutes.")}
              </p>
              <input className={inputClass} placeholder={tr("reset code")} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
              <input className={inputClass} type="password" placeholder={tr("new password")} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.currentTarget.value)} />
              <button
                type="submit"
                data-component="button-v2"
                data-size="normal"
                data-variant="neutral"
                className="rounded-lg px-3 py-1.5 text-13 text-ink-inverse disabled:opacity-50"
                disabled={busy || !code.trim() || newPassword.length < 4}
              >
                {tr("Reset and sign in")}
              </button></> : <>
                  <p className="text-12 leading-4 text-ink-muted">
                    {tr("A one-time code will appear in the Chrysalis window and its log file.")}
                  </p>
                  <button
                    type="submit"
                    data-component="button-v2"
                    data-size="normal"
                    data-variant="neutral"
                    className="rounded-lg px-3 py-1.5 text-13 text-ink-inverse disabled:opacity-50"
                    disabled={busy}
                  >
                    {tr("Get a code")}
                  </button>
                </>}
          </form> : null}

        {err && mode !== "pick" ? <div className="text-12 text-danger">{err}</div> : null}
      </div>
    </div>
  )
}

type TreeDir = { name: string; path: string; type: "dir"; children: TreeNode[] }
type TreeFile = { name: string; path: string; type: "file"; size?: number }
type TreeNode = TreeDir | TreeFile

function LaunchPicker(props: {
  launch: LaunchInfo | null
  onAgent: () => void
  onAskAgent: (prompt: string) => void
  onApp: (id: string) => void
  onRefresh: () => Promise<unknown>
  onCloseTab: (id: string) => void
}) {
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const slugOf = (name: string) =>
    name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "app"

  const selApp = (props.launch?.apps ?? []).find((a) => a.id === selected) ?? null

  const sectionLabel = "px-1 pb-1 pt-3 text-11 font-medium uppercase tracking-wider text-ink-faint first:pt-0"

  return (
    <div className="row-start-1 m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-base shadow-[var(--s-raised)] max-md:m-1">
      <div className="mx-auto flex w-full max-w-[960px] min-h-0 flex-1 flex-col px-6 py-8 max-md:px-4">
        <div className="flex items-center gap-3 pb-4">
          <Logo size={32} />
          <h1 className="text-20 font-medium text-ink">{tr("Where to?")}</h1>
        </div>
        {/* @container: the launcher splits into list + detail only when the
            PANE has room. In a split screen the pane is under half the window
            while the viewport is wide, so viewport breakpoints lie; the
            side-by-side layout is meant for a widescreen pane and switches to
            the stacked one below ~960px of pane width. */}
        <div className="@container flex min-h-0 flex-1 gap-4">
          {/* App list — scrollable (many apps), and in a narrow pane it yields
              the whole pane to the detail view. Sectioned: system, your apps,
              then ways to add more. */}
          <div
            className={cn("flex w-[320px] shrink-0 flex-col gap-1.5 overflow-y-auto overscroll-contain pr-1 @max-4xl:w-full @max-4xl:pr-0", { "@max-4xl:hidden": !!selected })}
          >
            <p className={sectionLabel}>{tr("System")}</p>
            <button
              className="flex items-center gap-3 rounded-lg border border-line px-4 py-3 text-left transition-colors hover:bg-hover"
              onClick={props.onAgent}
            >
              <IconSmall name="outline-square-arrow" size="normal" className="text-icon" />
              <span className="flex-1">
                <span className="block text-14 font-medium text-ink">{tr("Agent")}</span>
                <span className="block text-12 text-ink-muted">{tr("builds, edits and manages your apps")}</span>
              </span>
            </button>

            <p className={sectionLabel}>{tr("Your apps")}</p>
            {(props.launch?.apps ?? []).map((a) => (
                <div key={a.id}
                  className={cn("group/app relative flex items-center gap-3 rounded-lg border pl-4 pr-2 text-left transition-colors hover:bg-hover", {
                    "border-line-focus bg-hover": selected === a.id,
                    "border-line": selected !== a.id,
                  })}
                >
                  <IconSmall name="grid-plus" size="normal" className="text-icon" />
                  <button
                    className="flex min-w-0 flex-1 cursor-pointer py-3 text-left"
                    // phones open the app straight away (the detail pane
                    // would cover the list anyway); its info button shows it
                    onClick={() => (window.matchMedia("(max-width: 767px)").matches ? props.onApp(a.id) : setSelected(a.id))}
                    title={tr("About {name}", { name: a.name || a.id })}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-14 font-medium text-ink">{a.name || a.id}</span>
                        {a.official ? <span
                            className="shrink-0 rounded-full border border-line px-1.5 py-px text-9 font-medium tracking-wide text-ink-muted"
                            title={tr("Built and maintained by the Chrysalis maintainers")}
                          >
                            {tr("Official App")}
                          </span> : null}
                        {a.update ? <span
                            className="shrink-0 rounded-full bg-warning-soft/30 px-1.5 py-px text-9 font-medium tracking-wide text-ink"
                            title={`v${a.update} is available`}
                          >
                            {tr("Update")}
                          </span> : null}
                      </span>
                      <span className="block truncate text-12 text-ink-muted">
                        {a.author ? tr("by {author}", { author: a.author }) : a.repository ? tr("from git") : tr("app")}
                      </span>
                    </span>
                  </button>
                  <button
                    className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-faint hover:bg-pressed hover:text-ink @4xl:hidden"
                    title={tr("About {name}", { name: a.name || a.id })}
                    aria-label={tr("About {name}", { name: a.name || a.id })}
                    onClick={() => setSelected(a.id)}
                  >
                    <IconSmall name="info" />
                  </button>
                  <button
                    className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-faint opacity-0 transition-all hover:bg-pressed hover:text-danger group-hover/app:opacity-100 @max-4xl:opacity-100"
                    title={tr("Delete {name}", { name: a.name || a.id })}
                    aria-label={tr("Delete {name}", { name: a.name || a.id })}
                    onClick={() => setDeleting({ id: a.id, name: a.name || a.id })}
                  >
                    <IconSmall name="outline-xmark" />
                  </button>
                </div>
              ))}

            <p className={sectionLabel}>{tr("Add")}</p>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                className="flex flex-col gap-1.5 rounded-lg border border-dashed border-line px-3 py-3 text-left transition-colors hover:bg-hover"
                onClick={() => setCreating(true)}
              >
                <IconSmall name="workspace-new" size="normal" className="text-icon" />
                <span className="text-13 font-medium text-ink">{tr("New app")}</span>
                <span className="text-11 leading-4 text-ink-muted">{tr("a starter the agent builds out with you")}</span>
              </button>
              <button
                className="flex flex-col gap-1.5 rounded-lg border border-dashed border-line px-3 py-3 text-left transition-colors hover:bg-hover"
                onClick={() => setImporting(true)}
              >
                <IconSmall name="folder-add-left" size="normal" className="text-icon" />
                <span className="text-13 font-medium text-ink">{tr("Import app")}</span>
                <span className="text-11 leading-4 text-ink-muted">{tr("from a git repository")}</span>
              </button>
            </div>
          </div>

          {/* Detail: folder hierarchy + launch. Slides in when an app is
              picked; on phones it covers the list entirely. */}
          {selApp ? (
              <div className="flex min-h-0 flex-1 animate-in flex-col overflow-hidden rounded-lg border border-line fade-in slide-in-from-right-6 duration-200 @max-4xl:flex-1">
                <AppDetail
                  appId={selApp.id}
                  repository={selApp.repository ?? null}
                  official={selApp.official === true}
                  onBack={() => setSelected(null)}
                  onLaunch={() => props.onApp(selApp.id)}
                  onUpdated={() => void props.onRefresh()}
                  onAskAgent={props.onAskAgent}
                />
              </div>
            ) : null}
          {!selApp ? <div className="hidden min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-line text-13 text-ink-faint @4xl:flex">
              {tr("Pick an app to see what's inside.")}
            </div> : null}
        </div>
      </div>
      {props.launch?.engine ? (
          <div className="flex items-center gap-2 px-1 pb-1 pt-0.5 text-11 text-ink-faint">
            <span>{tr("Chrysalis engine v{version}", { version: props.launch.engine.version })}</span>
            {props.launch.engine.repository ? <a
                href={props.launch.engine.repository}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-1 text-ink-muted transition-colors hover:text-ink"
                title={props.launch.engine.repository}
              >
                <svg viewBox="0 0 16 16" className="size-3.5 fill-current" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
                GitHub
              </a> : null}
          </div>
        ) : null}
      {creating ? <NewAppDialog
          slugOf={slugOf}
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false)
            await props.onRefresh()
            props.onApp(id)
          }}
        /> : null}
      {importing ? <ImportAppDialog
          onClose={() => setImporting(false)}
          onImported={async (id) => {
            setImporting(false)
            await props.onRefresh()
            setSelected(id)
          }}
        /> : null}
      {deleting ? <DeleteAppDialog
          app={deleting!}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            const gone = deleting!.id
            setDeleting(null)
            if (selected === gone) setSelected(null)
            props.onCloseTab(gone)
            props.onRefresh()
          }}
        /> : null}
    </div>
  )
}

/** Right-hand pane of the launcher: what the app is made of (read-only folder
 *  hierarchy from the engine) plus the Launch action. Git-imported apps also
 *  get an update check against their repository and a link out to it. */
type Conflict = { path: string; reason: string }
type UpdateStrategy = "merge" | "mine" | "theirs" | "agent"
type UpdateReply = {
  status?: "applied" | "conflicts" | "current"
  from?: string
  to?: string
  strategy?: UpdateStrategy
  merged?: string[]
  conflicts?: Conflict[]
  agentPrompt?: string
  needsDepConfirm?: boolean
  head?: string
  deps?: { added: { name: string; spec: string }[]; changed: { name: string; spec: string; was: string }[]; removed: string[]; nonRegistry: string[] }
}

function AppDetail(props: {
  appId: string
  repository: string | null
  official: boolean
  onBack: () => void
  onLaunch: () => void
  onUpdated: () => void
  onAskAgent: (prompt: string) => void
}) {
  const detail = useResource(
    () =>
      api<{ tree: TreeDir; manifest?: { description?: string; version?: string } }>(
        "GET",
        `/v1/apps/${encodeURIComponent(props.appId)}/tree`,
      ),
    [props.appId],
  )
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [updates, setUpdates] = useState<
    | { state: "idle" }
    | { state: "checking" }
    | { state: "current" }
    | { state: "available"; version: string | null; remoteHead: string | null; modified: boolean | null; engine: string | null; engineVersion: string | null }
    | { state: "updating" }
    | { state: "conflicts"; from: string; to: string; conflicts: Conflict[] }
    | { state: "applied"; to: string; strategy: UpdateStrategy; merged: number; conflicts: number }
    | {
        state: "dep-review"
        strategy: UpdateStrategy
        head: string | null
        added: { name: string; spec: string }[]
        changed: { name: string; spec: string; was: string }[]
        removed: string[]
        nonRegistry: string[]
      }
    | { state: "error"; message: string }
  >({ state: "idle" })
  const canUpdate = props.official || !!props.repository

  const checkUpdates = async () => {
    setUpdates({ state: "checking" })
    try {
      const r = await api<{
        supported?: boolean
        upToDate?: boolean
        available?: string | null
        remoteHead?: string | null
        modified?: boolean | null
        engineOk?: boolean
        engine?: string | null
        engineVersion?: string
        error?: string
      }>("GET", `/v1/apps/${encodeURIComponent(props.appId)}/updates`)
      if (!r.supported) setUpdates({ state: "error", message: tr("This app has no update source.") })
      else if (r.error) setUpdates({ state: "error", message: r.error })
      else if (r.upToDate) setUpdates({ state: "current" })
      else
        setUpdates({
          state: "available",
          version: r.available ?? null,
          remoteHead: r.remoteHead ?? null,
          modified: r.modified ?? null,
          engine: r.engineOk === false ? r.engine ?? null : null,
          engineVersion: r.engineVersion ?? null,
        })
    } catch (e: any) {
      setUpdates({ state: "error", message: e.message ?? String(e) })
    }
  }

  const runUpdate = async (strategy: UpdateStrategy = "merge", confirmDeps = false) => {
    setUpdates({ state: "updating" })
    try {
      const r = await api<UpdateReply>("POST", `/v1/apps/${encodeURIComponent(props.appId)}/update`, {
        strategy,
        ...(confirmDeps ? { confirmDeps: true } : {}),
      })
      if (r.needsDepConfirm) {
        setUpdates({
          state: "dep-review",
          strategy,
          head: r.head ?? null,
          added: r.deps?.added ?? [],
          changed: r.deps?.changed ?? [],
          removed: r.deps?.removed ?? [],
          nonRegistry: r.deps?.nonRegistry ?? [],
        })
        return
      }
      if (r.status === "conflicts") {
        setUpdates({ state: "conflicts", from: r.from ?? "", to: r.to ?? "", conflicts: r.conflicts ?? [] })
        return
      }
      await detail.refetch()
      props.onUpdated()
      if (r.status === "current") {
        setUpdates({ state: "current" })
        return
      }
      setUpdates({ state: "applied", to: r.to ?? "", strategy, merged: r.merged?.length ?? 0, conflicts: r.conflicts?.length ?? 0 })
      if (r.agentPrompt) props.onAskAgent(r.agentPrompt)
    } catch (e: any) {
      setUpdates({ state: "error", message: e.message ?? String(e) })
    }
  }

  // the check is automatic and harmless (nothing local moves without an
  // explicit button); the UPDATE itself never is
  const [checkedFor, setCheckedFor] = useState<string | null>(null)
  useEffect(() => {
    if (!detail.data || !canUpdate) return
    if (checkedFor === props.appId) return
    setCheckedFor(props.appId)
    void checkUpdates()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- checkUpdates reads current state
  }, [detail.data, canUpdate, props.appId, checkedFor])

  // tree starts fully collapsed — only the top-level entries show; expand on demand
  const stats = () => {
    let files = 0
    let bytes = 0
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.type === "file") { files++; bytes += n.size ?? 0 } else walk(n.children ?? [])
      }
    }
    walk(detail.data?.tree?.children ?? [])
    return { files, kb: Math.max(1, Math.round(bytes / 1024)) }
  }

  const toggle = (p: string) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <button
          className="hidden size-7 cursor-pointer items-center justify-center rounded-md text-ink-muted hover:bg-hover @max-4xl:flex"
          onClick={props.onBack}
          aria-label={tr("Back to apps")}
        >
          <IconSmall name="outline-chevron-down" className="rotate-90" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-14 font-medium text-ink">{props.appId}</p>
          <p className="text-11 text-ink-faint">
            {detail.loading ? tr("reading files…") : `${stats().files} files · ~${stats().kb} KB`}
            {detail.data?.manifest?.version ? ` · v${detail.data.manifest.version}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {props.repository ? <a
              href={props.repository!}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-md px-2 py-1 text-12 text-ink-muted hover:bg-hover hover:text-ink"
              title={props.repository}
            >
              {tr("Repository ↗")}
            </a> : null}
          {canUpdate ? <Button
              variant="ghost-muted"
              size="small"
              disabled={updates.state === "checking" || updates.state === "updating"}
              onClick={() => void checkUpdates()}
            >
              {updates.state === "checking"
                ? tr("Checking…")
                : updates.state === "available"
                  ? tr("Update available")
                  : updates.state === "updating"
                    ? tr("Updating…")
                    : tr("Check for updates")}
            </Button> : null}
          <Button variant="neutral" size="small" onClick={props.onLaunch}>
            <span className="flex items-center gap-1.5">
              <IconSmall name="outline-square-arrow" size="small" />
              {tr("Launch")}
            </span>
          </Button>
        </div>
      </div>
      {updates.state === "available" ? <div className="flex flex-col gap-1.5 border-b border-line bg-warning-soft/10 px-4 py-2 text-12">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-ink">
              {updates.version
                ? tr("v{version} is available.", { version: updates.version })
                : updates.remoteHead
                  ? tr("The repository has new commits ({head}).", { head: updates.remoteHead.slice(0, 10) })
                  : tr("The repository has new commits.")}
              {updates.modified ? " " + tr("Your own edits are merged in.") : ""}{" "}
              {tr("Your data is kept.")}
            </span>
            {!updates.engine ? <Button variant="neutral" size="small" onClick={() => void runUpdate()}>
                {tr("Update")}
              </Button> : null}
          </div>
          {updates.engine ? <p className="text-11 text-ink-muted">
              {tr("Needs Chrysalis engine {engine}. This engine is {current}.", { engine: updates.engine, current: "v" + updates.engineVersion })}
            </p> : null}
        </div> : null}
      {updates.state === "conflicts" ? <div className="flex flex-col gap-2 border-b border-line bg-warning-soft/10 px-4 py-2.5 text-12">
          <p className="text-12 text-ink">
            {tr("Your edits overlap with v{version} in {files}. Nothing has changed yet.", { version: updates.to, files: updates.conflicts.length === 1 ? tr("1 file") : tr("{n} files", { n: updates.conflicts.length }) })}
          </p>
          <ul className="flex flex-col gap-0.5 font-mono text-11 text-ink-muted">
            {updates.conflicts.map((x) => (
              <li key={x.path} className="truncate" title={x.path}>
                {x.path} <span className="text-ink-faint">({x.reason})</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost-muted" size="small" onClick={() => void runUpdate("mine")} title={tr("The update lands everywhere else; where it overlaps, your version stays")}>
              {tr("Keep mine")}
            </Button>
            <Button variant="ghost-muted" size="small" onClick={() => void runUpdate("theirs")} title={tr("These files get the new version; yours stays in git history")}>
              {tr("Take update")}
            </Button>
            <Button variant="neutral" size="small" onClick={() => void runUpdate("agent")} title={tr("Write both sides into the files and have the agent merge them")}>
              {tr("Ask the agent to merge")}
            </Button>
          </div>
        </div> : null}
      {updates.state === "applied" ? <div className="border-b border-line px-4 py-1.5 text-11 text-ink-faint">
          {tr("Updated to v{version}.", { version: updates.to })}
          {updates.merged ? " " + (updates.merged === 1 ? tr("Your edits were kept in 1 file.") : tr("Your edits were kept in {n} files.", { n: updates.merged })) : ""}
          {updates.conflicts && updates.strategy === "mine" ? " " + tr("Where they overlapped, your version stayed.") : ""}
          {updates.conflicts && updates.strategy === "theirs" ? " " + tr("Your overlapping edits are in git history.") : ""}
          {updates.conflicts && updates.strategy === "agent" ? " " + tr("The agent is merging the overlaps.") : ""}
        </div> : null}
      {updates.state === "current" ? <div className="border-b border-line px-4 py-1.5 text-11 text-ink-faint">
          {tr("Up to date.")}
        </div> : null}
      {updates.state === "dep-review" ? <div className="flex flex-col gap-2 border-b border-line bg-warning-soft/10 px-4 py-2.5 text-12">
          <p className="text-12 text-ink">
            {tr("This update installs new packages. Nothing has changed yet.")}
          </p>
          <div className="flex flex-col gap-1 font-mono text-11">
            {(updates.state === "dep-review" ? updates.added : []).map((d) => (<span key={d.name}><span className="text-success">+ {d.name}</span> <span className="text-ink-faint">{d.spec}</span></span>))}
            {(updates.state === "dep-review" ? updates.changed : []).map((d) => (<span key={d.name}><span className="text-warning">~ {d.name}</span> <span className="text-ink-faint">{d.was} → {d.spec}</span></span>))}
            {(updates.state === "dep-review" ? updates.removed : []).map((name) => (<span key={name} className="text-ink-faint">- {name}</span>))}
            {(updates.state === "dep-review" ? updates.nonRegistry : []).map((entry) => (<span key={entry} className="text-danger">! {entry}</span>))}
          </div>
          {updates.state === "dep-review" && updates.nonRegistry.length > 0 ? <p className="text-11 text-ink-muted">
              {tr("Some packages come from outside the public npm registry. Review them before installing.")}
            </p> : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost-muted"
              size="small"
             
              onClick={() => { setUpdates({ state: "idle" }); void checkUpdates() }}
            >
              {tr("Cancel")}
            </Button>
            <Button
              variant="danger"
              size="small"
             
              onClick={() => void runUpdate(updates.state === "dep-review" ? updates.strategy : "merge", true)}
            >
              {tr("Install and update")}
            </Button>
          </div>
        </div> : null}
      {updates.state === "error" ? <div className="border-b border-line px-4 py-1.5 text-11 text-danger">
          {updates.message}
        </div> : null}
      {!detail.loading ? <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 font-mono text-12">
          <TreeRows nodes={detail.data?.tree?.children ?? []} depth={0} open={open} toggle={toggle} />
        </div> : <div className="p-4 text-13 text-ink-faint">{tr("Reading app files…")}</div>}
    </div>
  )
}

function TreeRows(props: { nodes: TreeNode[]; depth: number; open: Set<string>; toggle: (p: string) => void }) {
  return (
    <>
      {props.nodes.map((n) => (
        <Fragment key={n.path}>
          <button
            className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-hover"
            style={{ paddingLeft: `${props.depth * 14 + 6}px` }}
            onClick={() => (n.type === "dir" ? props.toggle(n.path) : undefined)}
          >
            {n.type === "dir" ? <IconSmall
                name="chevron-down"
                className={cn("size-3 shrink-0 text-ink-faint transition-transform", { "-rotate-90": !props.open.has(n.path) })}
              /> : null}
            <span
              className={cn({
                "truncate text-ink": n.type === "dir",
                "truncate text-ink-muted": n.type === "file",
              })}
            >
              {n.name}
            </span>
            {n.type === "file" && (n.size ?? 0) > 0 ? <span className="ml-auto shrink-0 text-10 text-ink-faint">{Math.max(1, Math.round((n as TreeFile).size! / 1024))} {tr("KB")}</span> : null}
          </button>
          {n.type === "dir" && props.open.has(n.path) ? <TreeRows nodes={(n as TreeDir).children ?? []} depth={props.depth + 1} open={props.open} toggle={props.toggle} /> : null}
        </Fragment>
      ))}
    </>
  )
}

/** New app: name + author → engine skeleton (the standard UI starter). After creation,
 *  the hand-off is the agent tab — it builds the actual app with you. */
function NewAppDialog(props: { slugOf: (name: string) => string; onClose: () => void; onCreated: (id: string) => void | Promise<void> }) {
  const [name, setName] = useState("")
  const [author, setAuthor] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const [created, setCreated] = useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    setErr("")
    try {
      const id = props.slugOf(name)
      await api("POST", "/v1/apps", { id, name: name.trim(), kind: "web", ...(author.trim() ? { author: author.trim() } : {}) })
      // kick the dependency install + first build in the background so the app is
      // ready shortly after it's opened (the agent flow also works)
      void api("POST", `/v1/apps/${encodeURIComponent(id)}/install`).catch(() => undefined)
      setCreated(id)
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    "w-full rounded-lg border border-line bg-panel px-3 py-2 text-13 text-ink outline-none placeholder:text-ink-muted focus:border-line-focus"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={props.onClose}>
      <div className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-line bg-panel p-4" onClick={(e) => e.stopPropagation()}>
        {!created ? <><h3 className="text-14 font-medium text-ink">{tr("New app")}</h3>
          <input ref={(el) => { if (el) setTimeout(() => el.focus(), 0) }} className={inputClass} placeholder={tr("app name")} value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <input className={inputClass} placeholder={tr("author (shown as “by …”)")} value={author} onChange={(e) => setAuthor(e.currentTarget.value)} />
          {err ? <div className="text-12 text-danger">{err}</div> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost-muted" size="small" onClick={props.onClose}>{tr("Cancel")}</Button>
            <Button variant="neutral" size="small" disabled={busy || !name.trim()} onClick={() => void create()}>
              {busy ? tr("Creating…") : tr("Create")}
            </Button>
          </div></>: <>
              <h3 className="text-14 font-medium text-ink">{tr("“{name}” created", { name })}</h3>
              <p className="text-13 leading-5 text-ink-muted">
                {tr("A starter page is in place. Open the {agent} tab and tell it what to build.", { agent: tr("Agent") })}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost-muted" size="small" onClick={props.onClose}>{tr("Later")}</Button>
                <Button variant="neutral" size="small" onClick={() => void props.onCreated(created!)}>{tr("Open the app")}</Button>
              </div>
            </>}
      </div>
    </div>
  )
}

/** fs + network together is the pair users misread: a list of capability
 *  names does not say that the two combined let a plugin read what the app
 *  stores AND post it somewhere. Say the consequence instead. */
function dataEgressWarning(permissions: string[], networkHosts: string[]): string | null {
  const readsData = permissions.some((p) => p === "fs" || p.startsWith("fs:"))
  const sends = permissions.includes("network")
  if (!readsData || !sends) return null
  const where = networkHosts.length ? networkHosts.join(", ") : tr("hosts it names at runtime")
  return tr("Can read this app's stored data (chats, characters, personas) and send it to {where}.", { where })
}

/** Import an app from a git repository: preview what's inside (bundled
 *  plugins and the permissions they ask for) and spell out the risk of
 *  running community code before anything is installed. */
function ImportAppDialog(props: { onClose: () => void; onImported: (id: string) => void | Promise<void> }) {
  const [gitUrl, setGitUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const [preview, setPreview] = useState<{
    slug: string
    head: string
    manifest: { name: string; version: string; author: string | null }
    plugins: { id: string; name: string; version: string | null; description: string | null; permissions: string[]; networkHosts: string[] }[]
  } | null>(null)

  const inputClass =
    "w-full rounded-lg border border-line bg-panel px-3 py-2 text-13 text-ink outline-none placeholder:text-ink-muted focus:border-line-focus"

  const stage = async () => {
    setBusy(true)
    setErr("")
    setPreview(null)
    try {
      const r = await api<NonNullable<typeof preview>>("POST", "/v1/apps/import", { gitUrl: gitUrl.trim() })
      setPreview(r)
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const confirmImport = async () => {
    const p = preview
    if (!p) return
    setBusy(true)
    setErr("")
    try {
      // head pins the install to the commit this preview reviewed
      const r = await api<{ ok: boolean; id: string }>("POST", "/v1/apps/import", { gitUrl: gitUrl.trim(), confirm: p.slug, head: p.head })
      // dependencies + first build in the background, like New app
      void api("POST", `/v1/apps/${encodeURIComponent(r.id)}/install`).catch(() => undefined)
      await props.onImported(r.id)
    } catch (e: any) {
      setErr(e.message ?? String(e))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 max-md:items-end" onClick={props.onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col gap-3 overflow-hidden rounded-xl border border-line bg-panel p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-14 font-medium text-ink">{tr("Import app from git")}</h3>
        <input
          className={inputClass}
          placeholder="https://github.com/you/your-chrysalis-app"
          value={gitUrl}
          onChange={(e) => setGitUrl(e.currentTarget.value)}
        />
        {err ? <><div className="text-12 leading-4 text-danger">{err}</div></>: null}
        {!preview ? <><p className="text-12 leading-4 text-ink-muted">
            {tr("The repository is cloned and inspected first, nothing runs until you review what it bundles and confirm.")}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost-muted" size="small" onClick={props.onClose}>{tr("Cancel")}</Button>
            <Button variant="neutral" size="small" disabled={busy || !gitUrl.trim()} onClick={() => void stage()}>
              {busy ? tr("Inspecting…") : tr("Inspect repository")}
            </Button>
          </div></>: null}
        {preview ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
              <div>
                <p className="text-14 font-medium text-ink">{preview.manifest.name}</p>
                <p className="text-12 text-ink-muted">
                  v{preview.manifest.version}
                  {preview.manifest.author ? <>{tr("· by {author}", { author: preview.manifest.author })}</> : null}
                </p>
              </div>
              <div className="rounded-lg border border-line p-3">
                <p className="text-12 font-medium text-ink">
                  {tr("Bundled plugins ({n})", { n: preview.plugins.length })}
                </p>
                {preview.plugins.length > 0 ? <ul className="mt-1.5 flex flex-col gap-2">
                    {(preview.plugins).map((pl) => (
                        <li key={pl.id} className="rounded-md bg-pressed/50 p-2">
                          <p className="text-12 text-ink">
                            {pl.name}
                            {pl.version ? <span className="text-ink-faint">v{pl.version}</span> : null}
                          </p>
                          {pl.description ? <p className="mt-0.5 text-11 leading-4 text-ink-muted">{pl.description}</p> : null}
                          <div className="mt-1 flex flex-wrap gap-1">
                            {pl.permissions.map((perm) => (
                                <span key={perm} className="rounded-full bg-warning-soft/20 px-1.5 py-0.5 text-10 text-ink-muted">
                                  {perm}
                                </span>
                              ))}
                            {pl.networkHosts.map((h) => (
                                <span key={h} className="rounded-full bg-warning-soft/20 px-1.5 py-0.5 text-10 font-mono text-ink-muted">
                                  {tr("net: {host}", { host: h })}
                                </span>
                              ))}
                          </div>
                          {dataEgressWarning(pl.permissions, pl.networkHosts) ? <p className="mt-1 text-11 leading-4 text-warning">{dataEgressWarning(pl.permissions, pl.networkHosts)}</p> : null}
                        </li>
                      ))}
                  </ul> : <p className="mt-1 text-12 text-ink-muted">{tr("No plugins, plain UI app.")}</p>}
              </div>
              <p className="rounded-lg border border-warning/30 bg-warning-soft/10 p-3 text-12 leading-4 text-ink-muted">
                {tr("Community apps run real code on your Chrysalis server: plugins can read and write the app's data, call models, and reach the hosts listed above. Only import repositories you trust. Your existing apps and data are untouched; you can delete it any time.")}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost-muted" size="small" onClick={props.onClose}>{tr("Cancel")}</Button>
                <Button variant="neutral" size="small" disabled={busy} onClick={() => void confirmImport()}>
                  {busy ? tr("Importing…") : tr("Import this app")}
                </Button>
              </div>
            </div>
          ) : null}
      </div>
    </div>
  )
}

/** App deletion: irreversible (the whole app folder goes), so confirm by name. */
function DeleteAppDialog(props: { app: { id: string; name: string }; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  const del = async () => {
    setBusy(true)
    setErr("")
    try {
      await api("DELETE", `/v1/apps/${encodeURIComponent(props.app.id)}`)
      props.onDeleted()
    } catch (e: any) {
      setErr(e.message ?? String(e))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={props.onClose}>
      <div className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-line bg-panel p-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-14 font-medium text-ink">{tr("Delete “{name}”?", { name: props.app.name })}</h3>
        <p className="text-13 leading-5 text-ink-muted">
          {tr("The entire app (code, plugins and its data) is removed permanently. This cannot be undone.")}
        </p>
        {err ? <div className="text-12 text-danger">{err}</div> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost-muted" size="small" onClick={props.onClose}>{tr("Cancel")}</Button>
          <Button variant="danger" size="small" disabled={busy} onClick={() => void del()}>
            {busy ? tr("Deleting…") : tr("Delete app")}
          </Button>
        </div>
      </div>
    </div>
  )
}


/** Plugins running with a specific app: the bundled ones plus anything
 *  imported from git (two-phase — review permissions before install).
 *  Manifest, permissions, network hosts, and removal with confirm. */
export function AppPluginsDialog(props: { appId: string; open: boolean; onClose: () => void }) {
  // source tracks `open`: null while closed (no fetch), the appId once open —
  // a plain one-arg createResource would fetch once at mount (closed → [])
  // and never re-run, showing "No plugins" forever
  const plugins = useResource(
    () => (props.open ? appPluginsApi.list(props.appId) : Promise.resolve([] as any[])),
    [props.open, props.appId],
  )
  const [confirming, setConfirming] = useState<string | null>(null)
  const [err, setErr] = useState("")
  // import-from-git (two-phase: inspect the repo, then install into THIS app)
  const [gitUrl, setGitUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{
    slug: string
    head: string
    manifest: { name: string; version: string | null; author: string | null; description: string | null }
    permissions: string[]
    networkHosts: string[]
  } | null>(null)

  const inputClass =
    "w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 text-13 text-ink outline-none placeholder:text-ink-muted focus:border-line-focus"

  const stage = async () => {
    setBusy(true)
    setErr("")
    setPreview(null)
    try {
      setPreview(await appPluginsApi.importPreview(props.appId, gitUrl.trim()))
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const confirmImport = async () => {
    const p = preview
    if (!p) return
    setBusy(true)
    setErr("")
    try {
      await appPluginsApi.importConfirm(props.appId, gitUrl.trim(), p.head)
      setPreview(null)
      setGitUrl("")
      plugins.refetch()
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (pid: string) => {
    setErr("")
    try {
      await appPluginsApi.remove(props.appId, pid)
      setConfirming(null)
      plugins.refetch()
    } catch (e: any) {
      setErr(e.message ?? String(e))
    }
  }

  // a disabled plugin stops executing entirely (routes, tools, panels) until
  // switched back on — nothing is uninstalled
  const toggle = async (pid: string, enabled: boolean) => {
    setErr("")
    setBusy(true)
    try {
      await appPluginsApi.setEnabled(props.appId, pid, enabled)
      plugins.refetch()
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    props.open ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={props.onClose}>
        <div className="flex max-h-[80vh] w-full max-w-lg flex-col gap-3 overflow-hidden rounded-xl border border-line bg-panel p-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2">
            <h3 className="flex-1 text-14 font-medium text-ink">{tr("Plugins: {appId}", { appId: props.appId })}</h3>
            <IconButton icon={<IconSmall name="outline-xmark" />} variant="ghost-muted" size="small" title={tr("Close")} onClick={props.onClose} />
          </div>
          {!plugins.loading ? <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
              {/* import from git — plugins are per-app, so this installs into
                  THIS app's plugins/ (a git-source app update keeps them) */}
              <div className="flex flex-col gap-1.5 border-b border-line pb-3">
                <p className="text-11 font-medium uppercase tracking-wide text-ink-faint">{tr("Import from git")}</p>
                {!preview ? <><div className="flex gap-1.5">
                    <input
                      className={inputClass}
                      placeholder="https://github.com/you/your-chrysalis-plugin"
                      value={gitUrl}
                      onChange={(e) => setGitUrl(e.currentTarget.value)}
                    />
                    <Button
                      variant="neutral"
                      size="small"
                      disabled={busy || !gitUrl.trim()}
                      onClick={() => void stage()}
                    >
                      {busy ? tr("Inspecting…") : tr("Inspect")}
                    </Button>
                  </div>
                  <p className="text-11 leading-4 text-ink-faint">
                    {tr("The repository is inspected first, nothing runs until you review its permissions and confirm.")}
                  </p></>: <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
                      <div>
                        <p className="text-13 font-medium text-ink">{preview!.manifest.name}</p>
                        <p className="text-11 text-ink-muted">
                          {preview!.manifest.version ? <>v{preview!.manifest.version}</> : null}
                          {preview!.manifest.author ? <>{tr("· by {author}", { author: preview!.manifest.author })}</> : null}
                        </p>
                        {preview!.manifest.description ? <p className="mt-0.5 text-12 leading-4 text-ink-muted">{preview!.manifest.description}</p> : null}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {(preview!.permissions).map((perm) => (
                            <span key={perm} className="rounded-full bg-warning-soft/20 px-1.5 py-0.5 text-10 text-ink-muted">{perm}</span>
                          ))}
                        {(preview!.networkHosts).map((h) => (
                            <span key={h} className="rounded-full bg-warning-soft/20 px-1.5 py-0.5 text-10 font-mono text-ink-muted">{tr("net: {host}", { host: h })}</span>
                          ))}
                        {preview!.permissions.length === 0 && preview!.networkHosts.length === 0 ? <span className="text-11 text-ink-faint">{tr("No permissions, no network. It only gets its own storage.")}</span> : null}
                      </div>
                      {dataEgressWarning(preview!.permissions, preview!.networkHosts) ? <p className="text-11 leading-4 text-warning">{dataEgressWarning(preview!.permissions, preview!.networkHosts)}</p> : null}
                      <p className="rounded-lg border border-warning/30 bg-warning-soft/10 p-2.5 text-12 leading-4 text-ink-muted">
                        {tr("Community plugins run real code on your Chrysalis server. This one gets the capabilities above, installed into {appId} only. App updates keep it. Import repositories you trust.", { appId: props.appId })}
                      </p>
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost-muted" size="small" onClick={() => setPreview(null)}>{tr("Back")}</Button>
                        <Button variant="neutral" size="small" disabled={busy} onClick={() => void confirmImport()}>
                          {busy ? tr("Importing…") : tr("Import into this app")}
                        </Button>
                      </div>
                    </div>}
              </div>
              {(plugins.data ?? []).map((pl: any) => (
                  <div key={pl.id} className={`flex flex-col gap-1 rounded-lg border border-line p-3 text-13 ${pl.disabled ? "opacity-55" : ""}`}>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 truncate font-medium">{pl.name}</span>
                      {pl.disabled && <span className="text-11 text-ink-faint">{tr("off")}</span>}
                      {pl.version && <span className="text-11 text-ink-faint">v{pl.version}</span>}
                      <Button variant="ghost-muted" size="small" disabled={busy} onClick={() => void toggle(pl.id, !!pl.disabled)}>
                        {pl.disabled ? tr("Enable") : tr("Disable")}
                      </Button>
                      <Button variant="ghost-muted" size="small" onClick={() => setConfirming(pl.id)}>
                        {tr("Remove")}
                      </Button>
                    </div>
                    {pl.description && <p className="text-12 text-ink-faint">{pl.description}</p>}
                    <div className="flex flex-wrap gap-1">
                      {(pl.permissions ?? []).map((perm: string) => (<span key={perm} className="rounded-full bg-pressed px-2 py-0.5 text-10 text-ink-muted">{perm}</span>))}
                      {(pl.networkHosts ?? []).map((h: string) => (<span key={h} className="rounded-full bg-pressed px-2 py-0.5 text-10 font-mono text-ink-muted">{tr("net: {host}", { host: h })}</span>))}
                    </div>
                    {confirming === pl.id ? <div className="mt-1 flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger-soft/10 p-2">
                        <p className="text-12 text-ink">
                          {tr("Remove “{name}”? It may take functionality of this app with it.", { name: pl.name })}
                        </p>
                        <div className="flex gap-2">
                          <Button variant="danger" size="small" onClick={() => remove(pl.id)}>{tr("Remove plugin")}</Button>
                          <Button variant="ghost-muted" size="small" onClick={() => setConfirming(null)}>{tr("Cancel")}</Button>
                        </div>
                      </div> : null}
                  </div>
                ))}
              {(plugins.data ?? []).length === 0 ? <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-13 text-ink-faint">
                  {tr("No plugins in this app yet, import one above.")}
                </div> : null}
            </div> : <div className="text-13 text-ink-faint">{tr("Loading…")}</div>}
          {err ? <div className="text-12 text-danger">{err}</div> : null}
        </div>
      </div> : null
  )
}
