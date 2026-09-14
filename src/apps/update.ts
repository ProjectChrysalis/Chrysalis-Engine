/**
 * App updates as a three-way merge. Every installed app keeps a copy of the
 * version it was installed or last updated from (the baseline, outside the
 * workspace). An update compares three trees per file: the baseline, the
 * app as it is now, and the incoming version.
 *
 *   unchanged since the baseline  → the update's version lands
 *   unchanged in the update       → your version stays
 *   changed on both sides         → a text merge; overlapping edits conflict
 *
 * With conflicts nothing is written unless the caller picks how to settle
 * them: keep your side of each conflict, take the update whole, or write the
 * conflict markers for the agent to resolve. data/ is never part of any of
 * it. Nothing here knows what an app is.
 */
import fs from "node:fs";
import path from "node:path";
import { UPDATE_KEEP, fileHistory, mergeFile, readDirAt, showFile } from "./git.js";

export type UpdateStrategy = "merge" | "mine" | "theirs" | "agent";

export const UPDATE_STRATEGIES: readonly UpdateStrategy[] = ["merge", "mine", "theirs", "agent"];

export type ConflictReason = "both edited" | "deleted in update" | "deleted by you" | "binary" | "no baseline";

export interface MergeOutcome {
  /** Files to write; null deletes. */
  writes: Map<string, Buffer | null>;
  /** Files where your edits and the update were combined without conflict. */
  merged: string[];
  conflicts: { path: string; reason: ConflictReason }[];
}

type Tree = Map<string, Buffer>;

/** Paths an update never reads or writes. The root manifest carries install
 *  provenance and is replaced whole by the caller. */
function outsideCode(rel: string): boolean {
  const segs = rel.split("/");
  const head = segs[0] ?? "";
  return (
    UPDATE_KEEP.has(head) ||
    rel === "manifest.json" ||
    segs.includes(".git") ||
    segs.includes("node_modules") ||
    head.startsWith(".__")
  );
}

/** An app's code files by relative path. Symlinks are skipped: an update
 *  must never follow one out of the app. */
export function readCodeTree(dir: string): Tree {
  const out: Tree = new Map();
  const walk = (abs: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (outsideCode(childRel)) continue;
      const full = path.join(abs, e.name);
      if (e.isDirectory()) walk(full, childRel);
      else if (e.isFile()) out.set(childRel, fs.readFileSync(full));
    }
  };
  walk(dir, "");
  return out;
}

const BASELINE_META = ".baseline.json";

function baselinePath(upstreamRoot: string, appId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(appId)) throw new Error(`invalid app id: ${appId}`);
  return path.join(upstreamRoot, appId);
}

export function readBaseline(upstreamRoot: string, appId: string): { version: string; files: Tree } | null {
  const dir = baselinePath(upstreamRoot, appId);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, BASELINE_META), "utf8")) as { version?: unknown };
    if (typeof meta.version !== "string") return null;
    const files = readCodeTree(path.join(dir, "tree"));
    return { version: meta.version, files };
  } catch {
    return null;
  }
}

/** Replace an app's baseline. Written beside the old one and swapped in, so
 *  a failure halfway leaves the previous baseline intact. */
export function writeBaseline(upstreamRoot: string, appId: string, version: string, files: Tree): void {
  const dir = baselinePath(upstreamRoot, appId);
  const next = `${dir}.next`;
  fs.rmSync(next, { recursive: true, force: true });
  for (const [rel, body] of files) {
    const to = path.join(next, "tree", rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, body);
  }
  fs.mkdirSync(next, { recursive: true });
  fs.writeFileSync(path.join(next, BASELINE_META), JSON.stringify({ version }) + "\n", "utf8");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(next, dir);
}

/** Where an app was installed from, as this engine recorded it. Kept beside
 *  the baseline, outside the workspace: it decides where updates come from
 *  and whether the app is official, so nothing inside the workspace may be
 *  able to change it. */
export interface InstallSource {
  git: string;
  ref: string;
  /** Restored from a backup file: the code came from the file, not the
   *  repository, so it is not official until an update makes it match. */
  restored?: true;
}

function sourcePath(upstreamRoot: string, appId: string): string {
  return `${baselinePath(upstreamRoot, appId)}.source.json`;
}

export function readInstallSource(upstreamRoot: string, appId: string): InstallSource | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sourcePath(upstreamRoot, appId), "utf8")) as { git?: unknown; ref?: unknown; restored?: unknown };
    if (typeof raw.git !== "string") return null;
    return { git: raw.git, ref: typeof raw.ref === "string" ? raw.ref : "HEAD", ...(raw.restored === true ? { restored: true as const } : {}) };
  } catch {
    return null;
  }
}

export function writeInstallSource(upstreamRoot: string, appId: string, source: InstallSource): void {
  fs.mkdirSync(upstreamRoot, { recursive: true });
  fs.writeFileSync(sourcePath(upstreamRoot, appId), JSON.stringify(source) + "\n", "utf8");
}

/** Data upgrades that did not finish after an update: each plugin whose
 *  onAppUpdate failed, with the version its data still has. Retried, from
 *  that version, until they succeed. */
export interface PendingUpgrade {
  /** plugin id → the version its onAppUpdate still has to upgrade from */
  plugins: Record<string, string>;
}

function upgradePath(upstreamRoot: string, appId: string): string {
  return `${baselinePath(upstreamRoot, appId)}.upgrade.json`;
}

export function readPendingUpgrade(upstreamRoot: string, appId: string): PendingUpgrade | null {
  try {
    const raw = JSON.parse(fs.readFileSync(upgradePath(upstreamRoot, appId), "utf8")) as { plugins?: unknown };
    const plugins: Record<string, string> = {};
    for (const [id, from] of Object.entries(raw.plugins && typeof raw.plugins === "object" ? raw.plugins : {})) {
      if (typeof from === "string") plugins[id] = from;
    }
    return Object.keys(plugins).length ? { plugins } : null;
  } catch {
    return null;
  }
}

/** Record what is still to upgrade; an empty list clears the record. */
export function writePendingUpgrade(upstreamRoot: string, appId: string, plugins: Record<string, string>): void {
  const file = upgradePath(upstreamRoot, appId);
  if (!Object.keys(plugins).length) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(upstreamRoot, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ plugins }) + "\n", "utf8");
}

/** An app was deleted: its baseline, install source and unfinished upgrade go
 *  with it, so a new app under the same id starts with none of them. */
export function forgetInstall(upstreamRoot: string, appId: string): void {
  const dir = baselinePath(upstreamRoot, appId);
  for (const target of [dir, `${dir}.next`, sourcePath(upstreamRoot, appId), upgradePath(upstreamRoot, appId)]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/** An app was renamed: its baseline, install source and unfinished upgrade
 *  follow it. */
export function moveInstall(upstreamRoot: string, fromId: string, toId: string): void {
  forgetInstall(upstreamRoot, toId);
  const pairs: [string, string][] = [
    [baselinePath(upstreamRoot, fromId), baselinePath(upstreamRoot, toId)],
    [sourcePath(upstreamRoot, fromId), sourcePath(upstreamRoot, toId)],
    [upgradePath(upstreamRoot, fromId), upgradePath(upstreamRoot, toId)],
  ];
  for (const [from, to] of pairs) {
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }
}

export function manifestVersion(dir: string): string {
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * An install from before baselines existed: the workspace history still
 * holds the commit that first brought this version in, and an app arrives
 * in one commit with nothing of the user's mixed into its code. Null when
 * the history has no such commit.
 */
export async function recoverBaseline(workspaceRoot: string, appId: string, version: string): Promise<Tree | null> {
  const manifestRel = `apps/${appId}/manifest.json`;
  let first: string | null = null;
  for (const sha of await fileHistory(workspaceRoot, manifestRel)) {
    const body = await showFile(workspaceRoot, sha, manifestRel);
    let v: unknown;
    try {
      v = body ? (JSON.parse(body.toString("utf8")) as { version?: unknown }).version : undefined;
    } catch {
      v = undefined;
    }
    if (v === version) first = sha;
    else if (first) break;
  }
  if (!first) return null;
  const out: Tree = new Map();
  for (const [rel, bytes] of await readDirAt(workspaceRoot, first, `apps/${appId}`, [...UPDATE_KEEP])) {
    if (!outsideCode(rel)) out.set(rel, bytes);
  }
  return out;
}

const same = (a: Buffer | undefined, b: Buffer | undefined): boolean => (a === undefined || b === undefined ? a === b : a.equals(b));
const isText = (b: Buffer): boolean => !b.subarray(0, 8000).includes(0);

/** Plan an update. `base` is null when no baseline is known: a file both
 *  sides have but disagree on is then a conflict. */
export async function mergeTrees(
  base: Tree | null,
  ours: Tree,
  theirs: Tree,
  strategy: UpdateStrategy,
  labels: { base: string; theirs: string },
): Promise<MergeOutcome> {
  const writes = new Map<string, Buffer | null>();
  const merged: string[] = [];
  const conflicts: MergeOutcome["conflicts"] = [];
  const paths = [...new Set([...(base?.keys() ?? []), ...ours.keys(), ...theirs.keys()])].sort();
  const names = { ours: "your version", base: labels.base, theirs: labels.theirs };

  for (const rel of paths) {
    const b = base?.get(rel);
    const o = ours.get(rel);
    const t = theirs.get(rel);
    if (same(o, t)) continue;
    if (base && same(o, b)) {
      writes.set(rel, t ?? null);
      continue;
    }
    if (base && same(t, b)) continue;
    if (strategy === "theirs") {
      // a file only you added has no upstream version to take
      if (t || b) writes.set(rel, t ?? null);
      continue;
    }
    if (!base) {
      // without a baseline, a file on one side only is new on that side
      if (!t) continue;
      if (!o) {
        writes.set(rel, t);
        continue;
      }
    }
    if (o && t && isText(o) && isText(t) && (!b || isText(b))) {
      const files = { ours: o, base: b ?? Buffer.alloc(0), theirs: t };
      const plain = mergeFile(files, names);
      if (plain.conflicts === 0) {
        writes.set(rel, plain.merged);
        merged.push(rel);
        continue;
      }
      conflicts.push({ path: rel, reason: base ? "both edited" : "no baseline" });
      if (strategy === "agent") writes.set(rel, plain.merged);
      else if (strategy === "mine") writes.set(rel, mergeFile(files, names, true).merged);
      continue;
    }
    // no text merge possible: your side stays unless the update is taken whole
    conflicts.push({ path: rel, reason: !t ? "deleted in update" : !o ? "deleted by you" : base ? "binary" : "no baseline" });
  }
  return { writes, merged, conflicts };
}

export function applyWrites(appDir: string, writes: Map<string, Buffer | null>): void {
  const root = path.resolve(appDir);
  for (const [rel, body] of writes) {
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep) || outsideCode(rel)) throw new Error(`refusing to write outside the app's code: ${rel}`);
    if (body === null) fs.rmSync(full, { force: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
  }
}

/** Undo applyWrites for `rels`: each path gets back what `before` held, and a
 *  path `before` did not have loses the file written there. Anything else
 *  found at such a path (a folder of the user's) was not written by the update
 *  and stays. */
export function restoreWrites(appDir: string, rels: Iterable<string>, before: Tree): void {
  const root = path.resolve(appDir);
  for (const rel of rels) {
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep) || outsideCode(rel)) continue;
    const body = before.get(rel);
    if (body) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    } else if (fs.lstatSync(full, { throwIfNoEntry: false })?.isFile()) {
      fs.rmSync(full);
    }
  }
}

/** Underscore-prefixed files under an app's data/ are templates the app
 *  ships for the agent. Missing ones arrive with an update; the rest of
 *  data/ is the user's and is never written. */
export function seedDataTemplates(incomingDir: string, appDir: string): string[] {
  const added: string[] = [];
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(incomingDir, "data", rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (e.isFile() && e.name.startsWith("_")) {
        const to = path.join(appDir, "data", child);
        if (fs.existsSync(to)) continue;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(incomingDir, "data", child), to);
        added.push(child);
      }
    }
  };
  walk("");
  return added;
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [0, 0, 0];
  const pb = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

/** Does `version` satisfy a range: space-separated comparisons (>=1.2.0
 *  <2.0.0), a caret or tilde range, an exact version, or "*". An unreadable
 *  range is not satisfied: an app that states a need the engine cannot
 *  check is not offered. */
export function satisfiesRange(range: string, version: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    if (part === "*") return true;
    const m = /^(>=|<=|>|<|=|\^|~)?(v?\d+(?:\.\d+){0,2})$/.exec(part);
    if (!m) return false;
    const want = parseVersion(m[2]!)!;
    const cmp = compareVersions(version, m[2]!);
    switch (m[1]) {
      case ">=": return cmp >= 0;
      case "<=": return cmp <= 0;
      case ">": return cmp > 0;
      case "<": return cmp < 0;
      case "^": return cmp >= 0 && (want[0] > 0 ? v[0] === want[0] : v[0] === 0 && v[1] === want[1]);
      case "~": return cmp >= 0 && v[0] === want[0] && v[1] === want[1];
      default: return cmp === 0;
    }
  });
}
