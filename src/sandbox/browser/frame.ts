/**
 * The sandbox frame (served from /client/sandbox/frame.html, sandboxed to an
 * opaque origin). It owns the wasmsh session: the worker is wrapped in a blob
 * URL because an opaque-origin document may not construct a worker from an
 * engine URL, and the wasmsh worker resolves its helper modules relative to
 * its own URL, so the one anchor it uses gets rewritten to the real one.
 *
 * The frame never talks to the engine with a session; the host page
 * (same-origin, authed) posts it work and passes every file byte back through
 * the workspace route. With internet access on, the worker's own HTTP goes to
 * the engine's sandbox proxy under a token the host handed over.
 */
import { createBrowserWorkerSession, type WasmshSession } from "@mayflowergmbh/wasmsh-pyodide/browser";
import { TOP_LEVEL_DOMAINS } from "./tlds";
import { workerLockdown } from "./lockdown";
import { SANDBOX_GIT_HOST, SHELL_PRELUDE } from "./prelude";

declare const __SANDBOX_VERSION__: string;

const VER = typeof __SANDBOX_VERSION__ === "string" ? __SANDBOX_VERSION__ : "dev";
const WORKER_REL = `/client/sandbox/wasmsh/${VER}/browser-worker.js`;
const ASSETS_REL = `/client/sandbox/wasmsh/${VER}/assets`;
const ANCHOR = "self.location.href";
const PYODIDE_ANCHOR = "const { loadPyodide } = await import(`${assetBaseUrl}/pyodide.mjs`);";
/**
 * The browser worker defines curl/wget's HTTP import (createNetworkStubs) but
 * never hands it to the wasm instance, so the placeholder Emscripten leaves
 * in its place calls itself until the stack overflows. Loading the module
 * factory first lets instantiation put the real function in the import table.
 */
const WIRE_HTTP_FETCH = `importScripts(\`\${assetBaseUrl}/pyodide.asm.js\`);
  const createModule = self._createPyodideModule;
  self._createPyodideModule = (settings) => createModule({
    ...settings,
    instantiateWasm(info, done) {
      info.env.wasmsh_js_http_fetch = (...args) => createNetworkStubs(moduleRef).wasmsh_js_http_fetch(...args);
      return settings.instantiateWasm(info, done);
    },
  });`;

interface MountFile {
  path: string;
  b64: string;
}

/** What the host boots the sandbox with. */
interface SandboxConfig {
  internet: boolean;
  token: string | null;
}

type Request =
  | { t: "config"; config: SandboxConfig }
  | { t: "mount"; id: number; files: MountFile[] }
  | { t: "run"; id: number; command: string; timeoutMs: number }
  | { t: "manifest"; id: number }
  | { t: "read"; id: number; paths: string[] }
  | { t: "rm"; id: number; paths: string[] }
  | { t: "reset"; id: number; config?: SandboxConfig };

const post = (m: Record<string, unknown>) => parent.postMessage({ __chrysalisSandbox: 1, ...m }, "*");
const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
};
const bytesToB64 = (buf: Uint8Array): string => {
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s);
};
const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** Only the mounted workspace is addressable, whatever a message claims. */
const vfsPath = (rel: string): string => {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.split("/").includes("..")) throw new Error(`Refusing path: ${rel}`);
  return `/workspace/${norm}`;
};

const MANIFEST_PY = `python3 - <<'PY'
import json, os
root = "/workspace"
out = {}
for dp, _dns, fns in os.walk(root):
    for f in fns:
        p = os.path.join(dp, f)
        try:
            st = os.stat(p)
        except OSError:
            continue
        out[os.path.relpath(p, root)] = [st.st_size, st.st_mtime_ns]
print(json.dumps(out))
PY`;

async function makeWorker(config: SandboxConfig): Promise<Worker> {
  const workerUrl = new URL(WORKER_REL, location.href).href;
  const net = config.token ? { token: config.token, url: new URL("/v1/sandbox/net", location.href).href, internet: config.internet } : null;
  const res = await fetch(workerUrl);
  if (!res.ok) throw new Error(`could not load the sandbox worker: HTTP ${res.status}`);
  const src = await res.text();
  if (!src.includes(ANCHOR)) throw new Error("the sandbox worker build changed shape: anchor not found (wasmsh upgrade?)");
  const lockdown = workerLockdown(workerUrl, net);
  const BOOT_ANCHOR = "runtimeBridge = runtimeBridgeModule().createRuntimeBridge(module);";
  if (!src.includes(BOOT_ANCHOR)) throw new Error("the sandbox worker build changed shape: boot anchor not found (wasmsh upgrade?)");
  if (!src.includes(PYODIDE_ANCHOR) || !src.includes("function createNetworkStubs(")) {
    throw new Error("the sandbox worker build changed shape: pyodide anchor not found (wasmsh upgrade?)");
  }
  const patched = (lockdown + src.split(ANCHOR).join(JSON.stringify(workerUrl)))
    .replace(PYODIDE_ANCHOR, `${WIRE_HTTP_FETCH}\n  ${PYODIDE_ANCHOR}`)
    .replace(BOOT_ANCHOR, `${BOOT_ANCHOR}\n  self.__sandboxLockEval && self.__sandboxLockEval();`);
  return new Worker(URL.createObjectURL(new Blob([patched], { type: "text/javascript" })));
}

let session: WasmshSession | null = null;
let booting: Promise<WasmshSession> | null = null;
let config: SandboxConfig | null = null;
let configured: (() => void) | null = null;
const whenConfigured = new Promise<void>((resolve) => {
  configured = resolve;
});

async function boot(): Promise<WasmshSession> {
  if (session) return session;
  await whenConfigured;
  if (!booting) {
    const cfg = config!;
    booting = (async () => {
      const worker = await makeWorker(cfg);
      const s = await createBrowserWorkerSession({
        worker,
        assetBaseUrl: new URL(ASSETS_REL, location.href).href,
        // a generous step budget: the engine's timeout is the wall-clock cap,
        // this stops runaway shell loops from wedging the worker forever
        stepBudget: 500_000_000,
        // the runtime checks hosts before the worker's HTTP runs: with
        // internet on, every name under a TLD passes and the proxy decides.
        // The git host passes either way: the engine answers it itself
        allowedHosts: !cfg.token ? [] : cfg.internet ? [SANDBOX_GIT_HOST, ...TOP_LEVEL_DOMAINS.map((tld) => `*.${tld}`)] : [SANDBOX_GIT_HOST],
        timeoutMs: 0,
      });
      // cd and git wrappers (see prelude.ts)
      await s.run(SHELL_PRELUDE);
      session = s;
      return s;
    })().catch((e) => {
      booting = null;
      throw e;
    });
  }
  return booting;
}

async function reset(): Promise<void> {
  const old = session;
  session = null;
  booting = null;
  try {
    await old?.close();
  } catch {
    /* already gone */
  }
}

async function handle(req: Request): Promise<void> {
  if (req.t === "config") {
    config = req.config;
    configured?.();
    return;
  }
  if (req.t === "reset") {
    await reset();
    if (req.config) config = req.config;
    post({ t: "reset-done", id: req.id });
    return;
  }
  const s = await boot();
  if (req.t === "mount") {
    let count = 0;
    for (const f of req.files) {
      await s.writeFile(vfsPath(f.path), b64ToBytes(f.b64));
      count++;
    }
    post({ t: "mounted", id: req.id, count });
    return;
  }
  if (req.t === "run") {
    const out = await s.run(`cd /workspace\n${req.command}`);
    post({ t: "run-result", id: req.id, exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr, timedOut: false, truncated: false });
    return;
  }
  if (req.t === "manifest") {
    const out = await s.run(MANIFEST_PY);
    let entries: Record<string, [number, number]> = {};
    const text = out.stdout.trim();
    if (text) {
      try {
        entries = JSON.parse(text.split("\n").pop() ?? "{}") as Record<string, [number, number]>;
      } catch {
        throw new Error("could not read the sandbox file manifest");
      }
    }
    post({ t: "manifest", id: req.id, entries });
    return;
  }
  if (req.t === "read") {
    const files: MountFile[] = [];
    for (const rel of req.paths) {
      const r = await s.readFile(vfsPath(rel));
      files.push({ path: rel, b64: bytesToB64(r.content) });
    }
    post({ t: "read", id: req.id, files });
    return;
  }
  // rm
  const out = await s.run(`cd /workspace\nrm -rf -- ${req.paths.map(shellQuote).join(" ")}`);
  post({ t: "rm", id: req.id, exitCode: out.exitCode });
}

addEventListener("message", (e: MessageEvent) => {
  if (e.source !== parent) return;
  const d = e.data as Request & { __chrysalisSandbox?: number };
  if (!d || d.__chrysalisSandbox !== 1) return;
  void handle(d).catch((err) => post({ t: "error", id: "id" in d ? d.id : undefined, error: String((err as Error)?.message ?? err) }));
});

post({ t: "hello" });
void boot()
  .then(() => post({ t: "ready", version: typeof __SANDBOX_VERSION__ === "string" ? __SANDBOX_VERSION__ : "dev" }))
  .catch((e) => post({ t: "fatal", error: String((e as Error)?.message ?? e) }));
