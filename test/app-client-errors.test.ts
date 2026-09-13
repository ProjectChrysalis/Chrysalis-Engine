/**
 * App client-error reporting: the app frame's dev runtime catches uncaught
 * throws, unhandled rejections and console.error, the shell pane forwards
 * them, and app_check reads back only the ones that ran on the current
 * sources. Everything here is untrusted display data.
 */
import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppEnv } from "../src/server/app.js";
import type { Hono } from "hono";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";
import { createAppSkeleton } from "../src/apps/manager.js";
import { readClientErrors, readClientLogs, sourceRev, writeClientErrors, writeClientLogs } from "../src/builder/server.js";

let dataDir: string;
let token: string;
let app: Hono<AppEnv>;
let appDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-errors-"));
  const users = new UserService(dataDir);
  users.create("admin", "admin", { password: "admin-pass-1" });
  token = users.create("alice", "user", { password: "test-pass-1" }).token;
  bootstrapUserDir(dataDir, "alice");
  app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
  const p = userPaths(dataDir, "alice");
  appDir = createAppSkeleton(p.apps, { id: "demo", name: "Demo", kind: "web" }).dir;
});
afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
});

const h = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const post = (body: unknown) => app.request("/v1/apps/demo/client-errors", { method: "POST", headers: h(), body: typeof body === "string" ? body : JSON.stringify(body) });

describe("app client errors", () => {
  it("stores forwarded runtime errors under the current source rev", async () => {
    const res = await post({
      events: [
        { kind: "uncaught", text: "  boom  ", stack: "Error: boom\n  at App (src/app.tsx:3:1)", at: 123 },
        { kind: "console", text: "kept" },
        { kind: "x".repeat(99), text: "long kind" },
        { text: "   " },
        { not: "an event" },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, stored: 3 });
    const list = readClientErrors(appDir, sourceRev(appDir));
    expect(list.map((e) => e.kind)).toEqual(["uncaught", "console", "error"]);
    expect(list[0]).toMatchObject({ text: "boom", at: 123 });
    expect(list[2]!.text).toBe("long kind");
  });

  it("caps a request at 20 events and keeps only the current revision", async () => {
    const rev = sourceRev(appDir);
    writeClientErrors(appDir, [{ kind: "console", text: "old", at: 1, rev: "old-rev" }]);
    const events = Array.from({ length: 25 }, (_, i) => ({ kind: "console", text: `e${i}` }));
    expect(await (await post({ events })).json()).toMatchObject({ stored: 20 });
    const list = readClientErrors(appDir, rev);
    expect(list).toHaveLength(20);
    expect(list[0]!.text).toBe("e0");
    expect(list.some((e) => e.text === "e24")).toBe(false);
    // a previous build's errors are history, not the current source's
    expect(readClientErrors(appDir, "old-rev").map((e) => e.text)).toEqual(["old"]);
  });

  it("ring-trims the log so a console loop cannot grow it without bound", () => {
    const rev = sourceRev(appDir);
    writeClientErrors(appDir, Array.from({ length: 210 }, (_, i) => ({ kind: "console", text: `t${i}`, at: i, rev })));
    const lines = fs.readFileSync(path.join(appDir, "dist", ".chrysalis-client-errors.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(200);
    expect(readClientErrors(appDir, rev, 1)[0]!.text).toBe("t209");
  });

  it("keeps the captured logs out of the public app frame", async () => {
    const rev = sourceRev(appDir);
    writeClientLogs(appDir, [{ kind: "log", text: "not for the network", at: Date.now(), rev }]);
    fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "dist", "index.html"), "<!doctype html>");
    // the frame route serves dist files publicly, but dot-files are internal
    const res = await app.request("/app/alice/demo/.chrysalis-client-logs.jsonl");
    expect(res.status).toBe(404);
  });

  it("normalizes bogus kinds and timestamps from an untrusted sender", async () => {
    const res = await post({
      events: [
        { kind: "Bad Kind!", text: "noisy", at: 1e300 },
        { kind: "warn", text: "ok", at: 1234 },
        { kind: "x".repeat(40), text: "long" },
      ],
    });
    expect(await res.json()).toMatchObject({ stored: 3 });
    const list = readClientErrors(appDir, sourceRev(appDir));
    expect(list[0]!.kind).toBe("error");
    expect(list[0]!.at).toBeGreaterThan(Date.now() - 5000);
    expect(list[1]).toMatchObject({ kind: "warn", at: 1234 });
    expect(list[2]!.kind).toBe("error");
  });

  it("refuses bad payloads, unknown apps and anonymous callers", async () => {
    expect((await post("{")).status).toBe(400);
    expect((await app.request("/v1/apps/nope/client-errors", { method: "POST", headers: h(), body: JSON.stringify({ events: [] }) })).status).toBe(404);
    expect((await app.request("/v1/apps/demo/client-errors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [] }) })).status).toBe(401);
  });

  it("stores page prints separately from errors, keeping the newest of a burst", async () => {
    const events = Array.from({ length: 50 }, (_, i) => ({ kind: "log", text: `p${i}` }));
    const res = await app.request("/v1/apps/demo/client-logs", { method: "POST", headers: h(), body: JSON.stringify({ events }) });
    expect(await res.json()).toMatchObject({ ok: true, stored: 40 });
    const rev = sourceRev(appDir);
    const list = readClientLogs(appDir, rev);
    expect(list).toHaveLength(40);
    expect(list[0]!.text).toBe("p10");
    expect(list.at(-1)!.text).toBe("p49");
    // the error store is untouched by prints
    expect(readClientErrors(appDir, rev)).toEqual([]);
  });

  it("ring-trims the print log and refuses anonymous callers", async () => {
    const rev = sourceRev(appDir);
    writeClientLogs(appDir, Array.from({ length: 310 }, (_, i) => ({ kind: "log", text: `t${i}`, at: i, rev })));
    const lines = fs.readFileSync(path.join(appDir, "dist", ".chrysalis-client-logs.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(300);
    expect((await app.request("/v1/apps/demo/client-logs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [] }) })).status).toBe(401);
  });
});
