import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverPlugins, invalidatePluginCache, runPluginRoute, type LoadedPlugin } from "../src/plugins/runtime.js";
import { PluginStoreService } from "../src/plugins/store.js";

let dir: string;
let data: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-pool-"));
  data = path.join(dir, "data");
  fs.mkdirSync(data, { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  invalidatePluginCache();
});

const deps = () => ({ store: new PluginStoreService(path.join(dir, "store")), models: {} as never, grantsFor: () => [] });

function plugin(id: string, code: string, permissions = ["routes", "fs"]): LoadedPlugin {
  const p = path.join(dir, "plugins", id);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "manifest.json"), JSON.stringify({ name: id, version: "1.0.0", permissions }));
  fs.writeFileSync(path.join(p, "plugin.js"), code);
  const found = discoverPlugins(path.join(dir, "plugins")).find((x) => x.id === id)!;
  found.fsRoot = data;
  return found;
}

const get = (pl: LoadedPlugin, p = "/") => runPluginRoute(pl, { method: "GET", path: p, query: {}, body: null }, deps());
const post = (pl: LoadedPlugin, p = "/") => runPluginRoute(pl, { method: "POST", path: p, query: {}, body: null }, deps());
const timed = async <T>(run: () => Promise<T>): Promise<{ out: T; ms: number }> => {
  const t = performance.now();
  const out = await run();
  return { out, ms: performance.now() - t };
};

/** Spins inside the guest without reading the clock, so the result stays
 *  repeatable. */
const SPIN = (n: number) => `let x = 0; for (let i = 0; i < ${n}; i++) x = (x + i) % 7;`;

describe("plugin sandbox pool", () => {
  it("a slow route does not hold up another plugin's route", async () => {
    // warm two workers, so neither call below pays a cold start
    const quick = plugin("quick", "export function handleRoute() { return { json: { ok: true } }; }", ["routes"]);
    const slow = plugin("slow", `export function handleRoute() { ${SPIN(30_000_000)} return { json: { done: true } }; }`, ["routes"]);
    await Promise.all([get(quick), get(quick)]);
    const slowRun = timed(() => post(slow));
    await Bun.sleep(50);
    const quickRun = await timed(() => post(quick));
    const slowDone = await slowRun;
    expect(slowDone.out?.json).toEqual({ done: true });
    expect(quickRun.out?.json).toEqual({ ok: true });
    expect(quickRun.ms).toBeLessThan(slowDone.ms / 2);
  }, 30_000);

  it("a route that runs out of memory fails alone", async () => {
    const hog = plugin("hog", `export function handleRoute() { const a = []; for (;;) a.push("x".repeat(1 << 20) + a.length); }`, ["routes"]);
    const fine = plugin("fine", `export function handleRoute() { ${SPIN(2_000_000)} return { json: { fine: true } }; }`, ["routes"]);
    const [bad, good] = await Promise.all([post(hog), post(fine)]);
    expect(bad?.status).toBe(500);
    expect(JSON.stringify(bad?.json)).toMatch(/out of memory/);
    expect(good?.json).toEqual({ fine: true });
  }, 60_000);

  it("writes to one app folder never interleave, even across workers", async () => {
    fs.writeFileSync(path.join(data, "count.json"), "0");
    const counter = plugin("counter", `export function handleRoute(req, host) {
      const n = JSON.parse(host.fs.read("count.json"));
      ${SPIN(1_000_000)}
      host.fs.write("count.json", JSON.stringify(n + 1));
      return { json: { n: n + 1 } };
    }`);
    const outs = await Promise.all(Array.from({ length: 8 }, () => post(counter)));
    expect(outs.map((o) => (o?.json as { n: number } | undefined)?.n ?? 0).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(fs.readFileSync(path.join(data, "count.json"), "utf8")).toBe("8");
  }, 30_000);
});

describe("repeated reads", () => {
  const reader = () => plugin("reader", `export function handleRoute(req, host) {
    ${SPIN(20_000_000)}
    const names = host.fs.list("items");
    return { json: { names, items: names.map((n) => JSON.parse(host.fs.read("items/" + n))) } };
  }`);

  it("answers an unchanged read from memory and notices every kind of change", async () => {
    fs.mkdirSync(path.join(data, "items"));
    fs.writeFileSync(path.join(data, "items", "a.json"), '{"v":1}');
    const pl = reader();
    const first = await timed(() => get(pl));
    expect(first.out?.json).toEqual({ names: ["a.json"], items: [{ v: 1 }] });
    const again = await timed(() => get(pl));
    expect(again.out?.json).toEqual(first.out?.json);
    expect(again.ms).toBeLessThan(first.ms / 4);

    // an edited file
    fs.writeFileSync(path.join(data, "items", "a.json"), '{"v":2}');
    expect((await get(pl))?.json).toEqual({ names: ["a.json"], items: [{ v: 2 }] });
    // a file added to a folder it listed
    fs.writeFileSync(path.join(data, "items", "b.json"), '{"v":3}');
    expect((await get(pl))?.json).toEqual({ names: ["a.json", "b.json"], items: [{ v: 2 }, { v: 3 }] });
    // a file removed
    fs.rmSync(path.join(data, "items", "a.json"));
    expect((await get(pl))?.json).toEqual({ names: ["b.json"], items: [{ v: 3 }] });
    // a write through another route of the same app
    const writer = plugin("writer", 'export function handleRoute(req, host) { host.fs.write("items/b.json", "{\\"v\\":4}"); return { json: { ok: true } }; }');
    await post(writer);
    expect((await get(pl))?.json).toEqual({ names: ["b.json"], items: [{ v: 4 }] });
  }, 60_000);

  it("never remembers a result that read the clock or a random number", async () => {
    const clock = plugin("clock", "export function handleRoute() { return { json: { at: Date.now(), d: new Date().getTime(), r: Math.random() } }; }", ["routes"]);
    const a = (await get(clock))?.json as { r: number };
    await Bun.sleep(5);
    const b = (await get(clock))?.json as { r: number };
    expect(a.r).not.toBe(b.r);
    // dates built from a value stay repeatable
    const fixed = plugin("fixed", `export function handleRoute() { ${SPIN(20_000_000)} return { json: { y: new Date(0).getUTCFullYear(), ok: Date.UTC(2020, 0) > 0 } }; }`, ["routes"]);
    const first = await timed(() => get(fixed));
    const again = await timed(() => get(fixed));
    expect(again.out?.json).toEqual({ y: 1970, ok: true });
    expect(again.ms).toBeLessThan(first.ms / 4);
  }, 30_000);

  it("a read that writes runs every time", async () => {
    fs.writeFileSync(path.join(data, "hits.json"), "0");
    const pl = plugin("hits", `export function handleRoute(req, host) {
      const n = JSON.parse(host.fs.read("hits.json")) + 1;
      host.fs.write("hits.json", JSON.stringify(n));
      return { json: { n } };
    }`);
    await get(pl);
    await get(pl);
    expect((await get(pl))?.json).toEqual({ n: 3 });
  }, 30_000);
});

describe("plugin store", () => {
  it("persists deletes and leaves the file alone when a call changed nothing", async () => {
    const pl = plugin("kv", `export function handleRoute(req, host) {
      if (req.path === "/set") { host.store.put("a", 1); host.store.put("b", 2); }
      if (req.path === "/drop") host.store.delete("a");
      return { json: { keys: host.store.keys() } };
    }`, ["routes", "store"]);
    await post(pl, "/set");
    const file = path.join(dir, "store", "kv.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1, b: 2 });
    const before = fs.statSync(file).mtimeMs;
    await Bun.sleep(20);
    expect((await post(pl, "/look"))?.json).toEqual({ keys: ["a", "b"] });
    expect(fs.statSync(file).mtimeMs).toBe(before);
    await post(pl, "/drop");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ b: 2 });
  }, 30_000);
});

describe("host regex", () => {
  it("finds matches with the host engine, as the guest's own would", async () => {
    const pl = plugin("rx", `export function handleRoute(req, host) {
      const all = host.regex.matches("(?<w>[a-z])(\\\\d)?", "g", "a1 b c3");
      const one = host.regex.matches("[a-z]", "", "xyz");
      const none = host.regex.matches("q", "g", "abc");
      let bad = false;
      try { host.regex.matches("(", "g", "x"); } catch { bad = true; }
      return { json: { all, one, none, bad } };
    }`, ["routes"]);
    expect((await post(pl))?.json).toEqual({
      all: [
        { index: 0, match: "a1", groups: ["a", "1"], named: { w: "a" } },
        { index: 3, match: "b", groups: ["b", null], named: { w: "b" } },
        { index: 5, match: "c3", groups: ["c", "3"], named: { w: "c" } },
      ],
      one: [{ index: 0, match: "x", groups: [], named: null }],
      none: [],
      bad: true,
    });
  }, 30_000);

  it("runs a pattern that rescans long text far faster than the guest can", async () => {
    // lazy-dot alternatives with the s flag rescan to the end from every position
    const pattern = "(<a>.*?</a>)|(.*?</think(ing)?>)";
    const text = "word ".repeat(1600);
    const pl = plugin("rxspeed", `export function handleRoute(req, host) {
      const re = new RegExp(${JSON.stringify(pattern)}, "gs");
      const text = ${JSON.stringify(text)};
      if (req.path === "/guest") return { json: { n: (text.match(re) || []).length } };
      return { json: { n: host.regex.matches(${JSON.stringify(pattern)}, "gs", text).length } };
    }`, ["routes"]);
    const guest = await timed(() => post(pl, "/guest"));
    const native = await timed(() => post(pl, "/host"));
    expect(native.out?.json).toEqual(guest.out?.json as Record<string, unknown>);
    expect(native.ms).toBeLessThan(guest.ms / 3);
  }, 60_000);
});
