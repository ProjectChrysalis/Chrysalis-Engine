/**
 * Engine side of the in-browser builder. The engine never runs a build tool
 * over app files any more; it only
 *   - answers the builder's file reads for ONE app (appFsOps), and
 *   - writes what the builder produced into that app's dist/ (writeOutput).
 * Both are plain file operations with containment checks: no parsing, no
 * module loading, no toolchain. Everything that interprets app content runs
 * in the sandboxed builder frame in the browser.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FsOp, FsResult } from "./fs.js";

/** Top-level app dirs the builder never sees: user data, server-side plugin
 *  code, the build output itself, version control. */
const HIDDEN_TOP = new Set(["data", "plugins", "dist", ".git"]);
const MAX_TEXT = 32 * 1024 * 1024;
const MAX_INLINE = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 96 * 1024 * 1024;
export const MAX_BATCH_OPS = 1000;

/** An app dir's real location, anchored on the real apps dir: an app dir
 *  that is itself a symlink does not get to move the root. */
export function appRoot(appsDir: string, id: string): string {
  return path.join(fs.realpathSync(appsDir), id);
}

/** Why a builder may not see this app-relative path, or null if it may. */
export function hiddenReason(rel: string): string | null {
  if (rel.includes("\0") || rel.includes("\\")) return "bad path";
  const segs = rel.split("/");
  if (segs.some((s) => s === ".." || s === ".")) return "bad path";
  if (rel !== "" && segs.some((s) => s === "")) return "bad path";
  if (HIDDEN_TOP.has(segs[0]!)) return "not part of the app's source";
  if (segs.includes(".git")) return "not part of the app's source";
  if (/^\.env(?:\.|$)/.test(segs[segs.length - 1]!)) return "env files are read by the engine, not the builder";
  return null;
}

/** The real file for `rel`, or null when any part of the path is a symlink
 *  or the path leaves the app (realpath must land exactly where we asked). */
function realInside(root: string, rel: string): string | null {
  const full = rel === "" ? root : path.join(root, ...rel.split("/"));
  let real: string;
  try {
    real = fs.realpathSync(full);
  } catch {
    return null;
  }
  return real === full ? full : null;
}

const hashCache = new Map<string, { key: string; hash: string }>();

function readEnvVars(root: string, mode: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`]) {
    const file = realInside(root, name);
    if (!file) continue;
    let text = "";
    try {
      if (fs.statSync(file).size > 256 * 1024) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?(VITE_[A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2]!;
      const q = v[0];
      if ((q === '"' || q === "'") && v.endsWith(q)) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, "");
      // only VITE_-prefixed values ever reach a bundle (vite's rule)
      out[m[1]!] = v;
    }
  }
  return out;
}

/** Answer a batch of builder file operations for app `id`. */
export function appFsOps(appsDir: string, id: string, ops: FsOp[]): FsResult[] {
  const root = appRoot(appsDir, id);
  let budget = MAX_BATCH_BYTES;
  return ops.slice(0, MAX_BATCH_OPS).map((op): FsResult => {
    try {
      if (op.op === "env") return { ok: true, env: readEnvVars(root, String(op.mode).replace(/[^a-z]/g, "") || "production") };
      const rel = typeof op.path === "string" ? op.path : "";
      const why = hiddenReason(rel);
      if (why) return op.op === "stat" ? { ok: true, stat: null } : { ok: false, error: why };
      const file = realInside(root, rel);
      if (op.op === "stat") {
        if (!file) return { ok: true, stat: null };
        const st = fs.statSync(file);
        return { ok: true, stat: st.isDirectory() ? { kind: "dir", size: 0 } : st.isFile() ? { kind: "file", size: st.size } : null };
      }
      if (!file) return { ok: false, error: "not found" };
      if (op.op === "readdir") {
        const entries: Array<{ name: string; kind: "file" | "dir" }> = [];
        for (const e of fs.readdirSync(file, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          if (hiddenReason(childRel)) continue;
          if (e.isDirectory()) entries.push({ name: e.name, kind: "dir" });
          else if (e.isFile()) entries.push({ name: e.name, kind: "file" });
          // symlinks and specials are not part of any app
        }
        return { ok: true, entries };
      }
      const st = fs.statSync(file);
      if (!st.isFile()) return { ok: false, error: "not a file" };
      if (op.op === "hash") {
        const key = `${st.size}:${st.mtimeMs}`;
        const hit = hashCache.get(file);
        if (hit?.key === key) return { ok: true, hash: hit.hash };
        const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        hashCache.set(file, { key, hash });
        return { ok: true, hash };
      }
      if (op.op === "read") {
        const cap = op.binary ? MAX_INLINE : MAX_TEXT;
        if (st.size > cap || st.size > budget) return { ok: false, error: `too large to read (${st.size} bytes)` };
        budget -= st.size;
        const buf = fs.readFileSync(file);
        return op.binary ? { ok: true, b64: buf.toString("base64") } : { ok: true, text: buf.toString("utf8") };
      }
      return { ok: false, error: "unknown op" };
    } catch (e) {
      return { ok: false, error: (e as NodeJS.ErrnoException).code ?? "failed" };
    }
  });
}

// ---------- source fingerprint + change routing ----------

/** App-relative paths the builder reads, for the file watcher (rel is
 *  "<appId>/<path>"): everything but data/, plugins/, dist/, node_modules/
 *  and dot-dirs (.env files count). */
export function isBuildSource(rel: string): boolean {
  const segs = rel.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) return false;
  const rest = segs.slice(1);
  if (HIDDEN_TOP.has(rest[0]!) || rest.includes("node_modules") || rest.includes(".git")) return false;
  if (rest.slice(0, -1).some((s) => s.startsWith("."))) return false;
  const file = rest[rest.length - 1]!;
  return !file.startsWith(".") || /^\.env(?:\.|$)/.test(file);
}

/** A cheap fingerprint of what a build reads: newest mtime and file count
 *  over the app's source tree, plus the installed-packages marker. */
export function sourceRev(appDir: string): string {
  let newest = 0;
  let count = 0;
  const walk = (dir: string, depth: number, top: boolean): void => {
    if (depth > 16) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || (top && HIDDEN_TOP.has(e.name))) continue;
      if (e.name.startsWith(".") && !/^\.env(?:\.|$)/.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1, false);
        continue;
      }
      count++;
      try {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        /* raced a write */
      }
    }
  };
  walk(appDir, 0, true);
  // Install marker: whatever the app's deps were installed with — the
  // node_modules dir itself, npm's bookkeeping, or a lockfile. A reinstall
  // moves at least one of them, which is all this fingerprint needs.
  let installed = 0;
  for (const marker of ["node_modules", "node_modules/.package-lock.json", "bun.lock", "bun.lockb"]) {
    try {
      const m = fs.statSync(path.join(appDir, marker)).mtimeMs;
      if (m > installed) installed = m;
    } catch {
      /* not installed that way */
    }
  }
  return `${Math.round(newest)}-${count}-${Math.round(installed)}`;
}

// ---------- build lease ----------

const leases = new Map<string, { holder: string; until: number; busy: boolean }>();
const LEASE_MS = 45_000;

/**
 * One tab builds an app at a time. The holder marks the lease `busy` while a
 * build is actually running; an idle lease protects nothing, so another tab
 * may take it over at once. That keeps a page that is merely open (or whose
 * build died) from parking the app behind "another tab is building" while
 * nothing is. `force` is the fallback for a holder that stays busy past any
 * plausible build: after waiting it out, a contender takes even that.
 */
export function takeLease(key: string, holder: string, opts: { release?: boolean; force?: boolean; busy?: boolean } = {}): boolean {
  const now = Date.now();
  const cur = leases.get(key);
  if (opts.release) {
    if (cur?.holder === holder) leases.delete(key);
    return false;
  }
  if (!cur || cur.until < now || cur.holder === holder || opts.force === true || !cur.busy) {
    leases.set(key, { holder, until: now + LEASE_MS, busy: opts.busy === true });
    return true;
  }
  return false;
}

export function leaseHolder(key: string): string | null {
  const cur = leases.get(key);
  return cur && cur.until >= Date.now() ? cur.holder : null;
}

// ---------- build status ----------

export interface BuildStatusFile {
  rev: string;
  ok: boolean;
  mode: "development" | "production";
  errors: Array<{ text: string; file?: string; line?: number; column?: number; lineText?: string }>;
  warnings: number;
  at: number;
  /** Which builder produced it. A status from an older browser bundle can
   *  carry stale results (an error the new builder would catch), so both
   *  /build/status and app_check treat a mismatch as not built. */
  builder?: string;
}

const STATUS = ".chrysalis-build.json";
const CLIENT_ERRORS = ".chrysalis-client-errors.jsonl";
const CLIENT_ERRORS_MAX = 200;
const CLIENT_LOGS = ".chrysalis-client-logs.jsonl";
const CLIENT_LOGS_MAX = 300;

export function readBuildStatus(appDir: string): BuildStatusFile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, "dist", STATUS), "utf8")) as BuildStatusFile;
  } catch {
    return null;
  }
}

/** A runtime error the app frame caught (uncaught throw, unhandled rejection,
 *  console.error), tagged with the source revision it ran on. */
export interface ClientErrorEntry {
  kind: string;
  text: string;
  stack?: string;
  at: number;
  rev: string;
}

/** Append runtime errors to the app's dist (derived, gitignored, swapped away
 *  by the next full build). Ring-trimmed so a console-error loop cannot grow
 *  the file without bound. */
export function writeClientErrors(appDir: string, entries: ClientErrorEntry[]): void {
  appendJsonlRing(path.join(appDir, "dist", CLIENT_ERRORS), CLIENT_ERRORS_MAX, entries);
}

/** The runtime errors recorded while `rev` was the built source. Older revs
 *  are history from before the last build and are dropped; newest last. */
export function readClientErrors(appDir: string, rev: string, limit = 20): ClientErrorEntry[] {
  try {
    const lines = fs.readFileSync(path.join(appDir, "dist", CLIENT_ERRORS), "utf8").split("\n");
    const out: ClientErrorEntry[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as ClientErrorEntry;
        if (e && e.rev === rev && typeof e.text === "string") out.push(e);
      } catch { /* torn line */ }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

/** A print the app page made (console.log/info/warn/debug), tagged with the
 *  source revision it ran on. */
export interface ClientLogEntry {
  kind: string;
  text: string;
  at: number;
  rev: string;
}

/** Append page prints to the app's dist, ring-trimmed like the errors: a
 *  print loop must not grow the file without bound. */
export function writeClientLogs(appDir: string, entries: ClientLogEntry[]): void {
  appendJsonlRing(path.join(appDir, "dist", CLIENT_LOGS), CLIENT_LOGS_MAX, entries);
}

/** The page prints recorded while `rev` was the built source; newest last. */
export function readClientLogs(appDir: string, rev: string, limit = 100): ClientLogEntry[] {
  try {
    const lines = fs.readFileSync(path.join(appDir, "dist", CLIENT_LOGS), "utf8").split("\n");
    const out: ClientLogEntry[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as ClientLogEntry;
        if (e && e.rev === rev && typeof e.text === "string") out.push(e);
      } catch { /* torn line */ }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

/** Append JSONL entries and keep only the newest `max` lines. */
function appendJsonlRing(file: string, max: number, entries: readonly unknown[]): void {
  if (!entries.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > max) fs.writeFileSync(file, lines.slice(-max).join("\n") + "\n", "utf8");
  } catch { /* trim is best effort */ }
}

/** The dev meta a builder session may adopt, or null when it describes a
 *  dist that cannot load: every file it references must be on disk. A stale
 *  or interrupted write must not be adopted, or the next hot update points
 *  open pages at files nothing ever wrote. */
export function readDevMeta(appDir: string): unknown {
  try {
    const dist = path.join(appDir, "dist");
    const meta = JSON.parse(fs.readFileSync(path.join(dist, "dev", "meta.json"), "utf8")) as {
      snapshot?: unknown;
      depsJs?: unknown;
      depsCss?: unknown;
    };
    for (const p of [meta.snapshot, meta.depsJs, ...(meta.depsCss ? [meta.depsCss] : [])]) {
      if (typeof p !== "string" || p.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
      if (!fs.existsSync(path.join(dist, ...p.split("/")))) return null;
    }
    return meta;
  } catch {
    return null;
  }
}

// ---------- writing build output ----------

const DIST_PATH = /^(?:[A-Za-z0-9_@-][A-Za-z0-9_.@-]{0,150}\/){0,6}[A-Za-z0-9_@-][A-Za-z0-9_.@-]{0,150}$/;
export const MAX_OUTPUT_FILES = 5000;

/** A path the builder may write under dist/: plain segments, no dot-files. */
export function validDistPath(p: unknown): p is string {
  return typeof p === "string" && p.length <= 400 && DIST_PATH.test(p) && !p.split("/").some((s) => s.startsWith("."));
}

export interface BuilderOutput {
  ok: boolean;
  mode: "development" | "production";
  files: Array<{ path: string; contents: string }>;
  copies: Array<{ from: string; to: string }>;
  errors: BuildStatusFile["errors"];
  warnings: unknown[];
  remove?: string[];
  keep?: string[];
  full?: boolean;
  hot?: { seq: number; file: string } | null;
}

/** Check an output's shape before anything is written. */
export function checkOutput(raw: unknown): BuilderOutput | string {
  const o = raw as Partial<BuilderOutput> | null;
  if (!o || typeof o !== "object") return "no output";
  if (o.mode !== "development" && o.mode !== "production") return "bad mode";
  const files = Array.isArray(o.files) ? o.files : [];
  const copies = Array.isArray(o.copies) ? o.copies : [];
  if (files.length > MAX_OUTPUT_FILES || copies.length > 4 * MAX_OUTPUT_FILES) return "too many files";
  for (const f of files) if (!f || !validDistPath(f.path) || typeof f.contents !== "string") return `bad output file ${String(f?.path)}`;
  for (const c of copies) {
    if (!c || typeof c.from !== "string" || !validDistPath(c.to)) return `bad copy ${String(c?.to)}`;
    try {
      if (hiddenReason(normalizeRel(c.from))) return `copy source ${c.from} is not part of the app`;
    } catch {
      return `bad copy source ${c.from}`;
    }
  }
  for (const list of [o.remove, o.keep]) {
    if (list !== undefined && (!Array.isArray(list) || list.some((p) => !validDistPath(p)))) return "bad remove/keep list";
  }
  const errors = (Array.isArray(o.errors) ? o.errors : []).slice(0, 50).map((e) => ({
    text: String((e as { text?: unknown })?.text ?? "").slice(0, 4000),
    ...(typeof (e as { file?: unknown }).file === "string" ? { file: String((e as { file: string }).file).slice(0, 400) } : {}),
    ...(typeof (e as { line?: unknown }).line === "number" ? { line: (e as { line: number }).line } : {}),
    ...(typeof (e as { column?: unknown }).column === "number" ? { column: (e as { column: number }).column } : {}),
    ...(typeof (e as { lineText?: unknown }).lineText === "string" ? { lineText: String((e as { lineText: string }).lineText).slice(0, 400) } : {}),
  }));
  return {
    ok: o.ok === true,
    mode: o.mode,
    files,
    copies,
    errors,
    warnings: Array.isArray(o.warnings) ? o.warnings : [],
    remove: o.remove ?? [],
    keep: o.keep ?? [],
    full: o.full === true || o.mode === "production",
    hot: o.hot && typeof o.hot.seq === "number" && validDistPath(o.hot.file) ? { seq: o.hot.seq, file: o.hot.file } : null,
  };
}

function normalizeRel(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new Error("outside");
    out.push(seg);
  }
  return out.join("/");
}

function copyInto(root: string, from: string, dest: string): void {
  const src = realInside(root, normalizeRel(from));
  if (!src || !fs.statSync(src).isFile()) throw new Error(`copy source ${from} is missing`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);
}

/** public/ is copied as-is (regular files only; links are not the app's). */
function copyPublic(root: string, dest: string): void {
  const pub = realInside(root, "public");
  if (!pub) return;
  let budget = 20_000;
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (budget-- <= 0 || e.name.startsWith(".")) continue;
      const src = path.join(dir, e.name);
      const out = path.join(dest, rel, e.name);
      if (e.isDirectory()) walk(src, path.join(rel, e.name));
      else if (e.isFile()) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(src, out, fs.constants.COPYFILE_FICLONE);
      }
    }
  };
  walk(pub, "");
}

function writeStatus(distDir: string, out: BuilderOutput, rev: string, builder?: string): void {
  const status: BuildStatusFile = { rev, ok: out.ok, mode: out.mode, errors: out.errors, warnings: out.warnings.length, at: Date.now(), ...(builder ? { builder } : {}) };
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, STATUS), JSON.stringify(status));
}

/**
 * Write a builder's output into the app's dist/. A full build is staged
 * beside dist and swapped in; a hot update is written in place. A failed
 * build leaves dist alone and records its errors.
 */
export function writeOutput(appsDir: string, id: string, out: BuilderOutput, rev: string, builder?: string): void {
  const root = appRoot(appsDir, id);
  const dist = path.join(root, "dist");
  if (!out.ok) {
    writeStatus(dist, out, rev, builder);
    return;
  }
  if (!out.full) {
    for (const f of out.files) {
      const dest = path.join(dist, ...f.path.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.contents);
    }
    for (const c of out.copies) copyInto(root, c.from, path.join(dist, ...c.to.split("/")));
    for (const r of out.remove ?? []) fs.rmSync(path.join(dist, ...r.split("/")), { force: true });
    writeStatus(dist, out, rev, builder);
    return;
  }
  const stamp = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
  const staging = path.join(root, `.dist-next-${stamp}`);
  const old = path.join(root, `.dist-old-${stamp}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    copyPublic(root, staging);
    for (const k of out.keep ?? []) {
      const src = path.join(dist, ...k.split("/"));
      // A full build keeps files it did not resend (deps bundles). If one is
      // gone, the swapped-in dist could never load — refuse the swap so the
      // writer drops its session and rebuilds from what dist actually holds.
      if (!fs.existsSync(src) || !fs.lstatSync(src).isFile()) {
        throw new Error(`build output keeps ${k}, which dist does not have`);
      }
      const dest = path.join(staging, ...k.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);
    }
    for (const c of out.copies) copyInto(root, c.from, path.join(staging, ...c.to.split("/")));
    for (const f of out.files) {
      const dest = path.join(staging, ...f.path.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.contents);
    }
    writeStatus(staging, out, rev, builder);
    if (fs.existsSync(dist)) fs.renameSync(dist, old);
    fs.renameSync(staging, dist);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
}
