import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginSandbox, type SandboxRequest } from "../src/plugins/sandbox.js";

const box = new PluginSandbox(1);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-warm-"));
afterAll(async () => {
  await box.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

const COUNTER = `let n = 0;
let kept = null;
export function handleRoute(req, host) {
  if (req.path === "/keep") { kept = host; return { json: "kept" }; }
  if (req.path === "/stale") { try { kept.fs.read("x.txt"); return { json: "read" }; } catch (e) { return { json: String(e.message) }; } }
  if (req.path === "/spin") { for (;;) {} }
  if (req.path === "/now") return { json: Date.now() > 0 };
  n++;
  return { json: n };
}`;

const call = async (route: string, extra: Partial<SandboxRequest> = {}) => {
  const r = await box.eval({ source: COUNTER, hook: "__route", ctx: { method: "GET", path: route, query: {}, body: null }, storeSnapshot: {}, fsAllowed: true, fsRoot: root, ...extra });
  return r.ok ? r.out : `error: ${r.error}`;
};
const count = async (extra: Partial<SandboxRequest> = {}) => ((await call("/n", extra)) as { json: number }).json;

describe("plugins kept loaded between calls", () => {
  it("keeps module state per key and starts fresh without one", async () => {
    expect([await count({ warmKey: "a" }), await count({ warmKey: "a" }), await count({ warmKey: "a" })]).toEqual([1, 2, 3]);
    expect(await count({ warmKey: "b" })).toBe(1);
    expect([await count(), await count()]).toEqual([1, 1]);
  });

  it("refuses a host kept from a call that has ended", async () => {
    fs.writeFileSync(path.join(root, "x.txt"), "x");
    await call("/keep", { warmKey: "stale" });
    expect(await call("/stale", { warmKey: "stale" })).toEqual({ json: "host belongs to a call that has ended" });
  });

  it("drops a context that ran out of time and loads a fresh one", async () => {
    await count({ warmKey: "slow" });
    expect(await call("/spin", { warmKey: "slow", executionTimeoutMs: 200 })).toMatch(/maximum allowed time/);
    expect(await count({ warmKey: "slow" })).toBe(1);
  });

  it("loads again when the code changes, and recovers from code that does not parse", async () => {
    expect(await count({ warmKey: "edit" })).toBe(1);
    expect(await count({ warmKey: "edit", source: COUNTER.replace("n++", "n += 10") })).toBe(10);
    expect(await call("/", { warmKey: "edit", source: "export function handleRoute( {" })).toMatch(/^error: /);
    expect(await count({ warmKey: "edit" })).toBe(1);
  });

  it("still tells a repeatable read from one that used the clock", async () => {
    const plain = await box.eval({ source: COUNTER, hook: "__route", ctx: { method: "GET", path: "/n", query: {}, body: null }, storeSnapshot: {}, fsAllowed: true, fsRoot: root, warmKey: "memo", trackReads: true });
    const clock = await box.eval({ source: COUNTER, hook: "__route", ctx: { method: "GET", path: "/now", query: {}, body: null }, storeSnapshot: {}, fsAllowed: true, fsRoot: root, warmKey: "memo", trackReads: true });
    expect(plain.reads).toBeDefined();
    expect(clock.ok).toBe(true);
    expect(clock.reads).toBeUndefined();
  });

  it("keeps a bounded number of contexts", async () => {
    for (let i = 0; i < 6; i++) await count({ warmKey: `lru-${i}` });
    expect(await count({ warmKey: "lru-5" })).toBe(2);
    expect(await count({ warmKey: "lru-0" })).toBe(1);
  });
});
