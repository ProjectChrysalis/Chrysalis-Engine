/**
 * Sandbox host, loaded by the shell (/client/sandbox/host.js). It is the
 * broker between the engine and the sandbox frame: it lists the workspace,
 * tells the runtime what changed since its last command, hands it the
 * tokens it fetches with, enforces the time limit, and writes the files a
 * command changed back through the engine.
 *
 * Commands run in /client/sandbox/frame.html: a sandboxed, opaque-origin
 * frame with no cookies and no storage, whose worker hosts the runtime. The
 * runtime keeps its filesystem between commands and reads file contents on
 * first use, so a command costs only what it touches. A command that runs
 * past its limit takes the frame down with it; the next one starts a fresh
 * frame from the workspace on disk.
 */

declare const __SANDBOX_VERSION__: string;
import { abortable } from "../../cancellation.js";

const VERSION = typeof __SANDBOX_VERSION__ === "string" ? __SANDBOX_VERSION__ : "dev";
const HOST_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
const HEARTBEAT_MS = 15_000;
/** Files at most this big ride a batched JSON write; larger ones go raw. */
const INLINE_WRITE = 1024 * 1024;
const BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_FILES = 200;

interface SandboxConfig {
  internet: boolean;
  token: string | null;
  fsToken: string | null;
  hidden: string[];
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  writes: [string, Uint8Array][];
  deletes: string[];
  runtime?: string | null;
}

interface PathResult {
  path: string;
  ok: boolean;
  size?: number;
  mtime?: number;
  error?: string;
}

type Meta = [number, number];

const api = (path: string, init?: RequestInit) =>
  fetch(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers as Record<string, string> | undefined) } }).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((body as { error?: string }).error ?? `${path}: ${r.status}`);
    return body;
  });

// ---------- engine event stream (one per page) ----------
type BusListener = (type: string, payload: Record<string, unknown>) => void;
const busListeners = new Set<BusListener>();
let bus: WebSocket | null = null;
function ensureBus(): void {
  if (bus) return;
  const open = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/ws`);
    bus = ws;
    ws.onmessage = (ev) => {
      try {
        const f = JSON.parse(String(ev.data)) as { type?: string; payload?: Record<string, unknown> };
        if (typeof f.type === "string") for (const l of busListeners) l(f.type, f.payload ?? {});
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => setTimeout(open, 1500);
  };
  open();
}

// ---------- the frame ----------
class SandboxFrame {
  private iframe: HTMLIFrameElement;
  private port: MessagePort | null = null;
  private onWindowMessage: (e: MessageEvent) => void;
  private waiting = new Map<number, (r: RunResult | { fatal: string }) => void>();
  private seq = 0;
  private rejectReady!: (error: Error) => void;
  /** Resolves with the runtime version once it can run commands. */
  ready: Promise<string | null>;
  dead = false;
  /** What this frame's runtime has been told about the workspace. */
  known = new Map<string, Meta>();
  fresh = true;

  constructor() {
    let ok!: (v: string | null) => void;
    let fail!: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      ok = res;
      fail = rej;
      this.rejectReady = rej;
    });
    this.ready.catch(() => {});
    this.iframe = document.createElement("iframe");
    this.iframe.setAttribute("sandbox", "allow-scripts");
    this.iframe.setAttribute("aria-hidden", "true");
    this.iframe.title = "agent sandbox";
    this.iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    this.onWindowMessage = (e: MessageEvent) => {
      if (e.source !== this.iframe.contentWindow || this.port) return;
      const d = e.data as { __chrysalisSandbox?: number; t?: string } | null;
      if (d?.__chrysalisSandbox !== 1 || d.t !== "loaded") return;
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = (m: MessageEvent) => {
        const msg = m.data as { type?: string; id?: number; runtime?: string | null; error?: string };
        if (msg?.type === "ready") ok(msg.runtime ?? null);
        else if (msg?.type === "fatal") {
          fail(new Error(msg.error ?? "the sandbox runtime did not start"));
          for (const settle of this.waiting.values()) settle({ fatal: msg.error ?? "the sandbox runtime stopped" });
          this.waiting.clear();
          this.dispose();
        } else if (msg?.type === "result" && typeof msg.id === "number") {
          this.waiting.get(msg.id)?.(msg as unknown as RunResult);
          this.waiting.delete(msg.id);
        }
      };
      // the frame is opaque-origin: "*" is the only target it can have, and
      // this one message carries nothing but the private channel
      this.iframe.contentWindow?.postMessage({ __chrysalisSandbox: 1, t: "init" }, "*", [channel.port2]);
    };
    addEventListener("message", this.onWindowMessage);
    this.iframe.src = `/client/sandbox/frame.html?v=${VERSION}`;
    document.body.appendChild(this.iframe);
  }

  exec(message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<RunResult | { fatal: string } | { timedOut: true }> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const cancel = () => {
        this.waiting.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.dispose();
        resolve({ fatal: "Command stopped" });
      };
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        signal?.removeEventListener("abort", cancel);
        // a synchronous guest can only be stopped by ending its worker
        this.dispose();
        resolve({ timedOut: true });
      }, timeoutMs);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        resolve(r);
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      this.port?.postMessage({ ...message, type: "exec", id });
    });
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.rejectReady(new Error("Sandbox stopped"));
    for (const settle of this.waiting.values()) settle({ fatal: "Sandbox stopped" });
    this.waiting.clear();
    removeEventListener("message", this.onWindowMessage);
    this.port?.close();
    this.iframe.remove();
  }
}

// ---------- the running host ----------
let frame: SandboxFrame | null = null;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let ready = false;
let runtime: string | null = null;
/** Why the runtime did not start, for the engine to pass on. */
let bootError: string | null = null;
let queue: Promise<void> = Promise.resolve();
const commands = new Map<string, AbortController>();
let executingId: string | null = null;
/** Paths whose sync-back was refused: the next command resends the engine's
 *  copy (or its absence) so the runtime stops holding a change that did not
 *  land. */
const refused = new Set<string>();

function beat(): void {
  void api("/v1/sandbox/host", { method: "POST", body: JSON.stringify({ host: HOST_ID, ready, version: VERSION, ...(bootError ? { error: bootError } : {}) }) }).catch(() => {
    /* logged out or engine restarting — the next beat retries */
  });
}

function startHeartbeat(): void {
  if (heartbeat) return;
  beat();
  heartbeat = setInterval(beat, HEARTBEAT_MS);
  // a reload or a closed tab would otherwise stay the addressed host until
  // its heartbeat expired, and every command sent meanwhile would wait it out
  addEventListener("pagehide", () => {
    navigator.sendBeacon("/v1/sandbox/host", new Blob([JSON.stringify({ host: HOST_ID, gone: true })], { type: "application/json" }));
  });
}

function publish(): void {
  (window as unknown as { ChrysalisSandbox: unknown }).ChrysalisSandbox = { version: VERSION, host: HOST_ID, runtime };
}

/** The frame to run in, started (and waited for) when there is none. */
async function liveFrame(): Promise<SandboxFrame> {
  if (!frame || frame.dead) frame = new SandboxFrame();
  const f = frame;
  try {
    runtime = await f.ready;
  } catch (e) {
    bootError = (e as Error).message;
    beat();
    throw e;
  }
  bootError = null;
  publish();
  if (!ready) {
    ready = true;
    beat();
  }
  return f;
}

async function listTree(): Promise<{ files: Map<string, Meta>; truncated: boolean }> {
  const body = (await api("/v1/sandbox/fs", { method: "POST", body: JSON.stringify({ op: "tree" }) })) as {
    tree?: { files: { path: string; size: number; mtime: number }[]; truncated: boolean };
  };
  const files = new Map<string, Meta>();
  for (const f of body.tree?.files ?? []) files.set(f.path, [f.size, f.mtime]);
  return { files, truncated: body.tree?.truncated === true };
}

async function sandboxConfig(): Promise<SandboxConfig> {
  try {
    const r = (await api("/v1/sandbox/config")) as Partial<SandboxConfig>;
    return {
      internet: r.internet === true,
      token: typeof r.token === "string" ? r.token : null,
      fsToken: typeof r.fsToken === "string" ? r.fsToken : null,
      hidden: Array.isArray(r.hidden) ? r.hidden.filter((h): h is string => typeof h === "string") : [],
    };
  } catch {
    return { internet: false, token: null, fsToken: null, hidden: [] };
  }
}

/** What the runtime must learn before this command: everything, for a new
 *  frame; otherwise only what changed on disk since it last looked. */
function syncFor(f: SandboxFrame, tree: Map<string, Meta>): { files: [string, number, number][]; deletes: string[]; reset?: boolean } {
  const files: [string, number, number][] = [];
  const deletes: string[] = [];
  const reset = f.fresh;
  for (const [path, meta] of tree) {
    const had = f.known.get(path);
    if (reset || refused.has(path) || !had || had[0] !== meta[0] || had[1] !== meta[1]) files.push([path, meta[0], meta[1]]);
  }
  if (!reset) for (const path of f.known.keys()) if (!tree.has(path)) deletes.push(path);
  for (const path of refused) if (!tree.has(path) && !deletes.includes(path)) deletes.push(path);
  refused.clear();
  f.known = new Map(tree);
  f.fresh = false;
  return reset ? { files, deletes, reset: true } : { files, deletes };
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Write a command's changes; returns one line per path that did not land. */
async function syncBack(f: SandboxFrame, writes: [string, Uint8Array][], deletes: string[], signal?: AbortSignal): Promise<string[]> {
  const results: PathResult[] = [];
  const failed = (paths: string[], error: string) => {
    for (const path of paths) results.push({ path, ok: false, error });
  };
  let batch: { path: string; b64: string }[] = [];
  let batchBytes = 0;
  const flush = async () => {
    signal?.throwIfAborted();
    if (!batch.length) return;
    const sending = batch;
    batch = [];
    batchBytes = 0;
    try {
      const r = (await api("/v1/sandbox/fs", { method: "PUT", signal, body: JSON.stringify({ op: "write", files: sending }) })) as { results?: PathResult[] };
      results.push(...(r.results ?? []));
    } catch (e) {
      signal?.throwIfAborted();
      failed(sending.map((s) => s.path), (e as Error).message);
    }
  };
  for (const [path, bytes] of writes) {
    signal?.throwIfAborted();
    if (bytes.length > INLINE_WRITE) {
      try {
        const r = await fetch(`/v1/sandbox/fs/file?path=${encodeURIComponent(path)}`, { method: "PUT", credentials: "same-origin", signal, body: bytes as BodyInit });
        const body = (await r.json().catch(() => ({}))) as { results?: PathResult[]; error?: string };
        if (!r.ok) failed([path], body.error ?? `HTTP ${r.status}`);
        else results.push(...(body.results ?? []));
      } catch (e) {
        signal?.throwIfAborted();
        failed([path], (e as Error).message);
      }
      continue;
    }
    if (batch.length >= BATCH_FILES || batchBytes + bytes.length > BATCH_BYTES) await flush();
    batch.push({ path, b64: bytesToB64(bytes) });
    batchBytes += bytes.length;
  }
  await flush();
  for (let i = 0; i < deletes.length; i += BATCH_FILES) {
    signal?.throwIfAborted();
    const slice = deletes.slice(i, i + BATCH_FILES);
    try {
      const r = (await api("/v1/sandbox/fs", { method: "PUT", signal, body: JSON.stringify({ op: "delete", paths: slice }) })) as { results?: PathResult[] };
      results.push(...(r.results ?? []));
    } catch (e) {
      signal?.throwIfAborted();
      failed(slice, (e as Error).message);
    }
  }
  const notes: string[] = [];
  for (const r of results) {
    if (r.ok && typeof r.size === "number" && typeof r.mtime === "number") f.known.set(r.path, [r.size, r.mtime]);
    else if (r.ok) f.known.delete(r.path);
    else {
      refused.add(r.path);
      notes.push(`${r.path}: ${r.error ?? "not saved"}`);
    }
  }
  return notes;
}

function result(id: unknown, r: Record<string, unknown>): void {
  void api("/v1/sandbox/result", { method: "POST", body: JSON.stringify({ id, ...r }) }).catch(() => {
    /* the engine moved on */
  });
}

async function execute(id: string, command: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  let f: SandboxFrame;
  let tree: { files: Map<string, Meta>; truncated: boolean };
  let cfg: SandboxConfig;
  try {
    [f, tree, cfg] = await abortable(Promise.all([liveFrame(), listTree(), sandboxConfig()]), signal);
  } catch (e) {
    frame?.dispose();
    frame = null;
    result(id, { exitCode: null, stdout: "", stderr: `sandbox: ${(e as Error).message}. Reload the page if this keeps happening.`, timedOut: false, truncated: false });
    return;
  }
  const origin = location.origin;
  const message = {
    command,
    sync: syncFor(f, tree.files),
    config: {
      fileUrl: `${origin}/v1/sandbox/file?token=${encodeURIComponent(cfg.fsToken ?? "")}&path=`,
      proxy: cfg.internet && cfg.token ? `${origin}/v1/sandbox/proxy?token=${encodeURIComponent(cfg.token)}&url=` : null,
      hidden: cfg.hidden,
    },
  };
  signal.throwIfAborted();
  const out = await f.exec(message, timeoutMs, signal);
  if ("timedOut" in out) {
    frame = null;
    result(id, {
      exitCode: null,
      stdout: "",
      stderr: `The command ran past its ${Math.round(timeoutMs / 1000)}s limit and was stopped. Its file changes were discarded, and so were files in /tmp.`,
      timedOut: true,
      truncated: false,
    });
    return;
  }
  if ("fatal" in out) {
    frame = null;
    result(id, { exitCode: null, stdout: "", stderr: `sandbox: ${out.fatal}`, timedOut: false, truncated: false });
    return;
  }
  signal.throwIfAborted();
  const notes = await syncBack(f, out.writes ?? [], out.deletes ?? [], signal);
  let stderr = out.stderr;
  if (notes.length) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}sandbox: these changes were not saved to your files:\n${notes.map((n) => `  ${n}`).join("\n")}\n`;
  if (tree.truncated) stderr += "sandbox: the workspace has more files than the sandbox lists; some are not visible here.\n";
  result(id, { exitCode: out.exitCode, stdout: out.stdout, stderr, timedOut: false, truncated: false });
}

const listener: BusListener = (type, payload) => {
  if (payload.host !== HOST_ID) return;
  const id = payload.id;
  if (typeof id !== "string") return;
  if (type === "sandbox_cancel") {
    commands.get(id)?.abort();
    if (executingId === id) { frame?.dispose(); frame = null; }
    return;
  }
  if (type !== "sandbox_run" || typeof payload.command !== "string") return;
  const controller = new AbortController();
  commands.set(id, controller);
  const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 120_000;
  queue = queue.then(async () => {
    if (controller.signal.aborted) return;
    executingId = id;
    try { await execute(id, payload.command as string, timeoutMs, controller.signal); }
    finally { executingId = null; }
  }).catch(() => undefined).finally(() => commands.delete(id));
};

busListeners.add(listener);

// Starting the runtime (a worker and a few MB of wasm) must not compete with
// the shell and the open app for the first seconds: start on idle.
const scheduleWarm = () => {
  const warm = () => void liveFrame().catch(() => undefined);
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(warm, { timeout: 8000 });
  else setTimeout(warm, 4000);
};

// This script loads on every page, the sign-in screen included. The bus only
// connects with a session, so its hello is the signal that there is someone
// to boot for.
let started = false;
const startOnce = (): void => {
  if (started) return;
  started = true;
  startHeartbeat();
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", scheduleWarm, { once: true });
  else scheduleWarm();
};
busListeners.add((type) => {
  if (type === "hello") startOnce();
});
ensureBus();
publish();
