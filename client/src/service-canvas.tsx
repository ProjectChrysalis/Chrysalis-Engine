// The pane for a service app: a program the engine runs and shows here. It
// asks before the first run, shows the program's own output while it comes
// up, then frames the port the engine put in front of it.
import { useCallback, useEffect, useRef, useState } from "react"
import { IconSmall } from "./ui/icon"
import { Button } from "./ui/button"
import { api } from "./api"
import { tr } from "./i18n/index"

interface ServiceInfo {
  state: "stopped" | "installing" | "starting" | "running" | "failed"
  port: number | null
  rev: number
  error: string | null
  log: string[]
  approved: boolean
  canApprove: boolean
  command: string[]
  setup: string[] | null
  cwd: string
}

/** What the phone menu sends a pane, whose header is not shown there:
 *  { app, action: "fullscreen" | "log" | "restart" | "stop" }. */
export const SERVICE_PANE_EVENT = "chrysalis-service-pane"

/** The service's own origin: this page's name, the service's port. */
const serviceUrl = (port: number) => `${location.protocol}//${location.hostname}:${port}/`

export function ServiceCanvas(props: { tab: { id: string; name: string }; onAskAgent: (prompt: string) => void; split?: boolean; onSplit: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [info, setInfo] = useState<ServiceInfo | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  /** the frame was pointed at the app's port and nothing answered from it */
  const [silent, setSilent] = useState(false)
  const heard = useRef(false)
  /** the approval's own choice: do not ask again when this app's program changes */
  const [always, setAlways] = useState(false)
  /** the rev the frame shows, so a newer one loads the page again */
  const shown = useRef<number | null>(null)
  /** stopped by hand: opening the tab again must not start it behind your back */
  const held = useRef(false)
  /** the program's output, under the page */
  const [logOpen, setLogOpen] = useState(false)
  const logShown = useRef(false)
  const logRef = useRef<HTMLPreElement>(null)
  /** the view follows new lines until it is scrolled up */
  const logFollows = useRef(true)
  const base = `/v1/apps/${encodeURIComponent(props.tab.id)}/service`

  const act = useCallback(async (action: "approve" | "start" | "stop" | "restart") => {
    held.current = action === "stop"
    try {
      setInfo(await api<ServiceInfo>("POST", `${base}/${action}`, action === "approve" ? { always } : undefined))
      setFailure(null)
    } catch (e) {
      setFailure((e as Error).message)
    }
  }, [base, always])

  useEffect(() => {
    let alive = true
    let timer: number | undefined
    shown.current = null
    held.current = false
    const tick = async () => {
      let next: ServiceInfo | null = null
      try {
        next = await api<ServiceInfo>("GET", logShown.current ? `${base}?log=full` : base)
        if (!alive) return
        setFailure(null)
        // an allowed program comes up with its tab
        if (next.approved && next.state === "stopped" && !held.current) {
          next = await api<ServiceInfo>("POST", `${base}/start`)
          if (!alive) return
        }
        setInfo(next)
      } catch (e) {
        if (!alive) return
        setFailure((e as Error).message)
      }
      timer = window.setTimeout(tick, next?.state === "running" && !logShown.current ? 3000 : 800)
    }
    void tick()
    return () => {
      alive = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [base])

  const running = info?.state === "running" && info.port !== null
  const port = running ? (info?.port ?? null) : null
  const rev = info?.rev ?? null
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || port === null || rev === null || shown.current === rev) return
    shown.current = rev
    heard.current = false
    setSilent(false)
    // the port's own first page: it reports back, then moves on to the app
    frame.src = `${serviceUrl(port)}__chrysalis/open`
    const probe = window.setInterval(() => {
      if (heard.current) window.clearInterval(probe)
      else frame.contentWindow?.postMessage({ chrysalisService: "probe" }, new URL(serviceUrl(port)).origin)
    }, 1000)
    const timer = window.setTimeout(() => { if (!heard.current) setSilent(true) }, 6000)
    return () => {
      window.clearInterval(probe)
      window.clearTimeout(timer)
    }
  }, [port, rev])

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== frameRef.current?.contentWindow) return
      if (port === null || ev.origin !== new URL(serviceUrl(port)).origin) return
      if ((ev.data as { chrysalisService?: unknown } | null)?.chrysalisService !== "open") return
      heard.current = true
      setSilent(false)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [port])

  const toggleLog = () => {
    const open = !logOpen
    logShown.current = open
    logFollows.current = true
    setLogOpen(open)
    if (open) void api<ServiceInfo>("GET", `${base}?log=full`).then(setInfo, () => {})
  }
  const fullscreen = () => {
    if (info?.port != null) window.open(serviceUrl(info.port), "_blank", "noopener")
  }
  const asked = useRef<(action: string) => void>(() => {})
  asked.current = (action) => {
    if (action === "log") toggleLog()
    else if (action === "fullscreen") fullscreen()
    else if (action === "restart" || action === "stop") void act(action)
  }
  useEffect(() => {
    const onAsk = (ev: Event) => {
      const detail = (ev as CustomEvent<{ app?: string; action?: string }>).detail
      if (detail?.app === props.tab.id && detail.action) asked.current(detail.action)
    }
    window.addEventListener(SERVICE_PANE_EVENT, onAsk)
    return () => window.removeEventListener(SERVICE_PANE_EVENT, onAsk)
  }, [props.tab.id])
  const busy = info?.state === "installing" || info?.state === "starting"
  const log = info?.log ?? []
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the lines change
  useEffect(() => {
    const el = logRef.current
    if (el && logFollows.current) el.scrollTop = el.scrollHeight
  }, [info, logOpen])
  const iconButton = "flex size-7 items-center justify-center rounded-md transition-colors hover:bg-hover hover:text-ink disabled:opacity-50 "
  return (
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
            className="flex items-center gap-1 rounded-md px-2 py-1 text-12 text-ink-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
            title={tr("Open in a full browser tab (installable as an app)")}
            disabled={!running}
            onClick={fullscreen}
          >
            <IconSmall name="outline-square-arrow" size="small" />
            <span>{tr("Fullscreen")}</span>
          </button>
          <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
          <button
            className={`${iconButton}${logOpen ? "bg-hover text-ink" : "text-ink-muted"}`}
            title={tr("Show the program's output")}
            aria-label={tr("Show the program's output")}
            aria-pressed={logOpen}
            disabled={!running}
            onClick={toggleLog}
          >
            <IconSmall name="terminal-active" size="small" />
          </button>
          <button
            className={`${iconButton}text-ink-muted`}
            title={tr("Stop this app's program and start it again")}
            aria-label={tr("Restart")}
            disabled={!info?.approved || busy}
            onClick={() => void act("restart")}
          >
            <IconSmall name="rebuild" size="small" />
          </button>
          <button
            className={`${iconButton}text-ink-muted`}
            title={tr("Stop this app's program")}
            aria-label={tr("Stop")}
            disabled={!info || info.state === "stopped"}
            onClick={() => void act("stop")}
          >
            <IconSmall name="stop" size="small" />
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* its own origin with its own cookies and storage: not the sandboxed
            frame an app page gets, since the program behind it is trusted
            with far more than a page is */}
        <iframe
          ref={frameRef}
          title={props.tab.name}
          allow="clipboard-read; clipboard-write; microphone; fullscreen"
          className="min-h-0 w-full flex-1 border-0 bg-transparent"
          style={{ visibility: running ? "visible" : "hidden" }}
        />
        {running && logOpen ? (
          <div className="relative flex max-h-[40%] shrink-0 flex-col border-t border-line bg-panel">
            <button
              className="absolute right-2 top-1.5 flex size-6 items-center justify-center rounded-md bg-panel text-ink-muted transition-colors hover:bg-hover hover:text-ink"
              aria-label={tr("Close")}
              onClick={toggleLog}
            >
              <IconSmall name="xmark-small" size="small" />
            </button>
            <pre
              ref={logRef}
              className="min-h-0 overflow-y-auto whitespace-pre-wrap p-3 pr-10 text-12 leading-4 text-ink-muted [overflow-wrap:anywhere] [scrollbar-width:thin]"
              onScroll={(e) => {
                const el = e.currentTarget
                logFollows.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
              }}
            >
              {log.length ? log.join("\n") : tr("No output yet.")}
            </pre>
          </div>
        ) : null}
        {running && silent ? (
          <p role="alert" className="absolute inset-x-0 top-0 z-10 border-b border-line bg-panel px-3 py-2 text-12 text-ink-muted">
            {tr("This page is not loading. The firewall on the computer running Chrysalis may be blocking port {port}. An admin can allow it in Settings, Server.", { port: String(info?.port ?? "") })}
          </p>
        ) : null}
        {!running ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 overflow-auto bg-base p-6 text-13 text-ink-muted">
            {!info ? (
              failure ? <span role="alert" className="text-danger">{failure}</span> : <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink-muted" aria-hidden="true" />
            ) : !info.approved ? (
              <div className="flex max-w-[520px] flex-col gap-3">
                <p className="text-14 text-ink">{tr("This app runs a program on this computer")}</p>
                <p>{tr("It is not sandboxed like other apps: it can read and change anything your account can. Allow it only if you trust where it came from.")}</p>
                <pre className="overflow-auto rounded-lg border border-line bg-panel p-3 text-12 leading-4 text-ink">{[info.setup ? info.setup.join(" ") : null, info.command.join(" ")].filter(Boolean).join("\n")}</pre>
                <p className="text-12">{tr("Runs in: {folder}", { folder: `apps/${props.tab.id}/${info.cwd === "." ? "" : info.cwd}` })}</p>
                {info.canApprove ? (
                  <>
                    <label className="flex cursor-pointer items-center gap-2 text-12">
                      <input type="checkbox" className="size-4 accent-[var(--c-contrast)]" checked={always} onChange={(e) => setAlways(e.currentTarget.checked)} />
                      <span>{tr("Don't ask again for this app, even if its program changes")}</span>
                    </label>
                    <div><Button variant="primary" size="small" onClick={() => void act("approve")}>{tr("Allow and start")}</Button></div>
                  </>
                ) : <p>{tr("Only an admin account can run this kind of app.")}</p>}
                {failure ? <span role="alert" className="text-danger">{failure}</span> : null}
              </div>
            ) : (
              <div className="flex w-full max-w-[720px] flex-col gap-3">
                <div className="flex items-center gap-2">
                  {busy ? <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-ink-muted motion-reduce:animate-none" aria-hidden="true" /> : null}
                  <span role="status" aria-live="polite" className={info.state === "failed" ? "text-danger" : undefined}>
                    {info.state === "installing" ? tr("Downloading what the program needs…")
                      : info.state === "starting" ? tr("Starting the program…")
                      : info.state === "failed" ? tr("The program stopped: {reason}", { reason: info.error ?? "" })
                      : tr("The program is stopped.")}
                  </span>
                </div>
                {log.length ? <pre className="max-h-[50vh] overflow-auto rounded-lg border border-line bg-panel p-3 text-12 leading-4 text-ink-muted">{log.slice(-40).join("\n")}</pre> : null}
                {!busy ? (
                  <div className="flex items-center gap-2">
                    <Button variant="neutral" size="small" onClick={() => void act("start")}>{tr("Start")}</Button>
                    {info.state === "failed" ? (
                      <Button
                        variant="ghost-muted"
                        size="small"
                        onClick={() => props.onAskAgent(`The "${props.tab.name}" app (apps/${props.tab.id}/) runs a program that will not start. Investigate and fix it.\n\nIts output:\n${log.slice(-40).join("\n")}`)}
                      >
                        {tr("Ask the agent")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {failure ? <span role="alert" className="text-danger">{failure}</span> : null}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
