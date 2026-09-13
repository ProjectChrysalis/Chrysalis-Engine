/**
 * Dev runtime, loaded first in a dev-built app page (served from
 * /client/builder/runtime.js, inside the app's sandboxed frame). It is the
 * module system for the builder's dev output: dev/deps-*.js registers
 * node_modules, dev/app-*.js defines every app module, dev/hot-<n>.js
 * redefines what changed. Hot updates re-run the changed modules up to the
 * nearest React Refresh boundary (a module exporting only components) or an
 * import.meta.hot.accept(), and React Refresh swaps components in place so
 * their state survives. Anything else reloads the page.
 */
import RefreshRuntime from "react-refresh/runtime";

type Factory = (
  this: unknown,
  require: (spec: string) => unknown,
  module: { exports: unknown },
  exports: unknown,
  meta: Record<string, unknown>,
  reg: (type: unknown, id: string) => void,
  sig: () => unknown,
) => void;

interface Rec {
  id: string;
  deps: Record<string, string>;
  factory: Factory;
  module?: { exports: unknown };
  boundary?: boolean;
}

interface HotState {
  selfAccept: boolean;
  selfCallbacks: Array<(mod: unknown) => void>;
  depAccepts: Map<string, (mod: unknown) => void>;
  dispose: Array<(data: Record<string, unknown>) => void>;
  prune: Array<(data: Record<string, unknown>) => void>;
  declined: boolean;
}

interface BuildMessage {
  text: string;
  file?: string;
  line?: number;
  column?: number;
  lineText?: string;
}

const w = window as unknown as Record<string, unknown>;

// before react-dom loads (the deps file comes after this script)
RefreshRuntime.injectIntoGlobalHook(window);
w.$RefreshReg$ = () => {};
w.$RefreshSig$ = () => (type: unknown) => type;

const records = new Map<string, Rec>();
const deps = new Map<string, unknown>();
const hot = new Map<string, HotState>();
const hotData = new Map<string, Record<string, unknown>>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const styles = new Map<string, HTMLStyleElement>();
const base = document.baseURI;
let started = false;
let seq = 0;
let env: Record<string, unknown> = {};

function emit(event: string, payload?: unknown): void {
  for (const cb of listeners.get(event) ?? []) {
    try {
      cb(payload);
    } catch (e) {
      console.error(e);
    }
  }
}

function fullReload(reason: string): void {
  console.info("[chrysalis] reloading:", reason);
  emit("chrysalis:beforeFullReload", { reason });
  location.reload();
}

/** node_modules namespaces, shaped so esbuild's __toESM keeps them as-is. */
function wrapDep(ns: unknown): unknown {
  if (!ns || typeof ns !== "object") return ns;
  const o: Record<string, unknown> = {};
  Object.defineProperty(o, "__esModule", { value: true });
  for (const k of Object.keys(ns)) Object.defineProperty(o, k, { enumerable: true, get: () => (ns as Record<string, unknown>)[k] });
  return o;
}

function hotState(id: string): HotState {
  let st = hot.get(id);
  if (!st) {
    st = { selfAccept: false, selfCallbacks: [], depAccepts: new Map(), dispose: [], prune: [], declined: false };
    hot.set(id, st);
  }
  return st;
}

function hotContext(rec: Rec) {
  const st = hotState(rec.id);
  if (!hotData.has(rec.id)) hotData.set(rec.id, {});
  const toId = (spec: string) => rec.deps[spec] ?? spec;
  return {
    get data() {
      return hotData.get(rec.id)!;
    },
    accept(a?: unknown, b?: unknown) {
      if (typeof a === "function" || a === undefined) {
        st.selfAccept = true;
        if (typeof a === "function") st.selfCallbacks.push(a as (m: unknown) => void);
      } else if (typeof a === "string") {
        st.depAccepts.set(toId(a), (m) => (b as ((m: unknown) => void) | undefined)?.(m));
      } else if (Array.isArray(a)) {
        const ids = a.map((x) => toId(String(x)));
        for (const id of ids) {
          st.depAccepts.set(id, () => (b as ((m: unknown[]) => void) | undefined)?.(ids.map((i) => load(i).exports)));
        }
      }
    },
    acceptExports(_names: unknown, cb?: (m: unknown) => void) {
      st.selfAccept = true;
      if (cb) st.selfCallbacks.push(cb);
    },
    dispose(cb: (data: Record<string, unknown>) => void) {
      st.dispose.push(cb);
    },
    prune(cb: (data: Record<string, unknown>) => void) {
      st.prune.push(cb);
    },
    decline() {
      st.declined = true;
    },
    invalidate(message?: string) {
      fullReload(message ?? `${rec.id} invalidated itself`);
    },
    on(event: string, cb: (payload: unknown) => void) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(cb);
    },
    off(event: string, cb: (payload: unknown) => void) {
      listeners.get(event)?.delete(cb);
    },
    send() {},
  };
}

function resolveTarget(target: string, from: string): unknown {
  if (target.startsWith("dep:")) {
    const id = target.slice(4);
    if (!deps.has(id)) throw new Error(`[chrysalis] dependency ${id} is missing from the deps bundle (imported by ${from})`);
    return deps.get(id);
  }
  if (target === "\0empty") return {};
  if (target.startsWith("\0missing:")) throw new Error(target.slice("\0missing:".length));
  return load(target).exports;
}

function isBoundary(exports: unknown): boolean {
  if (RefreshRuntime.isLikelyComponentType(exports)) return true;
  if (!exports || typeof exports !== "object") return false;
  let any = false;
  for (const key of Object.keys(exports)) {
    if (key === "__esModule") continue;
    any = true;
    if (!RefreshRuntime.isLikelyComponentType((exports as Record<string, unknown>)[key])) return false;
  }
  return any;
}

function execute(rec: Rec): void {
  const module = { exports: {} as unknown };
  rec.module = module;
  const meta: Record<string, unknown> = { url: new URL(rec.id.split("?")[0]!, base).href, env, hot: hotContext(rec) };
  const reg = (type: unknown, id: string) => RefreshRuntime.register(type, `${rec.id} ${id}`);
  const require = (spec: string) => {
    const target = rec.deps[spec];
    if (target === undefined) throw new Error(`[chrysalis] cannot find "${spec}" (imported by ${rec.id})`);
    return resolveTarget(target, rec.id);
  };
  try {
    rec.factory.call(module.exports, require, module, module.exports, meta, reg, RefreshRuntime.createSignatureFunctionForTransform);
  } catch (e) {
    rec.module = undefined;
    throw e;
  }
  rec.boundary = isBoundary(module.exports);
  if (rec.boundary && module.exports && typeof module.exports === "object") {
    for (const [k, v] of Object.entries(module.exports)) if (k !== "__esModule") RefreshRuntime.register(v, `${rec.id} %exports% ${k}`);
  }
}

function load(id: string): { exports: unknown } {
  const rec = records.get(id);
  if (!rec) throw new Error(`[chrysalis] unknown module ${id}`);
  if (!rec.module) execute(rec);
  return rec.module!;
}

type ModuleTable = Record<string, [Record<string, string>, Factory]>;

function define(table: ModuleTable): void {
  for (const [id, [d, factory]] of Object.entries(table)) {
    const old = records.get(id);
    records.set(id, { id, deps: d, factory, ...(old?.module ? { module: old.module, boundary: old.boundary } : {}) });
  }
}

function importersOf(id: string): string[] {
  const out: string[] = [];
  for (const r of records.values()) if (r.module && Object.values(r.deps).includes(id)) out.push(r.id);
  return out;
}

// ---------- error overlay ----------
let overlay: HTMLElement | null = null;
let overlayKeys: ((e: KeyboardEvent) => void) | null = null;

/** One line a human (or the agent) can act on: the error's own message, then
 *  only stack frames that name an app file — runtime plumbing is noise. */
function failureText(e: unknown, id?: string): string {
  const err = e as { message?: unknown; stack?: unknown } | null;
  const message = typeof err?.message === "string" && err.message.trim() ? err.message : String(e);
  const stack = typeof err?.stack === "string" ? err.stack : "";
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => (line.startsWith("at ") || line.includes("@")) && !line.includes("/client/builder/runtime.js"))
    .slice(0, 5);
  return `${id ? `${id}: ` : ""}${message}${frames.length ? `\n  ${frames.join("\n  ")}` : ""}`;
}

/** Runtime failures are not build failures: the shell's build card cannot see
 *  them, so tell the parent pane what the overlay is showing. Display data
 *  only — the pane's own controls decide what to do with it. */
function notifyParent(text: string | null): void {
  try {
    parent.postMessage({ __chrysalisRuntime: 1, t: "error", text }, "*");
  } catch { /* top-level page in standalone mode */ }
}

/** Runtime errors worth the agent's attention: uncaught throws, unhandled
 *  rejections and console.error. Build failures already ride the build status;
 *  these are what breaks AFTER a clean build. Events batch to the shell pane,
 *  which forwards them to the engine where app_check reads them back. */
const clientErrors: Array<{ kind: string; text: string; stack?: string; at: number }> = [];
let clientErrorsDirty = false;
const MAX_CLIENT_ERRORS = 100;

/** console.log/info/warn/debug: the page's own prints. The agent reads them
 *  back like a test log (app_console), so the runtime keeps a bounded ring —
 *  a print loop must not grow the page's memory or the engine's file. */
const clientLogs: Array<{ kind: string; text: string; at: number }> = [];
let clientLogsDirty = false;
const MAX_CLIENT_LOGS = 200;
const LOGS_PER_FLUSH = 40;

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function recordClientError(kind: string, text: string, stack?: string): void {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!clean) return;
  // one throw can arrive twice (React logs to console.error, reportError then
  // fires the window error event): collapse identical text in a short window
  const last = clientErrors[clientErrors.length - 1];
  if (last && last.text === clean && Date.now() - last.at < 500) return;
  if (clientErrors.length >= MAX_CLIENT_ERRORS) return;
  clientErrors.push({ kind, text: clean, ...(stack ? { stack: stack.slice(0, 4000) } : {}), at: Date.now() });
  clientErrorsDirty = true;
}

function recordClientLog(kind: string, text: string): void {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!clean) return;
  // a render loop printing the same line: keep one, not two hundred
  const last = clientLogs[clientLogs.length - 1];
  if (last && last.text === clean && Date.now() - last.at < 250) return;
  if (clientLogs.length >= MAX_CLIENT_LOGS) return;
  clientLogs.push({ kind, text: clean, at: Date.now() });
  clientLogsDirty = true;
}

function flushClientErrors(): void {
  if (!clientErrorsDirty || !clientErrors.length) return;
  clientErrorsDirty = false;
  try {
    parent.postMessage({ __chrysalisRuntime: 1, t: "app-errors", events: clientErrors.splice(0) }, "*");
  } catch { /* top-level page in standalone mode */ }
}

function flushClientLogs(): void {
  if (!clientLogsDirty || !clientLogs.length) return;
  clientLogsDirty = false;
  // a burst keeps its tail: the latest prints are the ones that explain the
  // state a test is looking at
  const events = clientLogs.splice(0);
  try {
    parent.postMessage({ __chrysalisRuntime: 1, t: "app-logs", events: events.slice(-LOGS_PER_FLUSH) }, "*");
  } catch { /* top-level page in standalone mode */ }
}

function installClientErrorCapture(): void {
  window.addEventListener("error", (e) => {
    // resource (script/img) failures carry neither message nor error; those
    // surface as build errors instead
    if (!e.error && !e.message) return;
    const text = e.message || textOf(e.error);
    recordClientError("uncaught", text, e.error instanceof Error ? e.error.stack : undefined);
    flushClientErrors();
    notifyParent(text);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const text = textOf(e.reason);
    recordClientError("unhandled", text, e.reason instanceof Error ? e.reason.stack : undefined);
    flushClientErrors();
    notifyParent(text);
  });
  const levels = ["log", "info", "warn", "debug"] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      recordClientLog(level, args.map(textOf).join(" "));
      original(...args);
    };
  }
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const err = args.find((a): a is Error => a instanceof Error);
    recordClientError("console", args.map(textOf).join(" "), err?.stack);
    originalError(...args);
  };
  setInterval(() => {
    flushClientErrors();
    flushClientLogs();
  }, 1500);
}

function showErrors(list: BuildMessage[] | string[]): void {
  clearErrors();
  if (!list.length) return;
  const host = document.createElement("chrysalis-error-overlay");
  const root = host.attachShadow({ mode: "open" });
  const box = document.createElement("div");
  // the overlay exists to be READ: text stays selectable, a click never
  // dismisses it (a fixed build clears it), and Close or Escape is the way out
  box.setAttribute(
    "style",
    "position:fixed;inset:0;z-index:2147483647;background:rgba(10,10,14,.92);color:#f3f3f5;font:13px/1.5 ui-monospace,monospace;padding:64px 24px 24px;overflow:auto;white-space:pre-wrap;user-select:text;cursor:text",
  );
  box.textContent =
    "The app has an error (fix the file and it updates here):\n\n" +
    list
      .map((m) => (typeof m === "string" ? m : `${m.file ?? ""}${m.line ? `:${m.line}:${m.column ?? 0}` : ""}\n  ${m.text}${m.lineText ? `\n\n    ${m.lineText}` : ""}`))
      .join("\n\n");
  // phones have no Escape key: a real button is the dismiss path there
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.setAttribute(
    "style",
    "position:fixed;top:12px;right:12px;padding:10px 16px;border:1px solid #3a3a44;border-radius:8px;background:#1c1c24;color:#f3f3f5;font:inherit;cursor:pointer",
  );
  close.addEventListener("click", clearErrors);
  overlayKeys = (e) => {
    if (e.key === "Escape") clearErrors();
  };
  window.addEventListener("keydown", overlayKeys);
  root.appendChild(box);
  root.appendChild(close);
  document.documentElement.appendChild(host);
  overlay = host;
}
function clearErrors(): void {
  if (overlayKeys) window.removeEventListener("keydown", overlayKeys);
  overlayKeys = null;
  overlay?.remove();
  overlay = null;
}

// ---------- hot updates ----------
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => RefreshRuntime.performReactRefresh(), 30);
}

function apply(table: ModuleTable, info: { errors?: BuildMessage[] }): void {
  emit("chrysalis:beforeUpdate", { type: "update" });
  const changed = Object.keys(table);
  const wasLive = new Set(changed.filter((id) => records.get(id)?.module));
  define(table);
  // walk from each changed module up to whatever accepts the change
  const run = new Set<string>();
  const acceptCalls: Array<() => void> = [];
  const queue = [...wasLive];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    run.add(id);
    const st = hotState(id);
    if (st.declined) {
      fullReload(`${id} declines hot updates`);
      return;
    }
    const rec = records.get(id)!;
    if (st.selfAccept || rec.boundary) continue;
    const importers = importersOf(id);
    if (!importers.length) {
      fullReload(`${id} changed and nothing above it can take the update`);
      return;
    }
    for (const imp of importers) {
      const cb = hotState(imp).depAccepts.get(id);
      if (cb) acceptCalls.push(() => cb(load(id).exports));
      else queue.push(imp);
    }
  }
  // dispose the old instances, then re-run: each module re-executes its
  // re-run dependencies first, through require
  for (const id of run) {
    const st = hotState(id);
    const data: Record<string, unknown> = {};
    for (const cb of st.dispose) cb(data);
    hotData.set(id, data);
    hot.set(id, { selfAccept: false, selfCallbacks: [], depAccepts: new Map(), dispose: [], prune: [], declined: false });
    const rec = records.get(id);
    if (rec) rec.module = undefined;
    const callbacks = st.selfCallbacks;
    acceptCalls.push(() => callbacks.forEach((cb) => cb(load(id).exports)));
  }
  const failures: string[] = [];
  for (const id of run) {
    try {
      load(id);
    } catch (e) {
      console.error(e);
      failures.push(failureText(e, id));
    }
  }
  for (const call of acceptCalls) {
    try {
      call();
    } catch (e) {
      console.error(e);
      failures.push(failureText(e));
    }
  }
  scheduleRefresh();
  notifyParent(failures.length ? failures.join("\n\n") : null);
  if (info.errors?.length) showErrors(info.errors);
  else if (failures.length) showErrors(failures);
  else clearErrors();
  emit("chrysalis:afterUpdate", { type: "update", updates: changed.map((path) => ({ path })) });
}

// ---------- event stream ----------
let loading = false;
const queued: number[] = [];

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => {
      s.remove();
      resolve();
    };
    s.onerror = () => {
      s.remove();
      reject(new Error(`could not load ${src}`));
    };
    document.head.appendChild(s);
  });
}

/** Fetch hot updates up to `target`, in order; any gap reloads. */
async function catchUp(target: number): Promise<void> {
  queued.push(target);
  if (loading) return;
  loading = true;
  try {
    while (queued.length) {
      const goal = Math.max(...queued.splice(0));
      while (seq < goal) {
        const next = seq + 1;
        try {
          await loadScript(`./dev/hot-${next}.js`);
        } catch {
          return fullReload("missed updates are no longer available");
        }
        if (seq < next) return fullReload(`hot update ${next} did not apply`);
      }
    }
  } finally {
    loading = false;
  }
}

function connect(): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/ws`);
  } catch {
    return;
  }
  let opened = false;
  ws.onopen = () => {
    // anything missed while the stream was down
    if (opened) return;
    opened = true;
    void loadScript(`./dev/meta.js?t=${Date.now()}`).catch(() => {});
  };
  ws.onmessage = (ev) => {
    let frame: { type?: string; payload?: { kind?: string; seq?: number; mode?: string } };
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (frame.type !== "app_built" || !frame.payload) return;
    const p = frame.payload;
    if (p.kind === "hot" && typeof p.seq === "number") void catchUp(p.seq);
    else if (p.kind === "full") fullReload("the app was rebuilt");
  };
  ws.onclose = () => setTimeout(connect, 1500);
}

const api = {
  env: {} as Record<string, unknown>,
  url(distPath: string): string {
    return new URL(distPath, base).href;
  },
  css(id: string, text: string): void {
    let el = styles.get(id);
    if (!el) {
      el = document.createElement("style");
      el.setAttribute("data-chrysalis-css", id);
      document.head.appendChild(el);
      styles.set(id, el);
    }
    el.textContent = text;
  },
  deps(table: Record<string, unknown>): void {
    for (const [id, ns] of Object.entries(table)) deps.set(id, wrapDep(ns));
  },
  define(table: ModuleTable): void {
    env = api.env;
    define(table);
  },
  update(n: number, table: ModuleTable, info: { errors?: BuildMessage[] } = {}): void {
    if (!started) {
      // replaying hot files listed in index.html: definitions only
      define(table);
      seq = n;
      return;
    }
    if (n !== seq + 1) return;
    seq = n;
    apply(table, info);
  },
  /** from dev/meta.js: where the builder is now */
  sync(latest: number): void {
    if (latest > seq) void catchUp(latest);
  },
  start(entries: string[], n: number): void {
    seq = n;
    const boot = () => {
      started = true;
      const failures: string[] = [];
      for (const id of entries) {
        try {
          load(id);
        } catch (e) {
          console.error(e);
          failures.push(failureText(e, id));
        }
      }
      notifyParent(failures.length ? failures.join("\n\n") : null);
      if (failures.length) showErrors(failures);
      connect();
      // Tell the host the app has had its first paint; the pane's opening
      // overlay waits for this instead of vanishing when src is assigned.
      const announce = () => parent.postMessage({ __chrysalisRuntime: 1, t: "ready" }, "*");
      if (document.readyState === "complete") requestAnimationFrame(() => requestAnimationFrame(announce));
      else addEventListener("load", () => requestAnimationFrame(() => requestAnimationFrame(announce)), { once: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  },
};

installClientErrorCapture();
w.__chrysalis_dev = api;
