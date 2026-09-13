/**
 * isomorphic-git wrapper for per-user repos (text entities only — SPEC §12
 * git boundary). Pure JS: no git binary required on any platform.
 */
import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
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
): Promise<string> {
  await ensureCliIdentity(dir, username);
  const oldOid = await resolveHead(dir);
  const author = authorFor(username, viaAgent);
  const oid = await git.commit({ fs, dir, message, author });
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
      const [{ oid: committed }, { oid: current }] = await Promise.all([
        git.readBlob({ fs, dir, oid: head, filepath }),
        git.hashBlob({ object: fs.readFileSync(path.join(dir, filepath)) }),
      ]);
      if (committed !== current) row[2] = 2;
    } catch {
      /* not in HEAD after all: statusMatrix already said so */
    }
  }
  return matrix;
}

export async function initRepo(dir: string): Promise<void> {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    await git.init({ fs, dir, defaultBranch: "main" });
  }
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
      if (gitBoundaryIgnored(filepath)) continue;
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
  const matrix = await statusRows(dir);
  return matrix
    .filter(([filepath, head, workdir, stage]) => !gitBoundaryIgnored(filepath) && !(head === 1 && workdir === 1 && stage === 1))
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
    const wanted = new Set(paths.filter((p) => !gitBoundaryIgnored(p)));
    if (wanted.size === 0) return null;
    const matrix = await statusRows(dir);
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
  });
}

export async function log(dir: string, limit = 50): Promise<CommitInfo[]> {
  const commits = await git.log({ fs, dir, depth: limit });
  return commits.map((c) => ({
    oid: c.oid,
    message: c.commit.message.trim(),
    author: c.commit.author.name,
    timestamp: c.commit.author.timestamp * 1000,
  }));
}

export async function status(dir: string): Promise<{ path: string; head: number; workdir: number }[]> {
  const matrix = await statusRows(dir);
  return matrix
    .filter(([filepath, head, workdir, stage]) => !gitBoundaryIgnored(filepath) && !(head === 1 && workdir === 1 && stage === 1))
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
