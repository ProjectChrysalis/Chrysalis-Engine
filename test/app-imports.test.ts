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
  fs.writeFileSync(path.join(journal, "journal.json"), JSON.stringify([{ rel: "existing.json", backup: "0" }, { rel: "new.json", backup: null }]));
  fs.writeFileSync(path.join(root, "existing.json"), "changed"); fs.writeFileSync(path.join(root, "new.json"), "new");
  service.recover(state.id, root);
  expect(fs.readFileSync(path.join(root, "existing.json"), "utf8")).toBe("old"); expect(fs.existsSync(path.join(root, "new.json"))).toBe(false);
  journal = service.begin(state.id, root);
  fs.writeFileSync(path.join(journal, "journal.json"), JSON.stringify([{ rel: "new.json", backup: null }]));
  fs.writeFileSync(path.join(root, "new.json"), "committed");
  service.advance(state.id, 0, 1, {});
  service.recover(state.id, root);
  expect(fs.readFileSync(path.join(root, "new.json"), "utf8")).toBe("committed");
});
