/**
 * The browser sandbox host bundle (src/sandbox/browser/*), built on demand
 * with esbuild and served to the shell. The runtime it drives (shell, git,
 * python, node) is served from /client/sandbox/k/ out of the sandbox release.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const here = import.meta.dir;
const ENGINE_ROOT = path.resolve(here, "../..");

const ENTRIES = { "host.js": "host.ts" } as const;

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
