/**
 * The browser sandbox's own code and the wasmsh runtime assets. Both are
 * engine code (trusted), served to the sandbox frame: the host/frame bundles
 * are built on demand from src/sandbox/browser/*, and the wasmsh package
 * files (worker + Pyodide assets) come straight from node_modules.
 *
 * The frame is sandboxed to an opaque origin, so its fetches for these assets
 * are cross-origin (Origin: null): every route here answers with CORS open and
 * no credentials, and serves only these files — nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { INSTALL_KIND, resourcesDir } from "../install.js";
import { readPrebuilt } from "../prebuilt.js";

const here = import.meta.dir;
const ENGINE_ROOT = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

const ENTRIES = { "host.js": "host.ts", "frame.js": "frame.ts" } as const;

/** Where the wasmsh npm package lives (a packaged copy ships its runtime
 *  files in resources/prebuilt/wasmsh). Files are served under wasmsh/ from
 *  this directory, nothing outside it. */
function wasmshDir(): string {
  if (INSTALL_KIND !== "source") return path.join(resourcesDir(), "prebuilt", "wasmsh");
  return path.dirname(require.resolve("@mayflowergmbh/wasmsh-pyodide/package.json"));
}

interface Built {
  key: string;
  version: string;
  files: Map<string, { body: Buffer; type: string }>;
}

let built: Promise<Built> | null = null;

/** Newest mtime under src/sandbox plus the wasmsh package version: a change
 *  to either means a new bundle and a new cache key. */
function sourceKey(): string {
  let newest = 0;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(here);
  let pkg = "wasmsh";
  try {
    pkg = String((JSON.parse(fs.readFileSync(path.join(wasmshDir(), "package.json"), "utf8")) as { version?: string }).version ?? pkg);
  } catch {
    /* package missing — the build below reports it */
  }
  return `${newest}:${pkg}`;
}

async function build(key: string): Promise<Built> {
  const esbuild = await import("esbuild");
  const version = crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
  const files: Built["files"] = new Map();
  for (const [out, src] of Object.entries(ENTRIES)) {
    const r = await esbuild.build({
      entryPoints: [path.join(here, "browser", src)],
      absWorkingDir: ENGINE_ROOT,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2020",
      minify: true,
      write: false,
      logLevel: "silent",
      define: {
        __SANDBOX_VERSION__: JSON.stringify(version),
        // the wasmsh browser adapter computes default paths from import.meta;
        // we always pass explicit URLs instead, so a fixed base is fine
        "import.meta.url": JSON.stringify("/client/sandbox/wasmsh/browser.js"),
      },
    });
    const body = Buffer.from(r.outputFiles[0]!.contents);
    files.set(out, { body, type: "text/javascript; charset=utf-8" });
  }
  const html = `<!doctype html><meta charset="utf-8"><title>sandbox</title><script src="/client/sandbox/frame.js?v=${version}"></script>`;
  files.set("frame.html", { body: Buffer.from(html), type: "text/html; charset=utf-8" });
  return { key, version, files };
}

async function current(): Promise<Built> {
  if (INSTALL_KIND !== "source") {
    built ??= readPrebuilt(path.join(resourcesDir(), "prebuilt", "sandbox")).then(({ version, files }) => ({ key: version, version, files }));
    return built;
  }
  const key = sourceKey();
  if (built) {
    const b = await built.catch(() => null);
    if (b && b.key === key) return b;
  }
  built = build(key);
  return built;
}

/** Bundle from source now, for writing a prebuilt copy; also names the
 *  wasmsh package directory whose runtime files ship beside it. */
export async function buildSandboxForRelease(): Promise<{ version: string; files: Map<string, { body: Buffer; type: string }>; wasmshDir: string }> {
  return { ...(await build(sourceKey())), wasmshDir: wasmshDir() };
}

export async function sandboxVersion(): Promise<string> {
  return (await current()).version;
}

export async function sandboxAsset(name: string): Promise<{ body: Buffer; type: string } | null> {
  return (await current()).files.get(name) ?? null;
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".whl": "application/octet-stream",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
};

/** A file from the wasmsh package, by path relative to the package root. Only
 *  the runtime files the worker needs are exposed: the worker bundle itself,
 *  its helper modules, and the Pyodide assets. */
export function wasmshAsset(rel: string): { body: Buffer; type: string } | null {
  if (!(rel === "browser-worker.js" || rel.startsWith("lib/") || rel.startsWith("assets/"))) return null;
  if (rel.split("/").includes("..")) return null;
  const base = wasmshDir();
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return { body: fs.readFileSync(full), type: MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream" };
}

/** The sandbox frame's policy: opaque origin, scripts and asset fetches only
 *  from the engine, workers from blobs (the wasmsh worker is wrapped in one),
 *  eval/wasm for Pyodide, no other network at all. Firefox checks a worker's
 *  own module imports against worker-src, so the engine is listed there too. */
export function sandboxFrameCsp(origin: string): string {
  return (
    "sandbox allow-scripts; default-src 'none'; " +
    `script-src ${origin} 'unsafe-eval' 'wasm-unsafe-eval'; worker-src blob: ${origin}; ` +
    `connect-src ${origin}; img-src 'none'; style-src 'none'; font-src 'none'; media-src 'none'; ` +
    `frame-ancestors ${origin}; base-uri 'none'; form-action 'none'; webrtc 'block'`
  );
}
