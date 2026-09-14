/**
 * App backups: an installed app as one zip, and a zip back into an app.
 *
 * The archive is the app folder as it is (code, plugins, live data) minus
 * derived dirs, plus a `.__backup/` folder the engine writes itself: where
 * the app updates from and the version it was installed from, so a restored
 * app keeps updating with its own edits merged in.
 *
 * Reading a zip trusts nothing in it: entry names are checked before any
 * byte is written, sizes are counted while inflating (a header can lie), and
 * only plain files are created, so no entry can land outside the staging
 * folder or become a link.
 */
import fs from "node:fs";
import path from "node:path";
import { Unzip, UnzipInflate, zip as zipFiles } from "fflate";
import { isValidGitRef, isValidGitUrl } from "./git.js";

/** Largest app a backup holds, uncompressed, and largest zip accepted. */
export const BACKUP_MAX_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 100_000;

/** The engine's own folder inside a backup. App folders never carry a
 *  `.__` entry of their own (exports skip them), so it cannot collide. */
export const BACKUP_META_DIR = ".__backup";

export interface BackupMeta {
  format: 1;
  id: string;
  exportedAt: string;
  engine: string;
  /** Where the app updates from, with the version its baseline holds. */
  source?: { git: string; ref: string; head?: string; baselineVersion: string };
}

export class BackupError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 422 = 422) {
    super(message);
  }
}

const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Every file of an installed app, by relative path. Symlinks are skipped,
 *  never followed, so nothing an app plants can pull a file from outside its
 *  folder into the archive. */
function appFiles(root: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  const walk = (rel: string) => {
    const abs = rel ? path.join(root, rel) : root;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".__") || entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) {
        const file = path.join(abs, entry.name);
        total += fs.statSync(file).size;
        if (total > BACKUP_MAX_BYTES) throw new BackupError("this app is too large to export (over 512 MB)", 413);
        files[childRel] = fs.readFileSync(file);
      }
    }
  };
  walk("");
  return files;
}

/** Zip an installed app. `baseline` is the tree its updates merge against. */
export async function buildBackup(
  appDir: string,
  meta: BackupMeta,
  baseline: Map<string, Buffer> | null,
): Promise<Uint8Array> {
  const files = appFiles(fs.realpathSync(appDir));
  const withMeta = meta.source && baseline ? meta : { ...meta, source: undefined };
  files[`${BACKUP_META_DIR}/backup.json`] = Buffer.from(JSON.stringify(withMeta, null, 2) + "\n", "utf8");
  if (withMeta.source && baseline) {
    for (const [rel, body] of baseline) files[`${BACKUP_META_DIR}/baseline/${rel}`] = body;
  }
  return new Promise((resolve, reject) => {
    zipFiles(files, { level: 3 }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** A zip entry's path when it is safe to create under a folder; null skips
 *  it (folders, OS clutter, derived dirs); throws for a path that tries to
 *  leave. */
function entryPath(name: string): string | null {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.endsWith("/")) return null;
  if (normalized.includes("\0") || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new BackupError(`the zip has an entry outside its own folder: ${name}`);
  }
  const segs = normalized.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) throw new BackupError(`the zip has an entry outside its own folder: ${name}`);
  if (segs[0] === "__MACOSX" || segs.at(-1) === ".DS_Store" || segs.some((s) => SKIPPED_DIRS.has(s))) return null;
  return segs.join("/");
}

/**
 * Unpack a backup zip into `dest` (created, must not exist) and find the app
 * in it.
 */
export function extractBackup(zip: Uint8Array, dest: string): { root: string; meta: BackupMeta | null } {
  if (zip.byteLength > BACKUP_MAX_BYTES) throw new BackupError("the file is too large (over 512 MB)", 413);
  if (zip[0] !== 0x50 || zip[1] !== 0x4b) throw new BackupError("not a zip file", 400);
  fs.mkdirSync(dest, { recursive: true });
  const destRoot = fs.realpathSync(dest);
  let total = 0;
  let entries = 0;
  let failure: Error | null = null;
  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    if (failure) return;
    try {
      if (++entries > MAX_ENTRIES) throw new BackupError("the zip has too many files");
      const rel = entryPath(file.name);
      if (!rel) return;
      const target = path.join(destRoot, ...rel.split("/"));
      const chunks: Uint8Array[] = [];
      file.ondata = (err, chunk, final) => {
        if (failure) return;
        if (err) {
          failure = new BackupError(`the zip is damaged: ${err.message}`);
          return;
        }
        total += chunk.byteLength;
        if (total > BACKUP_MAX_BYTES) {
          failure = new BackupError("the app in this zip is too large (over 512 MB)", 413);
          file.terminate();
          return;
        }
        chunks.push(chunk);
        if (!final) return;
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          // wx: a zip listing one name twice keeps the first, and never
          // writes through anything already there
          fs.writeFileSync(target, Buffer.concat(chunks), { flag: "wx" });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") failure = e as Error;
        }
      };
      file.start();
    } catch (e) {
      failure = e instanceof BackupError ? e : new BackupError(`the zip cannot be read: ${(e as Error).message}`);
    }
  };
  try {
    unzipper.push(zip, true);
  } catch (e) {
    failure ??= new BackupError(`the zip cannot be read: ${(e as Error).message}`);
  }
  if (failure) throw failure;

  return locateBackup(destRoot);
}

/** The app inside an unpacked backup: at the top, or inside the single
 *  folder a re-zipped app sits in. */
export function locateBackup(dir: string): { root: string; meta: BackupMeta | null } {
  let root = dir;
  if (!fs.existsSync(path.join(root, "manifest.json"))) {
    const top = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.name !== "__MACOSX");
    const only = top.length === 1 && top[0]?.isDirectory() ? path.join(root, top[0].name) : null;
    if (!only || !fs.existsSync(path.join(only, "manifest.json"))) throw new BackupError("not a Chrysalis app (no manifest.json in the zip)");
    root = only;
  }
  return { root, meta: readBackupMeta(root) };
}

function readBackupMeta(root: string): BackupMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, BACKUP_META_DIR, "backup.json"), "utf8")) as Partial<BackupMeta>;
    if (raw.format !== 1 || typeof raw.id !== "string") return null;
    const s = raw.source;
    const source =
      s && typeof s.git === "string" && isValidGitUrl(s.git) && typeof s.ref === "string" && isValidGitRef(s.ref) && typeof s.baselineVersion === "string"
        ? { git: s.git, ref: s.ref, baselineVersion: s.baselineVersion, ...(typeof s.head === "string" && /^[0-9a-f]{7,40}$/.test(s.head) ? { head: s.head } : {}) }
        : undefined;
    return {
      format: 1,
      id: raw.id,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
      engine: typeof raw.engine === "string" ? raw.engine : "",
      ...(source ? { source } : {}),
    };
  } catch {
    return null;
  }
}
