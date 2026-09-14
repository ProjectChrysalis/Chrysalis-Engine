/**
 * Git app transport (SPEC-v2 app distribution): clone community apps,
 * check remotes for updates, merge an update into an installed copy, and
 * refresh it in place. The user's data/ survives every update.
 *
 * Everything works without a git program: merges are diff3 in JS, workspace
 * history is read with isomorphic-git, and clones and update checks use
 * isomorphic-git over HTTPS. When the machine does have git, clones and
 * update checks go through it instead, which adds SSH remotes and
 * self-hosted dumb-HTTP servers. Calls to git go through execFile (argv
 * only, never a shell), refuse to prompt for credentials, and carry their
 * own timeout.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import diff3Merge from "diff3";

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0", // never hang waiting for a password
  // askpass must never prompt either; /bin/true exists on Linux/macOS but not
  // Windows/Android. Unset there, TERMINAL_PROMPT=0 alone fails fast (same
  // no-hang guarantee without resolving a POSIX path)
  ...(fs.existsSync("/bin/true") ? { GIT_ASKPASS: "/bin/true" } : {}),
  GIT_CONFIG_NOSYSTEM: "1",
  // a repo's .lfsconfig must not point checkout at a server of its choosing
  GIT_LFS_SKIP_SMUDGE: "1",
};

/** The git program on this machine, if any (looked up once).
 *  CHRYSALIS_NO_SYSTEM_GIT=1 runs as if there were none. */
let gitProgram: string | null | undefined;
function systemGit(): string | null {
  if (process.env.CHRYSALIS_NO_SYSTEM_GIT === "1") return null;
  gitProgram ??= Bun.which("git");
  return gitProgram;
}

export function isValidGitUrl(url: string): boolean {
  // https (the norm) or git@ SSH; plain http stays allowed for self-hosted
  // repositories on trusted LANs
  return /^https?:\/\/[^\s/]+\/[^\s]+$|^git@[^\s/]+:[^\s]+$/.test(url);
}

/** A branch, tag or HEAD, spelled so it can only ever be read as a ref: it
 *  starts with a word character, so git never takes it for an option. */
export function isValidGitRef(ref: string): boolean {
  return /^\w[\w./-]{0,199}$/.test(ref) && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock");
}

function checkRemote(url: string, ref?: string): void {
  if (!isValidGitUrl(url)) throw new Error(`not a repository address: ${url}`);
  if (ref !== undefined && !isValidGitRef(ref)) throw new Error(`not a branch or tag name: ${ref}`);
}

function needsSystemGit(url: string): Error {
  return new Error(`${url} is an SSH address, which needs git installed on this computer. Use the repository's https:// address instead.`);
}

function runGit(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  const program = systemGit();
  if (!program) return Promise.reject(new Error("git is not installed on this computer"));
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { cwd: opts.cwd, env: GIT_ENV, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr).trim().slice(-300) || err.message));
        else resolve(String(stdout));
      },
    );
  });
}

const LINES = /[^\n]*\n|[^\n]+$/g;

/**
 * Three-way merge of one text file: the changes between `base` and `theirs`
 * applied to `ours`, line by line. Overlapping edits come back between
 * conflict markers and counted, or resolved toward ours when `favorOurs` is
 * set. Both sides making the same edit is not a conflict.
 */
export function mergeFile(
  files: { ours: Buffer; base: Buffer; theirs: Buffer },
  labels: { ours: string; base: string; theirs: string },
  favorOurs = false,
): { merged: Buffer; conflicts: number } {
  const split = (b: Buffer): string[] => b.toString("utf8").match(LINES) ?? [];
  const withNewline = (lines: string[]): string => {
    const text = lines.join("");
    return text === "" || text.endsWith("\n") ? text : `${text}\n`;
  };
  let out = "";
  let conflicts = 0;
  for (const block of diff3Merge(split(files.ours), split(files.base), split(files.theirs))) {
    if (block.ok) {
      out += block.ok.join("");
      continue;
    }
    conflicts++;
    if (favorOurs) {
      out += block.conflict.a.join("");
      continue;
    }
    out += `<<<<<<< ${labels.ours}\n${withNewline(block.conflict.a)}=======\n${withNewline(block.conflict.b)}>>>>>>> ${labels.theirs}\n`;
  }
  return { merged: Buffer.from(out, "utf8"), conflicts };
}

/** Commits that touched `file` in the workspace repository at `repoRoot`,
 *  newest first. */
export async function fileHistory(repoRoot: string, file: string): Promise<string[]> {
  try {
    const commits = await git.log({ fs, dir: repoRoot, filepath: file, force: true });
    return commits.map((c) => c.oid);
  } catch {
    return [];
  }
}

/** A file's content at a commit, or null when it did not exist there. */
export async function showFile(repoRoot: string, commit: string, file: string): Promise<Buffer | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir: repoRoot, oid: commit, filepath: file });
    return Buffer.from(blob);
  } catch {
    return null;
  }
}

/** Every file under `dir` at a commit, keyed by path relative to `dir`,
 *  except those under the `exclude` subfolders. */
export async function readDirAt(repoRoot: string, commit: string, dir: string, exclude: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const prefix = `${dir}/`;
  await git.walk({
    fs,
    dir: repoRoot,
    trees: [git.TREE({ ref: commit })],
    map: async (filepath, [entry]) => {
      if (!entry) return null;
      // only descend along the requested folder
      if (filepath !== "." && !prefix.startsWith(`${filepath}/`) && !filepath.startsWith(prefix)) return null;
      if (!filepath.startsWith(prefix)) return true;
      const rel = filepath.slice(prefix.length);
      if (exclude.some((x) => rel === x || rel.startsWith(`${x}/`))) return null;
      if ((await entry.type()) === "blob") {
        const content = await entry.content();
        if (content) out.set(rel, Buffer.from(content));
      }
      return true;
    },
  });
  return out;
}

/** The commit a ref points at on the remote, without touching any local
 *  state: the cheap half of an update check. */
export async function gitRemoteHead(url: string, ref = "HEAD"): Promise<string | null> {
  checkRemote(url, ref);
  let sha: string | undefined;
  if (systemGit()) {
    const out = await runGit(["ls-remote", "--", url, ref], { timeoutMs: 30_000 });
    sha = out.split("\n").find((l) => l.trim())?.trim().split(/\s+/)[0];
  } else {
    if (url.startsWith("git@")) throw needsSystemGit(url);
    const refs = await git.listServerRefs({ http, url, symrefs: true });
    const want = ref === "HEAD" ? "HEAD" : ref.startsWith("refs/") ? ref : null;
    const hit = refs.find((r) => (want ? r.ref === want : r.ref === `refs/heads/${ref}` || r.ref === `refs/tags/${ref}`));
    sha = hit?.oid;
  }
  return sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/** The version and engine range the manifest at `commit` of a GitHub
 *  repository names, read without cloning, so an update can be described
 *  before it is fetched. Null for other hosts or when it cannot be read; the
 *  update checks the real manifest either way. */
export async function remoteManifest(url: string, commit: string, fetcher: typeof fetch = fetch): Promise<{ version?: string; engine?: string } | null> {
  const repo = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!repo || !/^[0-9a-f]{40}$/.test(commit)) return null;
  try {
    const res = await fetcher(`https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/${commit}/manifest.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const raw = (await res.json()) as { version?: unknown; engine?: unknown };
    return {
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      ...(typeof raw.engine === "string" ? { engine: raw.engine } : {}),
    };
  } catch {
    return null;
  }
}

/** Pack a workspace repo's loose objects when they pile up. isomorphic-git
 *  never gc's: every chat save mints a fresh blob + commit, so months of use
 *  leave tens of thousands of loose objects that make statusMatrix and commit
 *  slower. A git program on the machine packs them; threshold-gated so
 *  untouched repos skip the spawn. Without git the objects stay loose and
 *  keep working. Returns true when a gc actually ran. */
export async function gcRepoIfChunky(cwd: string, threshold = 4000): Promise<boolean> {
  const objectsDir = path.join(cwd, ".git", "objects");
  let loose = 0;
  try {
    for (const entry of fs.readdirSync(objectsDir)) {
      if (!/^[0-9a-f]{2}$/.test(entry)) continue; // info/, pack/
      loose += fs.readdirSync(path.join(objectsDir, entry)).length;
      if (loose > threshold) break;
    }
  } catch {
    return false; // no repo / no objects dir
  }
  if (loose <= threshold || !systemGit()) return false;
  try {
    await runGit(["gc", "--quiet"], { cwd, timeoutMs: 300_000 });
    return true;
  } catch {
    return false; // git missing or busy — loose objects keep working, just slower
  }
}

/** Symlinks check out as plain files holding the link text. Engine code
 *  reads app files host-side (the public dist route, the dev overlay, the
 *  build), so a repo-shipped link to ../../credentials would be a read of
 *  whatever it names. */
const NO_SYMLINKS = ["-c", "core.symlinks=false"];

/** Clone `url` into `dest` (must not exist) and return the checked-out
 *  commit. Depth 1: app histories are irrelevant, and a shallow clone can't
 *  be tricked into gigabytes of pack. Self-hosted dumb-HTTP servers can't do
 *  shallow; with git installed those fall back to a full clone. */
export async function gitClone(url: string, dest: string, ref?: string): Promise<string> {
  checkRemote(url, ref);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const branch = ref && ref !== "HEAD" ? ref : undefined;
  if (!systemGit()) {
    if (url.startsWith("git@")) throw needsSystemGit(url);
    await git.clone({ fs, http, dir: dest, url, ref: branch, singleBranch: true, depth: 1 });
    // isomorphic-git writes symlinks as links; drop them before anything reads the tree
    removeSymlinks(dest);
    return git.resolveRef({ fs, dir: dest, ref: "HEAD" });
  }
  const branchArgs = branch ? ["--branch", branch] : [];
  try {
    await runGit([...NO_SYMLINKS, "clone", "--depth", "1", "--single-branch", ...branchArgs, "--", url, dest]);
  } catch (e) {
    if (!/dumb http|shallow/i.test(String((e as Error).message))) throw e;
    await runGit([...NO_SYMLINKS, "clone", ...branchArgs, "--", url, dest]);
  }
  return (await runGit(["rev-parse", "HEAD"], { cwd: dest, timeoutMs: 15_000 })).trim();
}

/** Files that never cross an update: the user's own content and derived
 *  artifacts (the engine rebuilds them after the swap). */
export const UPDATE_KEEP = new Set(["data", "node_modules", "dist"]);

/** Drop the .git directory from a staged clone — provenance lives in the
 *  manifest (source.git + head), and a nested repo inside the workspace is
 *  dead weight the workspace git can't track. */
export function stripVcs(dir: string): void {
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  removeSymlinks(dir);
}

/** Drop every symlink under `dir` (a staged clone). Checkout already writes
 *  them as plain files; this holds if that setting is ever overridden. */
function removeSymlinks(dir: string): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) fs.rmSync(full, { force: true });
    else if (e.isDirectory()) removeSymlinks(full);
  }
}

