/**
 * isomorphic-git wrapper for per-user repos (text entities only — SPEC §12
 * git boundary). Pure JS: no git binary required on any platform.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import git from "isomorphic-git";
import { GitIndexManager } from "isomorphic-git/managers";
import { gitBoundaryIgnored } from "./paths.js";

export interface CommitInfo {
  oid: string;
  message: string;
  author: string;
  timestamp: number;
}

function authorFor(username: string, viaAgent: boolean): { name: string; email: string } {
  const name = viaAgent ? `${username} (via agent)` : username;
  return { name, email: `${username}@local` };
}

/** A file over this size stays out of history: every save of it would add
 *  another compressed copy to the repository (a long chat grows it by tens
 *  of MB a message), and hashing it means reading it whole. It stays on disk
 *  untouched; a tracked file that grows past it leaves the next commit that
 *  names it. */
const MAX_VERSIONED_BYTES = 32 * 1024 * 1024;
function versioned(dir: string, filepath: string): boolean {
  if (gitBoundaryIgnored(filepath)) return false;
  try { return fs.statSync(path.join(dir, filepath)).size <= MAX_VERSIONED_BYTES; } catch { return true; }
}

// Route sweeps, agent tools and restores all commit the same repo from
// concurrent async contexts — isomorphic-git index writes must not interleave.
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const run = repoLocks.get(dir) ?? Promise.resolve();
  const next = run.then(fn, fn);
  repoLocks.set(dir, next.catch(() => undefined));
  return next;
}

/** isomorphic-git never writes one, so `git reflog` (the standard "where am
 *  I" tool for agents and users shell-ing in) returns nothing. Append the
 *  HEAD entry ourselves; git tolerates a logs/HEAD that starts mid-history. */
function appendReflog(dir: string, oldOid: string, newOid: string, author: { name: string; email: string }, message: string): void {
  try {
    const logsDir = path.join(dir, ".git", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const now = new Date();
    const tz = -now.getTimezoneOffset();
    const tzStr = `${tz < 0 ? "-" : "+"}${String(Math.floor(Math.abs(tz) / 60)).padStart(2, "0")}${String(Math.abs(tz) % 60).padStart(2, "0")}`;
    const line = `${oldOid} ${newOid} ${author.name} <${author.email}> ${Math.floor(now.getTime() / 1000)} ${tzStr}\tcommit: ${message.split("\n")[0]}\n`;
    fs.appendFileSync(path.join(logsDir, "HEAD"), line, "utf8");
  } catch { /* reflog is best-effort — never fail a commit over it */ }
}

/** Give the repo a CLI-usable identity. isomorphic-git commits carry an
 *  explicit author, but plain `git commit` (agent shell, user terminal)
 *  aborts with "Author identity unknown" unless config has one. */
async function ensureCliIdentity(dir: string, username: string): Promise<void> {
  const author = authorFor(username, false);
  const name = await git.getConfig({ fs, dir, path: "user.name" }).catch(() => null);
  if (name != null) return;
  await git.setConfig({ fs, dir, path: "user.name", value: author.name });
  await git.setConfig({ fs, dir, path: "user.email", value: author.email });
}

async function resolveHead(dir: string): Promise<string> {
  try {
    return await git.resolveRef({ fs, dir, ref: "HEAD" });
  } catch {
    return "0".repeat(40); // unborn branch
  }
}

/** Commit with identity provisioning + reflog; caller holds the repo lock. */
async function commitWithReflog(
  dir: string,
  username: string,
  message: string,
  viaAgent: boolean,
  tree?: string,
): Promise<string> {
  await ensureCliIdentity(dir, username);
  const oldOid = await resolveHead(dir);
  const author = authorFor(username, viaAgent);
  const oid = await git.commit({ fs, dir, message, author, ...(tree ? { tree } : {}) });
  appendReflog(dir, oldOid, oid, author, message);
  return oid;
}

type StatusRow = [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3];

/**
 * statusMatrix, with racily-clean files checked by content.
 *
 * isomorphic-git decides "unchanged" from whole-second mtimes and the size.
 * A file rewritten at the same size within the second its index entry was
 * written (an app route saving the same chat twice in quick succession)
 * looks unchanged and would drop out of history. Git itself re-hashes such
 * entries; so does this: any clean row whose file is not older than the
 * index is compared against HEAD's blob.
 */
async function statusRows(dir: string): Promise<StatusRow[]> {
  const matrix = (await git.statusMatrix({ fs, dir })) as StatusRow[];
  let indexSecond: number;
  try {
    indexSecond = Math.floor(fs.statSync(path.join(dir, ".git", "index")).mtimeMs / 1000);
  } catch {
    return matrix;
  }
  let head: string | null = null;
  for (const row of matrix) {
    const [filepath, h, w, st] = row;
    if (!(h === 1 && w === 1 && st === 1)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(dir, filepath));
    } catch {
      continue;
    }
    if (Math.floor(stat.mtimeMs / 1000) < indexSecond) continue;
    head ??= await resolveHead(dir);
    try {
      // read before starting readBlob: a file deleted meanwhile must not
      // leave that promise rejecting with nothing awaiting it
      const object = fs.readFileSync(path.join(dir, filepath));
      const [{ oid: committed }, { oid: current }] = await Promise.all([
        git.readBlob({ fs, dir, oid: head, filepath }),
        git.hashBlob({ object }),
      ]);
      if (committed !== current) row[2] = 2;
    } catch {
      /* not in HEAD after all: statusMatrix already said so */
    }
  }
  return matrix;
}

export async function initRepo(dir: string): Promise<void> {
  const gitDir = path.join(dir, ".git");
  if (fs.existsSync(path.join(gitDir, "HEAD"))) return;
  // A .git without HEAD is not a repository: an emptied or crashed skeleton.
  // Re-init, salvaging any surviving object database (outside .git, which is
  // about to be removed) so recovery never costs more than it must.
  const salvage = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-git-salvage-"));
  let salvaged = false;
  const objects = path.join(gitDir, "objects");
  if (fs.existsSync(objects)) {
    for (const entry of fs.readdirSync(objects)) {
      fs.cpSync(path.join(objects, entry), path.join(salvage, entry), { recursive: true });
      salvaged = true;
    }
  }
  fs.rmSync(gitDir, { recursive: true, force: true });
  await git.init({ fs, dir, defaultBranch: "main" });
  if (salvaged) {
    for (const entry of fs.readdirSync(salvage)) {
      fs.cpSync(path.join(salvage, entry), path.join(gitDir, "objects", entry), { recursive: true });
    }
  }
  fs.rmSync(salvage, { recursive: true, force: true });
}

/** Idempotent: init if missing, then return. Callers may assume a repo exists. */
export async function ensureRepo(dir: string): Promise<void> {
  await initRepo(dir);
}

/** Stage all changes (add modified/new, remove deleted) and commit.
 * statusMatrix row: [filepath, HEAD, WORKDIR, STAGE]; 0=absent, 1=clean, 2=modified, 3=added. */
export async function commitAll(
  dir: string,
  username: string,
  message: string,
  viaAgent = false,
): Promise<string | null> {
  return withRepoLock(dir, async () => {
    await ensureRepo(dir); // self-heal: repos are normally created at user bootstrap
    const matrix = await statusRows(dir);
    let changed = 0;
    for (const [filepath, head, workdir, stage] of matrix) {
      // git boundary (paths.ts): credentials/chat logs/runtime state are never
      // staged — even if a tampered .gitignore would let statusMatrix see them.
      if (!versioned(dir, filepath)) continue;
      if (workdir === 0) {
        // deleted from workdir (was tracked or staged)
        if (head !== 0 || stage !== 0) {
          await git.remove({ fs, dir, filepath });
          changed++;
        }
        continue;
      }
      if (workdir === 2 || head === 0) {
        // modified, or new/untracked (workdir 2), or present in workdir but not in HEAD
        await git.add({ fs, dir, filepath });
        changed++;
      }
    }
    if (changed === 0) return null;
    return commitWithReflog(dir, username, message, viaAgent);
  });
}

/** Paths with uncommitted changes (the same rows `status` reports, names only).
 *  Boundary paths are excluded — they are never staged, so they are never pending. */
export async function changedPaths(dir: string): Promise<string[]> {
  const matrix = await withRepoLock(dir, () => statusRows(dir));
  return matrix
    .filter(([filepath, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1) && versioned(dir, filepath))
    .map(([filepath]) => filepath);
}

/** Commit ONLY the given paths (stage add/remove per path), leaving other
 *  pending changes uncommitted. Used to separate out-of-band edits from a
 *  route's own sweep commit so history describes what each commit holds. */
export async function commitPaths(
  dir: string,
  username: string,
  message: string,
  paths: string[],
  viaAgent = false,
): Promise<string | null> {
  if (paths.length === 0) return null;
  return withRepoLock(dir, async () => {
    await ensureRepo(dir);
    return commitMatrixPaths(dir, username, message, paths, await statusRows(dir), viaAgent);
  });
}

/** commitPaths against a status already read; caller holds the repo lock. */
async function commitMatrixPaths(dir: string, username: string, message: string, paths: string[], matrix: StatusRow[], viaAgent = false): Promise<string | null> {
  const wanted = new Set(paths.filter((p) => versioned(dir, p)));
  if (wanted.size === 0) return null;
  let changed = 0;
  for (const [filepath, head, workdir, stage] of matrix) {
    if (!wanted.has(filepath)) continue;
    if (workdir === 0) {
      if (head !== 0 || stage !== 0) {
        await git.remove({ fs, dir, filepath });
        changed++;
      }
      continue;
    }
    if (workdir === 2 || head === 0) {
      await git.add({ fs, dir, filepath });
      changed++;
    }
  }
  if (changed === 0) return null;
  return commitWithReflog(dir, username, message, viaAgent);
}

/** Replace one tree entry without involving unrelated staged files. */
interface TreeChange { segments: string[]; filepath: string; blob: string | null; mode: string }

/** Writes every change into the tree under `oid`, one tree write per folder
 *  touched (a write per file rewrote a whole folder each time, which made a
 *  large import's commit quadratic). A file in neither the tree nor on disk,
 *  or new and ignored, is left out. Returns null for an empty tree. */
async function applyTreeChanges(dir: string, oid: string | undefined, changes: TreeChange[], changed: string[]): Promise<string | null> {
  const entries = oid ? (await git.readTree({ fs, dir, oid })).tree : [];
  const byName = new Map(entries.map(entry => [entry.path, entry]));
  const groups = new Map<string, TreeChange[]>();
  for (const change of changes) {
    const name = change.segments[0]!;
    const group = groups.get(name);
    if (group) group.push(change); else groups.set(name, [change]);
  }
  let dirty = false;
  for (const [name, group] of groups) {
    const previous = byName.get(name);
    const leaf = group.find(change => change.segments.length === 1);
    if (leaf) {
      if (leaf.blob) {
        if (!previous && await git.isIgnored({ fs, dir, filepath: leaf.filepath })) continue;
        if (previous?.oid === leaf.blob && previous.mode === leaf.mode) continue;
        byName.set(name, { path: name, mode: leaf.mode, type: "blob", oid: leaf.blob });
      } else {
        if (!previous) continue;
        byName.delete(name);
      }
      changed.push(leaf.filepath);
      dirty = true;
      continue;
    }
    if (previous && previous.type !== "tree") throw new Error("File blocks a directory: " + name);
    const child = await applyTreeChanges(dir, previous?.oid, group.map(change => ({ ...change, segments: change.segments.slice(1) })), changed);
    if (child === (previous?.oid ?? null)) continue;
    if (child) byName.set(name, { path: name, mode: "040000", type: "tree", oid: child }); else byName.delete(name);
    dirty = true;
  }
  if (!dirty) return oid ?? null;
  return byName.size ? git.writeTree({ fs, dir, tree: [...byName.values()] }) : null;
}

/** A loose blob in git's own format, hashed and compressed natively. An
 *  object already on disk is never rewritten. */
function writeBlobFile(dir: string, bytes: Buffer): string {
  const wrapped = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]);
  const oid = createHash("sha1").update(wrapped).digest("hex");
  const file = path.join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, zlib.deflateSync(wrapped), { flag: "wx" });
      fs.renameSync(temporary, file);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }
  return oid;
}

/** What GitIndexManager reads and writes the index through. */
const indexFs = {
  lstat: async (file: string) => fs.promises.lstat(file).catch(() => null),
  read: async (file: string) => fs.promises.readFile(file).catch(() => null),
  write: (file: string, data: Uint8Array) => fs.promises.writeFile(file, data),
};

/** Commit only the named paths; unrelated index entries keep their staging. */
export async function commitWrittenPaths(dir: string, username: string, message: string, paths: string[], viaAgent = false): Promise<string | null> {
  return withRepoLock(dir, () => commitKnownPaths(dir, username, message, paths, viaAgent));
}

/** Paths an app route wrote whose commit is queued and has not run yet. */
const queuedWrites = new Map<string, Map<string, number>>();

/** An app route's history, queued behind the repo's other git work so the
 *  route answers without waiting for it. With `sweep`, whatever else changed
 *  since the last commit (agent or shell edits) is committed first under an
 *  out-of-band label; then the route's own writes. Readers of history (log,
 *  status, changedPaths) take the same lock, so they see both. */
export function queueRouteCommit(dir: string, username: string, message: string, written: string[], sweep: boolean): Promise<void> {
  const queued = queuedWrites.get(dir) ?? new Map<string, number>();
  queuedWrites.set(dir, queued);
  for (const file of written) queued.set(file, (queued.get(file) ?? 0) + 1);
  return withRepoLock(dir, async () => {
    for (const file of written) {
      const left = (queued.get(file) ?? 1) - 1;
      if (left > 0) queued.set(file, left); else queued.delete(file);
    }
    await ensureRepo(dir);
    if (sweep) {
      // a route queued behind this one wrote what is still queued: its own
      // commit names it
      const own = new Set(written);
      const matrix = await statusRows(dir);
      const dirty = matrix
        .filter(([filepath, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1) && versioned(dir, filepath))
        .map(([filepath]) => filepath)
        .filter((filepath) => !own.has(filepath) && !queued.has(filepath));
      if (dirty.length > 0) {
        const preview = dirty.slice(0, 3).join(", ") + (dirty.length > 3 ? ` +${dirty.length - 3} more` : "");
        await commitMatrixPaths(dir, username, `out-of-band: ${preview}`, dirty, matrix);
      }
    }
    if (written.length) await commitKnownPaths(dir, username, message, written);
  });
}

/** commitWrittenPaths; caller holds the repo lock. */
async function commitKnownPaths(dir: string, username: string, message: string, paths: string[], viaAgent = false): Promise<string | null> {
  await ensureRepo(dir);
  const head = await resolveHead(dir);
  const original = head === "0".repeat(40) ? undefined : (await git.readCommit({ fs, dir, oid: head })).commit.tree;
  const changes: TreeChange[] = [];
  const staged = new Map<string, { oid: string; stats: fs.Stats }>();
  for (const raw of new Set(paths)) {
    const filepath = path.posix.normalize(raw.replaceAll("\\", "/"));
    const full = path.resolve(dir, filepath);
    if (!full.startsWith(path.resolve(dir) + path.sep) || gitBoundaryIgnored(filepath)) continue;
    let stats: fs.Stats | null = null;
    try { stats = fs.lstatSync(full); } catch { /* deleted */ }
    if (stats && !stats.isFile()) continue;
    if (stats && stats.size > MAX_VERSIONED_BYTES) stats = null; // leaves history, see versioned()
    const blob = stats ? writeBlobFile(dir, fs.readFileSync(full)) : null;
    if (stats && blob) staged.set(filepath, { oid: blob, stats });
    const mode = stats && (stats.mode & 0o111) ? "100755" : "100644";
    changes.push({ segments: filepath.split("/"), filepath, blob, mode });
  }
  const changed: string[] = [];
  const tree = await applyTreeChanges(dir, original, changes, changed) ?? await git.writeTree({ fs, dir, tree: [] });
  if (!changed.length || tree === original) return null;
  // the index takes the blobs just written, in one read and one write
  await GitIndexManager.acquire({ fs: indexFs, gitdir: path.join(dir, ".git"), cache: {} }, async (index) => {
    for (const filepath of changed) {
      const entry = staged.get(filepath);
      if (entry) index.insert({ filepath, oid: entry.oid, stats: entry.stats });
      else index.delete({ filepath });
    }
  });
  return commitWithReflog(dir, username, message, viaAgent, tree);
}

export async function log(dir: string, limit = 50): Promise<CommitInfo[]> {
  const commits = await withRepoLock(dir, () => git.log({ fs, dir, depth: limit }));
  return commits.map((c) => ({
    oid: c.oid,
    message: c.commit.message.trim(),
    author: c.commit.author.name,
    timestamp: c.commit.author.timestamp * 1000,
  }));
}

export async function status(dir: string): Promise<{ path: string; head: number; workdir: number }[]> {
  const matrix = await withRepoLock(dir, () => statusRows(dir));
  return matrix
    .filter(([filepath, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1) && versioned(dir, filepath))
    .map(([p, head, workdir]) => ({ path: p, head, workdir }));
}

/**
 * One-time-per-boot migration for the git boundary: removes tracked
 * credentials/chat logs/runtime state from the index (working-tree files
 * STAY — isomorphic-git remove is index-only) and commits the untracking.
 * No-op when nothing boundary-tracked remains.
 */
export async function untrackBoundary(dir: string, username: string): Promise<void> {
  await withRepoLock(dir, async () => {
    await ensureRepo(dir);
    const matrix = await statusRows(dir);
    const tracked = matrix.filter(([f, head]) => head !== 0 && gitBoundaryIgnored(f)).map(([f]) => f);
    if (tracked.length === 0) return;
    for (const f of tracked) await git.remove({ fs, dir, filepath: f });
    // fold the .gitignore upgrade (if any) into the same commit
    const gi = matrix.find(([f, head, workdir]) => f === ".gitignore" && (head === 0 || workdir === 2));
    if (gi) await git.add({ fs, dir, filepath: ".gitignore" });
    await commitWithReflog(
      dir,
      username,
      "chore: untrack runtime state and chat logs (git boundary)",
      false,
    );
  });
}

/** Restore a file's content from a commit, then commit the restore.
 *
 * SECURITY: filepath is attacker-controllable (HTTP body / agent tool) —
 * it must resolve INSIDE the repo dir: no "..", not absolute, and never
 * into .git/ internals.
 */
export async function restoreFile(
  dir: string,
  filepath: string,
  oid: string,
  username: string,
): Promise<void> {
  const rel = filepath.replace(/\\/g, "/");
  if (rel.startsWith("/") || rel.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw new Error(`invalid restore path: ${filepath}`);
  }
  if (/^\.git($|\/)/i.test(rel)) throw new Error("refusing to restore into .git/");
  // git boundary: restoring credentials/runtime paths from history would
  // resurrect exactly what the boundary keeps out of the repo
  if (gitBoundaryIgnored(rel)) throw new Error(`refusing to restore git-boundary path: ${filepath}`);
  const abs = path.resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) {
    throw new Error(`path escapes repo: ${filepath}`);
  }
  const blob = await git.readBlob({ fs, dir, oid, filepath: rel });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(blob.blob));
  await withRepoLock(dir, async () => {
    await git.add({ fs, dir, filepath: rel });
    await commitWithReflog(dir, username, `restore: ${filepath} from ${oid.slice(0, 8)}`, false);
  });
}
