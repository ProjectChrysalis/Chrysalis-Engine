import fs from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export const IMPORT_CHUNK_BYTES = 8 * 1024 * 1024;
export const IMPORT_MAX_BYTES = 32 * 1024 ** 3;
const MAX_EXPANDED = 256 * 1024 ** 3;
const MAX_ENTRY = 64 * 1024 ** 2;
const BATCH_BYTES = 8 * 1024 ** 2;
export interface ImportState { id: string; name: string; size: number; uploaded: number; status: "uploading" | "indexing" | "ready" | "failed"; files: number; expanded: number; cursor: number; error?: string; collections: string[]; collectionCounts?: Record<string, number>; lastBatch?: { from: number; cursor: number; total: number; done: boolean; summary: unknown }; counts?: Record<string, number>; errors?: string[]; updatedAt: number }
interface Row { seq: number; name: string; size: number; entry: string }
const active = new Set<string>();
const zipOpen = (file: string): Promise<ZipFile> => new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => err || !zip ? reject(err ?? new Error("invalid archive")) : resolve(zip)));

/** Uploads live outside app data. Archive names are metadata, never filesystem paths. */
export class AppImports {
  constructor(private root: string, private dataRoot?: string) { fs.mkdirSync(root, { recursive: true }); }
  private dir(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid import id");
    const dir = path.join(this.root, id);
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("invalid import directory");
    return dir;
  }
  state(id: string): ImportState {
    const state = JSON.parse(fs.readFileSync(path.join(this.dir(id), "state.json"), "utf8")) as ImportState;
    if (state.status === "indexing" && !active.has(this.dir(id))) this.index(id);
    return state;
  }
  private save(state: ImportState): void {
    state.updatedAt = Date.now();
    const dest = path.join(this.dir(state.id), "state.json");
    fs.writeFileSync(dest + ".tmp", JSON.stringify(state));
    fs.renameSync(dest + ".tmp", dest);
  }
  create(name: string, size: number, collections: string[]): ImportState {
    if (!Number.isSafeInteger(size) || size <= 0 || size > IMPORT_MAX_BYTES) throw new Error("archive must be between 1 byte and 32 GB");
    if (collections.length > 32 || collections.some((v) => !/^[a-zA-Z0-9 _/-]{1,80}$/.test(v))) throw new Error("invalid collection order");
    // Abandoned uploads expire; running uploads and indexing are retained.
    for (const id of fs.readdirSync(this.root)) {
      try { const state = JSON.parse(fs.readFileSync(path.join(this.root, id, "state.json"), "utf8")); if (Date.now() - state.updatedAt > 7 * 86400_000 && !active.has(path.join(this.root, id))) { if (this.dataRoot) this.recover(id, this.dataRoot); fs.rmSync(path.join(this.root, id), { recursive: true, force: true }); } } catch { /* unrelated or incomplete directory */ }
    }
    if (fs.readdirSync(this.root).length >= 4) throw new Error("finish or cancel an existing import first");
    const disk = fs.statfsSync(this.root);
    if (Number(disk.bavail) * Number(disk.bsize) < size + 64 * 1024 ** 2) throw new Error("not enough disk space for this archive");
    const id = randomUUID();
    fs.mkdirSync(path.join(this.root, id));
    fs.writeFileSync(path.join(this.root, id, "archive.zip"), "");
    const state: ImportState = { id, name: name.slice(0, 240), size, uploaded: 0, status: "uploading", files: 0, expanded: 0, cursor: 0, collections, updatedAt: Date.now() };
    this.save(state);
    return state;
  }
  append(id: string, offset: number, bytes: Uint8Array): ImportState {
    const state = this.state(id);
    if (state.status !== "uploading") throw new Error("upload is already complete");
    if (!Number.isSafeInteger(offset) || offset !== state.uploaded) throw new Error("upload offset changed, refresh import status");
    if (!bytes.length || bytes.length > IMPORT_CHUNK_BYTES || offset + bytes.length > state.size) throw new Error("invalid upload chunk");
    const file = path.join(this.dir(id), "archive.zip");
    const fd = fs.openSync(file, "r+");
    try { let at = 0; while (at < bytes.length) at += fs.writeSync(fd, bytes, at, bytes.length - at, offset + at); } finally { fs.closeSync(fd); }
    state.uploaded += bytes.length;
    this.save(state);
    if (state.uploaded === state.size) { state.status = "indexing"; this.save(state); this.index(id); }
    return state;
  }
  private index(id: string): void {
    const dir = this.dir(id);
    if (active.has(dir)) return;
    active.add(dir);
    void (async () => {
      const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as ImportState;
      const db = new Database(path.join(dir, "index.sqlite"));
      let zip: ZipFile | undefined;
      try {
        db.exec("CREATE TABLE IF NOT EXISTS written_paths (name TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, name TEXT UNIQUE, size INTEGER, phase INTEGER, entry TEXT); DELETE FROM entries; BEGIN;");
        state.files = 0; state.expanded = 0; state.collectionCounts = {};
        const insert = db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?)");
        zip = await zipOpen(path.join(dir, "archive.zip"));
        await new Promise<void>((resolve, reject) => {
          zip!.on("error", reject); zip!.on("end", resolve);
          zip!.on("entry", (entry: Entry) => {
            try {
              if (entry.fileName.endsWith("/")) { zip!.readEntry(); return; }
              if (entry.isEncrypted()) throw new Error("encrypted archives are not supported");
              state.expanded += entry.uncompressedSize;
              if (++state.files > 1_000_000 || state.expanded > MAX_EXPANDED) throw new Error("archive exceeds 1 million files or 256 GB expanded");
              const segments = entry.fileName.split("/");
              let phase = state.collections.length;
              for (let i = 0; i < state.collections.length; i++) if (segments.some((_, at) => segments.slice(at).join("/").toLowerCase().startsWith(state.collections[i]!.toLowerCase()))) { phase = i; break; }
              if (phase < state.collections.length) { const collection = state.collections[phase]!; state.collectionCounts![collection] = (state.collectionCounts![collection] ?? 0) + 1; }
              insert.run(state.files, entry.fileName, entry.uncompressedSize, phase, JSON.stringify(entry));
              if (state.files % 1000 === 0) this.save(state);
              zip!.readEntry();
            } catch (err) { reject(err); }
          });
          zip!.readEntry();
        });
        db.exec("COMMIT; CREATE INDEX IF NOT EXISTS ordered ON entries(phase, name); DROP TABLE IF EXISTS ordered_entries; CREATE TABLE ordered_entries AS SELECT ROW_NUMBER() OVER (ORDER BY phase,name) AS ordinal, * FROM entries; CREATE UNIQUE INDEX ordinal_index ON ordered_entries(ordinal);");
        state.status = "ready";
      } catch (err) { state.status = "failed"; state.error = err instanceof Error ? err.message : String(err); }
      finally { zip?.close(); db.close(); this.save(state); active.delete(dir); }
    })();
  }
  async batch(id: string, cursor: number): Promise<{ entries: Record<string, unknown>; next: number; total: number }> {
    const state = this.state(id);
    if (state.status !== "ready" || cursor !== state.cursor) throw new Error("import is not ready at this cursor");
    const dir = this.dir(id);
    const db = new Database(path.join(dir, "index.sqlite"), { readonly: true });
    const zip = await zipOpen(path.join(dir, "archive.zip"));
    zip.on("error", () => undefined);
    try {
      const rows = db.query<Row, [number]>("SELECT seq,name,size,entry FROM ordered_entries WHERE ordinal>? ORDER BY ordinal LIMIT 32").all(cursor);
      const entries: Record<string, unknown> = {};
      let size = 0; let used = 0;
      const read = async (row: Row): Promise<unknown> => {
        if (row.size > MAX_ENTRY) return { __binary__: true, size: row.size, error: "entry exceeds 64 MB" };
        const parsed = JSON.parse(row.entry);
        const entry = Object.assign(Object.create(yauzl.Entry.prototype), parsed) as Entry;
        const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (err, value) => err || !value ? reject(err) : resolve(value)));
        const chunks: Buffer[] = []; let bytes = 0; let crc = 0;
        for await (const chunk of stream as AsyncIterable<Buffer>) { bytes += chunk.length; if (bytes > MAX_ENTRY) throw new Error("entry exceeds 64 MB"); crc = crc32(chunk, crc); chunks.push(chunk); }
        if (crc !== entry.crc32) throw new Error("archive entry checksum failed: " + row.name);
        const data = Buffer.concat(chunks);
        return /\.(json|jsonl|txt|md|js|css|html|yml|yaml|csv)$/i.test(row.name) ? data.toString("utf8") : { __b64__: true, base64: data.toString("base64"), size: data.length };
      };
      for (const row of rows) {
        if (used && size + row.size > BATCH_BYTES) break;
        entries[row.name] = await read(row); size += row.size; used++;
        if (/(^|\/)card\.json$/i.test(row.name) && typeof entries[row.name] === "string") {
          const card = JSON.parse(entries[row.name] as string) as { assets?: { uri?: string }[]; data?: { assets?: { uri?: string }[] } };
          let assetBytes = row.size;
          for (const asset of card.data?.assets ?? card.assets ?? []) {
            if (!asset.uri || !/^(?:__asset:|embeded:\/\/)/.test(asset.uri)) continue;
            const name = asset.uri.replace(/^(?:__asset:|embeded:\/\/)/, "");
            const side = db.query<Row, [string]>("SELECT seq,name,size,entry FROM entries WHERE name=?").get(name);
            if (side && !Object.hasOwn(entries, side.name)) {
              assetBytes += side.size;
              if (assetBytes > MAX_ENTRY) throw new Error("card package media exceeds 64 MB");
              entries[side.name] = await read(side);
            }
          }
        }
        // Sidecars belong to the same transaction as their transcript.
        if (/\.jsonl$/i.test(row.name)) for (const suffix of [".meta.json", ".memories.json"]) {
          const side = db.query<Row, [string]>("SELECT seq,name,size,entry FROM entries WHERE name=?").get(row.name.replace(/\.jsonl$/i, suffix));
          if (side) entries[side.name] = await read(side);
        }
      }
      return { entries, next: cursor + used, total: state.files };
    } finally { zip.close(); db.close(); }
  }
  transactionDir(id: string): string { return path.join(this.dir(id), "transaction"); }
  recover(id: string, dataRoot: string): void {
    const dir = this.transactionDir(id), journal = path.join(dir, "journal.json");
    if (!fs.existsSync(journal)) { fs.rmSync(dir, { recursive: true, force: true }); return; }
    const checkpoint = path.join(dir, "cursor");
    if (fs.existsSync(checkpoint) && JSON.parse(fs.readFileSync(path.join(this.dir(id), "state.json"), "utf8")).cursor !== Number(fs.readFileSync(checkpoint, "utf8"))) { this.commit(id); return; }
    const records = JSON.parse(fs.readFileSync(journal, "utf8")) as { rel: string; backup: string | null }[];
    for (const record of records.reverse()) {
      const full = path.resolve(dataRoot, record.rel);
      if (!full.startsWith(path.resolve(dataRoot) + path.sep) || record.rel.split(/[\\/]/).includes("..")) throw new Error("invalid import recovery path");
      const realRoot = fs.realpathSync(dataRoot);
      let ancestor = path.dirname(full);
      while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
      const realParent = fs.realpathSync(ancestor);
      if ((realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) || (fs.existsSync(full) && fs.lstatSync(full).isSymbolicLink())) throw new Error("import recovery path is a symlink");
      if (record.backup) {
        if (!/^[0-9]+$/.test(record.backup)) throw new Error("invalid import recovery file");
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.copyFileSync(path.join(dir, record.backup), full);
      } else fs.rmSync(full, { force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  begin(id: string, dataRoot: string): string {
    this.recover(id, dataRoot);
    const dir = this.transactionDir(id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "journal.json"), "[]");
    fs.writeFileSync(path.join(dir, "cursor"), String(this.state(id).cursor));
    return dir;
  }
  commit(id: string): void { fs.rmSync(this.transactionDir(id), { recursive: true, force: true }); }
  recordWrites(id: string, files: string[]): void {
    const db = new Database(path.join(this.dir(id), "index.sqlite"));
    try {
      const insert = db.prepare("INSERT OR IGNORE INTO written_paths VALUES (?)");
      db.transaction(() => { for (const file of files) insert.run(file); })();
    } finally { db.close(); }
  }
  writtenPaths(id: string): string[] {
    const db = new Database(path.join(this.dir(id), "index.sqlite"), { readonly: true });
    try { return db.query<{ name: string }, []>("SELECT name FROM written_paths").all().map((row) => row.name); }
    finally { db.close(); }
  }
  advance(id: string, from: number, cursor: number, summary: unknown): void {
    const state = this.state(id);
    state.cursor = cursor;
    state.lastBatch = { from, cursor, total: state.files, done: cursor >= state.files, summary };
    state.counts ??= {};
    for (const [key, value] of Object.entries((summary ?? {}) as Record<string, unknown>)) if (Array.isArray(value)) state.counts[key] = (state.counts[key] ?? 0) + value.length;
    const errors = (summary as { errors?: unknown })?.errors;
    if (Array.isArray(errors)) state.errors = [...(state.errors ?? []), ...errors.filter((value): value is string => typeof value === "string")].slice(0, 1000);
    this.save(state);
  }
  remove(id: string): void { const dir = this.dir(id); if (active.has(dir)) throw new Error("wait for archive indexing to finish"); if (this.dataRoot) this.recover(id, this.dataRoot); fs.rmSync(dir, { recursive: true, force: true }); }
}
