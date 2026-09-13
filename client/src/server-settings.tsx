// Settings > Server (admins): the settings in config.yaml, applied as soon as
// they are saved. Port, LAN and HTTPS changes move the engine's socket, so the
// page follows the engine to its new address.
import { useEffect, useState, type ReactNode } from "react"
import { renderSVG } from "uqr"
import { serverApi, type ServerInfo } from "./api"
import { tr } from "./i18n/index"
import { Pane, inputClass } from "./settings"
import { Button, IconButton } from "./ui/button"
import { IconSmall } from "./ui/icon"
import { useResource } from "./use-resource"

/** Where this page should go after the socket moved. Same host name, new
 *  port and scheme; a page opened on another device keeps its address. */
function movedUrl(info: ServerInfo): string {
  const scheme = info.effective.ssl.enabled ? "https:" : "http:"
  const url = new URL(window.location.href)
  url.protocol = scheme
  url.port = String(info.effective.port)
  return url.toString()
}

function CopyButton(props: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <IconButton
      icon={<IconSmall name={done ? "circle-check" : "copy"} />}
      variant="ghost-muted"
      size="small"
      title={tr("Copy")}
      onClick={() => {
        void navigator.clipboard?.writeText(props.text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
    />
  )
}

function PathRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-13">
      <span className="w-24 shrink-0 text-ink-muted">{props.label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-panel px-2 py-1 font-mono text-12 text-ink" title={props.value}>{props.value}</code>
      <CopyButton text={props.value} />
    </div>
  )
}

function Toggle(props: { label: string; hint?: string; checked: boolean; locked?: string; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-13 text-ink">
        <input
          type="checkbox"
          className="size-4 accent-[var(--c-contrast)]"
          checked={props.checked}
          disabled={props.disabled || !!props.locked}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        {props.label}
      </label>
      {props.hint ? <p className="pl-6 text-12 leading-4 text-ink-muted">{props.hint}</p> : null}
      {props.locked ? <LockedNote source={props.locked} /> : null}
    </div>
  )
}

function LockedNote(props: { source: string }) {
  return <p className="pl-6 text-12 text-ink-faint">{tr("Set by {source} for this run", { source: props.source })}</p>
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-13 font-medium text-ink">{props.title}</h3>
      {props.children}
    </section>
  )
}

/** One text setting with its own Save button. */
function TextSetting(props: {
  label: string
  value: string
  locked?: string
  disabled: boolean
  inputMode?: "numeric" | "text"
  placeholder?: string
  onSave: (value: string) => void
}) {
  const [draft, setDraft] = useState(props.value)
  useEffect(() => setDraft(props.value), [props.value])
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-13 text-ink-muted">{props.label}</span>
        <input
          className={inputClass}
          inputMode={props.inputMode}
          placeholder={props.placeholder}
          value={draft}
          disabled={props.disabled || !!props.locked}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft !== props.value) props.onSave(draft)
          }}
        />
        <Button variant="neutral" size="small" disabled={props.disabled || !!props.locked || draft === props.value} onClick={() => props.onSave(draft)}>
          {tr("Save")}
        </Button>
      </div>
      {props.locked ? <p className="pl-26 text-12 text-ink-faint">{tr("Set by {source} for this run", { source: props.locked })}</p> : null}
    </div>
  )
}

function PhoneQr(props: { urls: string[] }) {
  const [pick, setPick] = useState(0)
  const url = props.urls[Math.min(pick, props.urls.length - 1)]
  if (!url) {
    return <p className="text-12 text-ink-muted">{tr("No network address found. Connect this computer to Wi-Fi or a network.")}</p>
  }
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div
        className="size-36 shrink-0 rounded-lg bg-white p-2"
        // uqr renders plain rects and paths from the URL text alone
        dangerouslySetInnerHTML={{ __html: renderSVG(url, { border: 1 }) }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-12 leading-4 text-ink-muted">{tr("Scan with your phone's camera, or type the address. Both devices need to be on the same network.")}</p>
        {props.urls.map((u, i) => (
          <div key={u} className="flex items-center gap-1">
            <button
              type="button"
              className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left font-mono text-12 ${i === pick ? "bg-pressed text-ink" : "text-ink-muted hover:bg-hover"}`}
              onClick={() => setPick(i)}
            >
              {u}
            </button>
            <CopyButton text={u} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** How this kind of install gets a new version. */
function updateHow(kind: ServerInfo["installKind"]): string {
  if (kind === "source") return tr("Update with git pull, then bun install, then restart Chrysalis.")
  if (kind === "npm") return tr("Update with bun install -g chrysalis-engine, then restart Chrysalis.")
  if (kind === "android") return tr("Install the new app from the release page. Your data stays.")
  return tr("Download it from the release page and replace this copy. Your data stays in its own folder.")
}

function ReleaseRow(props: { info: ServerInfo }) {
  const release = useResource(() => serverApi.release())
  const r = release.data
  if (!r?.newer) {
    const label = r ? tr("Chrysalis {version}, the latest version", { version: props.info.version }) : tr("Chrysalis {version}", { version: props.info.version })
    return <p className="text-12 text-ink-faint">{label}</p>
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2">
      <div className="flex items-center gap-2 text-13">
        <span className="min-w-0 flex-1 text-ink">{tr("Chrysalis {version} is available", { version: r.version })}</span>
        <a className="text-accent underline" href={r.url} target="_blank" rel="noreferrer">{tr("Release page")}</a>
      </div>
      <p className="text-12 leading-4 text-ink-muted">{updateHow(props.info.installKind)}</p>
    </div>
  )
}

export function ServerTab() {
  const info = useResource(() => serverApi.get())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const [moving, setMoving] = useState<string | null>(null)

  const save = async (changes: Record<string, unknown>) => {
    setBusy(true)
    setErr("")
    try {
      const next = await serverApi.update(changes)
      info.mutate(next)
      if (next.moved) {
        const target = movedUrl(next)
        if (target !== window.location.href) {
          setMoving(target)
          setTimeout(() => window.location.assign(target), 1200)
        }
      }
    } catch (e) {
      setErr((e as Error).message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const d = info.data
  if (!d) {
    return (
      <Pane title={tr("Server")} description={tr("How Chrysalis runs on this computer.")}>
        <div className="text-13 text-ink-faint">{info.loading ? tr("Loading…") : err}</div>
      </Pane>
    )
  }
  const f = d.file
  const e = d.effective
  const locked = d.locked

  return (
    <Pane title={tr("Server")} description={tr("Saved to config.yaml. Changes apply right away.")}>
      <div className="flex flex-col gap-6 pb-4">
        {moving ? <div className="rounded-lg border border-line bg-panel px-3 py-2 text-13 text-ink">{tr("Moving to {url}…", { url: moving })}</div> : null}
        {err ? <div className="rounded-lg border border-danger px-3 py-2 text-13 text-danger">{err}</div> : null}

        <Section title={tr("Other devices")}>
          <Toggle
            label={tr("Allow other devices on my network")}
            hint={tr("Open Chrysalis from your phone or another computer. Every account still needs its password.")}
            checked={e.lan}
            locked={locked.lan}
            disabled={busy}
            onChange={(lan) => void save({ lan })}
          />
          {e.lan ? <PhoneQr urls={d.urls.lan} /> : null}
          <TextSetting
            label={tr("Host names")}
            value={f.allowedHosts.join(", ")}
            locked={locked.allowedHosts}
            disabled={busy}
            placeholder={tr("e.g. chrysalis.home, mypc.tailnet.ts.net")}
            onSave={(v) => void save({ allowedHosts: v.split(",").map((h) => h.trim()).filter(Boolean) })}
          />
        </Section>

        <Section title={tr("Connection")}>
          <TextSetting
            label={tr("Port")}
            value={String(f.port)}
            locked={locked.port}
            disabled={busy}
            inputMode="numeric"
            onSave={(v) => void save({ port: Number(v) })}
          />
          <Toggle
            label={tr("Use HTTPS")}
            hint={tr("Phones only allow the microphone and installing as an app over HTTPS. Needs a certificate and key file.")}
            checked={e.ssl.enabled}
            locked={locked["ssl.enabled"]}
            disabled={busy}
            onChange={(enabled) => void save({ "ssl.enabled": enabled })}
          />
          <TextSetting label={tr("Certificate")} value={f.ssl.certPath} locked={locked["ssl.certPath"]} disabled={busy} onSave={(v) => void save({ "ssl.certPath": v })} />
          <TextSetting label={tr("Key")} value={f.ssl.keyPath} locked={locked["ssl.keyPath"]} disabled={busy} onSave={(v) => void save({ "ssl.keyPath": v })} />
        </Section>

        <Section title={tr("Apps and agent")}>
          <Toggle
            label={tr("Apps can download packages")}
            hint={tr("Install scripts never run.")}
            checked={e.apps.packageDownloads}
            locked={locked["apps.packageDownloads"]}
            disabled={busy}
            onChange={(v) => void save({ "apps.packageDownloads": v })}
          />
          <Toggle
            label={tr("Agent shell")}
            hint={tr("Runs inside your browser tab, never on this computer.")}
            checked={e.agent.shell}
            locked={locked["agent.shell"]}
            disabled={busy}
            onChange={(v) => void save({ "agent.shell": v })}
          />
          {d.installKind === "binary" || d.installKind === "npm" ? (
            <Toggle
              label={tr("Open the browser when Chrysalis starts")}
              checked={e.openBrowser}
              locked={locked.openBrowser}
              disabled={busy}
              onChange={(v) => void save({ openBrowser: v })}
            />
          ) : null}
        </Section>

        <Section title={tr("Files")}>
          <PathRow label={tr("Config file")} value={d.configPath} />
          <PathRow label={tr("Data folder")} value={d.dataDir} />
          <p className="text-12 leading-4 text-ink-muted">
            {tr("Every setting here is in the config file, with notes. Edit it with any text editor while Chrysalis is stopped.")}
          </p>
        </Section>

        <Section title={tr("Version")}>
          <ReleaseRow info={d} />
        </Section>
      </div>
    </Pane>
  )
}
