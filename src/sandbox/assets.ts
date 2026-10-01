/**
 * The browser sandbox bundles (src/sandbox/browser/*), built on demand with
 * esbuild: host.js runs in the shell page, frame.js in the sandboxed frame.
 * The runtime the frame loads (shell, git, python, node) is served from
 * /client/sandbox/r/<version>/ out of the sandbox release.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { INSTALL_KIND, resourcesDir } from "../install.js";
import { readPrebuilt } from "../prebuilt.js";

const here = import.meta.dir;
const ENGINE_ROOT = path.resolve(here, "../..");

const ENTRIES = { "host.js": "host.ts", "frame.js": "frame.ts" } as const;

interface Built {
  key: string;
  version: string;
  files: Map<string, { body: Buffer; type: string }>;
}

let built: Promise<Built> | null = null;

/** Newest mtime under src/sandbox: a change means a new bundle/cache key. */
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
  return String(newest);
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
      define: { __SANDBOX_VERSION__: JSON.stringify(version) },
    });
    files.set(out, { body: Buffer.from(r.outputFiles[0]!.contents), type: "text/javascript; charset=utf-8" });
  }
  return { key, version, files };
}

async function current(): Promise<Built> {
  // a packaged copy has no sources to bundle: dist wrote these ahead of time
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

export async function buildSandboxForRelease(): Promise<{ version: string; files: Map<string, { body: Buffer; type: string }> }> {
  const b = await build(sourceKey());
  return { version: b.version, files: b.files };
}

export async function sandboxVersion(): Promise<string> {
  return (await current()).version;
}

export async function sandboxAsset(name: string): Promise<{ body: Buffer; type: string } | null> {
  return (await current()).files.get(name) ?? null;
}

/** The sandbox frame's policy: an opaque origin whose scripts come from the
 *  engine's sandbox paths and whose only connections are the runtime files,
 *  the network proxy and the workspace file route. */
export function sandboxFrameCsp(origin: string): string {
  return (
    "sandbox allow-scripts; default-src 'none'; " +
    `script-src ${origin}/client/sandbox/ 'wasm-unsafe-eval'; worker-src blob:; ` +
    `connect-src ${origin}/client/sandbox/r/ ${origin}/v1/sandbox/proxy ${origin}/v1/sandbox/file; ` +
    "img-src 'none'; style-src 'none'; font-src 'none'; media-src 'none'; " +
    `frame-ancestors ${origin}; base-uri 'none'; form-action 'none'`
  );
}
