import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lines, query, splice } from "../src/plugins/data-index.mjs";
import { PluginSandbox } from "../src/plugins/sandbox.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "data-index-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const put = (rel: string, value: unknown) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value));
};
const later = () => Bun.sleep(5);

describe("field index", () => {
  const spec = { files: "characters/*/card.json", fields: { name: "name", fav: "extensions.fav", tags: "tags", book: "character_book?" } };

  it("answers from the files, and follows every edit, addition and removal", async () => {
    put("characters/aria/card.json", { name: "Aria", tags: ["fantasy"], extensions: { fav: true }, character_book: { entries: "x".repeat(100_000) } });
    put("characters/kael/card.json", { name: "Kael", tags: ["sci-fi"] });
    put("characters/__staged/card.json", { name: "Hidden" });
    put("characters/broken/card.json", "{ not json");
    const first = query(root, spec, { sort: "name" });
    expect(first.total).toBe(3);
    expect(first.rows.map((r) => [r.keys[0], r.data.name, r.data.fav])).toEqual([["aria", "Aria", true], ["kael", "Kael", null], ["broken", null, null]]);
    expect(first.rows[2]!.error).toBeTruthy();
    expect(first.rows.map((r) => r.data.book)).toEqual([true, false, null]);

    await later();
    put("characters/kael/card.json", { name: "Kael Renamed", tags: ["sci-fi"], extensions: { fav: true } });
    put("characters/zed/card.json", { name: "Zed" });
    fs.rmSync(path.join(root, "characters/aria"), { recursive: true });
    const second = query(root, spec, { where: { fav: true } });
    expect(second.rows.map((r) => r.data.name)).toEqual(["Kael Renamed"]);
    expect(query(root, spec, {}).total).toBe(3);
  });

  it("filters, sorts and pages", () => {
    for (let i = 0; i < 30; i++) put(`presets/p${String(i).padStart(2, "0")}.json`, { name: `Preset ${i}`, size: i % 7, tags: i % 2 ? ["odd"] : ["even"] });
    const s = { files: "presets/*.json", fields: { name: "name", size: "size", tags: "tags" } };
    const page = query(root, s, { where: { tags: "odd", size: { gte: 3 } }, sort: [["size", "desc"], ["name", "asc"]], offset: 2, limit: 3 });
    const all = query(root, s, { where: { tags: "odd", size: { gte: 3 } }, sort: [["size", "desc"], ["name", "asc"]] });
    expect(page.total).toBe(all.total);
    expect(page.rows).toEqual(all.rows.slice(2, 5));
    expect(all.rows.every((r) => (r.data.size as number) >= 3 && (r.data.tags as string[]).includes("odd"))).toBe(true);
    expect(query(root, s, { where: { name: { contains: "preset 1" } } }).total).toBe(11);
  });

  it("refuses patterns that leave the folder or reach the engine's own", () => {
    for (const files of ["../x/*.json", "__index/*", "a/../b.json", "/etc/*"]) expect(() => query(root, { files, fields: { a: "a" } })).toThrow();
  });

  it("starts over from a damaged index", () => {
    put("presets/a.json", { name: "A" });
    fs.mkdirSync(path.join(root, "__index"), { recursive: true });
    fs.writeFileSync(path.join(root, "__index", "index.sqlite"), "this is not a database");
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "data-index-damaged-"));
    try {
      fs.cpSync(root, fresh, { recursive: true });
      expect(query(fresh, { files: "presets/*.json", fields: { name: "name" } }).rows[0]!.data.name).toBe("A");
    } finally { fs.rmSync(fresh, { recursive: true, force: true }); }
  });
});

describe("JSONL records", () => {
  it("reads records by position and rewrites only the tail", async () => {
    const file = path.join(root, "chats/c.jsonl");
    put("chats/c.jsonl", Array.from({ length: 10 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n\n");
    expect(lines(file, -3).lines.map((l) => JSON.parse(l).i)).toEqual([7, 8, 9]);
    expect(lines(file, 2, 4)).toEqual({ lines: ['{"i":2}', '{"i":3}'], from: 2, total: 10 });
    const head = fs.readFileSync(file).subarray(0, 40);
    expect(splice(file, 8, ['{"i":8,"edited":true}', '{"i":10}'])).toEqual({ total: 10 });
    expect(fs.readFileSync(file).subarray(0, 40)).toEqual(head);
    expect(lines(file, -2).lines).toEqual(['{"i":8,"edited":true}', '{"i":10}']);
    expect(splice(file, 10, ['{"i":11}'])).toEqual({ total: 11 });
    expect(splice(file, 9, [])).toEqual({ total: 9 });
    expect(fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // someone else rewrote the file: positions come from it again
    await later();
    fs.writeFileSync(file, '{"i":"a"}\n{"i":"b"}');
    expect(lines(file, -1).lines).toEqual(['{"i":"b"}']);
    expect(splice(file, 2, ['{"i":"c"}'])).toEqual({ total: 3 });
    expect(fs.readFileSync(file, "utf8")).toBe('{"i":"a"}\n{"i":"b"}\n{"i":"c"}\n');
  });

  it("treats a missing file as empty and creates it on the first write", () => {
    const file = path.join(root, "chats/new.jsonl");
    expect(lines(file)).toEqual({ lines: [], from: 0, total: 0 });
    expect(splice(file, 0, ['{"first":true}'])).toEqual({ total: 1 });
    expect(() => splice(file, 3, [])).toThrow();
    expect(() => splice(file, 0, ["two\nlines"])).toThrow();
  });
});

describe("through the plugin sandbox", () => {
  const box = new PluginSandbox(1);
  afterAll(() => box.dispose());
  it("offers query, lines and spliceLines on host.fs, and keeps plugins out of the index", async () => {
    put("characters/aria/card.json", { name: "Aria" });
    put("chats/c.jsonl", '{"n":1}\n{"n":2}\n');
    const r = await box.eval({
      source: `export function handleRoute(req, host) {
        const q = host.fs.query({ files: "characters/*/card.json", fields: { name: "name" } }, {});
        const tail = host.fs.lines("chats/c.jsonl", -1);
        const after = host.fs.spliceLines("chats/c.jsonl", 2, ['{"n":3}']);
        let refused = null;
        try { host.fs.write("__index/index.sqlite", "x"); } catch (e) { refused = String(e.message); }
        return { json: { names: q.rows.map((r) => r.data.name), tail: tail.lines, after, refused } };
      }`,
      hook: "__route", ctx: { method: "POST", path: "/x", query: {}, body: null }, storeSnapshot: {}, fsAllowed: true, fsRoot: root,
    });
    expect(r.error).toBeUndefined();
    expect(r.out).toEqual({ json: { names: ["Aria"], tail: ['{"n":2}'], after: { total: 3 }, refused: "__index/ belongs to the engine" } });
    expect(r.fsWrites).toEqual(["chats/c.jsonl"]);
    expect(fs.readFileSync(path.join(root, "chats/c.jsonl"), "utf8")).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
  });
});
