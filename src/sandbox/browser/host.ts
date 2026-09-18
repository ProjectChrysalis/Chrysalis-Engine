/**
 * Sandbox host, loaded by the shell (/client/sandbox/host.js). It owns the
 * workspace sync and drives the wasm sandbox runtime directly in a worker:
 * no iframe, no SharedArrayBuffer, no COOP/COEP. Before every run it pulls
 * changed files from the engine, passes the workspace into the runtime, and
 * writes changed files back after.
 *
 * The runtime is served with the sandbox files under /client/sandbox/k/.
 */

declare const __SANDBOX_VERSION__: string;

const VERSION = typeof __SANDBOX_VERSION__ === "string" ? __SANDBOX_VERSION__ : "dev";
const HOST_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
const HEARTBEAT_MS = 15_000;
const EXEC_WORKER_URL = "/client/sandbox/k/runtime/exec-worker.mjs";

interface SandboxConfig {
  internet: boolean;
  token: string | null;
}

interface ExecReply {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  files: Record<string, Uint8Array>;
  scratch: Record<string, Uint8Array>;
  wallMs: number;
}

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

// ---------- workspace sync ----------
type Meta = [number, number];

class Workspace {
  private host = new Map<string, Meta>();
  private files = new Map<string, Uint8Array>();
  ready = false;

  /** Engine-side tree -> local contents map. Reads only what changed. */
  async pull(): Promise<void> {
    const tree = (await api("/v1/sandbox/fs", { method: "POST", body: JSON.stringify({ op: "tree" }) })) as {
      tree?: { files: { path: string; size: number; mtime: number }[]; truncated: boolean };
    };
    const next = new Map<string, Meta>();
    for (const f of tree.tree?.files ?? []) next.set(f.path, [f.size, f.mtime]);
    const changed: string[] = [];
    for (const [rel, meta] of next) {
      const cur = this.host.get(rel);
      if (!cur || cur[0] !== meta[0] || cur[1] !== meta[1]) changed.push(rel);
    }
    const removed = [...this.host.keys()].filter((rel) => !next.has(rel));
    this.host = next;
    for (const rel of removed) this.files.delete(rel);
    if (changed.length) await this.readBatches(changed);
    this.ready = true;
  }

  private async readBatches(paths: string[]): Promise<void> {
    const READ_BATCH_FILES = 200;
    for (let i = 0; i < paths.length; i += READ_BATCH_FILES) {
      const batch = paths.slice(i, i + READ_BATCH_FILES);
      const got = (await api("/v1/sandbox/fs", { method: "POST", body: JSON.stringify({ op: "read", paths: batch }) })) as {
        files?: { path: string; b64: string }[];
      };
      for (const f of got.files ?? []) this.files.set(f.path, b64ToBytes(f.b64));
    }
  }

  /** Runtime result -> engine. Writes changed files, deletes removed ones. */
  async push(result: Record<string, Uint8Array>): Promise<void> {
    const writes: { path: string; b64: string }[] = [];
    for (const [rel, bytes] of Object.entries(result)) {
      const cur = this.files.get(rel);
      if (cur && bytesEqual(cur, bytes)) continue;
      this.files.set(rel, bytes);
      writes.push({ path: rel, b64: bytesToB64(bytes) });
    }
    const deletes: string[] = [];
    for (const rel of [...this.files.keys()]) {
      if (rel in result) continue;
      this.files.delete(rel);
      deletes.push(rel);
    }
    const WRITE_BATCH = 200;
    for (let i = 0; i < writes.length; i += WRITE_BATCH) {
      await api("/v1/sandbox/fs", { method: "PUT", body: JSON.stringify({ op: "write", files: writes.slice(i, i + WRITE_BATCH) }) });
    }
    for (let i = 0; i < deletes.length; i += WRITE_BATCH) {
      await api("/v1/sandbox/fs", { method: "PUT", body: JSON.stringify({ op: "delete", paths: deletes.slice(i, i + WRITE_BATCH) }) });
    }
  }

  contents(): Record<string, Uint8Array> {
    return Object.fromEntries(this.files);
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------- the running host ----------
let workspace: Workspace | null = null;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let ready = false;
let queue: Promise<void> = Promise.resolve();

function beat(): void {
  void api("/v1/sandbox/host", { method: "POST", body: JSON.stringify({ host: HOST_ID, ready, version: VERSION }) }).catch(() => {
    /* logged out or engine restarting — the next beat retries */
  });
}

function startHeartbeat(): void {
  if (heartbeat) return;
  beat();
  heartbeat = setInterval(beat, HEARTBEAT_MS);
}

// ---------- the sandbox worker ----------
// Commands go to the runtime behind a worker boundary: the engine's page
// never imports or links it, so the sandbox stays a separate program.
let execWorker: Worker | null = null;
let execSeq = 0;
const execPending = new Map<number, (reply: ExecReply) => void>();
/** /tmp handoff between commands: the engine only syncs /workspace, so the
 *  host carries scratch files itself while the tab lives. */
let scratch: Record<string, Uint8Array> = {};

function execWorkerHandle(): Worker {
  if (execWorker) return execWorker;
  const worker = new Worker(EXEC_WORKER_URL, { type: "module" });
  worker.onmessage = (event: MessageEvent) => {
    const reply = event.data as { type?: string; id?: number };
    if (reply?.type !== "result" || typeof reply.id !== "number") return;
    const settle = execPending.get(reply.id);
    execPending.delete(reply.id);
    settle?.(reply as unknown as ExecReply);
  };
  worker.onerror = (event: ErrorEvent) => {
    for (const [id, settle] of execPending) {
      execPending.delete(id);
      settle({ exitCode: null, stdout: "", stderr: `sandbox worker failed: ${event.message || "script error"}`, files: {}, scratch, wallMs: 0 });
    }
    execWorker = null;
  };
  execWorker = worker;
  return worker;
}

function runInWorker(command: string, files: Record<string, Uint8Array>, gitProxy?: string): Promise<ExecReply> {
  return new Promise((resolve) => {
    const id = ++execSeq;
    execPending.set(id, resolve);
    try {
      execWorkerHandle().postMessage({ type: "exec", id, command, files, scratch, gitProxy });
    } catch (error) {
      execPending.delete(id);
      resolve({ exitCode: null, stdout: "", stderr: `sandbox worker refused the run: ${(error as Error)?.message ?? error}`, files: {}, scratch, wallMs: 0 });
    }
  });
}

/** Boot = pull the workspace once; the runtime has no persistent state. */
function warm(): Promise<void> {
  if (!workspace) {
    workspace = new Workspace();
    void (async () => {
      await workspace!.pull();
      ready = true;
      beat();
    })().catch(() => {
      workspace = null;
    });
  }
  return workspace.ready ? Promise.resolve() : (async () => {
    while (workspace && !workspace.ready) await new Promise((r) => setTimeout(r, 100));
  })();
}

function result(id: unknown, r: Record<string, unknown>): void {
  void api("/v1/sandbox/result", { method: "POST", body: JSON.stringify({ id, ...r }) }).catch(() => {
    /* the engine moved on */
  });
}

/** The mount for one command: a packed repo's object database is tens of MB,
 *  so only git commands carry it. */
function contentsFor(command: string): Record<string, Uint8Array> {
  const all = workspace!.contents();
  if (/(^|[\s|&;(])git(\s|$)/.test(command)) return all;
  const out: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(all)) {
    if (path === ".git" || path.startsWith(".git/")) continue;
    out[path] = bytes;
  }
  return out;
}

async function execute(id: unknown, command: string, _timeoutMs: number): Promise<void> {
  if (!workspace) {
    workspace = new Workspace();
    await workspace.pull();
    ready = true;
    beat();
  } else {
    await workspace.pull();
  }
  const cfg = await sandboxConfig();
  const gitProxy = cfg.token ? `${location.origin}/v1/sandbox/proxy?token=${encodeURIComponent(cfg.token)}&url=` : undefined;
  const out = await runInWorker(command, contentsFor(command), gitProxy);
  scratch = out.scratch ?? {};
  try {
    await workspace.push(out.files);
  } catch (e) {
    result(id, { exitCode: out.exitCode, stdout: out.stdout, stderr: `${out.stderr}${out.stderr ? "\n" : ""}sync back failed: ${String((e as Error)?.message ?? e)}`, timedOut: false, truncated: false });
    return;
  }
  result(id, { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr, timedOut: false, truncated: false });
}

/** Network access and the proxy token, fetched fresh for every run. */
async function sandboxConfig(): Promise<SandboxConfig> {
  try {
    const r = (await api("/v1/sandbox/config")) as Partial<SandboxConfig>;
    return { internet: r.internet === true, token: typeof r.token === "string" ? r.token : null };
  } catch {
    return { internet: false, token: null };
  }
}

const listener: BusListener = (type, payload) => {
  if (type !== "sandbox_run") return;
  if (payload.host !== HOST_ID) return;
  const id = payload.id;
  if (typeof id !== "string" || typeof payload.command !== "string") return;
  const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 120_000;
  queue = queue.then(() => execute(id, payload.command as string, timeoutMs)).catch(() => undefined);
};

busListeners.add(listener);

// The runtime boot (worker + 368KB wasm) must not compete with the shell and
// the open app for the first seconds: warm on idle.
const scheduleWarm = () => {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(() => void warm(), { timeout: 8000 });
  else setTimeout(() => void warm(), 4000);
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

(window as unknown as { ChrysalisSandbox: unknown }).ChrysalisSandbox = { version: VERSION, host: HOST_ID };
