/**
 * Sandbox host, loaded by the shell (/client/sandbox/host.js). It owns one
 * sandboxed frame, relays the engine's run requests into it, and keeps the
 * workspace in sync in both directions:
 *
 *   host -> sandbox: the engine's tree is diffed before every run, so files
 *                    the agent edited with the file tools are visible to the
 *                    shell too
 *   sandbox -> host: after every run the VFS manifest is diffed and changed
 *                    files are written back through /v1/sandbox/fs
 *
 * Everything the sandbox can touch is handed to it; it never gets network,
 * host paths, or credentials. A run that outlives its timeout resets the
 * worker (a wedged Python loop cannot be cooperatively cancelled).
 *
 * The engine broadcasts run requests on the user's bus. The host it considers
 * active (most recent heartbeat) is the one addressed by `hostId`; other tabs
 * ignore the request, so exactly one sandbox executes.
 */

declare const __SANDBOX_VERSION__: string;

const VERSION = typeof __SANDBOX_VERSION__ === "string" ? __SANDBOX_VERSION__ : "dev";
const HOST_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
const HEARTBEAT_MS = 15_000;
const READ_BATCH_BYTES = 4 * 1024 * 1024;
const READ_BATCH_FILES = 200;

interface MountFile {
  path: string;
  b64: string;
}

interface SandboxConfig {
  internet: boolean;
  token: string | null;
}

type FrameReply =
  | { t: "hello" }
  | { t: "ready"; version?: string }
  | { t: "reset-done"; id: number }
  | { t: "fatal"; error: string }
  | { t: "mounted"; id: number; count: number }
  | { t: "run-result"; id: number; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }
  | { t: "manifest"; id: number; entries: Record<string, [number, number]> }
  | { t: "read"; id: number; files: MountFile[] }
  | { t: "rm"; id: number; exitCode: number | null }
  | { t: "error"; id?: number; error: string };

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

// ---------- the sandbox frame ----------
class Frame {
  private iframe: HTMLIFrameElement;
  private ready: Promise<void>;
  private waiting = new Map<number, { resolve: (r: FrameReply) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private onMessage: (e: MessageEvent) => void;
  dead = false;

  constructor(config: SandboxConfig) {
    this.iframe = document.createElement("iframe");
    this.iframe.setAttribute("sandbox", "allow-scripts");
    this.iframe.setAttribute("aria-hidden", "true");
    this.iframe.title = "agent sandbox";
    this.iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    let readyOk!: () => void;
    let readyFail!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      readyOk = res;
      readyFail = rej;
    });
    this.onMessage = (e: MessageEvent) => {
      if (e.source !== this.iframe.contentWindow) return;
      const d = e.data as FrameReply & { __chrysalisSandbox?: number };
      if (!d || d.__chrysalisSandbox !== 1) return;
      if (d.t === "hello") this.post({ t: "config", config });
      else if (d.t === "ready") readyOk();
      else if (d.t === "fatal") readyFail(new Error(d.error));
      else if (d.t === "error" && typeof d.id === "number") {
        const w = this.waiting.get(d.id);
        this.waiting.delete(d.id);
        w?.reject(new Error(d.error));
      } else if (typeof (d as { id?: number }).id === "number") {
        const w = this.waiting.get((d as { id: number }).id);
        this.waiting.delete((d as { id: number }).id);
        w?.resolve(d);
      }
    };
    addEventListener("message", this.onMessage);
    this.iframe.src = `/client/sandbox/frame.html?v=${VERSION}`;
    document.body.appendChild(this.iframe);
  }

  private post(m: Record<string, unknown>): void {
    this.iframe.contentWindow?.postMessage({ __chrysalisSandbox: 1, ...m }, "*");
  }

  call(m: Record<string, unknown>, timeoutMs: number): Promise<FrameReply> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("the sandbox stopped responding"));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.post({ ...m, id });
    });
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }

  dispose(): void {
    this.dead = true;
    removeEventListener("message", this.onMessage);
    this.iframe.remove();
  }
}

// ---------- workspace sync ----------
type Manifest = Map<string, [number, number]>;

class Workspace {
  host = new Map<string, [number, number]>();
  vfs: Manifest = new Map();
  ready = false;

  constructor(private frame: Frame) {}

  private frameCall(m: Record<string, unknown>, timeoutMs = 60_000): Promise<FrameReply> {
    return this.frame.call(m, timeoutMs);
  }

  /** Engine-side tree -> Map. */
  private static treeMap(files: { path: string; size: number; mtime: number }[]): Manifest {
    const m: Manifest = new Map();
    for (const f of files) m.set(f.path, [f.size, f.mtime]);
    return m;
  }

  /** Bring the sandbox VFS in line with the engine's tree. Reads only what
   *  changed since the last sync, so the steady-state cost is one tree call. */
  async pull(): Promise<void> {
    const tree = (await api("/v1/sandbox/fs", { method: "POST", body: JSON.stringify({ op: "tree" }) })) as {
      tree?: { files: { path: string; size: number; mtime: number }[]; truncated: boolean };
    };
    const next = Workspace.treeMap(tree.tree?.files ?? []);
    const changed: string[] = [];
    for (const [rel, v] of next) {
      const cur = this.host.get(rel);
      if (!cur || cur[0] !== v[0] || cur[1] !== v[1]) changed.push(rel);
    }
    const removed = [...this.host.keys()].filter((rel) => !next.has(rel));
    this.host = next;
    if (changed.length) await this.readAndMount(changed);
    if (removed.length) await this.frameCall({ t: "rm", paths: removed });
    await this.refreshVfs();
  }

  private async readAndMount(paths: string[]): Promise<void> {
    let batch: string[] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const got = (await api("/v1/sandbox/fs", { method: "POST", body: JSON.stringify({ op: "read", paths: batch }) })) as { files?: MountFile[] };
      const files = got.files ?? [];
      for (let i = 0; i < files.length; i += READ_BATCH_FILES) {
        await this.frameCall({ t: "mount", files: files.slice(i, i + READ_BATCH_FILES) }, 120_000);
      }
      batch = [];
      bytes = 0;
    };
    for (const p of paths) {
      const size = this.host.get(p)?.[0] ?? 0;
      if (bytes + size > READ_BATCH_BYTES && batch.length) await flush();
      batch.push(p);
      bytes += size;
      if (batch.length >= READ_BATCH_FILES) await flush();
    }
    await flush();
  }

  private async refreshVfs(): Promise<void> {
    const r = (await this.frameCall({ t: "manifest" }, 120_000)) as { entries?: Record<string, [number, number]> };
    this.vfs = new Map(Object.entries(r.entries ?? {}));
  }

  /** Initial mount: everything the engine currently has. */
  async mountAll(): Promise<void> {
    await this.refreshVfs();
    const all = [...this.host.keys()];
    await this.readAndMount(all);
    await this.refreshVfs();
    this.ready = true;
  }

  /** Diff the VFS against the last manifest and write changes back. */
  async push(): Promise<void> {
    const r = (await this.frameCall({ t: "manifest" }, 120_000)) as { entries?: Record<string, [number, number]> };
    const next: Manifest = new Map(Object.entries(r.entries ?? {}));
    const changed: string[] = [];
    for (const [rel, v] of next) {
      const cur = this.vfs.get(rel);
      if (!cur || cur[0] !== v[0] || cur[1] !== v[1]) changed.push(rel);
    }
    const removed = [...this.vfs.keys()].filter((rel) => !next.has(rel));
    this.vfs = next;
    if (changed.length) {
      let files: MountFile[] = [];
      let bytes = 0;
      const flush = async (): Promise<void> => {
        if (!files.length) return;
        await api("/v1/sandbox/fs", { method: "PUT", body: JSON.stringify({ op: "write", files }) });
        files = [];
        bytes = 0;
      };
      for (let i = 0; i < changed.length; i += READ_BATCH_FILES) {
        const slice = changed.slice(i, i + READ_BATCH_FILES);
        const got = (await this.frameCall({ t: "read", paths: slice }, 120_000)) as { files?: MountFile[] };
        for (const f of got.files ?? []) {
          const size = f.b64.length;
          if (bytes + size > READ_BATCH_BYTES && files.length) await flush();
          files.push(f);
          bytes += size;
        }
      }
      await flush();
    }
    if (removed.length) {
      await api("/v1/sandbox/fs", { method: "PUT", body: JSON.stringify({ op: "delete", paths: removed }) });
    }
  }
}

// ---------- the running host ----------
let frame: Frame | null = null;
let workspace: Workspace | null = null;
let booting: Promise<void> | null = null;
let warming: Promise<void> | null = null;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let ready = false;
let queue: Promise<void> = Promise.resolve();
/** The config the live frame's worker was booted with. */
let frameConfig: SandboxConfig | null = null;
let beats = 0;

function beat(): void {
  void api("/v1/sandbox/host", { method: "POST", body: JSON.stringify({ host: HOST_ID, ready }) }).catch(() => {
    /* logged out or engine restarting — the next beat retries */
  });
  // the token is baked into the worker at boot; pick up a changed one
  if (++beats % 4 === 0) refreshFrameConfig();
}

/** Rebuild the frame when the engine's config changes underneath it (a
 *  rotated signing key, or a restart that lost an old-style token). */
function refreshFrameConfig(): void {
  if (!frame || frame.dead) return;
  void sandboxConfig().then((cfg) => {
    if (!frame || frame.dead || cfg.token === frameConfig?.token) return;
    queue = queue
      .then(async () => {
        if (!frame || frame.dead || cfg.token === frameConfig?.token) return;
        await frame.call({ t: "reset", config: cfg }, 30_000);
        frameConfig = cfg;
        if (workspace) workspace.ready = false;
        ready = false;
        beat();
      })
      .catch(() => undefined);
  }, () => undefined);
}

function startHeartbeat(): void {
  if (heartbeat) return;
  beat();
  heartbeat = setInterval(beat, HEARTBEAT_MS);
}

/** Boot the frame and mount the workspace in the background, so the first
 *  command the agent runs does not pay for it. */
function warm(): Promise<void> {
  if (!warming) {
    warming = (async () => {
      const { workspace: ws } = await ensureFrame();
      if (!ws.ready) {
        await ws.mountAll();
        ready = true;
        beat();
      }
    })().catch(() => {
      warming = null;
    });
  }
  return warming;
}

async function ensureFrame(): Promise<{ frame: Frame; workspace: Workspace }> {
  if (frame && workspace && !frame.dead) return { frame, workspace };
  if (!booting) {
    booting = (async () => {
      const cfg = await sandboxConfig();
      const f = new Frame(cfg);
      await f.whenReady();
      frame = f;
      frameConfig = cfg;
      workspace = new Workspace(f);
      ready = false;
      startHeartbeat();
    })().catch((e) => {
      booting = null;
      throw e;
    });
  }
  await booting;
  return { frame: frame!, workspace: workspace! };
}

/** Internet access and the proxy token, fetched fresh for every frame. */
async function sandboxConfig(): Promise<SandboxConfig> {
  try {
    const r = (await api("/v1/sandbox/config")) as Partial<SandboxConfig>;
    return { internet: r.internet === true, token: typeof r.token === "string" ? r.token : null };
  } catch {
    return { internet: false, token: null };
  }
}

function result(id: unknown, r: Record<string, unknown>): void {
  void api("/v1/sandbox/result", { method: "POST", body: JSON.stringify({ id, ...r }) }).catch(() => {
    /* the engine moved on */
  });
}

/** True while a frame call is in flight so a hard-limit reset does not race
 *  a run that is merely slow: changes must reach disk even when the tool
 *  already answered "timed out". */
const HARD_LIMIT_EXTRA = 120_000;

async function execute(id: unknown, command: string, timeoutMs: number): Promise<void> {
  await warm();
  const { frame: f, workspace: ws } = await ensureFrame();
  if (!ws.ready) {
    await ws.mountAll();
    ready = true;
    beat();
  } else {
    await ws.pull();
  }
  let gaveUp = false;
  const hard = timeoutMs + HARD_LIMIT_EXTRA;
  const timer = setTimeout(() => {
    if (gaveUp) return;
    gaveUp = true;
    void f.call({ t: "reset" }, 10_000).catch(() => undefined);
    ws.ready = false;
    ready = false;
    result(id, { exitCode: null, stdout: "", stderr: "The command was stopped: it ran past the time limit.", timedOut: true, truncated: false });
  }, hard);
  try {
    const r = (await f.call({ t: "run", command, timeoutMs }, hard + 10_000)) as Extract<FrameReply, { t: "run-result" }>;
    // sync even when the engine already answered "timed out": the command's
    // file changes are still the user's
    await ws.push();
    if (gaveUp) return;
    gaveUp = true;
    clearTimeout(timer);
    result(id, { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, truncated: r.truncated });
  } catch (e) {
    if (gaveUp) return;
    gaveUp = true;
    clearTimeout(timer);
    // the worker may be wedged: rebuild it and remount on the next run
    void f.call({ t: "reset" }, 10_000).catch(() => undefined);
    ws.ready = false;
    ready = false;
    result(id, { exitCode: null, stdout: "", stderr: String((e as Error).message ?? e), timedOut: false, truncated: false });
  }
}

const listener: BusListener = (type, payload) => {
  if (type === "sandbox_config_changed") {
    // the runtime takes its host list once, at boot: a changed setting needs
    // a fresh worker, and the workspace is mounted again on the next run
    queue = queue.then(async () => {
      if (!frame || frame.dead || !workspace) return;
      const cfg = await sandboxConfig();
      await frame.call({ t: "reset", config: cfg }, 30_000);
      frameConfig = cfg;
      workspace.ready = false;
      ready = false;
      beat();
    }).catch(() => undefined);
    return;
  }
  if (type !== "sandbox_run") return;
  if (payload.host !== HOST_ID) return;
  const id = payload.id;
  if (typeof id !== "string" || typeof payload.command !== "string") return;
  const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 120_000;
  queue = queue.then(() => execute(id, payload.command as string, timeoutMs)).catch(() => undefined);
};

busListeners.add(listener);

// The sandbox boot is heavy (Pyodide + a full workspace mount) and must not
// compete with the shell and the open app for the first seconds: warm on idle.
const scheduleWarm = () => {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(() => void warm(), { timeout: 8000 });
  else setTimeout(() => void warm(), 4000);
};

// This script loads on every page, the sign-in screen included. Booting there
// downloaded the whole wasm runtime (Pyodide, the stdlib, micropip) for a
// shell a signed-out visitor cannot use, and heartbeated 401s for as long as
// the tab stayed open. The bus only connects with a session, so its hello is
// the signal that there is someone to boot for.
let started = false;
const startOnce = (): void => {
  if (started) return;
  started = true;
  startHeartbeat();
  // the script tag lives in <head>: wait for a body before mounting a frame
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", scheduleWarm, { once: true });
  else scheduleWarm();
};
busListeners.add((type) => {
  if (type === "hello") startOnce();
});
ensureBus();

(window as unknown as { ChrysalisSandbox: unknown }).ChrysalisSandbox = { version: VERSION, host: HOST_ID };
