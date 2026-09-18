/**
 * Workspace file operations for the browser sandbox: the engine is the only
 * thing that touches disk. The sandbox host asks for a tree (paths + sizes +
 * mtimes), reads file bytes to mount them, and sends changed files back as it
 * works. Everything is path-guarded and denylisted here, not in the browser.
 */
import fs from "node:fs";
import path from "node:path";
import { agentReadDenied, agentWriteDenied } from "../paths.js";

/** Directories never mounted into the sandbox (derived artifacts, runtime
 *  state, git internals, agent transcripts). Matched on any path segment. */
const MOUNT_SKIP_DIRS = new Set(["node_modules", "dist", "agent", "assets-store", "store", ".staging"]);
/** Files above this are not mounted (the VFS is in-memory). */
export const MAX_MOUNT_FILE = 2 * 1024 * 1024;
/** Total mounted bytes before the tree is marked truncated. */
export const MAX_MOUNT_TOTAL = 64 * 1024 * 1024;
/** Git needs its whole object database to read history or write a tree; a pack
 *  is one file, so .git gets its own larger budget instead of the 2MB file cap. */
export const MAX_GIT_MOUNT_TOTAL = 256 * 1024 * 1024;
/** A single synced-back file cap. */
export const MAX_WRITE_FILE = 4 * 1024 * 1024;
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

/** A path the sandbox may see. Rejects absolute paths, traversal, dotfiles
 *  outside the workspace, credential-shaped names and skipped trees. */
/** Git internals are read and written by the sandbox bridge so real git works
 *  in the workspace; the agent's file tools still never touch them. */
export function isGitPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return norm === ".git" || norm.startsWith(".git/");
}

/** Repository metadata whose loss breaks every reader; never deletable. */
const KEEP_IN_GIT = new Set([".git/HEAD", ".git/config", ".git/index"]);

export function sandboxPathAllowed(rel: string): string | null {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm || norm.startsWith("/") || norm.split("/").includes("..")) return "path escapes the workspace";
  if (/^auth\.json$/i.test(norm) || /(^|\/)auth\.json$/i.test(norm)) return "credentials are not sandbox-visible";
  if (isGitPath(norm)) return null;
  const denied = agentReadDenied(norm);
  if (denied) return denied;
  const segs = norm.split("/");
  for (const s of segs) if (MOUNT_SKIP_DIRS.has(s)) return `${s}/ is not mounted into the sandbox`;
  return null;
}

/** All mountable files under `root`, capped by size and total. Symlinks are
 *  skipped outright so nothing can point outside the tree. */
export function listWorkspaceFiles(root: string): { files: WorkspaceFileInfo[]; truncated: boolean } {
  const out: WorkspaceFileInfo[] = [];
  let total = 0;
  let truncated = false;
  const walk = (dir: string, rel: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // cloned repositories mount last: past the size cap they are what gets cut
    if (!rel) entries.sort((a, b) => Number(a.name === "repos") - Number(b.name === "repos"));
    for (const e of entries) {
      if (truncated) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (MOUNT_SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (/^auth\.json$/i.test(e.name)) continue;
        if (agentReadDenied(r)) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(path.join(dir, e.name));
        } catch {
          continue;
        }
        const inGit = rel === ".git" || rel.startsWith(".git/");
        if (!inGit && st.size > MAX_MOUNT_FILE) continue;
        if (total + st.size > (inGit ? MAX_GIT_MOUNT_TOTAL : MAX_MOUNT_TOTAL)) {
          truncated = true;
          return;
        }
        total += st.size;
        out.push({ path: r, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, "");
  return { files: out, truncated };
}

export type FsOp =
  | { op: "tree" }
  | { op: "read"; paths: string[] }
  | { op: "write"; files: { path: string; b64: string }[] }
  | { op: "delete"; paths: string[] };

export interface FsOpResult {
  tree?: { files: WorkspaceFileInfo[]; truncated: boolean };
  files?: { path: string; b64: string }[];
  ok?: boolean;
  error?: string;
}

/** Run one workspace fs op. Throws on policy violations (the route turns
 *  those into a 400); individual missing files are simply skipped. */
export function workspaceFs(root: string, op: FsOp): FsOpResult {
  const guard = makePathGuard(root);
  if (op.op === "tree") return { tree: listWorkspaceFiles(root) };
  if (op.op === "read") {
    const files: { path: string; b64: string }[] = [];
    for (const rel of op.paths.slice(0, MAX_BATCH)) {
      const bad = sandboxPathAllowed(rel);
      if (bad) throw new Error(`Refused: ${bad}`);
      const abs = path.resolve(root, rel);
      guard.assertReadable(abs, rel);
      try {
        const buf = fs.readFileSync(abs);
        files.push({ path: rel, b64: buf.toString("base64") });
      } catch {
        /* vanished between tree and read — the syncer treats it as absent */
      }
    }
    return { files };
  }
  if (op.op === "write") {
    let total = 0;
    for (const f of op.files.slice(0, MAX_BATCH)) {
      const bad = sandboxPathAllowed(f.path) ?? (isGitPath(f.path) ? null : agentWriteDenied(f.path));
      if (bad) throw new Error(`Refused: ${f.path}: ${bad}`);
      const buf = Buffer.from(f.b64, "base64");
      if (buf.length > MAX_WRITE_FILE) throw new Error(`Refused: ${f.path} is too large for the sandbox to write`);
      total += buf.length;
      if (total > MAX_WRITE_TOTAL) throw new Error("Refused: write batch too large");
      const abs = path.resolve(root, f.path);
      guard.assertWritable(abs, f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
    }
    return { ok: true };
  }
  for (const rel of op.paths.slice(0, MAX_BATCH)) {
    const bad = sandboxPathAllowed(rel) ?? (isGitPath(rel) ? null : agentWriteDenied(rel));
    if (bad) throw new Error(`Refused: ${bad}`);
    // Deleting these breaks the repository for every reader (the engine's file
    // tools included); no supported sandbox git operation removes them.
    if (KEEP_IN_GIT.has(rel)) throw new Error(`Refused: ${rel} is git metadata the engine keeps`);
    const abs = path.resolve(root, rel);
    guard.assertWritable(abs, rel);
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      /* already gone */
    }
  }
  return { ok: true };
}
