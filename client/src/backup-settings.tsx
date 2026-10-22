// Settings > Backups: the whole account (apps and their data, notes, agent
// history, settings, connections) backed up on this device, as a file, or
// pulled by another device with a one-time code.
import { useEffect, useRef, useState } from "react"
import { renderSVG } from "uqr"
import { backupApi, type AccountBackup, type BackupJob, type DriveBackup, type DriveStatus, type TransferOffer, type TransferPeek } from "./api"
import { tr } from "./i18n/index"
import { Pane, inputClass } from "./settings"
import { CopyButton, Section, Toggle } from "./server-settings"
import { Button, IconButton } from "./ui/button"
import { IconSmall } from "./ui/icon"
import { useResource } from "./use-resource"
import type { Me } from "./types"

function formatBytes(n: number): string {
  if (n < 1024) return tr("{n} B", { n })
  const units = [tr("KB"), tr("MB"), tr("GB"), tr("TB")]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

const labelText = (label: AccountBackup["label"]): string =>
  label === "auto" ? tr("Automatic") : label === "before-restore" ? tr("Before a restore") : tr("Made by hand")

function jobText(job: BackupJob): string {
  const progress = job.total > 0 ? tr("{done} of {total}", { done: formatBytes(Math.min(job.done, job.total)), total: formatBytes(job.total) }) : ""
  if (job.phase === "failed") return job.error ?? tr("Failed")
  if (job.phase === "done") return job.kind === "backup" ? tr("Backup done") : tr("Restored. Reloading…")
  if (job.phase === "receiving") return [tr("Receiving"), progress].filter(Boolean).join(" ")
  if (job.phase === "restoring") return tr("Restoring…")
  if (job.phase === "uploading") return [tr("Copying to Google Drive"), progress].filter(Boolean).join(" ")
  if (job.phase === "downloading") return [tr("Downloading from Google Drive"), progress].filter(Boolean).join(" ")
  return [tr("Backing up"), progress].filter(Boolean).join(" ")
}

function Progress(props: { job: BackupJob }) {
  const pct = props.job.total > 0 ? Math.min(100, Math.round((props.job.done / props.job.total) * 100)) : null
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2.5">
      <span className={props.job.phase === "failed" ? "text-13 text-danger" : "text-13 text-ink"}>{jobText(props.job)}</span>
      {pct !== null && props.job.phase !== "done" && props.job.phase !== "failed" ? (
        <div className="h-1 overflow-hidden rounded bg-panel">
          <div className="h-full bg-contrast transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  )
}

/** The code, the address and a QR the receiving device scans. */
function SendPanel() {
  const [keys, setKeys] = useState(true)
  const [offer, setOffer] = useState<TransferOffer | null>(null)
  const [state, setState] = useState<TransferOffer["state"] | "expired">("waiting")
  const [err, setErr] = useState("")
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!offer) return
    const t = setInterval(() => {
      setNow(Date.now())
      void backupApi.offer().then((o) => setState(o ? o.state : "expired")).catch(() => undefined)
    }, 2000)
    return () => clearInterval(t)
  }, [offer])

  const make = async () => {
    setErr("")
    try {
      const next = await backupApi.makeOffer(keys)
      setOffer(next)
      setState("waiting")
      setNow(Date.now())
    } catch (e) {
      setErr((e as Error).message ?? String(e))
    }
  }
  const cancel = async () => {
    await backupApi.cancelOffer().catch(() => undefined)
    setOffer(null)
  }

  if (!offer) {
    return (
      <div className="flex flex-col gap-2.5">
        <Toggle label={tr("Include API keys and sign-ins")} checked={keys} disabled={false} onChange={setKeys} />
        <div>
          <Button variant="neutral" size="small" onClick={() => void make()}>{tr("Make a code")}</Button>
        </div>
        {err ? <p className="text-12 text-danger">{err}</p> : null}
      </div>
    )
  }
  const address = offer.lan[0]
  const minutes = Math.max(0, Math.ceil((offer.expires - now) / 60_000))
  const status =
    state === "sending" ? tr("Sending…") :
    state === "sent" ? tr("Sent. The other device is restoring it.") :
    state === "expired" || minutes === 0 ? tr("This code expired.") :
    tr("Expires in {minutes} min. Works once.", { minutes })
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-4">
        {address ? (
          <div
            className="size-36 shrink-0 rounded-lg bg-white p-2"
            // uqr renders plain rects and paths from the text alone
            dangerouslySetInnerHTML={{ __html: renderSVG(`${address}/#transfer=${offer.code}`, { border: 1 }) }}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-2">
          <p className="text-12 leading-4 text-ink-muted">{tr("On the other device, open Settings > Backups > Receive and enter:")}</p>
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-13 text-ink-muted">{tr("Code")}</span>
            <code className="rounded bg-panel px-2 py-1 font-mono text-16 tracking-widest text-ink">{offer.code}</code>
            <CopyButton text={offer.code} />
          </div>
          {offer.lan.map((u) => (
            <div key={u} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-13 text-ink-muted">{tr("Address")}</span>
              <code className="min-w-0 truncate rounded bg-panel px-2 py-1 font-mono text-12 text-ink">{u}</code>
              <CopyButton text={u} />
            </div>
          ))}
          {!address ? <p className="text-12 text-warning">{tr("Other devices cannot reach this one. An admin can allow it in Settings > Server.")}</p> : null}
          <p className="text-12 text-ink-muted">{status}</p>
        </div>
      </div>
      <div className="flex gap-2">
        {state === "waiting" && minutes > 0 ? <Button variant="ghost" size="small" onClick={() => void cancel()}>{tr("Cancel")}</Button> : <Button variant="neutral" size="small" onClick={() => void make()}>{tr("New code")}</Button>}
      </div>
    </div>
  )
}

interface Detector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>
}
const BarcodeDetectorCtor = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector

/** The address and code from a scanned or pasted transfer link. */
function parseLink(text: string): { address: string; code: string } | null {
  const m = /^(https?:\/\/[^/#\s]+)\/?#transfer=([0-9A-Za-z-]{8,9})$/.exec(text.trim())
  return m ? { address: m[1]!, code: m[2]! } : null
}

function Scanner(props: { onFound: (address: string, code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState("")
  useEffect(() => {
    let stream: MediaStream | null = null
    let timer = 0
    let stopped = false
    const detector = BarcodeDetectorCtor ? new BarcodeDetectorCtor({ formats: ["qr_code"] }) : null
    void navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        if (stopped) {
          for (const t of s.getTracks()) t.stop()
          return
        }
        stream = s
        if (video.current) {
          video.current.srcObject = s
          void video.current.play()
        }
        const tick = async () => {
          if (stopped || !video.current || !detector) return
          try {
            for (const code of await detector.detect(video.current)) {
              const found = parseLink(code.rawValue)
              if (found) {
                props.onFound(found.address, found.code)
                return
              }
            }
          } catch { /* the frame was not ready */ }
          timer = window.setTimeout(() => void tick(), 300)
        }
        void tick()
      })
      .catch(() => setErr(tr("The camera could not be opened.")))
    return () => {
      stopped = true
      clearTimeout(timer)
      for (const t of stream?.getTracks() ?? []) t.stop()
    }
  }, [])
  return (
    <div className="flex flex-col gap-2">
      {err ? <p className="text-12 text-danger">{err}</p> : <video ref={video} className="aspect-square w-full max-w-64 rounded-lg bg-panel object-cover" muted playsInline />}
      <div>
        <Button variant="ghost" size="small" onClick={props.onClose}>{tr("Close camera")}</Button>
      </div>
    </div>
  )
}

function ReceivePanel(props: { busy: boolean; onJob: (job: BackupJob) => void }) {
  const [address, setAddress] = useState("")
  const [code, setCode] = useState("")
  const [peek, setPeek] = useState<TransferPeek | null>(null)
  const [scanning, setScanning] = useState(false)
  const [checking, setChecking] = useState(false)
  const [err, setErr] = useState("")

  const setFromText = (text: string) => {
    const link = parseLink(text)
    if (link) {
      setAddress(link.address)
      setCode(link.code)
    } else setAddress(text)
    setPeek(null)
  }
  const check = async () => {
    setErr("")
    setChecking(true)
    try {
      setPeek(await backupApi.peek(address, code))
    } catch (e) {
      setErr((e as Error).message ?? String(e))
    } finally {
      setChecking(false)
    }
  }
  const receive = async () => {
    setErr("")
    try {
      props.onJob((await backupApi.receive(address, code)).job)
      setPeek(null)
    } catch (e) {
      setErr((e as Error).message ?? String(e))
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-13 text-ink-muted">{tr("Address")}</span>
        <input className={inputClass} placeholder="192.168.1.20:8788" value={address} onChange={(e) => setFromText(e.currentTarget.value)} />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-13 text-ink-muted">{tr("Code")}</span>
        <input
          className={`${inputClass} font-mono uppercase tracking-widest`}
          placeholder="ABCD-2345"
          maxLength={9}
          value={code}
          onChange={(e) => {
            setCode(e.currentTarget.value)
            setPeek(null)
          }}
        />
      </div>
      {scanning ? (
        <Scanner
          onClose={() => setScanning(false)}
          onFound={(a, c) => {
            setAddress(a)
            setCode(c)
            setScanning(false)
          }}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="neutral" size="small" disabled={checking || props.busy || !address.trim() || !code.trim()} onClick={() => void check()}>{tr("Check")}</Button>
        {BarcodeDetectorCtor && !scanning ? <Button variant="neutral" size="small" onClick={() => setScanning(true)}>{tr("Scan QR code")}</Button> : null}
      </div>
      {peek ? (
        <div className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
          <p className="text-13 text-ink">
            {tr("{user}'s account: {files} files, {size}.", { user: peek.from, files: peek.files.toLocaleString(), size: formatBytes(peek.bytes) })}{" "}
            {peek.keys ? tr("API keys included.") : tr("No API keys.")}
          </p>
          <p className="text-12 leading-4 text-ink-muted">{tr("Everything in your account here is replaced. A backup of it is kept on this device first.")}</p>
          <div>
            <Button variant="danger" size="small" disabled={props.busy} onClick={() => void receive()}>{tr("Replace my account")}</Button>
          </div>
        </div>
      ) : null}
      {err ? <p className="text-12 text-danger">{err}</p> : null}
    </div>
  )
}

function BackupRow(props: { backup: AccountBackup; busy: boolean; onRestore: () => void; onDelete: () => void }) {
  const [confirm, setConfirm] = useState<"restore" | "delete" | null>(null)
  const b = props.backup
  const when = new Date(b.createdAt).toLocaleString()
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 basis-48 flex-col">
          <span className="truncate text-13 text-ink">{when}</span>
          <span className="text-12 text-ink-muted">
            {labelText(b.label)} · {formatBytes(b.bytes)}
            {b.added < b.bytes ? ` · ${tr("{size} new", { size: formatBytes(b.added) })}` : ""}
          </span>
        </div>
        <Button variant="neutral" size="small" disabled={props.busy} onClick={() => setConfirm(confirm === "restore" ? null : "restore")}>{tr("Restore")}</Button>
        <a href={backupApi.downloadUrl(b.id, false)} download title={tr("Download")} className="rounded-md p-1.5 text-ink-muted hover:bg-hover">
          <IconSmall name="download" />
        </a>
        <IconButton icon={<IconSmall name="trash" />} variant="ghost-muted" size="small" title={tr("Delete")} disabled={props.busy} onClick={() => setConfirm(confirm === "delete" ? null : "delete")} />
      </div>
      {confirm === "restore" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 basis-48 text-12 text-ink-muted">{tr("Your account goes back to this point. A backup of it as it is now is kept.")}</span>
          <Button variant="danger" size="small" onClick={() => { setConfirm(null); props.onRestore() }}>{tr("Restore")}</Button>
        </div>
      ) : null}
      {confirm === "delete" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 basis-48 text-12 text-ink-muted">{tr("Delete this backup?")}</span>
          <Button variant="danger" size="small" onClick={() => { setConfirm(null); props.onDelete() }}>{tr("Delete")}</Button>
        </div>
      ) : null}
    </div>
  )
}

/** What the trip to Google's sign-in page came back with (…/#drive=…). */
function driveOutcome(): string | null {
  const m = /(?:^#|&)drive=([^&]*)/.exec(window.location.hash)
  if (!m) return null
  history.replaceState(null, "", window.location.pathname + window.location.search)
  return decodeURIComponent(m[1] ?? "")
}

function DriveRow(props: { backup: DriveBackup; me: string; busy: boolean; onRestore: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const b = props.backup
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 basis-48 flex-col">
          <span className="truncate text-13 text-ink">{new Date(b.createdAt).toLocaleString()}</span>
          <span className="text-12 text-ink-muted">
            {formatBytes(b.bytes)}
            {b.from && b.from !== props.me ? ` · ${tr("from {user}", { user: b.from })}` : ""}
          </span>
        </div>
        <Button variant="neutral" size="small" disabled={props.busy} onClick={() => setConfirm(!confirm)}>{tr("Restore")}</Button>
      </div>
      {confirm ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 basis-48 text-12 text-ink-muted">{tr("Everything in your account here is replaced. A backup of it is kept on this device first.")}</span>
          <Button variant="danger" size="small" onClick={() => { setConfirm(false); props.onRestore() }}>{tr("Replace my account")}</Button>
        </div>
      ) : null}
    </div>
  )
}

function DriveSection(props: { drive: DriveStatus; me: string; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void>; onJob: (job: BackupJob) => void }) {
  const [outcome] = useState(driveOutcome)
  const [list, setList] = useState<DriveBackup[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState("")
  const d = props.drive
  const connect = async () => {
    setErr("")
    try {
      window.location.assign((await backupApi.driveConnect()).url)
    } catch (e) {
      setErr((e as Error).message ?? String(e))
    }
  }
  const load = async () => {
    setErr("")
    setLoading(true)
    try {
      setList(await backupApi.driveBackups())
    } catch (e) {
      setErr((e as Error).message ?? String(e))
    } finally {
      setLoading(false)
    }
  }
  const note =
    outcome === null || outcome === "cancelled" ? null :
    outcome === "connected" ? <p className="text-12 text-ink">{tr("Google Drive is connected. Your first backup is on its way there.")}</p> :
    <p className="text-12 text-danger">{outcome === "failed" ? tr("Connecting Google Drive failed. Try again.") : outcome}</p>
  if (!d.available) return <p className="text-12 text-ink-muted">{tr("Google Drive is not set up on this server.")}</p>
  if (!d.connected) {
    return (
      <div className="flex flex-col gap-2.5">
        {note}
        <p className="text-12 leading-4 text-ink-muted">{tr("Every backup also goes to your Google Drive, so you can restore it on any device.")}</p>
        <div>
          <Button variant="neutral" size="small" onClick={() => void connect()}>{tr("Connect Google Drive")}</Button>
        </div>
        {err ? <p className="text-12 text-danger">{err}</p> : null}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2.5">
      {note}
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 basis-48 truncate text-13 text-ink">{d.email ? tr("Connected as {email}", { email: d.email }) : tr("Connected")}</span>
        <Button variant="ghost" size="small" disabled={props.busy} onClick={() => void props.act(() => backupApi.driveDisconnect())}>{tr("Disconnect")}</Button>
      </div>
      {d.last ? (
        d.last.error
          ? <p className="text-12 text-danger">{tr("Last copy to Drive failed: {error}", { error: d.last.error })}</p>
          : <p className="text-12 text-ink-muted">{tr("Last copied {when}", { when: new Date(d.last.at).toLocaleString() })}</p>
      ) : null}
      <p className="text-12 text-ink-muted">{tr("Drive keeps the 2 newest daily copies. API keys and sign-ins are not copied.")}</p>
      <div>
        <Button variant="neutral" size="small" disabled={loading} onClick={() => void load()}>{list ? tr("Refresh") : tr("Show backups in Drive")}</Button>
      </div>
      {list ? (
        list.length ? (
          <div className="flex flex-col gap-1.5">
            {list.map((b) => (
              <DriveRow key={b.id} backup={b} me={props.me} busy={props.busy} onRestore={() => void props.act(async () => props.onJob((await backupApi.driveRestore(b.id)).job))} />
            ))}
          </div>
        ) : <p className="text-12 text-ink-muted">{tr("No backups in Drive yet.")}</p>
      ) : null}
      {err ? <p className="text-12 text-danger">{err}</p> : null}
    </div>
  )
}

export function BackupsTab(props: { me: Me }) {
  const state = useResource(() => backupApi.state())
  const [mode, setMode] = useState<"send" | "receive">("send")
  const [keysInFile, setKeysInFile] = useState(false)
  const [uploading, setUploading] = useState<{ sent: number; total: number } | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [err, setErr] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)

  const job = state.data?.job ?? null
  const running = !!job && job.phase !== "done" && job.phase !== "failed"
  const busy = running || !!uploading

  // follow a running job; a finished restore loads the restored account
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void state.refetch(), 1000)
    return () => clearInterval(t)
  }, [running])
  const reloaded = useRef(false)
  useEffect(() => {
    if (job?.phase === "done" && job.kind !== "backup" && !reloaded.current) {
      reloaded.current = true
      setTimeout(() => window.location.reload(), 1200)
    }
  }, [job?.phase, job?.kind])

  const act = async (fn: () => Promise<unknown>) => {
    setErr("")
    try {
      await fn()
    } catch (e) {
      setErr((e as Error).message ?? String(e))
    }
    await state.refetch()
  }
  const upload = async (file: File) => {
    setPendingFile(null)
    setUploading({ sent: 0, total: file.size })
    await act(() => backupApi.upload(file, (sent) => setUploading({ sent, total: file.size })))
    setUploading(null)
  }

  const d = state.data
  return (
    <Pane title={tr("Backups")} description={tr("Your whole account: apps and their data, notes, agent chats and settings.")}>
      <div className="flex flex-col gap-6 pb-4">
        {err ? <div className="rounded-lg border border-danger px-3 py-2 text-13 text-danger">{err}</div> : null}
        {job ? <Progress job={job} /> : null}
        {uploading ? <Progress job={{ kind: "restore", phase: "receiving", done: uploading.sent, total: uploading.total }} /> : null}

        {d ? (
          <Section title={tr("Google Drive")}>
            <DriveSection drive={d.drive} me={props.me.username} busy={busy} act={act} onJob={(j) => state.mutate({ ...d, job: j })} />
          </Section>
        ) : null}

        <Section title={tr("Move to another device")}>
          <div className="flex gap-1.5">
            <Button variant={mode === "send" ? "contrast" : "neutral"} size="small" onClick={() => setMode("send")}>{tr("Send")}</Button>
            <Button variant={mode === "receive" ? "contrast" : "neutral"} size="small" onClick={() => setMode("receive")}>{tr("Receive")}</Button>
          </div>
          {mode === "send" ? <SendPanel /> : props.me.role === "admin" ? (
            <ReceivePanel busy={busy} onJob={(j) => state.mutate(d ? { ...d, job: j } : d)} />
          ) : (
            <p className="text-12 text-ink-muted">{tr("Only an admin can receive an account. You can restore from a file below.")}</p>
          )}
        </Section>

        <Section title={tr("On this device")}>
          {d ? (
            <>
              <Toggle
                label={tr("Back up every day")}
                checked={d.settings.auto}
                disabled={busy}
                onChange={(auto) => void act(() => backupApi.settings(auto, d.settings.keep))}
              />
              <div className="flex items-center gap-2 pl-6">
                <span className="text-13 text-ink-muted">{tr("Daily backups to keep")}</span>
                <select
                  className="rounded-lg border border-line bg-panel px-2 py-1 text-13 text-ink"
                  value={d.settings.keep}
                  disabled={busy}
                  onChange={(e) => void act(() => backupApi.settings(d.settings.auto, Number(e.currentTarget.value)))}
                >
                  {[...new Set([3, 5, 7, 14, 30, d.settings.keep])].sort((a, b) => a - b).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <p className="pl-6 text-12 text-ink-muted">{tr("When there are more, the oldest is deleted. Backups you make with Back up now stay until you delete them.")}</p>
              {d.autoError ? <p className="pl-6 text-12 text-danger">{tr("Last automatic backup failed: {error}", { error: d.autoError })}</p> : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="neutral" size="small" disabled={busy} onClick={() => void act(() => backupApi.create())}>{tr("Back up now")}</Button>
                {d.free !== null ? <span className="text-12 text-ink-muted">{tr("{size} free on this disk", { size: formatBytes(d.free) })}</span> : null}
              </div>
              {d.backups.length ? (
                <div className="flex flex-col gap-1.5">
                  {d.backups.map((b) => (
                    <BackupRow
                      key={b.id}
                      backup={b}
                      busy={busy}
                      onRestore={() => void act(() => backupApi.restore(b.id))}
                      onDelete={() => void act(() => backupApi.remove(b.id))}
                    />
                  ))}
                </div>
              ) : <p className="text-12 text-ink-muted">{tr("No backups yet.")}</p>}
            </>
          ) : <p className="text-13 text-ink-faint">{state.loading ? tr("Loading…") : ""}</p>}
        </Section>

        <Section title={tr("Backup file")}>
          <Toggle label={tr("Include API keys and sign-ins")} checked={keysInFile} disabled={false} onChange={setKeysInFile} />
          <div className="flex flex-wrap gap-2">
            <Button variant="neutral" size="small" onClick={() => window.location.assign(backupApi.exportUrl(keysInFile))}>{tr("Download backup")}</Button>
            <Button variant="neutral" size="small" disabled={busy} onClick={() => fileInput.current?.click()}>{tr("Restore from file")}</Button>
            <input
              ref={fileInput}
              type="file"
              accept=".tar,.tgz,.gz,application/x-tar"
              className="hidden"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0]
                e.currentTarget.value = ""
                if (file) setPendingFile(file)
              }}
            />
          </div>
          {pendingFile ? (
            <div className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
              <p className="text-13 text-ink">{tr("Restore {name} ({size})?", { name: pendingFile.name, size: formatBytes(pendingFile.size) })}</p>
              <p className="text-12 leading-4 text-ink-muted">{tr("Everything in your account here is replaced. A backup of it is kept on this device first.")}</p>
              <div className="flex gap-2">
                <Button variant="danger" size="small" onClick={() => void upload(pendingFile)}>{tr("Replace my account")}</Button>
                <Button variant="ghost" size="small" onClick={() => setPendingFile(null)}>{tr("Cancel")}</Button>
              </div>
            </div>
          ) : null}
        </Section>
      </div>
    </Pane>
  )
}
