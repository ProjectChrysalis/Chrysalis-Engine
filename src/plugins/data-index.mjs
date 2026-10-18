/**
 * Indexes over an app's data folder, for the plugin sandbox's host.fs.
 *
 * The files stay the only truth: agents and people edit them as before, and
 * every answer here is checked against them. An index entry remembers a
 * file's size, times and inode; any difference re-reads that file, a new
 * file is read, a missing one is dropped. Deleting the index loses nothing
 * but the time to build it again.
 *
 *   query(spec, options)   small fields out of many JSON files: filtered,
 *                          sorted and paged without reading every file
 *   lines(file, from, to)  records (non-blank lines) of a JSONL file by
 *                          position, read without reading the rest
 *   splice(file, from, …)  replace a JSONL file from one record on, writing
 *                          only what changed
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Folder in the app's data the index lives in; reserved, never synced. */
export const INDEX_DIR = "__index";

export const signature = (st) => `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;

// ---------- field index ----------

const databases = new Map();

function database(root) {
  const file = path.join(root, INDEX_DIR, "index.sqlite");
  const held = databases.get(file);
  if (held) return held;
  const open = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
    db.exec("CREATE TABLE IF NOT EXISTS entries (spec TEXT NOT NULL, path TEXT NOT NULL, sig TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (spec, path)) WITHOUT ROWID");
    return db;
  };
  let db;
  try {
    db = open();
  } catch {
    // a damaged index is only a cache: start it over
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    db = open();
  }
  databases.set(file, db);
  return db;
}

/** Entries a worker has already loaded, by database file and spec. */
const loaded = new Map();

function patternOf(files) {
  if (typeof files !== "string" || !files || files.length > 200) throw new Error("query: files must be a path pattern such as \"characters/*/card.json\"");
  const segments = files.split("/");
  if (segments.some((s) => !s || s === "." || s === ".." || s.startsWith("__") || /[\\?[\]{}]/.test(s))) throw new Error(`query: invalid files pattern ${files}`);
  return segments.map((s) => (s.includes("*") ? new RegExp(`^${s.replace(/[.+^$()|]/g, "\\$&").replaceAll("*", "([^/]*)")}$`) : s));
}

/** Every file the pattern names, with what each `*` matched. Folders an
 *  engine reserves (`__…`) and symlinks are never part of a match. */
function matches(root, pattern, onDir) {
  const out = [];
  const walk = (dir, at, keys, rel) => {
    const part = pattern[at];
    const last = at === pattern.length - 1;
    if (typeof part === "string") {
      const full = path.join(dir, part);
      let st;
      try { st = fs.lstatSync(full); } catch { return; }
      if (last ? st.isFile() : st.isDirectory()) last ? out.push({ rel: rel + part, keys }) : walk(full, at + 1, keys, `${rel + part}/`);
      return;
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    onDir(dir);
    for (const e of entries) {
      if (e.name.startsWith("__")) continue;
      const m = part.exec(e.name);
      if (!m) continue;
      if (last ? e.isFile() : e.isDirectory()) {
        const next = [...keys, ...m.slice(1)];
        if (last) out.push({ rel: rel + e.name, keys: next });
        else walk(path.join(dir, e.name), at + 1, next, `${rel + e.name}/`);
      }
    }
  };
  walk(root, 0, [], "");
  return out;
}

/** The value at a dotted path, null when absent. A path ending in "?" asks
 *  only whether there is one, so a large value (an embedded lorebook) can be
 *  noticed without being copied into the index. */
function pick(value, dotted) {
  const exists = dotted.endsWith("?");
  let at = value;
  for (const key of (exists ? dotted.slice(0, -1) : dotted).split(".")) {
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, key)) return exists ? false : null;
    at = at[key];
  }
  if (exists) return at !== undefined && at !== null;
  return at === undefined ? null : at;
}

const compare = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
};

function test(value, cond) {
  if (cond === null || typeof cond !== "object") return Array.isArray(value) ? value.includes(cond) : value === cond;
  if (Array.isArray(cond)) return cond.some((c) => test(value, c));
  if ("exists" in cond && (value !== null) !== Boolean(cond.exists)) return false;
  if ("contains" in cond) {
    const needle = String(cond.contains).toLowerCase();
    const hay = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
    if (!hay.some((h) => h.toLowerCase().includes(needle))) return false;
  }
  if ("gt" in cond && !(compare(value, cond.gt) > 0)) return false;
  if ("gte" in cond && !(compare(value, cond.gte) >= 0)) return false;
  if ("lt" in cond && !(compare(value, cond.lt) < 0)) return false;
  if ("lte" in cond && !(compare(value, cond.lte) <= 0)) return false;
  if ("not" in cond && test(value, cond.not)) return false;
  return true;
}

/**
 * `spec`: { files: "characters/*\/card.json", fields: { name: "name", fav: "extensions.fav", hasBook: "character_book?" } }
 * `options`: { where: { field: value | [any of] | {contains, gt, gte, lt, lte, exists, not} },
 *   sort: field | [field, "desc"] | [[field, "desc"], …], offset, limit }
 * → { rows: [{ path, keys, data, error? }], total }. `keys` is what each `*`
 * matched; a file that is not valid JSON comes back with `error`.
 */
export function query(root, spec, options = {}, track) {
  const pattern = patternOf(spec?.files);
  const fields = spec?.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) throw new Error("query: fields must name at least one field");
  for (const [name, dotted] of Object.entries(fields)) if (typeof dotted !== "string" || !dotted || name.length > 64) throw new Error(`query: field ${name} must be a dotted path`);
  const db = database(root);
  const specKey = createHash("sha1").update(JSON.stringify([spec.files, Object.entries(fields).sort()])).digest("hex");
  const cacheKey = `${db.filename}\0${specKey}`;
  let known = loaded.get(cacheKey);
  if (!known) {
    known = new Map();
    for (const row of db.query("SELECT path, sig, data FROM entries WHERE spec = ?").all(specKey)) known.set(row.path, { sig: row.sig, entry: JSON.parse(row.data) });
    loaded.set(cacheKey, known);
  }
  const found = matches(root, pattern, (dir) => track?.dir(dir));
  const seen = new Set();
  const upserts = [];
  const rows = [];
  for (const { rel, keys } of found) {
    const full = path.join(root, rel);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    track?.file(full);
    seen.add(rel);
    const sig = signature(st);
    let hit = known.get(rel);
    if (!hit || hit.sig !== sig) {
      let entry;
      try {
        const value = JSON.parse(fs.readFileSync(full, "utf8"));
        entry = { data: Object.fromEntries(Object.entries(fields).map(([name, dotted]) => [name, pick(value, dotted)])) };
      } catch (e) {
        entry = { data: Object.fromEntries(Object.keys(fields).map((name) => [name, null])), error: String(e?.message ?? e).slice(0, 200) };
      }
      hit = { sig, entry };
      known.set(rel, hit);
      upserts.push([specKey, rel, sig, JSON.stringify(entry)]);
    }
    rows.push({ path: rel, keys, data: hit.entry.data, ...(hit.entry.error ? { error: hit.entry.error } : {}) });
  }
  const gone = [...known.keys()].filter((rel) => !seen.has(rel));
  if (upserts.length || gone.length) {
    for (const rel of gone) known.delete(rel);
    try {
      const put = db.prepare("INSERT OR REPLACE INTO entries VALUES (?, ?, ?, ?)");
      const drop = db.prepare("DELETE FROM entries WHERE spec = ? AND path = ?");
      db.transaction(() => {
        for (const row of upserts) put.run(...row);
        for (const rel of gone) drop.run(specKey, rel);
      })();
    } catch { /* the answer stands; the next query reads those files again */ }
  }
  let out = rows;
  const where = options?.where;
  if (where && typeof where === "object") {
    const conds = Object.entries(where);
    out = out.filter((row) => conds.every(([field, cond]) => test(field === "$path" ? row.path : row.data[field] ?? null, cond)));
  }
  const sort = options?.sort == null ? [] : typeof options.sort === "string" ? [[options.sort, "asc"]] : Array.isArray(options.sort[0]) ? options.sort : [options.sort];
  const order = sort.map((s) => (typeof s === "string" ? [s, "asc"] : [String(s[0]), s[1] === "desc" ? "desc" : "asc"]));
  out.sort((a, b) => {
    for (const [field, dir] of order) {
      const c = field === "$path" ? compare(a.path, b.path) : compare(a.data[field] ?? null, b.data[field] ?? null);
      if (c) return dir === "desc" ? -c : c;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const total = out.length;
  const offset = Math.max(0, Math.floor(Number(options?.offset) || 0));
  const limit = options?.limit == null ? total : Math.max(0, Math.floor(Number(options.limit) || 0));
  return { rows: out.slice(offset, offset + limit), total };
}

// ---------- JSONL records ----------

/** Where each record of a JSONL file starts and ends, by file. */
const records = new Map();

function scan(full, st) {
  const sig = signature(st);
  const held = records.get(full);
  if (held && held.sig === sig) return held;
  const starts = [];
  const ends = [];
  const fd = fs.openSync(full, "r");
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let base = 0, lineStart = 0, blank = true;
    for (;;) {
      const got = fs.readSync(fd, buf, 0, buf.length, base);
      if (!got) break;
      for (let i = 0; i < got; i++) {
        const byte = buf[i];
        if (byte === 10) {
          if (!blank) { starts.push(lineStart); ends.push(base + i); }
          lineStart = base + i + 1;
          blank = true;
        } else if (blank && byte !== 32 && byte !== 9 && byte !== 13) blank = false;
      }
      base += got;
    }
    if (!blank) { starts.push(lineStart); ends.push(base); }
  } finally { fs.closeSync(fd); }
  const entry = { sig, starts, ends, size: st.size };
  records.set(full, entry);
  return entry;
}

/** Records `from` (negative counts from the end) up to `to` (exclusive,
 *  default the end) → { lines, from, total, version }. A missing file has
 *  none and no version. `version` changes whenever the file does, whoever
 *  wrote it. */
export function lines(full, from = 0, to) {
  let st;
  try { st = fs.statSync(full); } catch (e) { if (e?.code === "ENOENT") return { lines: [], from: 0, total: 0, version: null }; throw e; }
  const idx = scan(full, st);
  const total = idx.starts.length;
  const clamp = (n, fallback) => { const v = n == null ? fallback : Math.floor(Number(n)); return Number.isFinite(v) ? Math.max(0, Math.min(total, v < 0 ? total + v : v)) : fallback; };
  const a = clamp(from, 0), b = Math.max(a, clamp(to, total));
  if (a === b) return { lines: [], from: a, total, version: idx.sig };
  const fd = fs.openSync(full, "r");
  try {
    const startByte = idx.starts[a], endByte = idx.ends[b - 1];
    const buf = Buffer.allocUnsafe(endByte - startByte);
    let at = 0;
    while (at < buf.length) { const got = fs.readSync(fd, buf, at, buf.length - at, startByte + at); if (!got) break; at += got; }
    const out = [];
    for (let i = a; i < b; i++) out.push(buf.toString("utf8", idx.starts[i] - startByte, idx.ends[i] - startByte).replace(/\r$/, ""));
    return { lines: out, from: a, total, version: idx.sig };
  } finally { fs.closeSync(fd); }
}

/** Keep records before `from` byte for byte and write `replacement` after
 *  them; `from` = total appends. The new records are written before the
 *  file is cut to length, so a crash in between leaves extra trailing bytes
 *  (which a reader skips as an unreadable line), never lost new ones.
 *  → { total, version } */
export function splice(full, from, replacement) {
  if (!Array.isArray(replacement) || replacement.some((l) => typeof l !== "string" || l.includes("\n"))) throw new Error("spliceLines: records must be strings without newlines");
  let st = null;
  try { st = fs.statSync(full); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  const idx = st ? scan(full, st) : { starts: [], ends: [], size: 0 };
  const total = idx.starts.length;
  const at = Math.floor(Number(from));
  if (!Number.isFinite(at) || at < 0 || at > total) throw new Error(`spliceLines: from must be between 0 and ${total}`);
  let offset = at < total ? idx.starts[at] : idx.size;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const fd = fs.openSync(full, st ? "r+" : "w");
  try {
    // appending to a file whose last record has no newline yet
    let lead = "";
    if (at === total && offset > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, offset - 1);
      if (last[0] !== 10) lead = "\n";
    }
    const text = lead + replacement.map((l) => `${l}\n`).join("");
    const bytes = Buffer.from(text, "utf8");
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, offset + written);
    fs.ftruncateSync(fd, offset + bytes.length);
    // the records just written, without reading the file again
    const starts = idx.starts.slice(0, at), ends = idx.ends.slice(0, at);
    offset += Buffer.byteLength(lead);
    for (const line of replacement) {
      const len = Buffer.byteLength(line);
      if (line.trim()) { starts.push(offset); ends.push(offset + len); }
      offset += len + 1;
    }
    fs.fsyncSync(fd);
    const after = fs.fstatSync(fd);
    const sig = signature(after);
    records.set(full, { sig, starts, ends, size: after.size });
    return { total: starts.length, version: sig };
  } finally { fs.closeSync(fd); }
}
