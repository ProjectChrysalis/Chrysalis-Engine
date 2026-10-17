// An app's package dependencies: `bun install --ignore-scripts` in the app dir.
// Nothing from the installed packages ever runs on the host: install scripts
// are off, and the builder that reads node_modules runs in the browser's
// sandbox (src/builder). The engine only downloads files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { abortable } from "../cancellation.js";
import { INSTALL_KIND } from "../install.js";

export interface InstallResult {
  ok: boolean;
  log: string;
  ms: number;
}

const SCRUB = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
const scrubEnv = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && !SCRUB.test(k)) out[k] = v;
  }
  return out;
};

/** App dirs with a package operation running, each chained behind the one
 *  before it. A build during one reads a half-written node_modules, so the
 *  builder waits while an app is listed here. */
const running = new Map<string, Promise<InstallResult>>();

/** Is a package install or removal running for this app? */
export function packagesBusy(appDir: string): boolean {
  return running.has(path.resolve(appDir));
}

/** One package operation per app at a time: two installs writing the same
 *  node_modules leave it in neither state. */
function exclusive(appDir: string, run: () => Promise<InstallResult>): Promise<InstallResult> {
  const key = path.resolve(appDir);
  const next = (running.get(key) ?? Promise.resolve()).then(run);
  running.set(key, next);
  void next.then(() => {
    if (running.get(key) === next) running.delete(key);
  });
  return next;
}

/** Packages are hardlinked out of the install cache. Android app storage
 *  cannot link across directories, so only there are they copied: a copy is
 *  a new file, and on Windows the virus scanner inspects each one the first
 *  time the builder reads it (tens of seconds per build, against under one
 *  for cache files it has already seen). */
const LINK_BACKEND = INSTALL_KIND === "android" ? ["--backend=copyfile"] : [];

/** Does this app declare package dependencies? */
export function hasPackages(appDir: string): boolean {
  return fs.existsSync(path.join(appDir, "package.json"));
}

/** Run Bun's package manager in an app. The engine's own executable is Bun:
 *  from source it is the bun that runs the engine, and a compiled engine
 *  acts as the full Bun CLI when BUN_BE_BUN is set. Nobody has to install
 *  Bun separately, and no shell ever sees the package names. */
function runBun(appDir: string, args: string[], signal?: AbortSignal, env: NodeJS.ProcessEnv = {}): Promise<InstallResult> {
  return new Promise((resolve) => {
    signal?.throwIfAborted();
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: appDir,
      env: { ...scrubEnv(), ...env, BUN_BE_BUN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cancel = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    let out = "";
    const sink = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 128 * 1024) out = out.slice(-128 * 1024);
    };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve({ ok: false, log: String(e), ms: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve({ ok: code === 0, log: out.trim() || (code === 0 ? "" : `bun ${args[0]} failed`), ms: Date.now() - started });
    });
  });
}

export function installApp(appDir: string, signal?: AbortSignal): Promise<InstallResult> {
  if (!hasPackages(appDir)) return Promise.resolve({ ok: false, log: "no package.json in this app", ms: 0 });
  // `bun install` does NOT remove packages taken out of package.json —
  // uninstallApp does that.
  return abortable(exclusive(appDir, async () => {
    const r = await runBun(appDir, ["install", "--ignore-scripts", ...LINK_BACKEND], signal);
    if (!r.ok || !damagedPackages(appDir).length) return r;
    repaired.add(path.resolve(appDir));
    return reinstallClean(appDir, signal);
  }), signal);
}

/**
 * Installed packages that cannot be what they claim: a package.json that
 * does not parse, or one of `suspects` (app-relative files a build failed
 * on) starting with a control byte. Packages are linked out of a download
 * cache that lives outside the engine's folders, so one bad cache entry
 * damages every install of that package until the cache is bypassed.
 */
export function damagedPackages(appDir: string, suspects: readonly string[] = []): string[] {
  const root = path.join(appDir, "node_modules");
  const out = new Set<string>();
  const check = (name: string) => {
    const file = path.join(root, name, "package.json");
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return; // folders without a manifest (a scope's leftovers) are not packages
    }
    try {
      JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      out.add(name);
    }
  };
  let top: fs.Dirent[] = [];
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of top) {
    if (e.name.startsWith(".") || !e.isDirectory()) continue;
    if (!e.name.startsWith("@")) { check(e.name); continue; }
    try {
      for (const inner of fs.readdirSync(path.join(root, e.name), { withFileTypes: true })) {
        if (inner.isDirectory()) check(`${e.name}/${inner.name}`);
      }
    } catch { /* scope folder vanished */ }
  }
  for (const rel of suspects) {
    const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(rel.replace(/\\/g, "/"));
    if (!m) continue;
    try {
      const fd = fs.openSync(path.join(appDir, rel), "r");
      const head = Buffer.alloc(1);
      const n = fs.readSync(fd, head, 0, 1, 0);
      fs.closeSync(fd);
      // a control byte no text file starts with (tab, newline and CR do)
      const b = head[0] ?? 0x20;
      if (n === 1 && b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) out.add(m[1]!);
    } catch { /* missing files are a resolve error, not damage */ }
  }
  return [...out];
}

/** Apps whose packages were reinstalled clean during this run: a second
 *  damaged result means the damage is not in the cache, and repeating the
 *  download would loop. */
const repaired = new Set<string>();

/** node_modules from scratch, with a download cache of its own that is
 *  thrown away after: nothing comes from the shared cache, and files are
 *  copied, not linked, so none of them shares its bytes with a cache file. */
async function reinstallClean(appDir: string, signal?: AbortSignal): Promise<InstallResult> {
  fs.rmSync(path.join(appDir, "node_modules"), { recursive: true, force: true });
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-packages-"));
  try {
    return await runBun(appDir, ["install", "--ignore-scripts", "--force", "--backend=copyfile"], signal, { BUN_INSTALL_CACHE_DIR: cache });
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

/**
 * Reinstall an app's packages clean when they are damaged (see
 * damagedPackages), at most once per app per run. Resolves true when a
 * reinstall ran and left nothing damaged, so the caller rebuilds.
 */
export function repairPackages(appDir: string, suspects: readonly string[] = []): Promise<boolean> {
  const key = path.resolve(appDir);
  if (repaired.has(key) || running.has(key) || !hasPackages(appDir)) return Promise.resolve(false);
  const damaged = damagedPackages(appDir, suspects);
  if (!damaged.length) return Promise.resolve(false);
  repaired.add(key);
  return exclusive(appDir, () => reinstallClean(appDir)).then((r) => r.ok && !damagedPackages(appDir, suspects).length);
}

/** Take packages out of an app: `bun remove` updates package.json, the
 *  lockfile and node_modules together. Names arrive as argv entries (no
 *  shell), but callers must still reject flag-shaped names. */
export function uninstallApp(appDir: string, packages: string[], signal?: AbortSignal): Promise<InstallResult> {
  if (!hasPackages(appDir)) return Promise.resolve({ ok: false, log: "no package.json in this app", ms: 0 });
  if (!packages.length) return Promise.resolve({ ok: false, log: "no package names given", ms: 0 });
  return abortable(exclusive(appDir, () => runBun(appDir, ["remove", ...LINK_BACKEND, ...packages], signal)), signal);
}
