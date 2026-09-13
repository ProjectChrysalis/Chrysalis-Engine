/**
 * The app store: the list's validation and caching, the /v1/store route,
 * official status from where the engine installed an app, and adopting
 * installs of apps earlier engines shipped.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import type { Hono } from "hono";
import type { AppEnv } from "../src/server/app.js";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";
import { invalidatePluginCache } from "../src/plugins/runtime.js";
import { adoptFormerlyShipped, createCatalog, isOfficialSource, parseCatalog } from "../src/apps/store.js";
import { readInstallSource, readCodeTree, writeBaseline, writeInstallSource } from "../src/apps/update.js";

const entry = (over: Record<string, unknown> = {}) => ({
  id: "roleplay",
  name: "Roleplay",
  description: "A roleplay studio.",
  author: "Project Chrysalis",
  repository: "https://github.com/ProjectChrysalis/Roleplay",
  tags: ["roleplay"],
  added: "2026-09-13",
  ...over,
});

describe("store list", () => {
  it("keeps valid entries and skips malformed ones without emptying the list", () => {
    const apps = parseCatalog({
      apps: [
        entry(),
        entry(), // duplicate id
        entry({ id: "plain-http", repository: "http://example.com/a/b" }),
        entry({ id: "ssh", repository: "git@github.com:a/b" }),
        entry({ id: "no-date", added: "yesterday" }),
        entry({ id: "Bad Id" }),
        entry({ id: "long", name: "x".repeat(81) }),
        entry({ id: "tagged", tags: ["ok", "NOT OK", 5, "fine one"], ref: "../main" }),
        "nonsense",
      ],
    });
    expect(apps.map((a) => a.id)).toEqual(["roleplay", "tagged"]);
    expect(apps[1]!.tags).toEqual(["ok", "fine one"]);
    expect(apps[1]!.ref).toBeUndefined();
    expect(parseCatalog({ apps: "no" })).toEqual([]);
    expect(parseCatalog(null)).toEqual([]);
  });

  it("official means a repository directly under a maintainers' owner", () => {
    expect(isOfficialSource("https://github.com/ProjectChrysalis/Roleplay")).toBe(true);
    expect(isOfficialSource("https://GitHub.com/projectchrysalis/roleplay.git/")).toBe(true);
    for (const url of [
      "https://github.com/ProjectChrysalisX/app",
      "https://github.com/someone/ProjectChrysalis",
      "https://github.com/ProjectChrysalis/a/b",
      "https://github.com/ProjectChrysalis/..",
      "https://github.com/ProjectChrysalis/",
      "http://github.com/ProjectChrysalis/app",
      "git@github.com:ProjectChrysalis/app",
    ]) {
      expect(isOfficialSource(url), url).toBe(false);
    }
  });

  it("caches the list, keeps the last good copy on disk, and says when a fetch failed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
    const cacheFile = path.join(dir, "store-catalog.json");
    let calls = 0;
    let online = true;
    const fetcher = (async () => {
      calls++;
      if (!online) throw new Error("offline");
      return new Response(JSON.stringify({ apps: [entry()] }));
    }) as unknown as typeof fetch;
    const url = "https://store.example/apps.json";
    const list = createCatalog({ url, cacheFile, fetcher, userAgent: "test" });
    expect((await list.get()).apps.map((a) => a.id)).toEqual(["roleplay"]);
    await list.get();
    expect(calls).toBe(1);

    // a restart while offline still shows the saved list, with the reason
    online = false;
    const restarted = createCatalog({ url, cacheFile, fetcher, userAgent: "test" });
    const offline = await restarted.get();
    expect(offline.apps.map((a) => a.id)).toEqual(["roleplay"]);
    expect(offline.fetchedAt).toBeGreaterThan(0);
    expect(offline.error).toContain("offline");
    // a copy saved for another list address is not used
    const elsewhere = await createCatalog({ url: "https://other.example/apps.json", cacheFile, fetcher, userAgent: "test" }).get();
    expect(elsewhere.apps).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

const git = (args: string[], cwd?: string) =>
  new Promise<void>((resolve, reject) => {
    execFile("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err) => (err ? reject(err) : resolve()));
  });

describe("installing from the store", () => {
  let dataDir: string;
  let repoDir: string;
  let server: http.Server;
  let owner: string;
  let token: string;
  let app: Hono<AppEnv>;
  let storeApps: unknown[];

  const call = (url: string, init: Record<string, unknown> = {}) =>
    app.request(url, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...init });

  /** A bare repository served over dumb HTTP, under the official owner
   *  unless another one is named. */
  const publish = async (name: string, manifest: Record<string, unknown>, under = "owner") => {
    const work = path.join(repoDir, `${name}-work`);
    fs.mkdirSync(path.join(work, "plugins", "api"), { recursive: true });
    fs.writeFileSync(path.join(work, "manifest.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(work, "plugins", "api", "manifest.json"), JSON.stringify({ name: "API", version: "1.0.0", permissions: ["routes"] }));
    fs.writeFileSync(path.join(work, "plugins", "api", "plugin.js"), "export function handleRoute() { return { status: 200, json: { ok: true } }; }");
    await git(["init"], work);
    await git(["add", "-A"], work);
    await git(["commit", "-m", "init"], work);
    const bare = path.join(repoDir, under, `${name}.git`);
    await git(["clone", "--bare", work, bare]);
    await git(["update-server-info"], bare);
    return `${owner.replace(/owner\/$/, under)}/${name}.git`;
  };

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-repos-"));
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\/+/, "");
      try {
        const data = fs.readFileSync(path.join(repoDir, rel));
        res.writeHead(200);
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    owner = `http://127.0.0.1:${(server.address() as { port: number }).port}/owner/`;
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    token = users.create("alice", "user", { password: "test-pass-1" }).token;
    bootstrapUserDir(dataDir, "alice");
    storeApps = [];
    app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus(), officialSources: [owner] });
  });

  afterEach(() => {
    server.closeAllConnections?.();
    server.close();
    for (const dir of [dataDir, repoDir]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* watcher races */ }
    }
    invalidatePluginCache();
  });

  const importApp = async (gitUrl: string) => {
    const preview = (await (await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl }) })).json()) as { slug: string; head: string };

    const done = (await (await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl, confirm: preview.slug, head: preview.head }) })).json()) as { id: string };
    return done.id;
  };
  const launchApps = async () =>
    ((await (await call("/v1/launch")).json()) as { apps: { id: string; official: boolean; repository: string | null }[] }).apps;

  it("lists entries official first, marks what is installed, and turns off with config", async () => {
    storeApps = [
      entry({ id: "community", name: "Community", repository: "https://github.com/someone/community", added: "2026-09-20" }),
      entry(),
    ];
    const users = new UserService(dataDir);
    const storeFetch = (async () => new Response(JSON.stringify({ apps: storeApps }))) as unknown as typeof fetch;
    const store = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus(), storeFetch });
    const list = async () =>
      (await (await store.request("/v1/store?fresh=1", { headers: { authorization: `Bearer ${token}` } })).json()) as { enabled: boolean; apps: { id: string; official: boolean; installed: string | null }[] };

    const before = await list();
    expect(before.enabled).toBe(true);
    expect(before.apps.map((a) => [a.id, a.official, a.installed])).toEqual([["roleplay", true, null], ["community", false, null]]);

    const p = userPaths(dataDir, "alice");
    fs.mkdirSync(path.join(p.apps, "my-roleplay"), { recursive: true });
    fs.writeFileSync(path.join(p.apps, "my-roleplay", "manifest.json"), JSON.stringify({ name: "Roleplay", version: "1", kind: "app" }));
    writeInstallSource(p.appUpstream, "my-roleplay", { git: "https://github.com/projectchrysalis/roleplay.git", ref: "HEAD" });
    expect((await list()).apps.find((a) => a.id === "roleplay")?.installed).toBe("my-roleplay");

    const config = defaultInstanceConfig();
    config.apps.store = null;
    const off = buildApp({ users, sessions: new SessionService(dataDir), config, dataDir, bus: new EventBus() });
    const res = (await (await off.request("/v1/store", { headers: { authorization: `Bearer ${token}` } })).json()) as { enabled: boolean };
    expect(res.enabled).toBe(false);
  });

  it("an app installed from an official repository is official until it is deleted, and keeps it through a rename", async () => {
    const officialUrl = await publish("studio", { name: "Studio", version: "1.0.0", kind: "app", official: true });
    const id = await importApp(officialUrl);
    expect(id).toBe("studio");
    const p = userPaths(dataDir, "alice");
    expect(readInstallSource(p.appUpstream, id)).toEqual({ git: officialUrl, ref: "HEAD" });
    expect((await launchApps()).find((a) => a.id === id)).toMatchObject({ official: true, repository: officialUrl });

    // the bridge treats it as official: it may write the model pricing catalog
    const trusted = await app.request("/v1/models/pricing", { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-chrysalis-app": id }, body: "{}" });
    expect(trusted.status).not.toBe(403);

    expect((await call(`/v1/apps/${id}/rename`, { method: "POST", body: JSON.stringify({ id: "studio-renamed" }) })).status).toBe(200);
    expect((await launchApps()).find((a) => a.id === "studio-renamed")?.official).toBe(true);
    expect(readInstallSource(p.appUpstream, id)).toBeNull();

    // deleted, then a new app under the same id: nothing carries over
    expect((await call("/v1/apps/studio-renamed", { method: "DELETE" })).status).toBe(200);
    expect(readInstallSource(p.appUpstream, "studio-renamed")).toBeNull();
    await call("/v1/apps", { method: "POST", body: JSON.stringify({ id: "studio-renamed", name: "Mine" }) });
    expect((await launchApps()).find((a) => a.id === "studio-renamed")?.official).toBe(false);

    // a community repository is never official, whatever its manifest says
    const community = await publish("other", { name: "Other", version: "1.0.0", kind: "app", official: true }, "someone");
    const otherId = await importApp(community);
    expect((await launchApps()).find((a) => a.id === otherId)?.official).toBe(false);
  }, 60_000);

  it("adopts an install an earlier engine shipped, and only that", async () => {
    const p = userPaths(dataDir, "alice");
    const make = (id: string) => {
      const dir = path.join(p.apps, id);
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "Roleplay", version: "4.16.1", kind: "app", official: true }));
      fs.writeFileSync(path.join(dir, "src", "main.tsx"), "export {}\n");
      return dir;
    };
    // created by hand, with no baseline the engine wrote: not adopted
    make("roleplay");
    expect(adoptFormerlyShipped(p)).toEqual([]);
    // seeded by the engine (it wrote the baseline): adopted once
    writeBaseline(p.appUpstream, "roleplay", "4.16.1", readCodeTree(path.join(p.apps, "roleplay")));
    expect(adoptFormerlyShipped(p)).toEqual([{ id: "roleplay", repository: "https://github.com/ProjectChrysalis/Roleplay" }]);
    expect(adoptFormerlyShipped(p)).toEqual([]);
    expect(readInstallSource(p.appUpstream, "roleplay")).toEqual({ git: "https://github.com/ProjectChrysalis/Roleplay", ref: "HEAD" });
    const manifest = JSON.parse(fs.readFileSync(path.join(p.apps, "roleplay", "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.official).toBeUndefined();
    expect(manifest.source).toEqual({ git: "https://github.com/ProjectChrysalis/Roleplay", ref: "HEAD" });
  });

  it("remembers the day the Store was last looked at", async () => {
    expect(((await (await call("/v1/settings")).json()) as { storeSeen: string | null }).storeSeen).toBeNull();
    expect((await call("/v1/settings", { method: "PUT", body: JSON.stringify({ storeSeen: "2026-09-13" }) })).status).toBe(200);
    expect(((await (await call("/v1/settings")).json()) as { storeSeen: string | null }).storeSeen).toBe("2026-09-13");
    expect((await call("/v1/settings", { method: "PUT", body: JSON.stringify({ storeSeen: "soon" }) })).status).toBe(400);
  });
});
