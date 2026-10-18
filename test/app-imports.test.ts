import { afterEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { AppImports, IMPORT_CHUNK_BYTES, IMPORT_MAX_BYTES } from "../src/apps/imports.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const imports = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-import-")); roots.push(root); return new AppImports(root); };
async function ready(service: AppImports, id: string) {
  for (let i = 0; i < 100; i++) { const state = service.state(id); if (state.status !== "indexing") return state; await Bun.sleep(10); }
  throw new Error("index timeout");
}
it("uploads disk-backed chunks, orders collections, includes sidecars, resumes and advances", async () => {
  const service = imports();
  const zip = zipSync({ "wrapper/chats/A/log.jsonl": strToU8('{"mes":"hi"}\n'), "wrapper/chats/A/log.meta.json": strToU8('{"title":"Original title"}'), "wrapper/characters/A.json": strToU8('{"name":"A"}'), "wrapper/worlds/book.json": strToU8('{"entries":[]}') });
  const created = service.create("backup.zip", zip.length, ["characters/", "worlds/", "chats/"]);
  service.append(created.id, 0, zip.subarray(0, 100));
  expect(() => service.append(created.id, 0, zip.subarray(100))).toThrow("offset");
  expect(service.state(created.id).uploaded).toBe(100);
  service.append(created.id, 100, zip.subarray(100));
  expect((await ready(service, created.id)).status).toBe("ready");
  const batch = await service.batch(created.id, 0);
  expect(Object.keys(batch.entries)[0]).toBe("wrapper/characters/A.json");
  expect(batch.entries["wrapper/chats/A/log.meta.json"]).toBe('{"title":"Original title"}');
  expect(batch.next).toBe(4);
  service.advance(created.id, 0, batch.next, { characters: ["a"] });
  expect(service.state(created.id).counts).toEqual({ characters: 1 });
  expect(service.state(created.id).lastBatch?.from).toBe(0);
  expect(() => service.batch(created.id, 0)).toThrow();
  service.remove(created.id);
  expect(() => service.state(created.id)).toThrow();
});
it("bounds each batch even when the archive spans many batches", async () => {
  const service = imports();
  const zip = zipSync(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`characters/${i.toString().padStart(3,"0")}.json`, strToU8(JSON.stringify({ name: String(i), description: "x".repeat(300_000) }))])));
  const created = service.create("library.zip", zip.length, ["characters/"]);
  service.append(created.id, 0, zip);
  await ready(service, created.id);
  let cursor = 0, batches = 0;
  while (cursor < 80) { const batch = await service.batch(created.id, cursor); expect(Object.keys(batch.entries).length).toBeLessThanOrEqual(32); expect(JSON.stringify(batch.entries).length).toBeLessThan(9 * 1024 ** 2); service.advance(created.id, cursor, batch.next, {}); cursor = batch.next; batches++; }
  expect(batches).toBeGreaterThan(2);
});
it("orders dotted collection filenames alongside folders", async () => {
  const service = imports();
  const zip = zipSync({
    "wrapper/library.json": strToU8("{}"),
    "wrapper/settings.json": strToU8("{}"),
    "wrapper/personas.json": strToU8("{}"),
    "wrapper/characters/A.json": strToU8('{"name":"A"}'),
  });
  const collections = ["characters/", "settings.json", "personas.json", "library.json"];
  const state = service.create("backup.zip", zip.length, collections);
  service.append(state.id, 0, zip);
  expect((await ready(service, state.id)).collectionCounts).toEqual(Object.fromEntries(collections.map((name) => [name, 1])));
  expect(Object.keys((await service.batch(state.id, 0)).entries)).toEqual([
    "wrapper/characters/A.json", "wrapper/settings.json", "wrapper/personas.json", "wrapper/library.json",
  ]);
  expect(() => service.create("backup.zip", 1, ["bad\u0000.json"])).toThrow("invalid collection order");
});
it("accepts multi-GB declarations without allocating them and enforces disk and chunk limits", () => {
  const service = imports();
  const state = service.create("large.zip", 3 * 1024 ** 3, []);
  expect(state.size).toBe(3 * 1024 ** 3);
  expect(() => service.append(state.id, 0, new Uint8Array(IMPORT_CHUNK_BYTES + 1))).toThrow("chunk");
  expect(() => service.create("too-large.zip", IMPORT_MAX_BYTES + 1, [])).toThrow("32 GB");
  expect(() => service.state("../outside")).toThrow("id");
});
it("restores interrupted batch writes and preserves writes after the cursor commits", async () => {
  const service = imports();
  const zip = zipSync({ "one.json": strToU8("{}") });
  const state = service.create("restore.zip", zip.length, []);
  service.append(state.id, 0, zip); await ready(service, state.id);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-data-")); roots.push(root);
  fs.writeFileSync(path.join(root, "existing.json"), "old");
  let journal = service.begin(state.id, root);
  fs.writeFileSync(path.join(journal, "0"), "old");
  // the last line was cut short by a crash: that write never started
  fs.writeFileSync(path.join(journal, "journal.jsonl"), [{ rel: "existing.json", backup: "0" }, { rel: "new.json", backup: null }].map((r) => JSON.stringify(r) + "\n").join("") + '{"rel":"ne');
  fs.writeFileSync(path.join(root, "existing.json"), "changed"); fs.writeFileSync(path.join(root, "new.json"), "new");
  service.recover(state.id, root);
  expect(fs.readFileSync(path.join(root, "existing.json"), "utf8")).toBe("old"); expect(fs.existsSync(path.join(root, "new.json"))).toBe(false);
  journal = service.begin(state.id, root);
  fs.writeFileSync(path.join(journal, "journal.jsonl"), JSON.stringify({ rel: "new.json", backup: null }) + "\n");
  fs.writeFileSync(path.join(root, "new.json"), "committed");
  service.advance(state.id, 0, 1, {});
  service.recover(state.id, root);
  expect(fs.readFileSync(path.join(root, "new.json"), "utf8")).toBe("committed");
  // a batch an older engine left half done still rolls back
  journal = service.begin(state.id, root);
  fs.rmSync(path.join(journal, "journal.jsonl"));
  fs.writeFileSync(path.join(journal, "journal.json"), JSON.stringify([{ rel: "older.json", backup: null }]));
  fs.writeFileSync(path.join(root, "older.json"), "half");
  service.recover(state.id, root);
  expect(fs.existsSync(path.join(root, "older.json"))).toBe(false);
});
it("hands a transcript too big for the sandbox over in slices, in a batch of its own", async () => {
  const service = imports();
  const line = JSON.stringify({ name: "Aria", mes: "a long reply ".repeat(60) }) + "\n";
  const lines = Math.ceil((65 * 1024 ** 2) / line.length);
  const zip = zipSync({ "chats/A/a.jsonl": strToU8(line), "chats/A/b.jsonl": strToU8(line.repeat(lines)), "chats/A/c.jsonl": strToU8(line) });
  const created = service.create("big.zip", zip.length, ["chats/"]);
  for (let at = 0; at < zip.length; at += IMPORT_CHUNK_BYTES) service.append(created.id, at, zip.subarray(at, at + IMPORT_CHUNK_BYTES));
  await ready(service, created.id);
  const first = await service.batch(created.id, 0);
  expect(Object.keys(first.entries)).toEqual(["chats/A/a.jsonl"]);
  service.advance(created.id, 0, first.next, {});
  const second = await service.batch(created.id, first.next);
  expect(Object.keys(second.entries)).toEqual(["chats/A/b.jsonl"]);
  const large = second.entries["chats/A/b.jsonl"] as { __large__: boolean; size: number; file: string };
  expect(large.__large__).toBe(true);
  expect(fs.statSync(large.file).size).toBe(line.length * lines);
  const { PluginSandbox } = await import("../src/plugins/sandbox.js");
  const box = new PluginSandbox(1);
  try {
    const r = await box.eval({
      source: `export function handleRoute(req, host) {
        const entry = host.zip.entries()["chats/A/b.jsonl"];
        let next = 0, n = 0, slices = 0, bad = 0;
        while (next !== null) {
          const slice = host.zip.read("chats/A/b.jsonl", next);
          for (const l of slice.text.split("\\n")) { if (!l) continue; try { JSON.parse(l); n++; } catch { bad++; } }
          next = slice.next; slices++;
        }
        return { json: { n, bad, slices, keys: Object.keys(entry) } };
      }`,
      hook: "__route", ctx: { method: "POST", path: "/x", query: {}, body: null }, storeSnapshot: {}, zipAllowed: true, zipEntries: second.entries,
      executionTimeoutMs: 120_000, memoryLimitBytes: 512 * 1024 ** 2,
    });
    expect(r.error).toBeUndefined();
    expect(r.out).toEqual({ json: { n: lines, bad: 0, slices: expect.any(Number), keys: ["__large__", "size"] } });
    expect((r.out as { json: { slices: number } }).json.slices).toBeGreaterThan(10);
  } finally { await box.dispose(); }
  service.advance(created.id, first.next, second.next, {});
  const third = await service.batch(created.id, second.next);
  expect(Object.keys(third.entries)).toEqual(["chats/A/c.jsonl"]);
  expect(fs.existsSync(large.file)).toBe(false);
}, 120_000);
it("stores animated and photo images from an archive on the host, whatever their type", async () => {
  const { PluginSandbox } = await import("../src/plugins/sandbox.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-import-media-"));
  roots.push(root);
  const data = path.join(root, "roleplay", "data");
  fs.mkdirSync(data, { recursive: true });
  const gif = Buffer.concat([Buffer.from("GIF89a"), crypto.getRandomValues(new Uint8Array(4096))]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.getRandomValues(new Uint8Array(4096))]);
  const box = new PluginSandbox(1);
  try {
    const r = await box.eval({
      source: `export function handleRoute(req, host) {
        const e = host.zip.entries();
        return { json: { kinds: Object.fromEntries(Object.entries(e).map(([k, v]) => [k, Object.keys(v)])), gif: host.zip.image("sprites/joy.gif").url, jpg: host.zip.image("avatars/me.jpg").url } };
      }`,
      hook: "__route", ctx: { method: "POST", path: "/x", query: {}, body: null }, storeSnapshot: {}, zipAllowed: true, fsAllowed: true, fsRoot: data,
      zipEntries: { "sprites/joy.gif": { __b64__: true, base64: gif.toString("base64"), size: gif.length }, "avatars/me.jpg": { __b64__: true, base64: jpg.toString("base64"), size: jpg.length } },
    });
    expect(r.error).toBeUndefined();
    const out = (r.out as { json: { kinds: Record<string, string[]>; gif: string; jpg: string } }).json;
    expect(out.kinds).toEqual({ "sprites/joy.gif": ["__image__", "size"], "avatars/me.jpg": ["__image__", "size"] });
    expect(out.gif).toMatch(/\/__media\/[a-f0-9]{64}\.gif$/);
    expect(out.jpg).toMatch(/\/__media\/[a-f0-9]{64}\.jpeg$/);
    expect(fs.readFileSync(path.join(data, "__media", out.gif.split("/").pop()!))).toEqual(gif);
  } finally { await box.dispose(); }
});
