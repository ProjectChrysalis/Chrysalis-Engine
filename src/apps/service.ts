/**
 * Service apps: an app whose manifest names a program instead of a UI to
 * build. The engine starts that program on a loopback port, keeps it alive,
 * and puts a second listening port in front of it that only the owner's
 * signed-in browser passes. The shell frames that port in a tab.
 *
 * Why a port of its own and not a path under the engine: such programs
 * serve from the root of their origin and set their own cookies and frame
 * rules. The front port forwards everything as is and removes only what
 * would stop the shell framing the page. Paths under /__chrysalis/ on it are
 * the engine's own: the page the shell opens first, and the channel that
 * tells an open page its files changed. The one thing it rewrites is the
 * script files of an app that asks for changed functions to be swapped in
 * its open pages (see hot.ts).
 *
 * This is the one place an app's code runs outside every sandbox, with the
 * rights of the account the engine runs under. Nothing starts until an admin
 * has approved the exact program (see serviceFingerprint); editing the
 * manifest's service block voids the approval, unless that admin chose not
 * to be asked again for the app.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { Server, ServerWebSocket, Subprocess } from "bun";
import { listenHost, type InstanceConfig } from "../config.js";
import { log } from "../logger.js";
import { HotScripts } from "./hot.js";
import type { ServiceSpec } from "./manager.js";

export type ServiceState = "stopped" | "installing" | "starting" | "running" | "failed";

export interface ServiceStatus {
  state: ServiceState;
  /** The port the shell frames, once one is held. */
  port: number | null;
  /** Goes up whenever the open page should load again. */
  rev: number;
  error: string | null;
  log: string[];
}

/** A request the engine itself makes to an app's program. */
export interface ServiceCall {
  method: string;
  /** Path and query, from the root of the program's own address. */
  path: string;
  headers?: Record<string, string>;
  /** A form goes out as multipart, with the content type that names its
   *  boundary. */
  body?: string | Uint8Array | FormData;
}

export interface ServiceManagerOptions {
  config: InstanceConfig;
  /** The engine's own certificate when it serves HTTPS: a front port speaks
   *  the same scheme as the page that frames it. */
  tls?: () => { cert: string; key: string } | undefined;
  /** The signed-in account a request belongs to, from its session cookie. */
  sessionUser: (req: Request) => string | null;
  /** Cookie the engine's own session rides in; never shown to a service. */
  sessionCookie: string;
}

/** How many front ports the engine may hold, counted up from its own. */
export const SERVICE_PORT_SPAN = 16;

export function servicePorts(cfg: InstanceConfig): number[] {
  const out: number[] = [];
  for (let i = 1; i <= SERVICE_PORT_SPAN && cfg.port + i <= 65535; i++) out.push(cfg.port + i);
  return out;
}

/** Whether an app's program, as its manifest names it now, may run. */
export function serviceApproved(file: string, id: string, spec: ServiceSpec): boolean {
  const a = readServiceApprovals(file)[id];
  return !!a && (a.always === true || a.fingerprint === serviceFingerprint(spec));
}

/** What an approval covers: the program, where it runs and what it is told.
 *  The reload and restart lists only steer the engine and stay editable. */
export function serviceFingerprint(spec: ServiceSpec): string {
  const env = spec.env ? Object.fromEntries(Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))) : {};
  return createHash("sha256")
    .update(JSON.stringify({ command: spec.command, cwd: spec.cwd ?? "", setup: spec.setup ?? [], env, ready: spec.ready ?? "/" }))
    .digest("hex");
}

interface Approval {
  fingerprint: string;
  port?: number;
  /** What the program signs in to the engine's model routes with. */
  key?: string;
  /** The admin trusts the app whatever its program becomes: no new question
   *  when the manifest changes. */
  always?: boolean;
  /** What setup last ran against (see setupStamp). */
  setup?: string;
}

export function readServiceApprovals(file: string): Record<string, Approval> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { services?: Record<string, unknown> };
    const out: Record<string, Approval> = {};
    for (const [id, v] of Object.entries(raw.services ?? {})) {
      const a = v as Partial<Approval> | null;
      if (a && typeof a.fingerprint === "string") {
        out[id] = {
          fingerprint: a.fingerprint,
          ...(typeof a.port === "number" ? { port: a.port } : {}),
          ...(typeof a.key === "string" && a.key ? { key: a.key } : {}),
          ...(a.always === true ? { always: true } : {}),
          ...(typeof a.setup === "string" ? { setup: a.setup } : {}),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeServiceApprovals(file: string, services: Record<string, Approval>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ services }, null, 2) + "\n", { mode: 0o600 });
}

export function writeServiceApproval(file: string, id: string, spec: ServiceSpec | null, always = false): void {
  const services = readServiceApprovals(file);
  if (spec) {
    services[id] = {
      fingerprint: serviceFingerprint(spec),
      ...(services[id]?.port ? { port: services[id].port } : {}),
      // the key outlives a new approval: the program may have stored it
      key: services[id]?.key ?? `csk_${randomBytes(24).toString("hex")}`,
      ...(always ? { always: true } : {}),
      ...(services[id]?.setup ? { setup: services[id].setup } : {}),
    };
  } else delete services[id];
  writeServiceApprovals(file, services);
}

/** What a setup run depends on: its command line and the files the manifest
 *  says it works from. A different stamp means setup is due again. */
function setupStamp(cwd: string, spec: ServiceSpec): string {
  const hash = createHash("sha256").update(JSON.stringify([spec.setup ?? [], spec.cwd ?? ""]));
  for (const rel of spec.setupOn ?? []) {
    hash.update(`\0${rel}\0`);
    try { hash.update(fs.readFileSync(path.resolve(cwd, rel))); } catch { /* not there, or a folder: counts as empty */ }
  }
  return hash.digest("hex");
}

function recordSetup(file: string, id: string, stamp: string): void {
  const services = readServiceApprovals(file);
  if (!services[id] || services[id].setup === stamp) return;
  services[id].setup = stamp;
  writeServiceApprovals(file, services);
}

/** The program an app has running, written where the next engine finds it. */
interface RunRecord {
  pid: number;
  argv: string[];
}

const runsFile = (target: ServiceTarget): string => path.join(path.dirname(target.approvalsFile), "services-running.json");

function readRuns(file: string): Record<string, RunRecord> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Partial<RunRecord> | null>;
    const out: Record<string, RunRecord> = {};
    for (const [id, r] of Object.entries(raw)) {
      if (r && typeof r.pid === "number" && Array.isArray(r.argv) && r.argv.every((a) => typeof a === "string")) out[id] = { pid: r.pid, argv: r.argv };
    }
    return out;
  } catch {
    return {};
  }
}

function writeRun(file: string, id: string, run: RunRecord | null): void {
  const runs = readRuns(file);
  if (run) runs[id] = run;
  else if (id in runs) delete runs[id];
  else return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(runs, null, 2) + "\n", { mode: 0o600 });
}

/** Whether a process id still belongs to the program that was started with
 *  this command line, and not to something that got the number since. Where
 *  that cannot be told, the answer is no. */
function stillRuns(run: RunRecord): boolean {
  try {
    process.kill(run.pid, 0);
  } catch {
    return false;
  }
  try {
    const words = fs.readFileSync(`/proc/${run.pid}/cmdline`, "utf8").split("\0");
    if (words.at(-1) === "") words.pop();
    return words.length === run.argv.length && words.every((w, i) => w === run.argv[i]);
  } catch { /* no /proc on this system */ }
  try {
    const ps = Bun.spawnSync(["ps", "-p", String(run.pid), "-o", "args="]);
    return ps.exitCode === 0 && ps.stdout.toString().trim() === run.argv.join(" ");
  } catch {
    return false;
  }
}

export interface ServiceTarget {
  username: string;
  appId: string;
  appDir: string;
  spec: ServiceSpec;
  /** Where approvals (and the port an app keeps between runs) are recorded. */
  approvalsFile: string;
}

interface FrontSocket {
  target: string;
  protocols: string[];
  headers: Record<string, string>;
  upstream?: WebSocket;
  queue: (string | Uint8Array)[];
}

interface Entry {
  target: ServiceTarget;
  state: ServiceState;
  front: Server<FrontSocket> | null;
  port: number | null;
  childPort: number;
  /** A second free port, for a program that runs a helper beside itself. */
  sparePort: number;
  modelsKey: string;
  /** Open pages waiting to hear that files changed. */
  watchers: Set<ReadableStreamDefaultController<Uint8Array>>;
  /** What open pages loaded of the app's script files (patchOn). */
  hot: HotScripts;
  /** Cookies the program set on requests made from here (see request()). */
  jar: Map<string, string>;
  proc: Subprocess<"ignore", "pipe", "pipe"> | null;
  log: string[];
  error: string | null;
  rev: number;
  /** A start or stop in flight; later calls wait behind it. */
  busy: Promise<void>;
  /** Set by stop(), so the program ending is not read as a crash. */
  stopping: boolean;
  startedAt: number;
  crashes: number[];
  restartTimer?: ReturnType<typeof setTimeout>;
}

const LOG_LINES = 300;
const READY_TIMEOUT_MS = 180_000;
const STOP_GRACE_MS = 3_000;
const CALL_TIMEOUT_MS = 120_000;
/** Headers that stop another origin framing or reading a page. */
const FRAME_BLOCKERS = ["x-frame-options", "cross-origin-opener-policy", "cross-origin-resource-policy", "cross-origin-embedder-policy"];
const HOP_HEADERS = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"];

/** Where the engine's own paths sit on a front port. */
const OWN_PREFIX = "/__chrysalis/";
const READY_SCRIPT = `(() => {
  const report = () => parent.postMessage({ chrysalisService: "open" }, "*");
  addEventListener("message", (event) => {
    if (event.source === parent && event.data?.chrysalisService === "probe") report();
  });
  report();
})();`;

/** Runs in the app's page. A change to stylesheets the page links is swapped
 *  in place, and so is a change inside the functions of a script the engine
 *  prepared for it; any other change loads the page again and puts back what
 *  was typed and scrolled. A page open in its own
 *  browser tab also loads again once the program is back from a restart (in
 *  the shell, the shell does that). */
const LIVE_SCRIPT = `(() => {
  if (window.__chrysalisLive) return;
  window.__chrysalisLive = true;
  // How many names a changed file and an address share, counted from the
  // end. A program may serve a folder under another address than the one it
  // has on disk, so the file's name and the folder it sits in are what tell
  // (the name alone when either side has no folder).
  const shared = (file, pathname) => {
    const a = file.split("/").filter(Boolean);
    const b = pathname.split("/").filter(Boolean).map((n) => { try { return decodeURIComponent(n); } catch { return n; } });
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n >= Math.min(2, a.length, b.length) ? n : 0;
  };
  const swap = (paths) => {
    const links = [...document.querySelectorAll('link[rel~="stylesheet"][href]')];
    const hits = new Set();
    for (const p of paths) {
      if (!/\\.css$/i.test(p)) return false;
      // several sheets can share a file name: the one whose address covers
      // most of the changed path is the one that file is
      let link = null;
      let depth = 0;
      for (const l of links) {
        const u = new URL(l.href, location.href);
        const n = u.origin === location.origin ? shared(p, u.pathname) : 0;
        if (n > depth) {
          link = l;
          depth = n;
        }
      }
      if (!link) return false;
      hits.add(link);
    }
    for (const link of hits) {
      const u = new URL(link.href, location.href);
      u.searchParams.set("_live", String(Date.now()));
      const next = link.cloneNode();
      next.href = u.href;
      next.addEventListener("load", () => link.remove());
      next.addEventListener("error", () => next.remove());
      link.after(next);
    }
    return true;
  };
  // A reload caused by a file change puts back what was typed and where
  // each pane was scrolled, as far as the page gives those elements ids.
  const KEPT = "chrysalis-live-kept";
  const reload = () => {
    try {
      const fields = [];
      for (const el of document.querySelectorAll("textarea[id], input[id]")) {
        if (/^(password|file|checkbox|radio|hidden|submit|button)$/.test(el.type)) continue;
        if (el.value && el.value !== el.defaultValue) fields.push([el.id, el.value]);
      }
      const scrolled = [];
      for (const el of document.querySelectorAll("[id]")) {
        if (el.scrollTop > 0) scrolled.push([el.id, el.scrollTop]);
      }
      sessionStorage.setItem(KEPT, JSON.stringify({ fields, scrolled, top: window.scrollY }));
    } catch {}
    location.reload();
  };
  try {
    const kept = JSON.parse(sessionStorage.getItem(KEPT) || "null");
    sessionStorage.removeItem(KEPT);
    if (kept) {
      let fields = kept.fields || [];
      let scrolled = kept.scrolled || [];
      let top = kept.top || 0;
      const until = Date.now() + 8000;
      // the page builds itself after load: each thing goes back once, when
      // its element is there, and is then left to the person
      const put = () => {
        fields = fields.filter(([id, value]) => {
          const el = document.getElementById(id);
          if (!el) return true;
          if (!el.value) {
            el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return false;
        });
        scrolled = scrolled.filter(([id, at]) => {
          const el = document.getElementById(id);
          if (!el || el.scrollHeight - el.clientHeight < at) return true;
          el.scrollTop = at;
          return false;
        });
        if (top && document.documentElement.scrollHeight - window.innerHeight >= top) {
          window.scrollTo(0, top);
          top = 0;
        }
        if ((fields.length || scrolled.length || top) && Date.now() < until) setTimeout(put, 250);
      };
      if (document.readyState === "loading") addEventListener("DOMContentLoaded", put);
      else put();
    }
  } catch {}
  // Scripts this page loaded with a table of their functions take a change
  // as newer bodies for those functions. False when one cannot.
  const patch = async (paths) => {
    // a page that may not evaluate text cannot take a newer body
    try { (0, eval)("0"); } catch { return false; }
    const files = (window.__cH || {}).f || {};
    const addresses = [];
    for (const p of paths) {
      let hits = [];
      let depth = 0;
      for (const address of Object.keys(files)) {
        const n = shared(p, address.split("?")[0]);
        if (!n || n < depth) continue;
        if (n > depth) hits = [];
        depth = n;
        hits.push(address);
      }
      if (!hits.length) return false;
      addresses.push(...hits);
    }
    const answers = [];
    for (const address of addresses) {
      const res = await fetch(address, { cache: "no-store", headers: { "x-chrysalis-hot": files[address] } });
      const got = res.ok ? await res.json() : null;
      if (!got || got.reload) return false;
      // saved halfway through a change: the next save says more
      if (got.wait) return true;
      answers.push([address, got]);
    }
    for (const [address, got] of answers) {
      Object.assign(window.__cH.s, got.patches);
      files[address] = got.key;
    }
    return true;
  };
  // one change at a time: each answer builds on the one before
  let patching = Promise.resolve();
  const changed = (paths) => {
    const scripts = paths.filter((p) => /\\.m?js$/i.test(p));
    const rest = paths.filter((p) => !scripts.includes(p));
    if (rest.length && !swap(rest)) return reload();
    if (!scripts.length) return;
    patching = patching.then(() => patch(scripts)).then((ok) => { if (!ok) reload(); }, reload);
  };
  const source = new EventSource("${OWN_PREFIX}live");
  source.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "change") changed(msg.paths || []);
    else if (msg.type === "reload") reload();
    else if (msg.type === "up" && window.parent === window) reload();
  };
})();
`;

async function freeLoopbackPort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port ?? 0;
  await probe.stop(true);
  if (!port) throw new Error("no free port for the program");
  return port;
}

/** Every program the engine has running, so none outlives it. */
const live = new Set<Subprocess>();
process.on("exit", () => {
  for (const proc of live) {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }
});

export class ServiceManager {
  private entries = new Map<string, Entry>();

  constructor(private opts: ServiceManagerOptions) {}

  private key(username: string, appId: string): string {
    return `${username}/${appId}`;
  }

  status(username: string, appId: string, lines = 60): ServiceStatus {
    const e = this.entries.get(this.key(username, appId));
    if (!e) return { state: "stopped", port: null, rev: 0, error: null, log: [] };
    return { state: e.state, port: e.port, rev: e.rev, error: e.error, log: e.log.slice(-lines) };
  }

  /** Start the program unless it is already up or coming up. Resolves once
   *  the attempt is under way, not when the program answers: callers watch
   *  status(). */
  start(target: ServiceTarget): void {
    const key = this.key(target.username, target.appId);
    let e = this.entries.get(key);
    if (e && (e.state === "running" || e.state === "starting" || e.state === "installing")) return;
    if (!e) {
      e = {
        target, state: "stopped", front: null, port: null, childPort: 0, sparePort: 0, modelsKey: "", watchers: new Set(), hot: new HotScripts(), jar: new Map(), proc: null, log: [], error: null,
        rev: 0, busy: Promise.resolve(), stopping: false, startedAt: 0, crashes: [],
      };
      this.entries.set(key, e);
    }
    e.target = target;
    e.crashes = [];
    // said at once, so nobody watching reads the last run's ending as this one's
    e.state = "starting";
    e.error = null;
    this.queue(e, () => this.bringUp(e!));
  }

  async stop(username: string, appId: string): Promise<void> {
    const e = this.entries.get(this.key(username, appId));
    if (!e) return;
    this.interrupt(e);
    await this.queue(e, () => this.bringDown(e, "stopped"));
  }

  restart(target: ServiceTarget): void {
    const e = this.entries.get(this.key(target.username, target.appId));
    if (!e) {
      this.start(target);
      return;
    }
    e.target = target;
    e.crashes = [];
    e.state = "starting";
    e.error = null;
    this.interrupt(e);
    this.queue(e, async () => {
      await this.bringDown(e, "starting");
      await this.bringUp(e);
    });
  }

  /** Stop a program and give its front port back (the app was removed, or
   *  its approval withdrawn). */
  async remove(username: string, appId: string): Promise<void> {
    const key = this.key(username, appId);
    const e = this.entries.get(key);
    if (!e) return;
    this.interrupt(e);
    await this.queue(e, () => this.bringDown(e, "stopped"));
    for (const w of e.watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    e.watchers.clear();
    await e.front?.stop(true);
    e.front = null;
    this.entries.delete(key);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => this.remove(e.target.username, e.target.appId)));
  }

  /** Files of a service app changed on disk (app-relative paths). */
  filesChanged(username: string, appId: string, paths: string[]): void {
    const e = this.entries.get(this.key(username, appId));
    if (!e || e.state !== "running") return;
    // a save often goes through a second file beside the real one, gone
    // again at once: what is still there is what changed. With nothing left,
    // files were really removed
    const there = paths.filter((p) => fs.existsSync(path.join(e.target.appDir, p)));
    if (there.length) paths = there;
    const cwd = (e.target.spec.cwd ?? "").replace(/\\/g, "/").replace(/^\.\/?|\/+$/g, "");
    const under = (rel: string, prefixes: string[] | undefined): boolean => {
      const norm = rel.replace(/\\/g, "/");
      const inner = cwd ? (norm.startsWith(`${cwd}/`) ? norm.slice(cwd.length + 1) : null) : norm;
      if (inner === null) return false;
      return (prefixes ?? []).some((p) => {
        const want = p.replace(/\\/g, "/").replace(/^\.\//, "");
        return inner === want || inner.startsWith(want.endsWith("/") ? want : `${want}/`);
      });
    };
    if (paths.some((p) => under(p, e.target.spec.restartOn))) {
      this.note(e, "files changed, restarting");
      this.restart(e.target);
      return;
    }
    const changed = paths.filter((p) => under(p, e.target.spec.reloadOn) || under(p, e.target.spec.patchOn)).map((p) => p.replace(/\\/g, "/"));
    if (!changed.length) return;
    // an open page that listens decides for itself (a stylesheet is swapped
    // in place); with none listening the shell loads the frame again
    if (e.watchers.size) this.tell(e, { type: "change", paths: changed });
    else e.rev++;
  }

  /** The account whose running program holds this key, for the model routes. */
  keyOwner(key: string): string | null {
    const given = Buffer.from(key);
    for (const e of this.entries.values()) {
      const own = Buffer.from(e.modelsKey);
      if (own.length > 0 && own.length === given.length && timingSafeEqual(own, given)) return e.target.username;
    }
    return null;
  }

  /** One request to an app's running program, made from this machine and
   *  not through a browser (the agent's tool). Cookies the program sets are
   *  kept for the next request, as a browser would keep them. */
  async request(username: string, appId: string, call: ServiceCall, signal?: AbortSignal): Promise<Response> {
    const e = this.entries.get(this.key(username, appId));
    if (!e || e.state !== "running") throw new Error("the program is not running");
    const origin = `http://127.0.0.1:${e.childPort}`;
    const url = new URL(call.path, origin);
    if (!call.path.startsWith("/") || url.origin !== origin) throw new Error("the path must start with / and stay inside the app");
    const headers = new Headers(call.headers);
    for (const h of [...HOP_HEADERS, "host", "content-length"]) headers.delete(h);
    if (call.body instanceof FormData) headers.delete("content-type");
    if (e.jar.size && !headers.has("cookie")) headers.set("cookie", [...e.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, {
      method: call.method,
      headers,
      ...(call.body !== undefined ? { body: call.body } : {}),
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const at = pair.indexOf("=");
      if (at < 1) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const gone = !value || attributes.some((a) => /^\s*max-age\s*=\s*-?0*\s*$/i.test(a));
      if (gone) e.jar.delete(name);
      else e.jar.set(name, value);
    }
    return res;
  }

  /** Open pages of an app load again: what they show was changed behind
   *  them. */
  reloadPages(username: string, appId: string): void {
    const e = this.entries.get(this.key(username, appId));
    if (!e || e.state !== "running") return;
    if (e.watchers.size) this.tell(e, { type: "reload" });
    else e.rev++;
  }

  private tell(e: Entry, event: { type: "change"; paths: string[] } | { type: "up" } | { type: "reload" }): void {
    const frame = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const w of e.watchers) {
      try { w.enqueue(frame); } catch { e.watchers.delete(w); }
    }
  }

  /** Steps run one after another, and a start waits on its program for as
   *  long as setup takes. A stop asked for meanwhile ends that program now,
   *  or it would only be heard once the start was through. */
  private interrupt(e: Entry): void {
    e.stopping = true;
    try { e.proc?.kill("SIGTERM"); } catch { /* already gone */ }
  }

  private queue(e: Entry, step: () => Promise<void>): Promise<void> {
    e.busy = e.busy.then(step).catch((err) => {
      e.state = "failed";
      e.error = (err as Error).message;
      this.note(e, e.error);
    });
    return e.busy;
  }

  private note(e: Entry, line: string): void {
    for (const l of stripVTControlCharacters(line).split(/\r?\n/)) {
      if (!l.trim()) continue;
      e.log.push(l.length > 500 ? `${l.slice(0, 500)}…` : l);
    }
    if (e.log.length > LOG_LINES) e.log.splice(0, e.log.length - LOG_LINES);
  }

  private fill(e: Entry, word: string): string {
    const { config } = this.opts;
    return word
      .replaceAll("{port}", String(e.childPort))
      .replaceAll("{port2}", String(e.sparePort))
      .replaceAll("{models_key}", e.modelsKey)
      .replaceAll("{models}", `${this.opts.tls?.() ? "https" : "http"}://127.0.0.1:${config.port}/v1/openai`)
      .replaceAll("{data}", path.join(e.target.appDir, "data"))
      .replaceAll("{app}", e.target.appDir);
  }

  /** The command line a manifest's words become. The engine's own runtime
   *  answers to "bun", whether this is a source run or a packaged program
   *  with the runtime inside. */
  private commandLine(e: Entry, words: string[]): string[] {
    const argv = words.map((w) => this.fill(e, w));
    return argv[0] === "bun" ? [process.execPath, ...argv.slice(1)] : argv;
  }

  /** An engine that was replaced without a clean stop (a development
   *  restart, a crash) leaves its program running and holding the app's data.
   *  It is stopped before another copy starts. */
  private async reap(e: Entry): Promise<void> {
    const file = runsFile(e.target);
    const left = readRuns(file)[e.target.appId];
    if (!left) return;
    if (stillRuns(left)) {
      this.note(e, "stopping the copy an earlier engine left running");
      try { process.kill(left.pid, "SIGTERM"); } catch { /* gone meanwhile */ }
      const deadline = Date.now() + STOP_GRACE_MS;
      while (stillRuns(left) && Date.now() < deadline) await Bun.sleep(100);
      if (stillRuns(left)) {
        try { process.kill(left.pid, "SIGKILL"); } catch { /* gone meanwhile */ }
        await Bun.sleep(100);
      }
    }
    writeRun(file, e.target.appId, null);
  }

  private spawn(e: Entry, words: string[]): Subprocess<"ignore", "pipe", "pipe"> {
    const argv = this.commandLine(e, words);
    const own = words[0] === "bun";
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // the engine's own switches are not the program's business
      if (v !== undefined && !k.startsWith("CHRYSALIS_")) env[k] = v;
    }
    // the usual name for it, unless the manifest uses that name itself
    env.PORT = String(e.childPort);
    for (const [k, v] of Object.entries(e.target.spec.env ?? {})) env[k] = this.fill(e, v);
    if (own) env.BUN_BE_BUN = "1";
    const cwd = path.resolve(e.target.appDir, e.target.spec.cwd ?? ".");
    const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    live.add(proc);
    void proc.exited.then(() => live.delete(proc));
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      let rest = "";
      try {
        for await (const chunk of stream) {
          rest += dec.decode(chunk, { stream: true });
          const lines = rest.split("\n");
          rest = lines.pop() ?? "";
          for (const l of lines) this.note(e, l);
        }
      } catch { /* the program went away mid-line */ }
      if (rest) this.note(e, rest);
    };
    void pump(proc.stdout);
    void pump(proc.stderr);
    return proc;
  }

  private async bringUp(e: Entry): Promise<void> {
    const { target } = e;
    clearTimeout(e.restartTimer);
    e.error = null;
    e.stopping = false;
    const cwd = path.resolve(target.appDir, target.spec.cwd ?? ".");
    if (!fs.existsSync(cwd)) throw new Error(`the folder ${target.spec.cwd} is missing from this app`);
    fs.mkdirSync(path.join(target.appDir, "data"), { recursive: true });
    if (!e.front) this.openFront(e);
    await this.reap(e);
    e.childPort = await freeLoopbackPort();
    do e.sparePort = await freeLoopbackPort(); while (e.sparePort === e.childPort);
    e.modelsKey = readServiceApprovals(target.approvalsFile)[target.appId]?.key ?? "";

    if (target.spec.setup) {
      const last = readServiceApprovals(target.approvalsFile)[target.appId]?.setup;
      const packages = fs.existsSync(path.join(cwd, "node_modules"));
      // due on the first start, when what it works from changed, and when
      // the packages it installed are gone. An install from before this was
      // recorded has its packages and counts as set up
      const due = last === undefined
        ? !packages
        : last !== setupStamp(cwd, target.spec) || (!packages && fs.existsSync(path.join(cwd, "package.json")));
      if (due) {
        if (!this.opts.config.apps.packageDownloads) throw new Error("this app needs to download its packages, and package downloads are off in config.yaml");
        e.state = "installing";
        this.note(e, `$ ${target.spec.setup.join(" ")}`);
        const setup = this.spawn(e, target.spec.setup);
        e.proc = setup;
        const code = await setup.exited;
        e.proc = null;
        if (e.stopping) return;
        if (code !== 0) throw new Error(`setup ended with code ${code}`);
      }
      // taken after the run: setup may rewrite the files it works from
      recordSetup(target.approvalsFile, target.appId, setupStamp(cwd, target.spec));
    }

    e.state = "starting";
    this.note(e, `$ ${target.spec.command.join(" ")}`);
    const proc = this.spawn(e, target.spec.command);
    e.proc = proc;
    e.startedAt = Date.now();
    const runs = runsFile(target);
    writeRun(runs, target.appId, { pid: proc.pid, argv: this.commandLine(e, target.spec.command) });
    void proc.exited.then((code) => {
      if (readRuns(runs)[target.appId]?.pid === proc.pid) writeRun(runs, target.appId, null);
      this.ended(e, proc, code);
    });

    const ready = `http://127.0.0.1:${e.childPort}${target.spec.ready ?? "/"}`;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (e.proc === proc && !e.stopping) {
      try {
        const res = await fetch(ready, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
        await res.body?.cancel();
        if (res.status < 500) break;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) {
        await this.bringDown(e, "failed");
        throw new Error("the program did not answer in time");
      }
      await Bun.sleep(250);
    }
    if (e.proc !== proc || e.stopping) return;
    e.state = "running";
    e.rev++;
    this.tell(e, { type: "up" });
    log.info(`[service] ${target.username}/${target.appId} is up on port ${e.port}`);
  }

  private ended(e: Entry, proc: Subprocess, code: number | null): void {
    if (e.proc !== proc) return;
    e.proc = null;
    if (e.stopping) return;
    this.note(e, `the program ended (code ${code ?? "none"})`);
    const now = Date.now();
    e.crashes = e.crashes.filter((t) => now - t < 60_000);
    e.crashes.push(now);
    // one that ran for a while gets another go; one that keeps falling over
    // (or never came up) waits for a person
    if (e.state === "running" && now - e.startedAt > 10_000 && e.crashes.length <= 3) {
      e.state = "starting";
      e.restartTimer = setTimeout(() => this.queue(e, () => this.bringUp(e)), 1_000);
      return;
    }
    e.state = "failed";
    e.error = `the program ended (code ${code ?? "none"})`;
  }

  private async bringDown(e: Entry, state: ServiceState): Promise<void> {
    clearTimeout(e.restartTimer);
    e.stopping = true;
    const proc = e.proc;
    e.proc = null;
    e.state = state;
    if (!proc) return;
    try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    const gone = await Promise.race([proc.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
    if (!gone) {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await proc.exited;
    }
  }

  // ---------- the front port ----------

  private openFront(e: Entry): void {
    const { config } = this.opts;
    const approvals = readServiceApprovals(e.target.approvalsFile);
    const kept = approvals[e.target.appId]?.port;
    const taken = new Set([...this.entries.values()].map((o) => o.port));
    const candidates = servicePorts(config).filter((p) => !taken.has(p));
    // the port it had last time comes first: the page's own storage is tied to it
    if (kept && candidates.includes(kept)) candidates.unshift(...candidates.splice(candidates.indexOf(kept), 1));
    for (const port of candidates) {
      try {
        e.front = Bun.serve<FrontSocket>({
          hostname: listenHost(config),
          port,
          tls: this.opts.tls?.(),
          idleTimeout: 255,
          maxRequestBodySize: 1024 * 1024 * 1024,
          fetch: (req, srv) => this.forward(e, req, srv),
          websocket: {
            open: (ws) => this.socketOpen(ws),
            message: (ws, data) => {
              const up = ws.data.upstream;
              if (up && up.readyState === WebSocket.OPEN) up.send(data);
              else ws.data.queue.push(typeof data === "string" ? data : new Uint8Array(data));
            },
            close: (ws) => {
              try { ws.data.upstream?.close(); } catch { /* already closed */ }
            },
          },
        });
        e.port = port;
        if (kept !== port && approvals[e.target.appId]) {
          approvals[e.target.appId] = { ...approvals[e.target.appId]!, port };
          writeServiceApprovals(e.target.approvalsFile, approvals);
        }
        return;
      } catch { /* taken by another program: try the next */ }
    }
    throw new Error(`no free port between ${config.port + 1} and ${config.port + SERVICE_PORT_SPAN} for this app`);
  }

  private socketOpen(ws: ServerWebSocket<FrontSocket>): void {
    const { target, protocols, headers } = ws.data;
    // Bun's client socket takes request headers; the DOM type does not say so
    const up = new (WebSocket as unknown as new (url: string, init: { protocols?: string[]; headers: Record<string, string> }) => WebSocket)(
      target, { ...(protocols.length ? { protocols } : {}), headers },
    );
    up.binaryType = "arraybuffer";
    ws.data.upstream = up;
    up.onopen = () => {
      for (const m of ws.data.queue) up.send(m);
      ws.data.queue = [];
    };
    up.onmessage = (ev) => {
      ws.send(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
    };
    up.onclose = (ev) => {
      try { ws.close(ev.code === 1005 || ev.code === 1006 ? 1011 : ev.code, ev.reason); } catch { /* already closed */ }
    };
    up.onerror = () => {
      try { ws.close(1011, "the program closed the connection"); } catch { /* already closed */ }
    };
  }

  /** The request's cookies without the engine's own session. */
  private cookiesFor(req: Request): string {
    return (req.headers.get("cookie") ?? "")
      .split(";")
      .map((c) => c.trim())
      .filter((c) => c && c.split("=")[0] !== this.opts.sessionCookie)
      .join("; ");
  }

  /** Whether this address is one of the app's own script files that pages
   *  load as they are (a file under a patchOn path whose place there ends
   *  the address). */
  private scriptFile(e: Entry, pathname: string): boolean {
    const spec = e.target.spec;
    if (!spec.patchOn?.length || !/\.m?js$/i.test(pathname)) return false;
    let parts: string[];
    try {
      parts = pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    } catch {
      return false;
    }
    if (!parts.length || parts.some((p) => p === ".." || p === "." || /[\\/\0]/.test(p))) return false;
    const base = path.join(e.target.appDir, spec.cwd ?? "");
    for (const prefix of spec.patchOn) {
      const named = prefix.replace(/\\/g, "/").replace(/^\.\/|\/+$/g, "");
      for (let i = 0; i < parts.length; i++) {
        const tail = parts.slice(i).join("/");
        const file = named === tail || named.endsWith(`/${tail}`) ? named : `${named}/${tail}`;
        try {
          if (fs.statSync(path.join(base, file)).isFile()) return true;
        } catch { /* not there */ }
      }
    }
    return false;
  }

  /** The engine's own paths on a front port. */
  private own(e: Entry, url: URL, signedIn: boolean): Response | null {
    if (!url.pathname.startsWith(OWN_PREFIX)) return null;
    const name = url.pathname.slice(OWN_PREFIX.length);
    // The shell opens this first: it says the port was reached (a firewall
    // that lets only the engine's port through shows as silence) and whether
    // the browser sent the sign-in, then moves on to the app.
    if (name === "open") {
      const body = `<!doctype html><meta charset="utf-8"><title></title><script>parent.postMessage({chrysalisService:"open",signedIn:${signedIn}},"*");${signedIn ? 'location.replace("/")' : ""}</script>${signedIn ? "" : "Open this app from Chrysalis."}`;
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (!signedIn) return null;
    if (name === "ready.js") {
      return new Response(READY_SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
    }
    if (name === "live.js") {
      return new Response(LIVE_SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
    }
    if (name === "live") {
      let self: ReadableStreamDefaultController<Uint8Array> | undefined;
      let beat: ReturnType<typeof setInterval> | undefined;
      const drop = () => {
        clearInterval(beat);
        if (self) e.watchers.delete(self);
      };
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          self = controller;
          e.watchers.add(controller);
          controller.enqueue(new TextEncoder().encode(": ok\n\n"));
          beat = setInterval(() => {
            try { controller.enqueue(new TextEncoder().encode(": ok\n\n")); } catch { drop(); }
          }, 30_000);
        },
        cancel: drop,
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  }

  private async forward(e: Entry, req: Request, srv: Server<FrontSocket>): Promise<Response | undefined> {
    const url = new URL(req.url);
    // Only the owner's signed-in browser passes. A page on another site that
    // points a name at this port carries no session cookie for it.
    const signedIn = this.opts.sessionUser(req) === e.target.username;
    const mine = this.own(e, url, signedIn);
    if (mine) {
      if (url.pathname === `${OWN_PREFIX}live`) srv.timeout(req, 0);
      return mine;
    }
    if (!signedIn) {
      return new Response("Open this app from Chrysalis.", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (e.state !== "running") {
      return new Response("The app is starting.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "1" } });
    }
    const cookie = this.cookiesFor(req);
    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      const headers: Record<string, string> = {};
      if (cookie) headers.cookie = cookie;
      const origin = req.headers.get("origin");
      if (origin) headers.origin = origin;
      const ok = srv.upgrade(req, {
        data: { target: `ws://127.0.0.1:${e.childPort}${url.pathname}${url.search}`, protocols, headers, queue: [] },
      });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }
    // a generation can stay silent for minutes before its first byte
    srv.timeout(req, 0);
    const headers = new Headers(req.headers);
    for (const h of HOP_HEADERS) headers.delete(h);
    // A script the page loads as it is on disk goes out with its functions
    // open to newer bodies; a page that holds one asks, with what it holds,
    // for what a save changed.
    const held = headers.get("x-chrysalis-hot");
    const hot = req.method === "GET" && (held !== null || req.headers.get("sec-fetch-dest") === "script") && this.scriptFile(e, url.pathname);
    headers.delete("x-chrysalis-hot");
    const kept = headers.get("if-none-match");
    if (hot) {
      // the file itself is needed every time, not word that it is unchanged
      headers.delete("if-none-match");
      headers.delete("if-modified-since");
    }
    headers.delete("host");
    if (cookie) headers.set("cookie", cookie);
    else headers.delete("cookie");
    // sent on plain, so the reply can be passed through byte for byte
    headers.set("accept-encoding", "identity");
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${e.childPort}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: hasBody ? req.body : undefined,
        redirect: "manual",
        signal: req.signal,
        // no overall time limit: streams run as long as the model does
        timeout: false,
      } as RequestInit);
    } catch (err) {
      if (req.signal.aborted) return new Response(null, { status: 499 });
      return new Response(`The app did not answer: ${(err as Error).message}`, { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const out = new Headers(res.headers);
    for (const h of [...HOP_HEADERS, ...FRAME_BLOCKERS, "content-encoding", "content-length"]) out.delete(h);
    const csp = out.get("content-security-policy");
    if (csp) {
      const kept = csp.split(";").map((d) => d.trim()).filter((d) => d && !/^frame-ancestors\b/i.test(d));
      if (kept.length) out.set("content-security-policy", kept.join("; "));
      else out.delete("content-security-policy");
    }
    // the program must not be able to replace the engine's session
    const cookies = res.headers.getSetCookie().filter((c) => c.split("=")[0]?.trim() !== this.opts.sessionCookie);
    out.delete("set-cookie");
    for (const c of cookies) out.append("set-cookie", c);
    const location = out.get("location");
    const inner = `http://127.0.0.1:${e.childPort}`;
    if (location?.startsWith(inner)) out.set("location", location.slice(inner.length) || "/");
    if (hot && res.status === 200 && /\b(java|ecma)script\b/i.test(out.get("content-type") ?? "")) {
      const source = await res.text();
      if (held !== null) return Response.json(await e.hot.patch(held, source), { headers: { "cache-control": "no-store" } });
      const text = await e.hot.load(url.pathname + url.search, source);
      if (text === null) return new Response(source, { status: 200, headers: out });
      // the browser may keep its copy, and asks every time whether it stands
      const tag = `"${Bun.hash(text).toString(36)}"`;
      out.delete("last-modified");
      out.set("etag", tag);
      out.set("cache-control", "no-cache");
      return kept === tag ? new Response(null, { status: 304, headers: out }) : new Response(text, { status: 200, headers: out });
    }
    // Readiness comes from the loaded page too, so a missed startup message
    // does not leave a working page marked unreachable. Scripts are loaded
    // by address for pages whose policy refuses inline code.
    const live = e.target.spec.reloadOn?.length || e.target.spec.patchOn?.length || e.target.spec.restartOn?.length;
    if (req.method === "GET" && res.status === 200 && /^text\/html\b/i.test(out.get("content-type") ?? "")) {
      const html = await res.text();
      const tag = `<script src="${OWN_PREFIX}ready.js"></script>${live ? `<script src="${OWN_PREFIX}live.js"></script>` : ""}`;
      const at = html.search(/<\/head\s*>/i);
      return new Response(at < 0 ? html + tag : html.slice(0, at) + tag + html.slice(at), { status: 200, headers: out });
    }
    return new Response(req.method === "HEAD" ? null : res.body, { status: res.status, statusText: res.statusText, headers: out });
  }
}
