import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { createAppSkeleton, validateAppManifest } from "../src/apps/manager.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";
import { invalidatePluginCache } from "../src/plugins/runtime.js";
import { type AppEnv, buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";

let dataDir: string;
let token: string;
let app: Hono<AppEnv>;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "share-"));
  const users = new UserService(dataDir);
  token = users.create("alice", "user", { password: "test-pass-1" }).token;
  bootstrapUserDir(dataDir, "alice");
  app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
});
afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
  invalidatePluginCache();
});

const h = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "content-type": "application/json", ...extra });

function makeApp(id: string, receives?: unknown, code?: string) {
  const p = userPaths(dataDir, "alice");
  createAppSkeleton(p.apps, { id, name: id.toUpperCase() });
  const file = path.join(p.apps, id, "manifest.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...(receives ? { receives } : {}) }));
  if (!code) return;
  const dir = path.join(p.apps, id, "plugins", "engine");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "E", version: "1", permissions: ["routes", "fs"], origin: "local" }));
  fs.writeFileSync(path.join(dir, "plugin.js"), code);
}

it("validates what an app says it receives", () => {
  const base = { name: "x", version: "1", kind: "web" };
  expect(validateAppManifest({ ...base, receives: { route: "/inbox", kinds: ["character", "character"] } })?.receives).toEqual({ route: "/inbox", kinds: ["character"] });
  expect(validateAppManifest({ ...base, receives: { route: "/inbox", kinds: ["*"] } })?.receives).toEqual({ route: "/inbox", kinds: ["*"] });
  for (const receives of [{ route: "inbox", kinds: ["a"] }, { route: "/a/../tree", kinds: ["a"] }, { route: "/inbox", kinds: [] }, { route: "/inbox", kinds: ["a b"] }]) {
    expect(validateAppManifest({ ...base, receives })?.receives).toBeUndefined();
  }
});

it("delivers an item the user sends to an app that takes its kind", async () => {
  makeApp("sender");
  makeApp("cards", { route: "/inbox", kinds: ["character"] }, `export function handleRoute(req, host) {
  if (req.method !== "POST" || req.path !== "/inbox") return null;
  host.fs.write("got.json", JSON.stringify(req.body));
  return { status: 200, json: { saved: req.body.name } };
}`);
  makeApp("notes", { route: "/inbox", kinds: ["note"] });
  makeApp("anything", { route: "/inbox", kinds: ["*"] });

  const targets = (await (await app.request("/v1/share/targets?kind=character&from=sender", { headers: h() })).json()) as { apps: { id: string }[] };
  expect(targets.apps.map((a) => a.id).sort()).toEqual(["anything", "cards"]);

  const item = { from: "sender", to: "cards", kind: "character", name: "Ember", data: { name: "Ember", tags: ["fire"] } };
  const res = await app.request("/v1/share", { method: "POST", headers: h(), body: JSON.stringify(item) });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, to: { id: "cards", name: "CARDS" }, result: { saved: "Ember" } });
  const got = JSON.parse(fs.readFileSync(path.join(userPaths(dataDir, "alice").apps, "cards", "data", "got.json"), "utf8"));
  expect(got).toEqual({ kind: "character", name: "Ember", from: { id: "sender", name: "SENDER" }, data: item.data });

  const wrongKind = await app.request("/v1/share", { method: "POST", headers: h(), body: JSON.stringify({ ...item, to: "notes" }) });
  expect(wrongKind.status).toBe(400);
  const toItself = await app.request("/v1/share", { method: "POST", headers: h(), body: JSON.stringify({ ...item, from: "anything", to: "anything" }) });
  expect(toItself.status).toBe(400);
}, 30_000);

it("an app frame cannot send on its own", async () => {
  makeApp("sender");
  makeApp("cards", { route: "/inbox", kinds: ["*"] });
  const body = JSON.stringify({ from: "sender", to: "cards", kind: "character", name: "x", data: "x" });
  const res = await app.request("/v1/share", { method: "POST", headers: h({ "x-chrysalis-app": "sender" }), body });
  expect(res.status).toBe(403);
  const list = await app.request("/v1/share/targets?kind=character&from=sender", { headers: h({ "x-chrysalis-app": "sender" }) });
  expect(list.status).toBe(403);
});
