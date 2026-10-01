/**
 * Workspace file operations for the browser sandbox: the engine is the only
 * thing that touches disk. The sandbox host lists the tree (paths, sizes,
 * mtimes), the sandbox frame reads a file's bytes the first time a command
 * needs them, and changed files come back through here. Everything is
 * path-guarded and denylisted here, not in the browser.
 */
import fs from "node:fs";
import path from "node:path";
import { AGENT_READ_DENYLIST, agentReadDenied, agentWriteDenied } from "../paths.js";

/** Directories never mounted into the sandbox (derived artifacts, runtime
 *  state, agent transcripts). Matched on any path segment. */
const MOUNT_SKIP_DIRS = new Set(["node_modules", "dist", "agent", "assets-store", "store", ".staging"]);
/** Listing stops here; a workspace this big is marked truncated. */
export const MAX_MOUNT_FILES = 100_000;
/** A single file the sandbox may read or write back. */
export const MAX_SANDBOX_FILE = 64 * 1024 * 1024;
/** A single fs request cap. */
export const MAX_BATCH = 500;
/** Total bytes accepted in one write batch. */
export const MAX_WRITE_TOTAL = 16 * 1024 * 1024;

export interface WorkspaceFileInfo {
  path: string;
  size: number;
  mtime: number;
}

/** Path guard for files that leave/enter the workspace: a symlink planted in
 *  the workspace must not turn a sandbox sync into a read/write handle on the
 *  rest of the machine. */
export function makePathGuard(root: string) {
  const inside = (real: string): boolean => real === root || real.startsWith(root + path.sep);
  return {
    /** read/list guard: the resolved target must stay inside the workspace */
    assertReadable(abs: string, rel: string): void {
      let real: string;
      try {
        real = fs.realpathSync(abs);
      } catch {
        return; // missing — the caller's existsSync reports "not found"
      }
      if (!inside(real)) throw new Error(`Refused: ${rel} resolves outside the workspace (symlink?).`);
    },
    /** write guard: never write through a symlink, and the NEAREST EXISTING
     *  ancestor must resolve inside the workspace (blocks dangling links and
     *  symlinked parent dirs alike) */
    assertWritable(abs: string, rel: string): void {
      if (abs === root) throw new Error("Refused: the workspace root itself is not a file.");
      try {
        if (fs.lstatSync(abs).isSymbolicLink()) throw new Error(`Refused: ${rel} is a symlink.`);
      } catch (e) {
        if ((e as Error).message.startsWith("Refused:")) throw e;
        /* doesn't exist yet — the ancestor walk below decides */
      }
      let dir = path.dirname(abs);
      for (;;) {
        try {
          const real = fs.realpathSync(dir);
          if (!inside(real)) throw new Error(`Refused: ${rel} resolves outside the workspace (symlink?).`);
          return; // nearest existing ancestor is inside — creating below it is safe
        } catch (e) {
          if ((e as Error).message.startsWith("Refused:")) throw e;
          const parent = path.dirname(dir);
          if (parent === dir) throw new Error(`Refused: cannot resolve a parent directory of ${rel}.`);
          dir = parent;
        }
      }
    },
  };
}

/** Git internals are read and written by the sandbox bridge so real git works
 *  in the workspace; the agent's file tools still never touch them. */
export function isGitPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return norm === ".git" || norm.startsWith(".git/");
}

/** Repository metadata whose loss breaks every reader; never deletable. */
const KEEP_IN_GIT = new Set([".git/HEAD", ".git/config", ".git/index"]);

/** Workspace files the sandbox never sees, as RegExp sources over the
 *  workspace-relative path: its git is told so a tracked one reads as
 *  hidden rather than deleted. */
export const SANDBOX_HIDDEN: string[] = ["(^|/)auth\\.json$", ...AGENT_READ_DENYLIST.map((d) => d.pattern.source)];

/** A path the sandbox may see. Rejects traversal, credentials, the user's
 *  settings and skipped trees. */
export function sandboxPathAllowed(rel: string): string | null {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm || norm.startsWith("/") || norm.split("/").includes("..")) return "path escapes the workspace";
  if (/(^|\/)auth\.json$/i.test(norm)) return "credentials are not sandbox-visible";
  if (isGitPath(norm)) return null;
  const denied = agentReadDenied(norm);
  if (denied) return denied;
  for (const s of norm.split("/")) if (MOUNT_SKIP_DIRS.has(s)) return `${s}/ is not mounted into the sandbox`;
  return null;
}

// ---------------------------------------------------------------------------
// Git internals the sandbox may not author.
//
// A real git program run on this machine in a workspace repository (the
// engine's own gc, or the user in a terminal) obeys that repository's config:
// core.fsmonitor, gc.recentObjectsHook, hooks and friends name commands it
// RUNS. The sandbox writes .git/ so its git works, which would make any of
// those a way out of the sandbox onto the host. So config files pass only
// keys from an allowlist, and hooks, alternates and repository redirects are
// refused outright, in every repository under the workspace.

const GIT_REFUSED: [RegExp, string][] = [
  [/(^|\/)\.git\/hooks(\/|$)/, "git hooks cannot be written from the sandbox"],
  [/(^|\/)\.git\/objects\/info\/(http-)?alternates$/, "git alternates cannot be written from the sandbox"],
  [/(^|\/)\.git\/(commondir|gitdir)$/, "repository redirects cannot be written from the sandbox"],
  [/(^|\/)\.git$/, "a .git file (a pointer to another repository) cannot be written from the sandbox"],
];
const GIT_CONFIG_FILE = /(^|\/)\.git\/(config|config\.worktree|worktrees\/[^/]+\/config\.worktree)$/;

const CONFIG_ALLOWED: Record<string, Set<string>> = {
  core: new Set(["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode", "symlinks", "autocrlf", "eol", "safecrlf", "quotepath", "compression", "loosecompression", "abbrev"]),
  remote: new Set(["url", "pushurl", "fetch", "tagopt", "prune", "mirror"]),
  branch: new Set(["remote", "merge", "rebase", "pushremote", "description"]),
  user: new Set(["name", "email"]),
  init: new Set(["defaultbranch"]),
  pull: new Set(["rebase", "ff"]),
  push: new Set(["default", "autosetupremote"]),
  fetch: new Set(["prune"]),
  extensions: new Set(["objectformat", "worktreeconfig"]),
  gc: new Set(["auto", "autopacklimit"]),
};

/** Why a git config file may not be written as given, or null. */
export function gitConfigRefused(source: string): string | null {
  let section: string | null = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "");
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\\n]|\\.)*")?\s*\]\s*(?:[#;].*)?$/.exec(line);
      if (!header) return `unreadable config section: ${line.slice(0, 80)}`;
      const name = header[1]!.toLowerCase();
      // [section.subsection] is the old spelling of [section "subsection"]
      section = name.split(".")[0]!;
      if (!CONFIG_ALLOWED[section]) return `git config section [${header[1]}] cannot be written from the sandbox`;
      continue;
    }
    const key = /^([A-Za-z][A-Za-z0-9-]*)\s*(=|$)/.exec(line);
    if (!key || section === null) return `unreadable config line: ${line.slice(0, 80)}`;
    if (!CONFIG_ALLOWED[section]!.has(key[1]!.toLowerCase())) return `git config key ${section}.${key[1]} cannot be written from the sandbox`;
  }
  return null;
}

/** Why the sandbox may not write `rel` with these bytes, or null. */
export function gitWriteRefused(rel: string, bytes: Uint8Array): string | null {
  const norm = rel.replace(/\\/g, "/");
  for (const [re, reason] of GIT_REFUSED) if (re.test(norm)) return reason;
  if (GIT_CONFIG_FILE.test(norm)) return gitConfigRefused(new TextDecoder().decode(bytes));
  return null;
}

/** All mountable files under `root`. Symlinks are skipped outright so
 *  nothing can point outside the tree; contents are read only on demand, so
 *  size does not limit what is listed. */
export function listWorkspaceFiles(root: string): { files: WorkspaceFileInfo[]; truncated: boolean } {
  const out: WorkspaceFileInfo[] = [];
  let truncated = false;
  const walk = (dir: string, rel: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (MOUNT_SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (/^auth\.json$/i.test(e.name) || agentReadDenied(r)) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(path.join(dir, e.name));
        } catch {
          continue;
        }
        if (st.size > MAX_SANDBOX_FILE) continue;
        if (out.length >= MAX_MOUNT_FILES) {
          truncated = true;
          return;
        }
        out.push({ path: r, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, "");
  return { files: out, truncated };
}

/** One workspace file's bytes for the sandbox, under the same rules as the
 *  listing. Throws with a message fit for the frame. */
export function readWorkspaceFile(root: string, rel: string): Buffer {
  const bad = sandboxPathAllowed(rel);
  if (bad) throw new Error(`Refused: ${bad}`);
  const abs = path.resolve(root, rel);
  makePathGuard(root).assertReadable(abs, rel);
  const st = fs.lstatSync(abs);
  if (!st.isFile()) throw new Error(`${rel} is not a file`);
  if (st.size > MAX_SANDBOX_FILE) throw new Error(`${rel} is too large for the sandbox`);
  return fs.readFileSync(abs);
}

export type FsOp = { op: "tree" } | { op: "write"; files: { path: string; b64: string }[] } | { op: "delete"; paths: string[] };

/** What happened to one path: the new size and mtime when written, or why it
 *  was refused. */
export interface FsPathResult {
  path: string;
  ok: boolean;
  size?: number;
  mtime?: number;
  error?: string;
}

export interface FsOpResult {
  tree?: { files: WorkspaceFileInfo[]; truncated: boolean };
  results?: FsPathResult[];
}

/** Write one file the sandbox changed. */
export function writeWorkspaceFile(root: string, rel: string, bytes: Uint8Array): FsPathResult {
  try {
    const bad = sandboxPathAllowed(rel) ?? (isGitPath(rel) ? null : agentWriteDenied(rel)) ?? gitWriteRefused(rel, bytes);
    if (bad) throw new Error(bad);
    if (bytes.length > MAX_SANDBOX_FILE) throw new Error("too large for the sandbox to write");
    const abs = path.resolve(root, rel);
    makePathGuard(root).assertWritable(abs, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    const st = fs.statSync(abs);
    return { path: rel, ok: true, size: st.size, mtime: st.mtimeMs };
  } catch (e) {
    return { path: rel, ok: false, error: (e as Error).message.replace(/^Refused: /, "") };
  }
}

/** Run one workspace fs op. Per-path refusals come back as results, so one
 *  refused file never costs the rest of the batch; malformed requests throw
 *  (the route turns those into a 400). */
export function workspaceFs(root: string, op: FsOp): FsOpResult {
  if (op.op === "tree") return { tree: listWorkspaceFiles(root) };
  if (op.op === "write") {
    let total = 0;
    const results: FsPathResult[] = [];
    for (const f of op.files.slice(0, MAX_BATCH)) {
      const buf = Buffer.from(f.b64, "base64");
      total += buf.length;
      if (total > MAX_WRITE_TOTAL) throw new Error("write batch too large");
      results.push(writeWorkspaceFile(root, f.path, buf));
    }
    return { results };
  }
  if (op.op === "delete") {
    const results: FsPathResult[] = [];
    for (const rel of op.paths.slice(0, MAX_BATCH)) {
      try {
        const bad = sandboxPathAllowed(rel) ?? (isGitPath(rel) ? null : agentWriteDenied(rel));
        if (bad) throw new Error(bad);
        // Deleting these breaks the repository for every reader (the
        // engine's file tools included); no git operation removes them.
        if (KEEP_IN_GIT.has(rel)) throw new Error(`${rel} is git metadata the engine keeps`);
        const abs = path.resolve(root, rel);
        makePathGuard(root).assertWritable(abs, rel);
        fs.rmSync(abs, { force: true });
        results.push({ path: rel, ok: true });
      } catch (e) {
        results.push({ path: rel, ok: false, error: (e as Error).message.replace(/^Refused: /, "") });
      }
    }
    return { results };
  }
  throw new Error("unknown op");
}
