/**
 * The agent's git: the everyday commands, spelled like the git command line
 * and answered from the workspace repository with isomorphic-git. Nothing
 * runs in the shell and no git program is needed.
 *
 * The workspace has one line of history that the engine commits to on its
 * own (file tools, app routes, restores), so there is no staging area,
 * branch or remote to manage. Reads: status, diff, log, show. Writes:
 * commit, restore (checkout -- path), revert.
 */
import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import { createTwoFilesPatch, structuredPatch } from "diff";
import * as repo from "../git.js";
import { agentReadDenied, agentWriteDenied, gitBoundaryIgnored } from "../paths.js";
import { makePathGuard } from "../sandbox/workspace.js";

/** Longest output one command returns; the rest is cut with a note. */
const MAX_OUTPUT = 60_000;
/** A file pair past this size is summarized instead of diffed line by line. */
const MAX_DIFF_FILE = 256 * 1024;
const DEFAULT_LOG = 20;

export interface GitCliOptions {
  dir: string;
  username: string;
  /** Plan mode: reads only. */
  readOnly: boolean;
}

export class GitCliError extends Error {}

const fail = (message: string): never => {
  throw new GitCliError(message);
};

/** Split an argument string the way a shell would: quotes group, backslash
 *  escapes. A leading "git" is dropped. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) fail("unterminated quote in arguments");
  if (has) out.push(cur);
  if (out[0] === "git") out.shift();
  return out;
}

/** Arguments before and after "--". */
function splitPathspecs(args: string[]): { flags: string[]; paths: string[] } {
  const at = args.indexOf("--");
  return at === -1 ? { flags: args, paths: [] } : { flags: args.slice(0, at), paths: args.slice(at + 1) };
}

/** A workspace-relative path from a pathspec; "." is the whole workspace. */
function normalizeSpec(spec: string): string {
  const rel = spec.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (rel === "." || rel === "") return "";
  if (rel.startsWith("/") || rel.split("/").some((s) => s === "..")) fail(`pathspec '${spec}' is outside the workspace`);
  return rel;
}

const within = (file: string, specs: string[]): boolean => !specs.length || specs.some((s) => s === "" || file === s || file.startsWith(`${s}/`));
/** Whether a directory may hold something the specs name. */
const mayHold = (dir: string, specs: string[]): boolean => !specs.length || specs.some((s) => s === "" || s.startsWith(`${dir}/`) || dir === s || dir.startsWith(`${s}/`));

// ---------- revisions ----------

export async function resolveRev(dir: string, spec: string): Promise<string> {
  const m = /^(.*?)((?:[~^]\d*)*)$/.exec(spec)!;
  const base = m[1] || "HEAD";
  let oid: string | null = null;
  try {
    oid = await git.resolveRef({ fs, dir, ref: base });
  } catch {
    if (/^[0-9a-f]{4,40}$/i.test(base)) oid = await git.expandOid({ fs, dir, oid: base.toLowerCase() }).catch(() => null);
  }
  if (!oid) return fail(`bad revision '${spec}'`);
  for (const step of m[2]!.match(/[~^]\d*/g) ?? []) {
    const n = step.length > 1 ? Number(step.slice(1)) : 1;
    if (step[0] === "~") {
      for (let i = 0; i < n; i++) oid = (await parents(dir, oid))[0] ?? fail(`bad revision '${spec}': history is shorter`);
    } else if (n > 0) {
      oid = (await parents(dir, oid))[n - 1] ?? fail(`bad revision '${spec}': no parent ${n}`);
    }
  }
  return oid;
}

async function parents(dir: string, oid: string): Promise<string[]> {
  return (await git.readCommit({ fs, dir, oid })).commit.parent;
}

const short = (oid: string) => oid.slice(0, 8);

// ---------- trees and files ----------

/** path → blob oid for every file a commit holds under the specs. */
async function treeFiles(dir: string, oid: string | null, specs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!oid) return out;
  await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: oid })],
    map: async (filepath, [entry]) => {
      if (filepath === ".") return true;
      if (!entry) return null;
      const type = await entry.type();
      if (type === "tree") return mayHold(filepath, specs) ? true : null;
      if (type === "blob" && within(filepath, specs) && !gitBoundaryIgnored(filepath)) out.set(filepath, await entry.oid());
      return null;
    },
  });
  return out;
}

async function blobAt(dir: string, oid: string, file: string): Promise<Buffer | null> {
  try {
    return Buffer.from((await git.readBlob({ fs, dir, oid, filepath: file })).blob);
  } catch {
    return null;
  }
}

function workFile(dir: string, file: string): Buffer | null {
  try {
    const abs = path.join(dir, file);
    const st = fs.lstatSync(abs);
    return st.isFile() ? fs.readFileSync(abs) : null;
  } catch {
    return null;
  }
}

const isBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0);

// ---------- diffs ----------

/** One changed file. Contents load on first use: name-only and name-status
 *  output never needs them, and a changed chat can be megabytes. */
interface Change {
  file: string;
  status: "A" | "M" | "D";
  load: () => Promise<{ before: Buffer | null; after: Buffer | null }>;
}

type DiffFormat = "patch" | "stat" | "name-only" | "name-status";

async function formatChanges(changes: Change[], format: DiffFormat): Promise<string> {
  changes.sort((a, b) => a.file.localeCompare(b.file));
  if (format === "name-only") return changes.map((c) => c.file).join("\n");
  if (format === "name-status") return changes.map((c) => `${c.status}\t${c.file}`).join("\n");
  const out: string[] = [];
  let plus = 0;
  let minus = 0;
  let size = 0;
  for (const c of changes) {
    // past the output cap the rest would only be cut away: stop reading
    if (size > MAX_OUTPUT) {
      out.push(`… ${changes.length - out.length} more file(s)`);
      break;
    }
    const { before, after } = await c.load();
    const line = format === "stat" ? statLine(c.file, before, after) : { text: patchOf(c.file, before, after), plus: 0, minus: 0 };
    plus += line.plus;
    minus += line.minus;
    size += line.text.length;
    out.push(line.text);
  }
  if (format === "stat") out.push(` ${changes.length} file${changes.length === 1 ? "" : "s"} changed, ${plus} insertion${plus === 1 ? "" : "s"}(+), ${minus} deletion${minus === 1 ? "" : "s"}(-)`);
  return out.join("\n");
}

function statLine(file: string, before: Buffer | null, after: Buffer | null): { text: string; plus: number; minus: number } {
  const a = before ?? Buffer.alloc(0);
  const b = after ?? Buffer.alloc(0);
  if (agentReadDenied(file)) return { text: ` ${file} | hidden`, plus: 0, minus: 0 };
  if (isBinary(a) || isBinary(b)) return { text: ` ${file} | Bin`, plus: 0, minus: 0 };
  if (a.length + b.length > MAX_DIFF_FILE) return { text: ` ${file} | ${a.length} -> ${b.length} bytes`, plus: 0, minus: 0 };
  let plus = 0;
  let minus = 0;
  for (const hunk of structuredPatch("a", "b", a.toString("utf8"), b.toString("utf8"), "", "", { context: 0 }).hunks) {
    for (const line of hunk.lines) {
      if (line[0] === "+") plus++;
      else if (line[0] === "-") minus++;
    }
  }
  return { text: ` ${file} | ${plus + minus} ${"+".repeat(Math.min(plus, 30))}${"-".repeat(Math.min(minus, 30))}`, plus, minus };
}

function patchOf(file: string, before: Buffer | null, after: Buffer | null): string {
  const head = [`diff --git a/${file} b/${file}`];
  if (before === null) head.push("new file");
  if (after === null) head.push("deleted file");
  const reason = agentReadDenied(file);
  if (reason) return `${head.join("\n")}\n(content hidden: ${reason})`;
  const a = before ?? Buffer.alloc(0);
  const b = after ?? Buffer.alloc(0);
  if (isBinary(a) || isBinary(b)) return `${head.join("\n")}\nBinary files differ`;
  if (a.length + b.length > MAX_DIFF_FILE) return `${head.join("\n")}\n(too large to diff here: ${a.length} -> ${b.length} bytes; read the file or grep it)`;
  const patch = createTwoFilesPatch(before === null ? "/dev/null" : `a/${file}`, after === null ? "/dev/null" : `b/${file}`, a.toString("utf8"), b.toString("utf8"), "", "", { context: 3 });
  return `${head.join("\n")}\n${patch.replace(/^(Index [^\n]*\n)?={10,}\n/, "").trimEnd()}`;
}

/** Changes between two commits (null = the empty tree). Both trees are
 *  walked together and a folder that is the same object on both sides is
 *  skipped whole, so the cost follows what changed, not the workspace size. */
async function treeChanges(dir: string, from: string | null, to: string, specs: string[]): Promise<Change[]> {
  const out: Change[] = [];
  await git.walk({
    fs,
    dir,
    trees: from ? [git.TREE({ ref: from }), git.TREE({ ref: to })] : [git.TREE({ ref: to })],
    map: async (filepath, entries) => {
      if (filepath === ".") return true;
      const [a, b] = from ? entries : [null, entries[0]];
      const [ta, tb] = await Promise.all([a ? a.type() : null, b ? b.type() : null]);
      if (ta === "tree" || tb === "tree") {
        if (!mayHold(filepath, specs)) return null;
        if (ta === "tree" && tb === "tree" && (await a!.oid()) === (await b!.oid())) return null;
        return true;
      }
      if (!within(filepath, specs) || gitBoundaryIgnored(filepath)) return null;
      const [oa, ob] = await Promise.all([ta === "blob" ? a!.oid() : null, tb === "blob" ? b!.oid() : null]);
      if (oa === ob) return null;
      out.push({
        file: filepath,
        status: oa === null ? "A" : ob === null ? "D" : "M",
        load: async () => ({
          before: oa === null ? null : await blobAt(dir, from!, filepath),
          after: ob === null ? null : await blobAt(dir, to, filepath),
        }),
      });
      return null;
    },
  });
  return out;
}

/** Changes from a commit to the files on disk. Only files that differ from
 *  HEAD on disk, or between the commit and HEAD, are read: the workspace
 *  holds every chat, and hashing all of it per call is not an option. */
async function workdirChanges(dir: string, from: string, specs: string[]): Promise<Change[]> {
  const head = await git.resolveRef({ fs, dir, ref: "HEAD" }).catch(() => null);
  const pending = (await repo.status(dir)).filter((s) => s.head !== 0 && within(s.path, specs)).map((s) => s.path);
  const candidates = new Set(pending);
  if (head && head !== from) for (const c of await treeChanges(dir, from, head, specs)) candidates.add(c.file);
  const out: Change[] = [];
  for (const file of candidates) {
    const before = await blobAt(dir, from, file);
    const after = workFile(dir, file);
    if (before === null && after === null) continue;
    if (before && after && before.equals(after)) continue;
    out.push({ file, status: before === null ? "A" : after === null ? "D" : "M", load: async () => ({ before, after }) });
  }
  return out;
}

// ---------- commands ----------

function takeFormat(flags: string[]): DiffFormat {
  if (flags.includes("--stat")) return "stat";
  if (flags.includes("--name-only")) return "name-only";
  if (flags.includes("--name-status")) return "name-status";
  return "patch";
}

async function status(o: GitCliOptions, args: string[]): Promise<string> {
  const { flags, paths } = splitPathspecs(args);
  const specs = paths.map(normalizeSpec);
  const rows = (await repo.status(o.dir)).filter((r) => within(r.path, specs)).sort((a, b) => a.path.localeCompare(b.path));
  // tracked changes first, untracked files after, as git lists them
  const changed = rows.filter((r) => r.head !== 0);
  const untracked = rows.filter((r) => r.head === 0);
  if (flags.includes("-s") || flags.includes("--short") || flags.includes("--porcelain")) {
    return [...changed.map((r) => `${r.workdir === 0 ? " D" : " M"} ${r.path}`), ...untracked.map((r) => `?? ${r.path}`)].join("\n");
  }
  if (!rows.length) return "On branch main\nnothing to commit, working tree clean";
  const lines = ["On branch main"];
  if (changed.length) lines.push("Changes not committed yet:", ...changed.map((r) => `\t${r.workdir === 0 ? "deleted: " : "modified:"}   ${r.path}`));
  if (untracked.length) lines.push("Untracked files:", ...untracked.map((r) => `\t${r.path}`));
  return lines.join("\n");
}

async function diff(o: GitCliOptions, args: string[]): Promise<string> {
  const { flags, paths } = splitPathspecs(args);
  const specs = paths.map(normalizeSpec);
  const format = takeFormat(flags);
  if (flags.includes("--cached") || flags.includes("--staged")) return "(nothing is staged: the workspace commits changes directly; plain `diff` shows what is not committed yet)";
  const revs = flags.filter((f) => !f.startsWith("-")).flatMap((r) => (r.includes("..") ? r.split(/\.\.\.?/) : [r]));
  let changes: Change[];
  if (revs.length === 0) changes = await workdirChanges(o.dir, await resolveRev(o.dir, "HEAD"), specs);
  else if (revs.length === 1) changes = await workdirChanges(o.dir, await resolveRev(o.dir, revs[0]!), specs);
  else if (revs.length === 2) changes = await treeChanges(o.dir, await resolveRev(o.dir, revs[0] || "HEAD"), await resolveRev(o.dir, revs[1] || "HEAD"), specs);
  else return fail("diff takes at most two revisions");
  return changes.length ? formatChanges(changes, format) : "";
}

interface LogEntry {
  oid: string;
  commit: { message: string; author: { name: string; email: string; timestamp: number }; parent: string[] };
}

async function log(o: GitCliOptions, args: string[]): Promise<string> {
  const { flags, paths } = splitPathspecs(args);
  const specs = paths.map(normalizeSpec).filter(Boolean);
  let limit = DEFAULT_LOG;
  let limited = false;
  const rest: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    const n = /^-(\d+)$/.exec(f)?.[1] ?? /^--max-count=(\d+)$/.exec(f)?.[1] ?? (f === "-n" || f === "--max-count" ? flags[++i] : undefined);
    if (n !== undefined) {
      limit = Math.max(1, Math.min(500, Number(n) || DEFAULT_LOG));
      limited = true;
    } else rest.push(f);
  }
  const oneline = rest.includes("--oneline");
  const withPatch = rest.includes("-p") || rest.includes("--patch");
  const withStat = rest.includes("--stat");
  const revArg = rest.find((f) => !f.startsWith("-"));
  let stopAt: string | null = null;
  let tip = "HEAD";
  if (revArg?.includes("..")) {
    const [a, b] = revArg.split(/\.\.\.?/);
    stopAt = await resolveRev(o.dir, a || "HEAD");
    tip = b || "HEAD";
  } else if (revArg) tip = revArg;
  const ref = await resolveRev(o.dir, tip);
  // one walk per pathspec (isomorphic-git filters on a single path), merged
  const walks = specs.length ? specs : [null];
  const seen = new Map<string, LogEntry>();
  for (const filepath of walks) {
    const entries = (await git.log({ fs, dir: o.dir, ref, depth: stopAt ? 5000 : limit + 1, ...(filepath ? { filepath, force: true } : {}) })) as LogEntry[];
    for (const e of entries) {
      if (e.oid === stopAt) break;
      seen.set(e.oid, e);
    }
  }
  const all = [...seen.values()].sort((a, b) => b.commit.author.timestamp - a.commit.author.timestamp);
  const shown = all.slice(0, limit);
  const blocks: string[] = [];
  for (const e of shown) {
    const subject = e.commit.message.trim();
    let block = oneline
      ? `${short(e.oid)} ${subject.split("\n")[0]}`
      : `commit ${e.oid}\nAuthor: ${e.commit.author.name} <${e.commit.author.email}>\nDate:   ${new Date(e.commit.author.timestamp * 1000).toISOString()}\n\n${subject.split("\n").map((l) => `    ${l}`).join("\n")}`;
    if (withPatch || withStat) {
      const changes = await treeChanges(o.dir, e.commit.parent[0] ?? null, e.oid, paths.map(normalizeSpec));
      block += `\n\n${await formatChanges(changes, withStat && !withPatch ? "stat" : "patch")}`;
    }
    blocks.push(block);
  }
  const more = all.length > shown.length && !limited ? `\n(showing the newest ${limit}; -n <count> for more)` : "";
  return (blocks.join(oneline && !withPatch && !withStat ? "\n" : "\n\n") || "(no commits)") + more;
}

async function show(o: GitCliOptions, args: string[]): Promise<string> {
  const { flags, paths } = splitPathspecs(args);
  const target = flags.find((f) => !f.startsWith("-")) ?? "HEAD";
  const colon = target.indexOf(":");
  if (colon !== -1) {
    const oid = await resolveRev(o.dir, target.slice(0, colon) || "HEAD");
    const file = normalizeSpec(target.slice(colon + 1));
    const reason = agentReadDenied(file) ?? (gitBoundaryIgnored(file) ? "not part of the workspace history" : null);
    if (reason) return fail(`${file}: ${reason}`);
    const body = await blobAt(o.dir, oid, file);
    if (body === null) {
      const inside = await treeFiles(o.dir, oid, [file]);
      if (inside.size) return [...inside.keys()].map((f) => f.slice(file ? file.length + 1 : 0)).sort().join("\n");
      return fail(`path '${file}' does not exist in ${short(oid)}`);
    }
    return isBinary(body) ? `(binary file, ${body.length} bytes)` : body.toString("utf8");
  }
  const oid = await resolveRev(o.dir, target);
  const { commit } = await git.readCommit({ fs, dir: o.dir, oid });
  const header = `commit ${oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\nDate:   ${new Date(commit.author.timestamp * 1000).toISOString()}\n\n${commit.message.trim().split("\n").map((l) => `    ${l}`).join("\n")}`;
  const changes = await treeChanges(o.dir, commit.parent[0] ?? null, oid, paths.map(normalizeSpec));
  return changes.length ? `${header}\n\n${await formatChanges(changes, takeFormat(flags))}` : header;
}

function refuseInPlanMode(o: GitCliOptions, what: string): void {
  if (o.readOnly) fail(`Plan mode: ${what} changes files, so it is not available.`);
}

async function commit(o: GitCliOptions, args: string[]): Promise<string> {
  refuseInPlanMode(o, "commit");
  const messages: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-m" || a === "--message") messages.push(args[++i] ?? fail("-m needs a message"));
    else if (a.startsWith("--message=")) messages.push(a.slice("--message=".length));
    else if (/^-[a-z]*m$/.test(a)) messages.push(args[++i] ?? fail("-m needs a message"));
  }
  const message = messages.join("\n\n").trim();
  if (!message) return fail("commit needs a message: commit -m \"what changed and why\"");
  const oid = await repo.commitAll(o.dir, o.username, message, true);
  return oid ? `[main ${short(oid)}] ${message.split("\n")[0]}` : "nothing to commit, working tree clean (file tools and app routes commit on their own; log shows those commits)";
}

/** Write files back to their content at a commit, then commit that. */
async function writeBack(o: GitCliOptions, oid: string, files: Map<string, Buffer | null>, message: string): Promise<string> {
  const guard = makePathGuard(o.dir);
  for (const file of files.keys()) {
    const reason = agentWriteDenied(file) ?? (gitBoundaryIgnored(file) ? "not part of the workspace history" : null);
    if (reason) fail(`${file}: ${reason}`);
    guard.assertWritable(path.join(o.dir, file), file);
  }
  for (const [file, body] of files) {
    const abs = path.join(o.dir, file);
    if (body === null) fs.rmSync(abs, { force: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
  }
  const committed = await repo.commitPaths(o.dir, o.username, message, [...files.keys()], true);
  return `${[...files.keys()].sort().map((f) => `${files.get(f) === null ? "deleted" : "restored"} ${f}`).join("\n")}\n${committed ? `[main ${short(committed)}] ${message}` : `(already matched ${short(oid)}; nothing to commit)`}`;
}

async function restore(o: GitCliOptions, args: string[]): Promise<string> {
  refuseInPlanMode(o, "restore");
  const { flags, paths } = splitPathspecs(args);
  let source = "HEAD";
  const loose: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    if (f === "-s" || f === "--source") source = flags[++i] ?? fail(`${f} needs a revision`);
    else if (f.startsWith("--source=")) source = f.slice("--source=".length);
    else if (f === "--worktree" || f === "-W" || f === "--staged" || f === "-S") continue;
    else if (f.startsWith("-")) fail(`restore: unsupported option ${f}`);
    else loose.push(f);
  }
  return restoreFrom(o, source, [...loose, ...paths]);
}

async function restoreFrom(o: GitCliOptions, source: string, specs: string[]): Promise<string> {
  if (!specs.length) return fail("name the files to restore: restore --source <commit> -- <path>...");
  const oid = await resolveRev(o.dir, source);
  const normalized = specs.map(normalizeSpec);
  if (normalized.includes("")) fail("restore names files or folders, not the whole workspace");
  const found = await treeFiles(o.dir, oid, normalized);
  for (const spec of normalized) {
    if (![...found.keys()].some((f) => within(f, [spec]))) fail(`pathspec '${spec}' did not match any file in ${short(oid)}`);
  }
  const files = new Map<string, Buffer | null>();
  for (const file of found.keys()) files.set(file, await blobAt(o.dir, oid, file));
  return writeBack(o, oid, files, `restore: ${normalized.join(", ")} from ${short(oid)}`);
}

async function checkout(o: GitCliOptions, args: string[]): Promise<string> {
  const { flags, paths } = splitPathspecs(args);
  if (!paths.length) return fail("checkout here only restores files: checkout <commit> -- <path>... (there are no branches to switch)");
  refuseInPlanMode(o, "checkout");
  const rev = flags.find((f) => !f.startsWith("-")) ?? "HEAD";
  return restoreFrom(o, rev, paths);
}

async function revert(o: GitCliOptions, args: string[]): Promise<string> {
  refuseInPlanMode(o, "revert");
  const target = args.find((a) => !a.startsWith("-")) ?? fail("revert needs a commit");
  const oid = await resolveRev(o.dir, target);
  const { commit: c } = await git.readCommit({ fs, dir: o.dir, oid });
  const parent = c.parent[0] ?? null;
  const changes = await treeChanges(o.dir, parent, oid, []);
  if (!changes.length) return `${short(oid)} changed nothing to revert`;
  // only files still as that commit left them: undoing it over later edits
  // would silently throw those edits away
  const files = new Map<string, Buffer | null>();
  const moved: string[] = [];
  for (const ch of changes) {
    const { before, after } = await ch.load();
    const now = workFile(o.dir, ch.file);
    if (after === null ? now !== null : now === null || !now.equals(after)) moved.push(ch.file);
    files.set(ch.file, before);
  }
  if (moved.length) {
    return fail(`these files changed after ${short(oid)}, so reverting it would lose that work:\n${moved.map((m) => `  ${m}`).join("\n")}\nUse diff ${short(oid)} -- <path> to see what changed, then restore or edit them one by one.`);
  }
  return writeBack(o, oid, files, `Revert "${c.message.trim().split("\n")[0]}"`);
}

const UNSUPPORTED: Record<string, string> = {
  add: "there is no staging area: commit -m takes every change at once",
  stage: "there is no staging area: commit -m takes every change at once",
  reset: "history is never rewritten here: restore --source <commit> -- <path> puts files back, revert <commit> undoes a commit",
  rebase: "history is never rewritten here: revert <commit> undoes a commit",
  stash: "there is no stash: commit your work, or diff to see it",
  branch: "the workspace has one line of history (main)",
  switch: "the workspace has one line of history (main)",
  merge: "the workspace has one line of history (main); app updates merge on their own",
  cherry: "the workspace has one line of history (main)",
  "cherry-pick": "the workspace has one line of history (main): restore files from the commit instead",
  push: "the workspace is local: there is no remote",
  pull: "the workspace is local: there is no remote",
  fetch: "the workspace is local: there is no remote",
  clone: "cloning is not available; apps come from the Store or Import app",
  init: "the workspace repository already exists",
  rm: "delete the file, then commit",
  mv: "move the file, then commit",
};

export const GIT_COMMANDS = "status, diff, log, show, commit, restore, checkout <commit> -- <path>, revert";

/** Run one git command line against the workspace repository. */
export async function runGitCli(o: GitCliOptions, input: string): Promise<string> {
  const args = splitArgs(input);
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "help" || cmd === "--help") return `Supported: ${GIT_COMMANDS}. Arguments work as on the command line, including revisions like HEAD~2 and -- pathspecs.`;
  let out: string;
  switch (cmd) {
    case "status": out = await status(o, rest); break;
    case "diff": out = await diff(o, rest); break;
    case "log": out = await log(o, rest); break;
    case "show": out = await show(o, rest); break;
    case "commit": out = await commit(o, rest); break;
    case "restore": out = await restore(o, rest); break;
    case "checkout": out = await checkout(o, rest); break;
    case "revert": out = await revert(o, rest); break;
    case "rev-parse": out = (await Promise.all(rest.filter((r) => !r.startsWith("-")).map((r) => resolveRev(o.dir, r)))).join("\n"); break;
    default:
      return fail(UNSUPPORTED[cmd] ? `git ${cmd}: ${UNSUPPORTED[cmd]}` : `git ${cmd} is not available. Supported: ${GIT_COMMANDS}.`);
  }
  return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… (output cut at ${MAX_OUTPUT} characters: narrow it with -- <path>, --stat or -n)` : out;
}
