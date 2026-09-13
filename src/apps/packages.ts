// An app's package dependencies: `bun install --ignore-scripts` in the app dir.
// Nothing from the installed packages ever runs on the host: install scripts
// are off, and the builder that reads node_modules runs in the browser's
// sandbox (src/builder). The engine only downloads files.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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

/** Does this app declare package dependencies? */
export function hasPackages(appDir: string): boolean {
  return fs.existsSync(path.join(appDir, "package.json"));
}

/** Run Bun's package manager in an app. The engine's own executable is Bun:
 *  from source it is the bun that runs the engine, and a compiled engine
 *  acts as the full Bun CLI when BUN_BE_BUN is set. Nobody has to install
 *  Bun separately, and no shell ever sees the package names. */
function runBun(appDir: string, args: string[]): Promise<InstallResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: appDir,
      env: { ...scrubEnv(), BUN_BE_BUN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      resolve({ ok: false, log: String(e), ms: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, log: out.trim() || (code === 0 ? "" : `bun ${args[0]} failed`), ms: Date.now() - started });
    });
  });
}

export function installApp(appDir: string): Promise<InstallResult> {
  if (!hasPackages(appDir)) return Promise.resolve({ ok: false, log: "no package.json in this app", ms: 0 });
  // --backend=copyfile: the default hardlinks out of the install cache, which
  // fails on filesystems that cannot link across directories (Android app
  // storage). App dep trees are small; copying is the portable choice.
  // `bun install` does NOT remove packages taken out of package.json —
  // uninstallApp does that.
  return runBun(appDir, ["install", "--ignore-scripts", "--backend=copyfile"]);
}

/** Take packages out of an app: `bun remove` updates package.json, the
 *  lockfile and node_modules together. Names arrive as argv entries (no
 *  shell), but callers must still reject flag-shaped names. */
export function uninstallApp(appDir: string, packages: string[]): Promise<InstallResult> {
  if (!hasPackages(appDir)) return Promise.resolve({ ok: false, log: "no package.json in this app", ms: 0 });
  if (!packages.length) return Promise.resolve({ ok: false, log: "no package names given", ms: 0 });
  return runBun(appDir, ["remove", ...packages]);
}
