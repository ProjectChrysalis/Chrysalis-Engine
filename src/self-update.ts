/**
 * A downloaded copy of Chrysalis (Windows, macOS, Linux, portable or not)
 * updates itself: an admin presses Update, the engine downloads its release
 * archive, swaps its own program file and resources/ for the new ones, and
 * restarts. config.yaml and data/ are never touched, so a portable copy stays
 * portable with nothing to move.
 *
 * The swap renames rather than overwrites: a running program can be renamed
 * on every platform (Windows included) but not replaced. The old files are
 * left as *.old and removed on the next start.
 *
 * The restart keeps this process as a thin parent: it stops serving, runs the
 * new program with the same arguments and terminal, passes Ctrl+C along, and
 * exits with the new program's code. A terminal, a double-clicked window or a
 * service manager keeps watching the same process it started.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { INSTALL_KIND, IN_CONTAINER } from "./install.js";
import { log } from "./logger.js";
import type { ReleaseAsset } from "./updates.js";

const run = promisify(execFile);

/** This copy can replace itself: a downloaded program, not a container,
 *  source checkout, npm package or Android app. */
export const SELF_UPDATE = INSTALL_KIND === "binary" && !IN_CONTAINER;

/** The download name for this computer, as the release archives use it. */
export function platformTarget(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  return `${os}-${arch === "arm64" ? "arm64" : "x64"}`;
}

/** This computer's archive among a release's assets. */
export function pickAsset(assets: unknown, target: string = platformTarget()): ReleaseAsset | null {
  if (!Array.isArray(assets)) return null;
  for (const a of assets as { name?: unknown; browser_download_url?: unknown; size?: unknown }[]) {
    if (typeof a?.name !== "string" || typeof a.browser_download_url !== "string" || typeof a.size !== "number") continue;
    if (!/^Chrysalis-.+\.(?:zip|tar\.gz)$/.test(a.name) || !a.name.replace(/\.(?:zip|tar\.gz)$/, "").endsWith(`-${target}`)) continue;
    if (!a.browser_download_url.startsWith("https://github.com/")) continue;
    return { name: a.name, url: a.browser_download_url, size: a.size };
  }
  return null;
}

export type UpdatePhase = "idle" | "downloading" | "installing" | "restarting" | "failed";
export interface UpdateState {
  phase: UpdatePhase;
  version?: string;
  error?: string;
}

let state: UpdateState = { phase: "idle" };
export const updateState = (): UpdateState => state;

const programDir = () => path.dirname(process.execPath);
const OLD = ".old";

/** Remove what an earlier update left behind. A file still held by the
 *  previous process stays until the next start. */
export function cleanUpAfterUpdate(dir: string = programDir()): void {
  if (!SELF_UPDATE && dir === programDir()) return;
  for (const name of fs.readdirSync(dir)) {
    if (name === ".update" || name.endsWith(OLD)) {
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      } catch { /* in use: next start */ }
    }
  }
}

/** The folder inside an unpacked archive that holds the program. */
function findProgram(unpacked: string, exe: string): string {
  const candidates = [unpacked, ...fs.readdirSync(unpacked).map((n) => path.join(unpacked, n))];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, exe)) && fs.existsSync(path.join(dir, "resources"))) return dir;
  }
  throw new Error(`the download has no ${exe} with a resources folder`);
}

async function extract(archive: string, into: string): Promise<void> {
  fs.mkdirSync(into, { recursive: true });
  // Windows' own tar reads zip; a Git Bash tar earlier on PATH would not
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  await run(tar, ["-xf", archive, "-C", into], { maxBuffer: 16 * 1024 * 1024 });
}

/** Put the new program and resources/ in place of the old ones. Anything
 *  already moved is moved back if a later step fails. */
export function swapProgram(dir: string, fresh: string, exe: string): void {
  const done: [from: string, to: string][] = [];
  const move = (from: string, to: string) => {
    fs.renameSync(from, to);
    done.push([from, to]);
  };
  for (const name of [exe, "resources"]) fs.rmSync(path.join(dir, name + OLD), { recursive: true, force: true });
  try {
    move(path.join(dir, exe), path.join(dir, exe + OLD));
    move(path.join(dir, "resources"), path.join(dir, "resources" + OLD));
    move(path.join(fresh, exe), path.join(dir, exe));
    move(path.join(fresh, "resources"), path.join(dir, "resources"));
  } catch (e) {
    for (const [from, to] of done.reverse()) {
      try {
        fs.renameSync(to, from);
      } catch { /* leave it for the error below */ }
    }
    throw e;
  }
  if (process.platform !== "win32") fs.chmodSync(path.join(dir, exe), 0o755);
  try {
    fs.copyFileSync(path.join(fresh, "README.txt"), path.join(dir, "README.txt"));
  } catch { /* optional */ }
}

/** Download and install a release, then restart into it. Runs in the
 *  background; updateState() reports progress. */
export function startUpdate(version: string, asset: ReleaseAsset, restart: () => Promise<void>): UpdateState {
  if (!SELF_UPDATE) return { phase: "failed", error: "this copy of Chrysalis cannot update itself" };
  if (state.phase === "downloading" || state.phase === "installing" || state.phase === "restarting") return state;
  state = { phase: "downloading", version };
  void (async () => {
    const dir = programDir();
    const work = path.join(dir, ".update");
    try {
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
      const archive = path.join(work, asset.name);
      const res = await fetch(asset.url, { signal: AbortSignal.timeout(20 * 60_000), redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
      // chunk by chunk: writing the whole response in one call stalls on
      // bodies this large
      const fd = fs.openSync(archive, "w");
      let written = 0;
      try {
        for await (const chunk of res.body) {
          written += chunk.length;
          if (written > asset.size) throw new Error("the download is larger than the release says");
          fs.writeSync(fd, chunk);
        }
      } finally {
        fs.closeSync(fd);
      }
      if (written !== asset.size) throw new Error("the download was incomplete");
      state = { phase: "installing", version };
      await extract(archive, path.join(work, "unpacked"));
      const exe = path.basename(process.execPath);
      swapProgram(dir, findProgram(path.join(work, "unpacked"), exe), exe);
      log.info(`[update] installed Chrysalis ${version}, restarting`);
      state = { phase: "restarting", version };
      await restart();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const error = code === "EACCES" || code === "EPERM" || code === "EBUSY"
        ? `Chrysalis could not replace its own files in ${dir} (${code}). If another program has them open, close it and try again; if your account cannot write there, move the folder somewhere it can.`
        : (e as Error).message;
      log.warn(`[update] ${error}`);
      state = { phase: "failed", version, error };
      fs.rmSync(work, { recursive: true, force: true });
    }
  })();
  return state;
}

/** Run the installed program in this one's place and mirror its life. Call
 *  after this process has stopped serving and released its port. */
export function runReplacement(): void {
  const child = spawn(process.execPath, process.argv.slice(2), {
    stdio: "inherit",
    env: { ...process.env, CHRYSALIS_UPDATED: "1" },
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.removeAllListeners(sig);
    process.on(sig, () => child.kill(sig));
  }
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on("error", (e) => {
    log.error(`[update] could not start the new version: ${e.message}`);
    process.exit(1);
  });
}
