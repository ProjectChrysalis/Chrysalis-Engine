/**
 * Account backups: one account's whole Chrysalis, its workspace plus the
 * settings kept beside its credentials.
 *
 * On this device a backup is a folder under data/backups/accounts/<user>/.
 * A file unchanged since the previous backup is a hard link to that
 * backup's copy, so a backup costs only what changed. Live files are never
 * linked: the engine rewrites some in place, which would change every
 * backup sharing them. Fresh copies are clones where the filesystem has
 * them (copy on write) and full copies elsewhere; where links are refused
 * (Android app storage) every backup is a full copy.
 *
 * Off this device a backup is a tar stream: a downloaded file, or another
 * engine pulling it with a transfer code. Reading one trusts nothing in it:
 * names are checked before anything is written, only plain files are made,
 * nothing is overwritten, and sizes are counted as the bytes arrive.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENGINE_VERSION } from "./install.js";
import { log } from "./logger.js";
import { userPaths } from "./paths.js";

export type BackupLabel = "manual" | "auto" | "before-restore";

export interface BackupMeta {
  format: 1;
  kind: "chrysalis-account";
  createdAt: string;
  engine: string;
  /** The account it was taken from. */
  from: string;
  /** Whether API keys and sign-ins are inside. */
  keys: boolean;
  files: number;
  bytes: number;
}

export interface BackupInfo extends BackupMeta {
  id: string;
  label: BackupLabel;
  /** Bytes this backup copied; the rest are links to the one before. */
  added: number;
}

export interface BackupSettings {
  auto: boolean;
  /** Automatic backups kept; older ones are removed. */
  keep: number;
}

export interface BackupJob {
  kind: "backup" | "restore" | "receive";
  phase: "copying" | "uploading" | "downloading" | "receiving" | "restoring" | "done" | "failed";
  done: number;
  total: number;
  error?: string;
  finishedAt?: number;
}

export class AccountBackupError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 422 | 507 = 422) {
    super(message);
  }
}

/** Largest account a backup file or a transfer may bring in. */
export const ACCOUNT_MAX_BYTES = 64 * 1024 ** 3;

const DEFAULT_SETTINGS: BackupSettings = { auto: false, keep: 3 };
const AUTO_EVERY_MS = 24 * 60 * 60 * 1000;
const KEEP_BEFORE_RESTORE = 3;
const BACKUP_ID = /^\d{8}-\d{9}-[0-9a-f]{4}$/;

/** Settings kept beside the credentials that travel with the account.
 *  Approvals (MCP programs, service apps) never do: a program approved on
 *  one machine is approved again on the next. */
const CREDENTIAL_FILES = new Set(["connections.json", "speech.json", "mcp.json", "sandbox.json"]);
const KEY_FILE = "auth.json";
const UPSTREAM_DIR = "app-upstream";

/** Workspace folders a backup leaves out: git history stays with each
 *  device, repos/ are clones the agent made to read, and the rest the
 *  engine rebuilds. */
const SKIP_TOP = new Set([".git", "repos"]);
const SKIP_ANY = new Set(["node_modules", "dist", "__index"]);

export const accountBackupsDir = (dataDir: string, username: string): string => path.join(dataDir, "backups", "accounts", username);

// ---------- settings + jobs ----------

export function readBackupSettings(dataDir: string, username: string): BackupSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(accountBackupsDir(dataDir, username), "settings.json"), "utf8")) as Partial<BackupSettings>;
    return {
      auto: typeof raw.auto === "boolean" ? raw.auto : DEFAULT_SETTINGS.auto,
      keep: Number.isInteger(raw.keep) && (raw.keep as number) >= 1 && (raw.keep as number) <= 60 ? (raw.keep as number) : DEFAULT_SETTINGS.keep,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeBackupSettings(dataDir: string, username: string, next: BackupSettings): BackupSettings {
  if (typeof next.auto !== "boolean" || !Number.isInteger(next.keep) || next.keep < 1 || next.keep > 60) {
    throw new AccountBackupError("keep must be a whole number from 1 to 60", 400);
  }
  const dir = accountBackupsDir(dataDir, username);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ auto: next.auto, keep: next.keep }, null, 2) + "\n", "utf8");
  return { auto: next.auto, keep: next.keep };
}

/** The last automatic attempt that failed, until one succeeds. */
export function readAutoError(dataDir: string, username: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(accountBackupsDir(dataDir, username), "auto.json"), "utf8")) as { error?: unknown };
    return typeof raw.error === "string" ? raw.error : null;
  } catch {
    return null;
  }
}

function writeAutoError(dataDir: string, username: string, error: string | null): void {
  const file = path.join(accountBackupsDir(dataDir, username), "auto.json");
  if (error === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify({ error, at: new Date().toISOString() }) + "\n", "utf8");
}

const jobs = new Map<string, BackupJob>();

/** What runs (or last ran) for this account; a finished job shows for a
 *  minute. */
export function currentJob(username: string): BackupJob | null {
  const job = jobs.get(username);
  if (job?.finishedAt && Date.now() - job.finishedAt > 60_000) {
    jobs.delete(username);
    return null;
  }
  return job ?? null;
}

/** Run one backup, restore or receive for an account; another one while it
 *  runs is refused. */
export function startJob(username: string, kind: BackupJob["kind"], run: (job: BackupJob) => Promise<void>): BackupJob {
  const running = jobs.get(username);
  if (running && !running.finishedAt) throw new AccountBackupError("a backup or restore is already running for this account", 409);
  const job: BackupJob = { kind, phase: kind === "receive" ? "receiving" : kind === "restore" ? "restoring" : "copying", done: 0, total: 0 };
  jobs.set(username, job);
  void run(job).then(
    () => {
      job.phase = "done";
      job.finishedAt = Date.now();
    },
    (e: unknown) => {
      job.phase = "failed";
      job.error = (e as Error).message ?? String(e);
      job.finishedAt = Date.now();
      log.warn(`[backups] ${kind} for ${username} failed: ${job.error}`);
    },
  );
  return job;
}

// ---------- what an account is made of ----------

interface FileEntry {
  /** Path inside a backup: workspace/… or credentials/… */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/** Plain files under `root`, symlinks skipped (never followed). `skip` sees
 *  the path's segments below root. */
function walkFiles(root: string, prefix: string, skip: (segs: string[]) => boolean, out: FileEntry[]): void {
  const walk = (segs: string[]) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, ...segs), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = [...segs, entry.name];
      if (entry.isSymbolicLink() || skip(next)) continue;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) {
        const abs = path.join(root, ...next);
        try {
          const st = fs.statSync(abs);
          out.push({ rel: `${prefix}/${next.join("/")}`, abs, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* removed while listing */ }
      }
    }
  };
  walk([]);
}

const skipWorkspace = (segs: string[]): boolean =>
  (segs.length === 1 && SKIP_TOP.has(segs[0] ?? "")) ||
  (segs[0] === "apps" && segs[1] === ".staging") ||
  SKIP_ANY.has(segs.at(-1) ?? "");

/** Every file that belongs in a backup of this account, as it is now. */
export function accountFiles(dataDir: string, username: string, keys: boolean): FileEntry[] {
  const p = userPaths(dataDir, username);
  const out: FileEntry[] = [];
  walkFiles(p.root, "workspace", skipWorkspace, out);
  const creds = path.dirname(p.auth);
  for (const name of [...CREDENTIAL_FILES, ...(keys ? [KEY_FILE] : [])]) {
    const abs = path.join(creds, name);
    try {
      const st = fs.lstatSync(abs);
      if (st.isFile()) out.push({ rel: `credentials/${name}`, abs, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* not set up */ }
  }
  walkFiles(p.appUpstream, `credentials/${UPSTREAM_DIR}`, () => false, out);
  return out;
}

// ---------- backups on this device ----------

function readInfo(dir: string): BackupInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "backup.json"), "utf8")) as BackupInfo;
    if (raw.kind !== "chrysalis-account" || raw.format !== 1 || !BACKUP_ID.test(path.basename(dir))) return null;
    return { ...raw, id: path.basename(dir) };
  } catch {
    return null;
  }
}

/** This account's backups on this device, newest first. */
export function listBackups(dataDir: string, username: string): BackupInfo[] {
  const base = accountBackupsDir(dataDir, username);
  let names: string[] = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  return names
    .filter((n) => BACKUP_ID.test(n))
    .map((n) => readInfo(path.join(base, n)))
    .filter((b): b is BackupInfo => !!b)
    .sort((a, b) => b.id.localeCompare(a.id));
}

export function backupDir(dataDir: string, username: string, id: string): string {
  if (!BACKUP_ID.test(id)) throw new AccountBackupError("no such backup", 404);
  const dir = path.join(accountBackupsDir(dataDir, username), id);
  if (!readInfo(dir)) throw new AccountBackupError("no such backup", 404);
  return dir;
}

export function deleteBackup(dataDir: string, username: string, id: string): void {
  fs.rmSync(backupDir(dataDir, username, id), { recursive: true, force: true });
}

function newBackupId(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 23).replace(/[:.]/g, "")}-${crypto.randomBytes(2).toString("hex")}`;
}

/** index.tsv in a backup: size, the live file's mtime and path per line. A
 *  file whose size and mtime still match is linked, not copied. */
function readIndex(dir: string): Map<string, { size: number; mtimeMs: number }> {
  const out = new Map<string, { size: number; mtimeMs: number }>();
  let text = "";
  try {
    text = fs.readFileSync(path.join(dir, "index.tsv"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const [size, mtime, ...rest] = line.split("\t");
    if (rest.length) out.set(rest.join("\t"), { size: Number(size), mtimeMs: Number(mtime) });
  }
  return out;
}

const LINK_REFUSED = new Set(["EPERM", "EXDEV", "ENOTSUP", "EMLINK", "EACCES", "ENOSYS", "EOPNOTSUPP"]);

/** Run `fn` over `items`, `width` at a time. */
async function pool<T>(items: readonly T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
}

/** Free bytes on the disk holding `dir`, or null when it cannot be read. */
function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Back the account up on this device. An automatic backup is skipped when
 * nothing changed since the last one (resolves null).
 */
export async function createBackup(
  dataDir: string,
  username: string,
  label: BackupLabel,
  job?: BackupJob,
): Promise<BackupInfo | null> {
  const base = accountBackupsDir(dataDir, username);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const files = accountFiles(dataDir, username, true);
  const total = files.reduce((n, f) => n + f.size, 0);
  const previous = listBackups(dataDir, username)[0];
  const prevDir = previous ? path.join(base, previous.id) : null;
  const prevIndex = prevDir ? readIndex(prevDir) : new Map<string, { size: number; mtimeMs: number }>();
  const unchanged = (f: FileEntry) => {
    const was = prevIndex.get(f.rel);
    return !!was && was.size === f.size && was.mtimeMs === f.mtimeMs;
  };
  if (label === "auto" && previous && files.length === prevIndex.size && files.every(unchanged)) return null;
  const toCopy = files.filter((f) => !unchanged(f)).reduce((n, f) => n + f.size, 0);
  const free = freeBytes(base);
  if (free !== null && free < toCopy + 256 * 1024 * 1024) {
    throw new AccountBackupError(`not enough disk space: the backup needs up to ${formatBytes(toCopy)} and ${formatBytes(free)} is free`, 507);
  }

  const id = newBackupId();
  const partial = path.join(base, `.partial-${id}`);
  fs.mkdirSync(partial, { mode: 0o700 });
  if (job) job.total = total;
  let added = 0;
  let linkable = !!prevDir;
  try {
    const made = new Set<string>();
    const ensureDir = (dir: string) => {
      if (made.has(dir)) return;
      fs.mkdirSync(dir, { recursive: true });
      made.add(dir);
    };
    await pool(files, 8, async (f) => {
      const dest = path.join(partial, ...f.rel.split("/"));
      ensureDir(path.dirname(dest));
      let linked = false;
      if (linkable && prevDir && unchanged(f)) {
        try {
          await fs.promises.link(path.join(prevDir, ...f.rel.split("/")), dest);
          linked = true;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? "";
          if (LINK_REFUSED.has(code)) linkable = false;
          else if (code !== "ENOENT") throw e;
        }
      }
      if (!linked) {
        try {
          await fs.promises.copyFile(f.abs, dest, fs.constants.COPYFILE_FICLONE);
          added += f.size;
        } catch (e) {
          // deleted since it was listed: the backup is of what is left
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      if (job) job.done += f.size;
    });
    fs.writeFileSync(path.join(partial, "index.tsv"), files.map((f) => `${f.size}\t${f.mtimeMs}\t${f.rel}`).join("\n") + "\n", "utf8");
    const info: Omit<BackupInfo, "id"> = {
      format: 1,
      kind: "chrysalis-account",
      createdAt: new Date().toISOString(),
      engine: ENGINE_VERSION,
      from: username,
      keys: true,
      files: files.length,
      bytes: total,
      label,
      added,
    };
    fs.writeFileSync(path.join(partial, "backup.json"), JSON.stringify(info, null, 2) + "\n", "utf8");
    fs.renameSync(partial, path.join(base, id));
    pruneBackups(dataDir, username);
    return { ...info, id };
  } catch (e) {
    fs.rmSync(partial, { recursive: true, force: true });
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") throw new AccountBackupError("the disk filled up while backing up", 507);
    throw e;
  }
}

/** Drop automatic backups past the kept count, and all but the last few
 *  taken before a restore. Backups made by hand stay until deleted. */
function pruneBackups(dataDir: string, username: string): void {
  const { keep } = readBackupSettings(dataDir, username);
  const all = listBackups(dataDir, username);
  const drop = [
    ...all.filter((b) => b.label === "auto").slice(keep),
    ...all.filter((b) => b.label === "before-restore").slice(KEEP_BEFORE_RESTORE),
  ];
  for (const b of drop) fs.rmSync(path.join(accountBackupsDir(dataDir, username), b.id), { recursive: true, force: true });
  // a backup cut short by a stop leaves its partial folder behind
  for (const name of fs.readdirSync(accountBackupsDir(dataDir, username))) {
    if (name.startsWith(".partial-") || name.startsWith(".incoming-") || name.startsWith(".replaced-")) {
      const full = path.join(accountBackupsDir(dataDir, username), name);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > 6 * 60 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true });
      } catch { /* already gone */ }
    }
  }
}

/** Take the daily automatic backup of every account that has them on and
 *  is due. Accounts run one after another. */
export async function runAutoBackups(
  dataDir: string,
  usernames: readonly string[],
  /** Runs after each new backup (the Google Drive upload); its failure is
   *  its own to report and leaves the backup in place. */
  after?: (username: string, made: BackupInfo) => Promise<void>,
): Promise<void> {
  for (const username of usernames) {
    if (!readBackupSettings(dataDir, username).auto) continue;
    const last = listBackups(dataDir, username).find((b) => b.label !== "before-restore");
    if (last && Date.now() - Date.parse(last.createdAt) < AUTO_EVERY_MS) continue;
    const running = jobs.get(username);
    if (running && !running.finishedAt) continue;
    try {
      const made = await createBackup(dataDir, username, "auto");
      writeAutoError(dataDir, username, null);
      if (made) log.info(`[backups] backed up ${username} (${formatBytes(made.added)} new)`);
      if (made && after) await after(username, made).catch((e) => log.warn(`[backups] upload of ${username}'s backup failed: ${(e as Error).message}`));
    } catch (e) {
      writeAutoError(dataDir, username, (e as Error).message);
      log.warn(`[backups] automatic backup of ${username} failed: ${(e as Error).message}`);
    }
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// ---------- tar out ----------

interface TarSource {
  name: string;
  abs?: string;
  data?: Uint8Array;
}

const enc = new TextEncoder();

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

/** One ustar header block. Names and sizes ustar cannot hold go in a pax
 *  record before it. */
function tarHeader(name: string, size: number, mtime: number, type: "0" | "x"): Uint8Array {
  const block = new Uint8Array(512);
  const put = (text: string, at: number, width: number) => block.set(enc.encode(text).subarray(0, width), at);
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.max(0, Math.floor(mtime)), 12), 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of block) sum += b;
  put(octal(sum, 7) + " ", 148, 8);
  return block;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = enc.encode(body).length + 1;
  while (String(len).length + enc.encode(body).length !== len) len = String(len).length + enc.encode(body).length;
  return `${len}${body}`;
}

const USTAR_MAX_SIZE = 8 ** 11 - 1;

function entryHeaders(name: string, size: number, mtimeMs: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const mtime = mtimeMs / 1000;
  const nameFits = enc.encode(name).length <= 100 && /^[\x20-\x7e]*$/.test(name);
  if (!nameFits || size > USTAR_MAX_SIZE) {
    const pax = enc.encode((nameFits ? "" : paxRecord("path", name)) + (size > USTAR_MAX_SIZE ? paxRecord("size", String(size)) : ""));
    out.push(tarHeader("pax", pax.length, mtime, "x"), pax, new Uint8Array((512 - (pax.length % 512)) % 512));
  }
  out.push(tarHeader(nameFits ? name : name.replace(/[^\x20-\x7e]/g, "_").slice(-100), size > USTAR_MAX_SIZE ? 0 : size, mtime, "0"));
  return out;
}

const READ_CHUNK = 1024 * 1024;
const WHOLE_FILE = 16 * 1024 * 1024;

/**
 * A tar stream of `sources`. Each file is measured when its turn comes, so
 * one changed since the list was made still gets a header that matches;
 * a large file that shrinks while it is read is padded to the size its
 * header promised.
 */
export function tarStream(sources: TarSource[]): ReadableStream<Uint8Array> {
  let i = 0;
  let open: { fd: fs.promises.FileHandle; left: number; pad: number } | null = null;
  const padding = (size: number) => new Uint8Array((512 - (size % 512)) % 512);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (open) {
          const want = Math.min(READ_CHUNK, open.left);
          const buf = new Uint8Array(want);
          const { bytesRead } = await open.fd.read(buf, 0, want, null);
          open.left -= want;
          controller.enqueue(bytesRead === want ? buf : buf.fill(0, bytesRead));
          if (open.left === 0) {
            controller.enqueue(new Uint8Array(open.pad));
            await open.fd.close();
            open = null;
          }
          return;
        }
        for (;;) {
          const src = sources[i++];
          if (!src) {
            controller.enqueue(new Uint8Array(1024));
            controller.close();
            return;
          }
          let data: Uint8Array | undefined = src.data;
          let mtimeMs = Date.now();
          if (!data) {
            let st: fs.Stats;
            try {
              st = fs.statSync(src.abs as string);
            } catch {
              continue; // removed since the list was made
            }
            mtimeMs = st.mtimeMs;
            if (st.size > WHOLE_FILE) {
              const fd = await fs.promises.open(src.abs as string, "r");
              for (const h of entryHeaders(src.name, st.size, mtimeMs)) controller.enqueue(h);
              open = { fd, left: st.size, pad: padding(st.size).length };
              return;
            }
            try {
              data = fs.readFileSync(src.abs as string);
            } catch {
              continue;
            }
          }
          for (const h of entryHeaders(src.name, data.length, mtimeMs)) controller.enqueue(h);
          controller.enqueue(data);
          controller.enqueue(padding(data.length));
          return;
        }
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await open?.fd.close();
    },
  });
}

/** The account as it is now, as tar sources. */
export function liveSources(dataDir: string, username: string, keys: boolean): TarSource[] {
  const files = accountFiles(dataDir, username, keys);
  const meta: BackupMeta = {
    format: 1,
    kind: "chrysalis-account",
    createdAt: new Date().toISOString(),
    engine: ENGINE_VERSION,
    from: username,
    keys,
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
  };
  return [{ name: "backup.json", data: enc.encode(JSON.stringify(meta, null, 2) + "\n") }, ...files.map((f) => ({ name: f.rel, abs: f.abs }))];
}

/** A backup on this device, as tar sources. */
export function backupSources(dataDir: string, username: string, id: string, keys: boolean): TarSource[] {
  const dir = backupDir(dataDir, username, id);
  const info = readInfo(dir) as BackupInfo;
  const files: FileEntry[] = [];
  walkFiles(path.join(dir, "workspace"), "workspace", () => false, files);
  walkFiles(path.join(dir, "credentials"), "credentials", (segs) => !keys && segs.length === 1 && segs[0] === KEY_FILE, files);
  const meta: BackupMeta = {
    format: 1,
    kind: "chrysalis-account",
    createdAt: info.createdAt,
    engine: info.engine,
    from: info.from,
    keys: keys && info.keys,
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
  };
  return [{ name: "backup.json", data: enc.encode(JSON.stringify(meta, null, 2) + "\n") }, ...files.map((f) => ({ name: f.rel, abs: f.abs }))];
}

// ---------- tar in ----------

/** The segments a tar entry is written to under the staging folder; null
 *  skips it. Throws for a name that tries to leave the folder. */
function entryTarget(name: string): string[] | null {
  const clean = name.replace(/^\.\//, "");
  if (clean.endsWith("/")) return null;
  const segs = clean.split("/");
  const badSeg = (s: string) => s === "" || s === "." || s === ".." || s.includes("\\") || s.includes("\0") || (process.platform === "win32" && s.includes(":"));
  if (clean.startsWith("/") || segs.some(badSeg)) throw new AccountBackupError(`the backup has an entry outside its own folder: ${name.slice(0, 200)}`);
  if (clean === "backup.json") return segs;
  if (segs[0] === "workspace" && segs.length > 1) return skipWorkspace(segs.slice(1)) ? null : segs;
  if (segs[0] === "credentials") {
    if (segs.length === 2 && (CREDENTIAL_FILES.has(segs[1] ?? "") || segs[1] === KEY_FILE)) return segs;
    if (segs[1] === UPSTREAM_DIR && segs.length > 2) return segs;
  }
  return null;
}

/** Bytes from a stream, taken by count. */
class ByteReader {
  private buf = new Uint8Array(0);
  private ended = false;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const r = await this.reader.read();
    if (r.done) {
      this.ended = true;
      return false;
    }
    const merged = new Uint8Array(this.buf.length + r.value.length);
    merged.set(this.buf);
    merged.set(r.value, this.buf.length);
    this.buf = merged;
    return true;
  }

  /** Exactly n bytes; null when the stream ended before any of them. */
  async exact(n: number): Promise<Uint8Array | null> {
    while (this.buf.length < n) {
      if (!(await this.fill())) {
        if (this.buf.length === 0) return null;
        throw new AccountBackupError("the backup ended early (the file is cut short)");
      }
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Between 1 and n bytes. */
  async some(n: number): Promise<Uint8Array> {
    if (this.buf.length === 0 && !(await this.fill())) throw new AccountBackupError("the backup ended early (the file is cut short)");
    const out = this.buf.slice(0, Math.min(n, this.buf.length));
    this.buf = this.buf.subarray(out.length);
    return out;
  }

  async skip(n: number): Promise<void> {
    while (n > 0) n -= (await this.some(n)).length;
  }

  cancel(): void {
    void this.reader.cancel().catch(() => undefined);
  }
}

/** A gzipped tar is read too (a backup someone compressed). */
async function openTar(body: ReadableStream<Uint8Array>): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const raw = body.getReader();
  const first = await raw.read();
  const head = first.done ? new Uint8Array(0) : first.value;
  const rest = new ReadableStream<Uint8Array>({
    start(c) {
      if (head.length) c.enqueue(head);
    },
    async pull(c) {
      const r = await raw.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel(reason) {
      return raw.cancel(reason);
    },
  });
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  return (gzip ? rest.pipeThrough(new DecompressionStream("gzip")) : rest).getReader() as ReadableStreamDefaultReader<Uint8Array>;
}

const dec = new TextDecoder();
const field = (block: Uint8Array, at: number, width: number): string => {
  const raw = block.subarray(at, at + width);
  const nul = raw.indexOf(0);
  return dec.decode(nul === -1 ? raw : raw.subarray(0, nul));
};

function numberField(block: Uint8Array, at: number, width: number): number {
  if ((block[at] ?? 0) & 0x80) {
    let n = 0;
    for (let k = at + 1; k < at + width; k++) n = n * 256 + (block[k] ?? 0);
    return n;
  }
  const text = field(block, at, width).trim();
  return text ? parseInt(text, 8) : 0;
}

/** pax records are "<length> <key>=<value>\n", the length in bytes. */
function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const len = Number(dec.decode(data.subarray(at, space)));
    if (!Number.isInteger(len) || len <= space - at || at + len > data.length) break;
    const record = dec.decode(data.subarray(space + 1, at + len - 1));
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

const DISK_RESERVE = 256 * 1024 * 1024;

/**
 * Unpack an account backup into `dest` (created; must not exist). Resolves
 * the backup's own description.
 */
export async function extractAccountTar(
  body: ReadableStream<Uint8Array>,
  dest: string,
  opts: { maxBytes: number; job?: BackupJob },
): Promise<BackupMeta> {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(dest);
  const input = new ByteReader(await openTar(body));
  let total = 0;
  let sinceCheck = 0;
  let nextName: string | null = null;
  let nextSize: number | null = null;
  try {
    for (;;) {
      const block = await input.exact(512);
      if (!block || block.every((b) => b === 0)) break;
      let sum = 0;
      for (let k = 0; k < 512; k++) sum += k >= 148 && k < 156 ? 32 : (block[k] ?? 0);
      if (sum !== numberField(block, 148, 8)) throw new AccountBackupError("not a Chrysalis backup (the file is not a tar archive)", 400);
      const type = String.fromCharCode(block[156] ?? 0);
      const prefix = field(block, 345, 155);
      const name = nextName ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
      const size = nextSize ?? numberField(block, 124, 12);
      const padded = size + ((512 - (size % 512)) % 512);
      if (type === "x" || type === "L") {
        if (size > 1024 * 1024) throw new AccountBackupError("the backup has an oversized entry header");
        const data = (await input.exact(padded)) ?? new Uint8Array(0);
        if (type === "L") nextName = dec.decode(data.subarray(0, size)).replace(/\0+$/, "");
        else {
          const pax = parsePax(data.subarray(0, size));
          if (pax.path !== undefined) nextName = pax.path;
          if (pax.size !== undefined) nextSize = Number(pax.size);
        }
        continue;
      }
      nextName = null;
      nextSize = null;
      const isFile = type === "0" || type === "\0" || type === "7";
      const segs = isFile ? entryTarget(name) : null;
      if (!segs) {
        await input.skip(padded);
        continue;
      }
      total += size;
      if (total > opts.maxBytes) throw new AccountBackupError(`the backup is larger than ${formatBytes(opts.maxBytes)}`, 413);
      const target = path.join(root, ...segs);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let fd: number | null = null;
      try {
        // wx: a name listed twice keeps the first, and nothing already
        // there is written through
        fd = fs.openSync(target, "wx", segs[0] === "workspace" ? 0o644 : 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      try {
        let left = size;
        while (left > 0) {
          const chunk = await input.some(Math.min(left, READ_CHUNK));
          if (fd !== null) fs.writeSync(fd, chunk);
          left -= chunk.length;
          sinceCheck += chunk.length;
          if (opts.job) opts.job.done += chunk.length;
          if (sinceCheck > 64 * 1024 * 1024) {
            sinceCheck = 0;
            const free = freeBytes(root);
            if (free !== null && free < DISK_RESERVE) throw new AccountBackupError("the disk is nearly full: free some space and try again", 507);
          }
        }
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
      await input.skip(padded - size);
    }
  } catch (e) {
    input.cancel();
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") throw new AccountBackupError("the disk filled up while receiving the backup", 507);
    throw e;
  }
  input.cancel();
  const meta = readMeta(root);
  if (!meta) throw new AccountBackupError("not a Chrysalis account backup (backup.json is missing)", 422);
  return meta;
}

function readMeta(dir: string): BackupMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "backup.json"), "utf8")) as Partial<BackupMeta>;
    if (raw.kind !== "chrysalis-account" || raw.format !== 1) return null;
    return {
      format: 1,
      kind: "chrysalis-account",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      engine: typeof raw.engine === "string" ? raw.engine : "",
      from: typeof raw.from === "string" ? raw.from : "",
      keys: raw.keys === true,
      files: Number.isInteger(raw.files) ? (raw.files as number) : 0,
      bytes: Number.isInteger(raw.bytes) ? (raw.bytes as number) : 0,
    };
  } catch {
    return null;
  }
}

/** A staging folder for a backup coming in, beside the account's backups
 *  (same disk as the workspace, so the restore is renames). */
export function incomingDir(dataDir: string, username: string): string {
  const base = accountBackupsDir(dataDir, username);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return path.join(base, `.incoming-${crypto.randomBytes(8).toString("hex")}`);
}

/** Copy a backup on this device into a staging folder. Copies, never links:
 *  the restored files are live and get rewritten in place. */
export async function stageBackup(dataDir: string, username: string, id: string, job?: BackupJob): Promise<string> {
  const src = backupDir(dataDir, username, id);
  const dest = incomingDir(dataDir, username);
  const files: FileEntry[] = [];
  walkFiles(src, "", () => false, files);
  if (job) job.total = files.reduce((n, f) => n + f.size, 0);
  const made = new Set<string>();
  try {
    await pool(files, 8, async (f) => {
      const target = path.join(dest, ...f.rel.slice(1).split("/"));
      const dir = path.dirname(target);
      if (!made.has(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        made.add(dir);
      }
      await fs.promises.copyFile(f.abs, target, fs.constants.COPYFILE_FICLONE);
      if (job) job.done += f.size;
    });
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") throw new AccountBackupError("the disk filled up while restoring", 507);
    throw e;
  }
  return dest;
}

// ---------- restore ----------

async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export interface RestoreOptions {
  /** A backup this engine made itself. One from a file or another device
   *  marks every app's install record restored, so no app arrives
   *  official (see apps/update.ts). */
  trusted: boolean;
  /** Admins may keep MCP servers that run a program on this machine. */
  admin: boolean;
  /** Called just before the swap: stop what holds the workspace open. */
  beforeSwap?: () => Promise<void>;
}

function sanitizeStaged(staged: string, opts: RestoreOptions): void {
  const creds = path.join(staged, "credentials");
  for (const name of [...CREDENTIAL_FILES, KEY_FILE]) {
    const file = path.join(creds, name);
    if (!fs.existsSync(file)) continue;
    try {
      JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
  if (!opts.admin) {
    const mcp = path.join(creds, "mcp.json");
    try {
      const cfg = JSON.parse(fs.readFileSync(mcp, "utf8")) as { servers?: Record<string, { type?: string }> };
      for (const [id, s] of Object.entries(cfg.servers ?? {})) if (s?.type === "stdio") delete cfg.servers?.[id];
      fs.writeFileSync(mcp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    } catch { /* none in the backup */ }
  }
  if (!opts.trusted) {
    const upstream = path.join(creds, UPSTREAM_DIR);
    let names: string[] = [];
    try {
      names = fs.readdirSync(upstream);
    } catch { /* no installed apps */ }
    for (const name of names.filter((n) => n.endsWith(".source.json"))) {
      const file = path.join(upstream, name);
      try {
        const source = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        fs.writeFileSync(file, JSON.stringify({ ...source, restored: true }) + "\n", "utf8");
      } catch {
        fs.rmSync(file, { force: true });
      }
    }
  }
}

/**
 * Replace the account with the backup unpacked in `staged` (consumed). A
 * backup of the account as it was is taken first, so a restore can be
 * undone by restoring that. Every move is undone if one fails part way.
 * The workspace's git history, its repos/ clones and the derived folders of
 * apps that exist on both sides stay with this device. Resolves the ids of
 * the apps the account now has.
 */
export async function restoreAccount(dataDir: string, username: string, staged: string, opts: RestoreOptions, job?: BackupJob): Promise<string[]> {
  if (!readMeta(staged)) throw new AccountBackupError("not a Chrysalis account backup (backup.json is missing)", 422);
  const incoming = path.join(staged, "workspace");
  if (!fs.existsSync(path.join(incoming, "apps")) && !fs.existsSync(path.join(incoming, "settings.json"))) {
    throw new AccountBackupError("this backup holds no workspace", 422);
  }
  sanitizeStaged(staged, opts);
  if (job) job.phase = "restoring";
  await createBackup(dataDir, username, "before-restore");

  const p = userPaths(dataDir, username);
  const creds = path.dirname(p.auth);
  const trash = path.join(accountBackupsDir(dataDir, username), `.replaced-${crypto.randomBytes(8).toString("hex")}`);
  fs.mkdirSync(path.join(trash, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(trash, "credentials"), { recursive: true });
  const moves: Array<[string, string]> = [];
  const move = async (from: string, to: string) => {
    await renameRetrying(from, to);
    moves.push([from, to]);
  };
  await opts.beforeSwap?.();
  try {
    // node_modules and dist of an app on both sides are kept: the engine
    // would otherwise download and build them again
    const incomingApps = fs.existsSync(path.join(incoming, "apps")) ? fs.readdirSync(path.join(incoming, "apps")) : [];
    for (const id of incomingApps.filter((n) => !n.startsWith("."))) {
      for (const derived of ["node_modules", "dist"]) {
        const have = path.join(p.apps, id, derived);
        const want = path.join(incoming, "apps", id, derived);
        if (fs.existsSync(have) && !fs.existsSync(want) && fs.existsSync(path.dirname(want))) await move(have, want);
      }
    }
    for (const name of fs.readdirSync(p.root)) {
      if (!SKIP_TOP.has(name)) await move(path.join(p.root, name), path.join(trash, "workspace", name));
    }
    for (const name of fs.readdirSync(incoming)) {
      if (!SKIP_TOP.has(name)) await move(path.join(incoming, name), path.join(p.root, name));
    }
    fs.mkdirSync(creds, { recursive: true, mode: 0o700 });
    const incomingCreds = path.join(staged, "credentials");
    for (const name of [...CREDENTIAL_FILES, KEY_FILE, UPSTREAM_DIR]) {
      const next = path.join(incomingCreds, name);
      const live = path.join(creds, name);
      // baselines describe the apps being replaced: they go even when the
      // backup brings none. A file the backup lacks stays as it is.
      if (!fs.existsSync(next) && name !== UPSTREAM_DIR) continue;
      if (fs.existsSync(live)) await move(live, path.join(trash, "credentials", name));
      if (fs.existsSync(next)) await move(next, live);
    }
  } catch (e) {
    for (const [from, to] of moves.reverse()) {
      try {
        fs.renameSync(to, from);
      } catch (undo) {
        log.error(`[backups] could not put ${from} back after a failed restore: ${(undo as Error).message}`);
      }
    }
    fs.rmSync(trash, { recursive: true, force: true });
    throw new AccountBackupError(`the restore could not finish and nothing was changed: ${(e as Error).message}`, 409);
  }
  for (const file of [...CREDENTIAL_FILES, KEY_FILE]) {
    try {
      fs.chmodSync(path.join(creds, file), 0o600);
    } catch { /* not in this backup */ }
  }
  fs.rmSync(staged, { recursive: true, force: true });
  void fs.promises.rm(trash, { recursive: true, force: true });
  try {
    return fs.readdirSync(p.apps).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}
