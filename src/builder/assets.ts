/**
 * The builder's browser code, bundled from src/builder/browser/* by the
 * engine's own esbuild on first request (engine code, not app code) and
 * kept in memory until a source file changes. Served at /client/builder/*.
 *
 * Packaged copies have no sources or esbuild: they load the same bundle,
 * built at release time, from resources/prebuilt/builder.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { INSTALL_KIND, resourcesDir } from "../install.js";
import { readPrebuilt } from "../prebuilt.js";

const here = import.meta.dir;
const ENGINE_ROOT = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

const ENTRIES = { "frame.js": "frame.ts", "host.js": "host.ts", "runtime.js": "runtime.ts" } as const;

interface Built {
  key: string;
  version: string;
  files: Map<string, { body: Buffer; type: string; gz: Buffer | null }>;
}

let built: Promise<Built> | null = null;

/** Newest mtime under src/builder: a changed source means a rebuild. */
function sourceKey(): string {
  let newest = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(here);
  return String(newest);
}

/** Bundle the builder from source. */
export async function build(key: string): Promise<Built> {
  const esbuild = await import("esbuild");
  const wasmPath = require.resolve("esbuild-wasm/esbuild.wasm");
  const wasmBytes = fs.readFileSync(wasmPath);
  const pkgs = ["esbuild-wasm", "@babel/standalone", "react-refresh", "tailwindcss"].map((p) => {
    try {
      return `${p}@${(JSON.parse(fs.readFileSync(require.resolve(`${p}/package.json`), "utf8")) as { version: string }).version}`;
    } catch {
      return p;
    }
  });
  const version = crypto.createHash("sha256").update(key + pkgs.join(",")).digest("hex").slice(0, 12);
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
      legalComments: "none",
      loader: { ".css": "text" },
      // react-refresh/babel only reaches for crypto without emitFullSignatures
      external: ["crypto"],
      define: {
        __BUILDER_VERSION__: JSON.stringify(version),
        // the dev runtime needs React Refresh's development build
        "process.env.NODE_ENV": JSON.stringify(out === "runtime.js" ? "development" : "production"),
      },
      logLevel: "silent",
    });
    const body = Buffer.from(r.outputFiles[0]!.contents);
    files.set(out, { body, type: "text/javascript; charset=utf-8", gz: zlib.gzipSync(body) });
  }
  const html = Buffer.from(`<!doctype html><meta charset="utf-8"><title>builder</title><script src="/client/builder/frame.js?v=${version}"></script>`);
  files.set("frame.html", { body: html, type: "text/html; charset=utf-8", gz: null });
  files.set("esbuild.wasm", { body: wasmBytes, type: "application/wasm", gz: zlib.gzipSync(wasmBytes, { level: 6 }) });
  return { key, version, files };
}

async function current(): Promise<Built> {
  if (INSTALL_KIND !== "source") {
    built ??= readPrebuilt(path.join(resourcesDir(), "prebuilt", "builder")).then(({ version, files }) => {
      const out: Built["files"] = new Map();
      for (const [name, f] of files) out.set(name, { ...f, gz: name === "frame.html" ? null : zlib.gzipSync(f.body, { level: 6 }) });
      return { key: version, version, files: out };
    });
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

/** Bundle from source now, for writing a prebuilt copy. */
export async function buildBuilderForRelease(): Promise<{ version: string; files: Map<string, { body: Buffer; type: string }> }> {
  return build(sourceKey());
}

export async function builderVersion(): Promise<string> {
  return (await current()).version;
}

export async function builderAsset(name: string): Promise<{ body: Buffer; type: string; gz: Buffer | null } | null> {
  return (await current()).files.get(name) ?? null;
}

/** The builder frame's policy: opaque origin, scripts only from the engine,
 *  eval for Tailwind plugins and wasm for esbuild, no network at all. */
export function builderFrameCsp(origin: string): string {
  return (
    "sandbox allow-scripts; default-src 'none'; " +
    `script-src ${origin} 'unsafe-eval' 'wasm-unsafe-eval'; worker-src blob:; ` +
    "connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; media-src 'none'; " +
    `frame-ancestors ${origin}; base-uri 'none'; form-action 'none'; webrtc 'block'`
  );
}
