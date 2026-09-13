/**
 * Builder host, loaded by the shell and the standalone app page
 * (/client/builder/host.js). For each app on screen it keeps a sandboxed
 * builder frame (/client/builder/frame.html), relays that frame's file reads
 * to the engine for that one app, uploads the output, and holds the app's
 * build lease so only one tab builds at a time.
 *
 * The frame is untrusted (a Tailwind plugin is app code and runs there), so
 * every message from it is shape-checked and bound to the app this host
 * chose; it can never name another app or reach anything but the file route.
 */

declare const __BUILDER_VERSION__: string;

interface BuildMessage {
  text: string;
  file?: string;
  line?: number;
  column?: number;
  lineText?: string;
}

export interface BuildStatus {
  phase: "checking" | "building" | "ready" | "error" | "waiting";
  message?: string;
  errors?: BuildMessage[];
}

interface ServerStatus {
  rev: string;
  needsBuild: boolean;
  buildable: boolean;
  status: { rev?: string; ok?: boolean; mode?: string; errors?: BuildMessage[] } | null;
  dev: unknown;
}

const VERSION = typeof __BUILDER_VERSION__ === "string" ? __BUILDER_VERSION__ : "dev";
const BUILD_TIMEOUT = 5 * 60_000;
const READ_BUDGET = 1536 * 1024 * 1024;
/** Seconds a BUSY lease may block a build before this tab forces it over.
 *  Idle leases yield at once (see takeLease), so this only caps a build that
 *  never finishes; the frame's own timeout is five minutes. */
const TAKEOVER_AFTER_S = 120;

let wasmBytes: Promise<ArrayBuffer> | null = null;
const wasm = () =>
  (wasmBytes ??= fetch(`/client/builder/esbuild.wasm?v=${VERSION}`).then((r) => {
    if (!r.ok) throw new Error(`esbuild.wasm: ${r.status}`);
    return r.arrayBuffer();
  }));

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

class BuilderFrame {
  private iframe: HTMLIFrameElement;
  private ready: Promise<void>;
  private waiting = new Map<number, (out: Record<string, unknown>) => void>();
  private nextId = 0;
  private bytes = 0;
  private onMessage: (e: MessageEvent) => void;
  dead = false;

  constructor(private appId: string, prior: unknown) {
    this.iframe = document.createElement("iframe");
    this.iframe.setAttribute("sandbox", "allow-scripts");
    this.iframe.setAttribute("aria-hidden", "true");
    this.iframe.title = "app builder";
    this.iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    let loaded!: () => void;
    let readyOk!: () => void;
    let readyFail!: (e: Error) => void;
    const loadedP = new Promise<void>((r) => (loaded = r));
    this.ready = new Promise<void>((res, rej) => {
      readyOk = res;
      readyFail = rej;
    });
    this.onMessage = (e: MessageEvent) => {
      if (e.source !== this.iframe.contentWindow) return;
      const d = e.data as { __chrysalisBuilder?: number; t?: string; rid?: unknown; ops?: unknown; id?: unknown; output?: unknown; error?: unknown; text?: unknown };
      if (!d || d.__chrysalisBuilder !== 1) return;
      if (d.t === "loaded") loaded();
      else if (d.t === "ready") readyOk();
      else if (d.t === "fatal") readyFail(new Error(String(d.error)));
      else if (d.t === "log") console.warn(`[builder:${appId}]`, String(d.text).slice(0, 4000));
      else if (d.t === "fs" && typeof d.rid === "number" && Array.isArray(d.ops)) void this.relay(d.rid, d.ops);
      else if (d.t === "result" && typeof d.id === "number" && d.output && typeof d.output === "object") {
        this.waiting.get(d.id)?.(d.output as Record<string, unknown>);
        this.waiting.delete(d.id);
      }
    };
    addEventListener("message", this.onMessage);
    this.iframe.src = `/client/builder/frame.html?v=${VERSION}`;
    document.body.appendChild(this.iframe);
    void (async () => {
      try {
        const [bytes] = await Promise.all([wasm(), loadedP]);
        const copy = bytes.slice(0);
        this.post({ t: "init", wasm: copy, prior }, [copy]);
      } catch (e) {
        readyFail(e as Error);
      }
    })();
  }

  private post(m: Record<string, unknown>, transfer: Transferable[] = []): void {
    // the frame is opaque-origin: "*" is the only target it can have, and
    // nothing secret is ever sent to it
    this.iframe.contentWindow?.postMessage({ __chrysalisBuilder: 1, ...m }, "*", transfer);
  }

  private async relay(rid: number, ops: unknown[]): Promise<void> {
    let results: unknown[];
    if (this.bytes > READ_BUDGET) {
      results = ops.map(() => ({ ok: false, error: "the build read too much" }));
    } else {
      try {
        const body = (await api(`/v1/apps/${encodeURIComponent(this.appId)}/build/fs`, { method: "POST", body: JSON.stringify({ ops: ops.slice(0, 1000) }) })) as { results?: unknown[] };
        results = body.results ?? [];
        for (const r of results) {
          const x = r as { text?: string; b64?: string };
          this.bytes += (x.text?.length ?? 0) + (x.b64?.length ?? 0);
        }
      } catch (e) {
        results = ops.map(() => ({ ok: false, error: String((e as Error).message) }));
      }
    }
    this.post({ t: "fs-result", rid, results });
  }

  async build(kind: string, changed: string[] = []): Promise<Record<string, unknown>> {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        this.dispose();
        reject(new Error("the build took too long and was stopped"));
      }, BUILD_TIMEOUT);
      this.waiting.set(id, (out) => {
        clearTimeout(timer);
        resolve(out);
      });
      this.post({ t: "build", id, kind, changed });
    });
  }

  dispose(): void {
    this.dead = true;
    removeEventListener("message", this.onMessage);
    this.iframe.remove();
  }
}

type Watcher = { onStatus: (s: BuildStatus) => void; onReload: () => void };

class AppBuild {
  private holder = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private leased = false;
  private disposed = false;
  private frame: BuilderFrame | null = null;
  private changed = new Set<string>();
  private running: Promise<void> | null = null;
  private again = false;
  private retried = false;
  private renew: ReturnType<typeof setInterval> | undefined;
  private listener: BusListener;
  private lastStatus: BuildStatus = { phase: "checking" };
  watchers = new Set<Watcher>();
  ready: Promise<void>;

  constructor(private appId: string) {
    this.listener = (type, payload) => {
      if (payload.app !== appId) return;
      if (type === "build_needed") {
        for (const p of Array.isArray(payload.paths) ? payload.paths : []) if (typeof p === "string") this.changed.add(p);
        void this.kick();
      } else if (type === "app_built" && payload.kind === "full" && payload.holder !== this.holder) {
        for (const w of this.watchers) w.onReload();
      }
    };
    busListeners.add(this.listener);
    ensureBus();
    this.ready = this.start();
  }

  private status(s: BuildStatus): void {
    this.lastStatus = s;
    for (const w of this.watchers) w.onStatus(s);
  }

  current(): BuildStatus {
    return this.lastStatus;
  }

  private base(): string {
    return `/v1/apps/${encodeURIComponent(this.appId)}/build`;
  }

  private async lease(opts: { force?: boolean; busy?: boolean } = {}): Promise<boolean> {
    const busy = opts.busy ?? this.running !== null;
    try {
      const r = (await api(`${this.base()}/lease`, { method: "POST", body: JSON.stringify({ holder: this.holder, busy, ...(opts.force ? { force: true } : {}) }) })) as { granted?: boolean };
      this.leased = r.granted === true;
    } catch {
      this.leased = false;
    }
    if (this.disposed) {
      this.releaseLease();
      return false;
    }
    if (this.leased && !this.renew) this.renew = setInterval(() => void this.lease(), 15_000);
    return this.leased;
  }

  /** Build the current sources now, even when dist looks current. The user's
   *  Rebuild button and the agent's build requests both land here. */
  async rebuild(): Promise<void> {
    if (this.disposed) return;
    let rev = "";
    try {
      rev = ((await api(this.base())) as ServerStatus).rev;
    } catch {
      /* stamp whatever lands */
    }
    if (this.disposed) return;
    if (!(await this.lease({ busy: true }))) {
      if (!this.disposed) this.status({ phase: "waiting", message: "Another open tab is building this app" });
      return;
    }
    await this.kick("full", rev);
  }

  private async start(): Promise<void> {
    this.status({ phase: "checking" });
    let st: ServerStatus;
    try {
      st = (await api(this.base())) as ServerStatus;
    } catch (e) {
      this.status({ phase: "error", message: String((e as Error).message) });
      return;
    }
    if (this.disposed) return;
    if (!st.buildable) {
      this.status({ phase: "ready" });
      return;
    }
    if (await this.lease({ busy: true })) {
      if (this.disposed) {
        this.releaseLease();
        return;
      }
      if (st.needsBuild) await this.kick("full", st.rev);
      else {
        this.status(st.status?.errors?.length ? { phase: "error", errors: st.status.errors } : { phase: "ready" });
        if (this.running) return;
        this.frame = new BuilderFrame(this.appId, st.dev);
        // warm the session in the background so the first edit is quick
        void this.frame.build("warm").catch(() => {});
        // no build to run: do not keep the lease, or another device that
        // needs one would wait on this idle tab forever
        this.releaseLease();
      }
      return;
    }
    if (this.disposed) return;
    if (!st.needsBuild) {
      this.status({ phase: "ready" });
      return;
    }
    // another tab is building: wait for it
    this.status({ phase: "waiting", message: "Another open tab is building this app" });
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (this.disposed) return;
      try {
        st = (await api(this.base())) as ServerStatus;
        if (!st.needsBuild) break;
        // an idle lease (its holder is not mid-build) yields at once; one that
        // stays busy past any plausible build is forced over. Either way this
        // tab stops waiting the moment the holder has nothing to protect.
        if (await this.lease({ busy: true, force: i >= TAKEOVER_AFTER_S - 1 })) {
          if (this.disposed) {
            this.releaseLease();
            return;
          }
          await this.kick("full", st.rev);
          return;
        }
      } catch {
        /* keep waiting */
      }
    }
    if (!this.disposed) this.status({ phase: "ready" });
  }

  /** Run one build batch under the lease. A change event that lands while a
   *  batch runs extends it, so a burst of saves is one lease. The lease is
   *  released when the batch ends — success or failure — because it
   *  serializes BUILDS, not tabs: an idle or broken tab that kept renewing
   *  left every other device showing "another open tab is building" while
   *  nothing was. */
  private async kick(kind: "full" | "update" = "update", rev = ""): Promise<void> {
    if (this.disposed) return;
    if (!this.leased && !(await this.lease({ busy: true }))) return;
    if (this.disposed) {
      this.releaseLease();
      return;
    }
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          const changed = [...this.changed];
          this.changed.clear();
          if (kind === "update") {
            try {
              rev = ((await api(this.base())) as ServerStatus).rev;
            } catch {
              /* stamp whatever lands */
            }
          }
          await this.run(kind, rev, changed);
          kind = "update";
        } while (this.again || this.changed.size);
      } finally {
        this.running = null;
        this.releaseLease();
      }
    })();
    await this.running;
  }

  private async run(kind: "full" | "update", rev: string, changed: string[] = []): Promise<void> {
    if (this.disposed) return;
    if (!this.frame || this.frame.dead) {
      // a new builder continues from what dist holds (its dev sequence)
      let prior: unknown = null;
      try {
        prior = ((await api(this.base())) as ServerStatus).dev;
      } catch {
        /* start fresh */
      }
      this.frame = new BuilderFrame(this.appId, prior);
    }
    if (kind === "full") this.status({ phase: "building", message: "Building the app" });
    let output: Record<string, unknown>;
    try {
      output = await this.frame.build(kind, changed);
    } catch (e) {
      this.frame = null;
      this.status({ phase: "error", message: String((e as Error).message) });
      return;
    }
    if (output.unchanged) {
      this.status((output.errors as BuildMessage[] | undefined)?.length ? { phase: "error", errors: output.errors as BuildMessage[] } : { phase: "ready" });
      return;
    }
    try {
      await api(`${this.base()}/output`, { method: "PUT", body: JSON.stringify({ holder: this.holder, rev, builder: VERSION, output }) });
    } catch (e) {
      // the output never landed, but the session in the frame already advanced
      // (seq, maybe a new snapshot): keeping it would make the next upload
      // reference files the engine never received. Drop it so the next build
      // starts from what dist actually holds.
      this.frame?.dispose();
      this.frame = null;
      // forced over mid-build: another tab owns the app now and its build is
      // what will land, so show what dist holds instead of an error this tab
      // cannot act on
      const ours = await this.lease();
      if (ours && !this.retried) {
        // one fresh-session retry: a rejected output (e.g. it kept a file
        // dist no longer has) rebuilds from dist truth instead of leaving a
        // permanently broken page
        this.retried = true;
        this.again = true;
        this.status({ phase: "building", message: "Build output did not land; rebuilding" });
        return;
      }
      this.status(ours ? { phase: "error", message: `saving the build failed: ${(e as Error).message}` } : { phase: "ready" });
      return;
    }
    this.retried = false;
    const errors = (output.errors as BuildMessage[] | undefined) ?? [];
    if (output.ok === false) this.status({ phase: "error", errors });
    else {
      this.status(errors.length ? { phase: "error", errors } : { phase: "ready" });
      if (output.full || output.mode === "production") for (const w of this.watchers) w.onReload();
    }
  }

  /** Give the lease back now, so another tab (or this page reloaded) can
   *  build without waiting for it to lapse. keepalive: survives unload.
   *  Unconditional: a grant that lands after disposal must not be left
   *  renewing. A release from a non-holder is a no-op server-side. */
  releaseLease(): void {
    this.leased = false;
    // stop renewing too: a release that leaves the heartbeat running would
    // re-take the lease seconds later and hold it forever again
    clearInterval(this.renew);
    this.renew = undefined;
    void fetch(`${this.base()}/lease`, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder: this.holder, release: true }),
    }).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    busListeners.delete(this.listener);
    clearInterval(this.renew);
    this.frame?.dispose();
    this.releaseLease();
  }
}

const builds = new Map<string, AppBuild>();
addEventListener("pagehide", () => {
  for (const b of builds.values()) b.releaseLease();
});

/** Build an app on request — from the shell's rebuild button, or from the
 *  agent (build_requested on the bus). A session is spun up even when the app
 *  has no pane open, then dropped once the request settles. */
function requestBuild(appId: string, force: boolean): Promise<void> {
  let b = builds.get(appId);
  if (!b) {
    b = new AppBuild(appId);
    builds.set(appId, b);
    const build = b;
    // start() builds when dist is stale; an explicit force (the agent's
    // app_check) builds again so the output carries this host's stamp
    return build.ready
      .then(() => (force ? build.rebuild() : undefined))
      .finally(() => {
        if (!build.watchers.size) {
          build.dispose();
          builds.delete(appId);
        }
      });
  }
  return force ? b.rebuild() : Promise.resolve();
}

busListeners.add((type, payload) => {
  if (type !== "build_requested" || typeof payload.app !== "string") return;
  void requestBuild(payload.app, payload.force === true);
});

/**
 * Keep `appId` built while it is on screen. `ready` settles once dist is
 * current (or the build failed: whatever dist holds is then shown).
 * `onReload` fires when a rebuild replaced the whole app and its frame
 * should load again.
 */
function watch(appId: string, onStatus: (s: BuildStatus) => void, onReload: () => void): { ready: Promise<void>; dispose: () => void } {
  let b = builds.get(appId);
  if (!b) {
    b = new AppBuild(appId);
    builds.set(appId, b);
  }
  const w: Watcher = { onStatus, onReload };
  b.watchers.add(w);
  onStatus(b.current());
  const build = b;
  return {
    ready: build.ready,
    dispose() {
      build.watchers.delete(w);
      if (!build.watchers.size) {
        build.dispose();
        builds.delete(appId);
      }
    },
  };
}

/** Force a rebuild now (the pane's Rebuild button). */
function rebuild(appId: string): Promise<void> {
  return requestBuild(appId, true);
}

(window as unknown as { ChrysalisBuilder: unknown }).ChrysalisBuilder = { watch, rebuild, version: VERSION };
