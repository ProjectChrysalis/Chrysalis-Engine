/**
 * A downloaded copy of Chrysalis (Windows, macOS, Linux, portable or not)
 * updates itself: an admin presses Update, the engine downloads its release
 * archive, checks it, swaps its own program file and resources/ for the new
 * ones, and restarts. config.yaml and data/ are never replaced, so a portable
 * copy stays portable with nothing to move.
 *
 * Nothing is swapped in that has not proven itself: the download must match
 * the release's size and checksum, and the new program must run on this
 * computer and report the version it claims before the old one is moved.
 *
 * The swap renames rather than overwrites: a running program can be renamed
 * on every platform (Windows included) but not replaced. The old files stay
 * as *.old until a later normal start, so an update can still be undone.
 *
 * The restart keeps this process as a thin parent: it stops serving, runs the
 * new program with the same arguments and terminal, passes Ctrl+C along, and
 * exits with the new program's code. A terminal, a double-clicked window or a
 * service manager keeps watching the same process it started. Until the new
 * version has served for a while, the parent also stands guard: if it exits
 * first, the parent moves the old program back, restores the account files
 * it saved before the restart, and runs the old version again, which reports
 * what went wrong in Settings.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ENGINE_VERSION, INSTALL_KIND, IN_CONTAINER } from "./install.js";
import { readLock } from "./lock.js";
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

/** This computer's archive among a release's assets. An asset still being
 *  uploaded is not offered. */
export function pickAsset(assets: unknown, target: string = platformTarget()): ReleaseAsset | null {
  if (!Array.isArray(assets)) return null;
  for (const a of assets as { name?: unknown; browser_download_url?: unknown; size?: unknown; state?: unknown; digest?: unknown }[]) {
    if (typeof a?.name !== "string" || typeof a.browser_download_url !== "string" || typeof a.size !== "number") continue;
    if (a.state !== undefined && a.state !== "uploaded") continue;
    if (!/^Chrysalis-.+\.(?:zip|tar\.gz)$/.test(a.name) || !a.name.replace(/\.(?:zip|tar\.gz)$/, "").endsWith(`-${target}`)) continue;
    if (!a.browser_download_url.startsWith("https://github.com/")) continue;
    const sha256 = typeof a.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest)?.[1]?.toLowerCase() : undefined;
    return { name: a.name, url: a.browser_download_url, size: a.size, ...(sha256 ? { sha256 } : {}) };
  }
  return null;
}

export type UpdatePhase = "idle" | "downloading" | "installing" | "restarting" | "failed";
export interface UpdateState {
  phase: UpdatePhase;
  version?: string;
  error?: string;
}

/** Set by the parent when it had to go back to this version. */
const FAILED_ENV = "CHRYSALIS_UPDATE_FAILED";
/** Set on the new version's first run, while the parent can still undo it. */
const UPDATED_ENV = "CHRYSALIS_UPDATED";

function initialState(): UpdateState {
  const raw = process.env[FAILED_ENV];
  delete process.env[FAILED_ENV];
  if (!raw) return { phase: "idle" };
  try {
    const failed = JSON.parse(raw) as { version?: unknown; error?: unknown };
    return {
      phase: "failed",
      ...(typeof failed.version === "string" ? { version: failed.version } : {}),
      error: typeof failed.error === "string" ? failed.error : "the update did not start",
    };
  } catch {
    return { phase: "failed", error: "the update did not start" };
  }
}

let state: UpdateState = initialState();
export const updateState = (): UpdateState => state;

const programDir = () => path.dirname(process.execPath);
const OLD = ".old";
const FAILED = ".failed";
/** Files a still-running process holds are set aside under a stamped name
 *  rather than deleted. */
const OLD_NAME = /\.old(?:-\d+)?$/;
const FAILED_NAME = /\.failed(?:-\d+)?$/;

/** Remove what an earlier update left behind. The *.old files stay while the
 *  version that replaced them is on its first run: they are how that run is
 *  undone. A file still held by a previous process stays until the next
 *  start. */
export function cleanUpAfterUpdate(dir: string = programDir(), firstRun: boolean = process.env[UPDATED_ENV] === "1"): void {
  if (!SELF_UPDATE && dir === programDir()) return;
  for (const name of fs.readdirSync(dir)) {
    if (name === ".update" || FAILED_NAME.test(name) || (!firstRun && OLD_NAME.test(name))) {
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

/** The new program must start on this computer and say it is the version the
 *  release names. A build for the wrong CPU, a missing system library or a
 *  mislabelled archive fails here, while the old program is still in place. */
export async function checkProgram(program: string, version: string): Promise<void> {
  if (process.platform !== "win32") fs.chmodSync(program, 0o755);
  let out: string;
  try {
    ({ stdout: out } = await run(program, ["--version"], { timeout: 60_000, maxBuffer: 1024 * 1024 }));
  } catch (e) {
    throw new Error(`the new version does not run on this computer: ${(e as Error).message.split("\n")[0]}`);
  }
  const said = out.trim().split("\n").pop()?.trim() ?? "";
  if (said !== version) throw new Error(`the download says it is Chrysalis ${said || "(nothing)"}, not ${version}`);
}

/** Set aside a name an earlier version may still be running from. */
function setAside(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    fs.renameSync(target, `${target}-${Date.now()}`);
  }
}

/** Put the new program and resources/ in place of the old ones. Anything
 *  already moved is moved back if a later step fails. */
export function swapProgram(dir: string, fresh: string, exe: string): void {
  const done: [from: string, to: string][] = [];
  const move = (from: string, to: string) => {
    fs.renameSync(from, to);
    done.push([from, to]);
  };
  for (const name of [exe, "resources"]) setAside(path.join(dir, name + OLD));
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

/** Put the program and resources/ from before the update back. The files that
 *  failed are kept as *.failed until the next start. */
export function restoreProgram(dir: string, exe: string): void {
  for (const name of [exe, "resources"]) {
    const current = path.join(dir, name);
    const old = path.join(dir, name + OLD);
    if (!fs.existsSync(old)) throw new Error(`${name + OLD} is missing`);
    setAside(current + FAILED);
    if (fs.existsSync(current)) fs.renameSync(current, current + FAILED);
    fs.renameSync(old, current);
  }
}

// ---------- account files saved across a restart ----------

const SNAPSHOT = ".update-snapshot";
/** Engine-owned files a new version's first start may migrate. Workspaces are
 *  git repositories and app baselines are rebuilt from them, so neither is
 *  copied. */
const SNAPSHOT_FILES = ["users.json", "sessions.json", "format.json"];

/** Copy the engine's own account files aside before a new version starts. */
export function saveEngineFiles(dataDir: string): void {
  const into = path.join(dataDir, SNAPSHOT);
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });
  const present: string[] = [];
  for (const name of SNAPSHOT_FILES) {
    const from = path.join(dataDir, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(into, name));
    present.push(name);
  }
  const credentials = path.join(dataDir, "credentials");
  if (fs.existsSync(credentials)) {
    fs.cpSync(credentials, path.join(into, "credentials"), {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("app-upstream"),
    });
  }
  fs.writeFileSync(path.join(into, "files.json"), JSON.stringify({ files: present }) + "\n", "utf8");
}

/** Put the saved account files back: files the snapshot had are restored and
 *  files it did not have (a format marker the new version wrote) are removed.
 *  Credential files the new version added are left alone. */
export function restoreEngineFiles(dataDir: string): void {
  const from = path.join(dataDir, SNAPSHOT);
  const listed = JSON.parse(fs.readFileSync(path.join(from, "files.json"), "utf8")) as { files: string[] };
  for (const name of SNAPSHOT_FILES) {
    const target = path.join(dataDir, name);
    if (listed.files.includes(name)) fs.copyFileSync(path.join(from, name), target);
    else fs.rmSync(target, { force: true });
  }
  const credentials = path.join(from, "credentials");
  if (fs.existsSync(credentials)) fs.cpSync(credentials, path.join(dataDir, "credentials"), { recursive: true, force: true });
}

/** Forget saved account files (after a healthy start, or a stale leftover). */
export function dropEngineFiles(dataDir: string): void {
  fs.rmSync(path.join(dataDir, SNAPSHOT), { recursive: true, force: true });
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
      const hash = crypto.createHash("sha256");
      const fd = fs.openSync(archive, "w");
      let written = 0;
      try {
        for await (const chunk of res.body) {
          written += chunk.length;
          if (written > asset.size) throw new Error("the download is larger than the release says");
          hash.update(chunk);
          fs.writeSync(fd, chunk);
        }
      } finally {
        fs.closeSync(fd);
      }
      if (written !== asset.size) throw new Error("the download was incomplete");
      if (asset.sha256 && hash.digest("hex") !== asset.sha256) throw new Error("the download does not match the release's checksum");
      state = { phase: "installing", version };
      await extract(archive, path.join(work, "unpacked"));
      const exe = path.basename(process.execPath);
      const fresh = findProgram(path.join(work, "unpacked"), exe);
      await checkProgram(path.join(fresh, exe), version);
      swapProgram(dir, fresh, exe);
      fs.rmSync(work, { recursive: true, force: true });
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

/** How the restart runs. Everything but dataDir defaults to this process. */
export interface ReplacementOptions {
  dataDir: string;
  /** The program folder and file name the update replaced. */
  dir?: string;
  exe?: string;
  /** What to run: this program with this process's arguments. */
  command?: string;
  args?: string[];
  /** How long the new version must keep answering before the update counts. */
  proveMs?: number;
  /** Pass Ctrl+C and termination on to the child. */
  forwardSignals?: boolean;
  exit?: (code: number) => void;
}

/** Run the program in this process's place and mirror its life: its exit
 *  code becomes ours, and Ctrl+C and termination pass through. */
function mirror(
  opts: Required<Omit<ReplacementOptions, "dataDir" | "proveMs">>,
  env: NodeJS.ProcessEnv,
  onExit: (code: number | null, signal: NodeJS.Signals | null, stopRequested: boolean) => void,
): ChildProcess {
  const child = spawn(opts.command, opts.args, { stdio: "inherit", env });
  let stopRequested = false;
  if (opts.forwardSignals) {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.removeAllListeners(sig);
      process.on(sig, () => {
        stopRequested = true;
        child.kill(sig);
      });
    }
  }
  let ended = false;
  const end = (code: number | null, signal: NodeJS.Signals | null) => {
    if (ended) return;
    ended = true;
    onExit(code, signal, stopRequested);
  };
  child.on("exit", end);
  child.on("error", (e) => {
    log.error(`[update] could not start Chrysalis: ${e.message}`);
    end(1, null);
  });
  return child;
}

/**
 * Run the installed program in this one's place. Call after this process has
 * stopped serving and released its port. Until the new version has answered
 * on its address for proveMs, an exit is treated as a failed update and this
 * version comes back instead.
 */
export function runReplacement(options: ReplacementOptions): void {
  const { dataDir } = options;
  const opts = {
    dir: options.dir ?? programDir(),
    exe: options.exe ?? path.basename(process.execPath),
    command: options.command ?? process.execPath,
    args: options.args ?? process.argv.slice(2),
    forwardSignals: options.forwardSignals ?? true,
    exit: options.exit ?? ((code: number) => process.exit(code)),
  };
  const proveMs = options.proveMs ?? 15_000;
  const exitWith = (code: number | null, signal: NodeJS.Signals | null) => opts.exit(code ?? (signal ? 1 : 0));
  const target = state.version ?? "";
  let saved = false;
  try {
    saveEngineFiles(dataDir);
    saved = true;
  } catch (e) {
    log.warn(`[update] could not save account files before restarting: ${(e as Error).message}`);
  }
  let proven = false;
  let answeringSince = 0;
  const child = mirror(opts, { ...process.env, [UPDATED_ENV]: "1" }, (code, signal, stopRequested) => {
    clearInterval(watch);
    if (proven || stopRequested) return exitWith(code, signal);
    const reason = signal ? `stopped by ${signal}` : `exited with code ${code}`;
    const error = `Chrysalis ${target} stopped before it finished starting (${reason}), so Chrysalis went back to ${ENGINE_VERSION}. The log has the details.`;
    log.error(`[update] ${error}`);
    try {
      restoreProgram(opts.dir, opts.exe);
    } catch (e) {
      log.error(`[update] could not put Chrysalis ${ENGINE_VERSION} back: ${(e as Error).message}`);
      return exitWith(1, null);
    }
    if (saved) {
      try {
        restoreEngineFiles(dataDir);
        dropEngineFiles(dataDir);
      } catch (e) {
        log.error(`[update] could not restore account files: ${(e as Error).message}`);
      }
    }
    mirror(opts, { ...process.env, [UPDATED_ENV]: "", [FAILED_ENV]: JSON.stringify({ version: target, error }) }, exitWith);
  });
  const watch = setInterval(() => {
    void (async () => {
      const lock = readLock(dataDir);
      if (!lock || lock.pid !== child.pid || proven) return;
      try {
        const res = await fetch(`${lock.url}/v1/health`, { signal: AbortSignal.timeout(2000), tls: { rejectUnauthorized: false } });
        const body = (await res.json()) as { instance?: string };
        if (body.instance !== lock.instance) return;
      } catch {
        answeringSince = 0;
        return;
      }
      answeringSince ||= Date.now();
      if (Date.now() - answeringSince < proveMs || proven) return;
      proven = true;
      clearInterval(watch);
      dropEngineFiles(dataDir);
      log.info(`[update] Chrysalis ${target} is running`);
    })();
  }, Math.min(1000, Math.max(100, proveMs / 5)));
  watch.unref();
}
