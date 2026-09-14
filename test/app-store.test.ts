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
import { strToU8, unzipSync, zipSync } from "fflate";
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
  repository: "https://github.com/ProjectChrysalis/Roleplay-Chrysalis",
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
    expect(isOfficialSource("https://github.com/ProjectChrysalis/Roleplay-Chrysalis")).toBe(true);
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
    writeInstallSource(p.appUpstream, "my-roleplay", { git: "https://github.com/projectchrysalis/roleplay-chrysalis.git", ref: "HEAD" });
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

  it("installs a Store app under the entry's id, not the repository's name", async () => {
    const url = await publish("studio-app", { name: "Studio", version: "1.0.0", kind: "app" });
    const preview = (await (await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl: url, id: "studio" }) })).json()) as { slug: string; head: string };
    expect(preview.slug).toBe("studio");
    const done = (await (await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl: url, id: "studio", confirm: preview.slug, head: preview.head }) })).json()) as { id: string };
    expect(done.id).toBe("studio");
    expect(fs.existsSync(path.join(userPaths(dataDir, "alice").apps, "studio", "manifest.json"))).toBe(true);
    // a bad id is refused before anything is staged
    const bad = await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl: url, id: "../evil" }) });
    expect(bad.status).toBe(400);
  }, 60_000);

  it("exports an app as a zip with its data, and never follows a link out", async () => {
    const url = await publish("studio", { name: "Studio", version: "1.0.0", kind: "app" });
    const id = await importApp(url);
    const dir = path.join(userPaths(dataDir, "alice").apps, id);
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "notes.json"), JSON.stringify({ hello: 1 }));
    fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "x");
    const secret = path.join(dataDir, "outside.txt");
    fs.writeFileSync(secret, "not the app's");
    fs.symlinkSync(secret, path.join(dir, "leak.txt"));

    const res = await call(`/v1/apps/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const names = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())));
    expect(names).toContain("manifest.json");
    expect(names).toContain("data/notes.json");
    expect(names.some((n) => n.startsWith("node_modules/"))).toBe(false);
    expect(names).not.toContain("leak.txt");
  }, 60_000);

  /** Commit a change to a published repository and serve the new head. */
  const republish = async (name: string, change: (work: string) => void, under = "owner") => {
    const work = path.join(repoDir, `${name}-work`);
    change(work);
    await git(["add", "-A"], work);
    await git(["commit", "-m", "next"], work);
    const bare = path.join(repoDir, under, `${name}.git`);
    fs.rmSync(bare, { recursive: true, force: true });
    await git(["clone", "--bare", work, bare]);
    await git(["update-server-info"], bare);
  };
  const uploadZip = (bytes: Uint8Array) =>
    app.request("/v1/apps/import", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/zip" }, body: bytes });
  const grantsOf = () =>
    (JSON.parse(fs.readFileSync(userPaths(dataDir, "alice").settings, "utf8")) as { pluginGrants?: Record<string, string[]> }).pluginGrants ?? {};

  it("restores a backup as a new app that keeps updating, and is official again only once its code is the repository's", async () => {
    const url = await publish("studio", { name: "Studio", version: "1.0.0", kind: "app" });
    const id = await importApp(url);
    const p = userPaths(dataDir, "alice");
    fs.mkdirSync(path.join(p.apps, id, "data"), { recursive: true });
    fs.writeFileSync(path.join(p.apps, id, "data", "notes.json"), "{\"hello\":1}");
    const zip = new Uint8Array(await (await call(`/v1/apps/${id}/export`)).arrayBuffer());
    const names = Object.keys(unzipSync(zip));
    expect(names).toContain(".__backup/backup.json");
    expect(names).toContain(".__backup/baseline/plugins/api/plugin.js");

    const preview = (await (await uploadZip(zip)).json()) as { file: string; id: string; data: boolean; updatesFrom: string | null; plugins: { id: string; permissions: string[] }[] };
    expect(preview).toMatchObject({ id: "studio-2", data: true, updatesFrom: url, plugins: [{ id: "api", permissions: ["routes"] }] });
    // nothing is installed by the preview
    expect(fs.existsSync(path.join(p.apps, "studio-2"))).toBe(false);

    const done = (await (await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ file: preview.file, name: "studio-backup.zip" }) })).json()) as { id: string };
    expect(done.id).toBe("studio-2");
    expect(fs.readFileSync(path.join(p.apps, "studio-2", "data", "notes.json"), "utf8")).toBe("{\"hello\":1}");
    expect(fs.existsSync(path.join(p.apps, "studio-2", ".__backup"))).toBe(false);
    expect(readInstallSource(p.appUpstream, "studio-2")).toEqual({ git: url, ref: "HEAD", restored: true });
    expect(grantsOf()["studio-2__api"]).toEqual(["routes"]);
    // the file's code is not the maintainers' release, whatever it says
    expect((await launchApps()).find((a) => a.id === "studio-2")).toMatchObject({ official: false, repository: url });
    // a token is used once
    expect((await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ file: preview.file }) })).status).toBe(409);

    await republish("studio", (work) => fs.writeFileSync(path.join(work, "README.md"), "new\n"));
    const updated = (await (await call("/v1/apps/studio-2/update", { method: "POST", body: "{}" })).json()) as { status: string };
    expect(updated.status).toBe("applied");
    expect(readInstallSource(p.appUpstream, "studio-2")).toEqual({ git: url, ref: "HEAD" });
    expect((await launchApps()).find((a) => a.id === "studio-2")?.official).toBe(true);
  }, 60_000);

  it("imports an app zipped by hand, and refuses a zip that reaches outside its folder", async () => {
    const manifest = strToU8(JSON.stringify({ name: "Hand Made", version: "0.1.0", kind: "app" }));
    const p = userPaths(dataDir, "alice");

    const wrapped = (await (await uploadZip(zipSync({ "hand-made/manifest.json": manifest, "hand-made/src/main.tsx": strToU8("export {}\n"), "__MACOSX/hand-made/._main.tsx": strToU8("x") }))).json()) as { file: string; id: string; updatesFrom: string | null };
    expect(wrapped).toMatchObject({ id: "hand-made", updatesFrom: null });
    const done = (await (await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ file: wrapped.file, name: "hand.zip" }) })).json()) as { id: string };
    expect(fs.readFileSync(path.join(p.apps, done.id, "src", "main.tsx"), "utf8")).toBe("export {}\n");
    expect(readInstallSource(p.appUpstream, done.id)).toBeNull();

    const escaping = await uploadZip(zipSync({ "manifest.json": manifest, "../../escaped.txt": strToU8("no") }));
    expect(escaping.status).toBe(422);
    expect(fs.existsSync(path.join(p.apps, "..", "escaped.txt"))).toBe(false);
    expect((await uploadZip(strToU8("not a zip at all"))).status).toBe(400);
    expect((await uploadZip(zipSync({ "readme.txt": strToU8("hi") }))).status).toBe(422);
    expect((await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ file: "../../etc" }) })).status).toBe(400);
  }, 60_000);

  it("asks before a community update gives a plugin a permission it never had", async () => {
    const url = await publish("tool", { name: "Tool", version: "1.0.0", kind: "app" }, "someone");
    const id = await importApp(url);
    const manifestFile = (work: string) => path.join(work, "plugins", "api", "manifest.json");
    await republish("tool", (work) => fs.writeFileSync(manifestFile(work), JSON.stringify({ name: "API", version: "1.1.0", permissions: ["routes", "network"] })), "someone");

    const review = (await (await call(`/v1/apps/${id}/update`, { method: "POST", body: "{}" })).json()) as { needsDepConfirm?: boolean; head: string; permissions: unknown };
    expect(review.needsDepConfirm).toBe(true);
    expect(review.permissions).toEqual([{ id: "api", name: "API", added: ["network"], hosts: [] }]);
    expect(grantsOf()[`${id}__api`]).toEqual(["routes"]);

    const moved = await call(`/v1/apps/${id}/update`, { method: "POST", body: JSON.stringify({ confirmDeps: true, head: "0".repeat(40) }) });
    expect(moved.status).toBe(409);
    const applied = (await (await call(`/v1/apps/${id}/update`, { method: "POST", body: JSON.stringify({ confirmDeps: true, head: review.head }) })).json()) as { status: string };
    expect(applied.status).toBe("applied");
    expect(grantsOf()[`${id}__api`]).toEqual(["routes", "network"]);
  }, 60_000);

  it("asks before a community update points a networked plugin at a new host", async () => {
    const url = await publish("feed", { name: "Feed", version: "1.0.0", kind: "app" }, "someone");
    const manifestFile = (work: string) => path.join(work, "plugins", "api", "manifest.json");
    const withHosts = (hosts: string[]) => JSON.stringify({ name: "API", version: "1.0.0", permissions: ["routes", "network"], networkHosts: hosts });
    await republish("feed", (work) => fs.writeFileSync(manifestFile(work), withHosts(["cards.example"])), "someone");
    const id = await importApp(url);
    expect(grantsOf()[`${id}__api`]).toEqual(["routes", "network"]);

    // same permissions, one more host: nothing new is granted, yet the plugin
    // could send what it reads somewhere it could not before
    await republish("feed", (work) => fs.writeFileSync(manifestFile(work), withHosts(["cards.example", "collector.example"])), "someone");
    const review = (await (await call(`/v1/apps/${id}/update`, { method: "POST", body: "{}" })).json()) as { needsDepConfirm?: boolean; head: string; permissions: unknown };
    expect(review.needsDepConfirm).toBe(true);
    expect(review.permissions).toEqual([{ id: "api", name: "API", added: [], hosts: ["collector.example"] }]);
    const p = userPaths(dataDir, "alice");
    expect(JSON.parse(fs.readFileSync(path.join(p.apps, id, "plugins", "api", "manifest.json"), "utf8")).networkHosts).toEqual(["cards.example"]);

    const applied = (await (await call(`/v1/apps/${id}/update`, { method: "POST", body: JSON.stringify({ confirmDeps: true, head: review.head }) })).json()) as { status: string };
    expect(applied.status).toBe("applied");
    expect(JSON.parse(fs.readFileSync(path.join(p.apps, id, "plugins", "api", "manifest.json"), "utf8")).networkHosts).toEqual(["cards.example", "collector.example"]);

    // dropping a host is not a review
    await republish("feed", (work) => fs.writeFileSync(manifestFile(work), withHosts(["cards.example"])), "someone");
    expect(((await (await call(`/v1/apps/${id}/update`, { method: "POST", body: "{}" })).json()) as { status: string }).status).toBe("applied");

    // the repository unpacked for review never lands in the workspace history
    const touched = await new Promise<string>((resolve, reject) =>
      execFile("git", ["log", "--name-only", "--format="], { cwd: p.root }, (err, out) => (err ? reject(err) : resolve(out))));
    expect(touched).toContain(`apps/${id}/plugins/api/manifest.json`);
    expect(touched).not.toContain(".staging");
  }, 60_000);

  it("an update whose plugin manifest conflicts still grants that plugin, and a locked plugin says why nothing answers", async () => {
    const url = await publish("studio", { name: "Studio", version: "1.0.0", kind: "app" });
    const id = await importApp(url);
    const p = userPaths(dataDir, "alice");
    const manifestPath = path.join(p.apps, id, "plugins", "api", "manifest.json");
    // an install an earlier engine seeded: plugins local, nothing granted
    const settings = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { pluginGrants?: Record<string, string[]> };
    delete settings.pluginGrants;
    fs.writeFileSync(p.settings, JSON.stringify(settings));
    const local = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(manifestPath, JSON.stringify({ ...local, origin: "local", version: "1.0.1" }, null, 2));
    invalidatePluginCache();
    expect((await call(`/v1/apps/${id}/ping`)).status).toBe(200);

    // the update bumps the same line: the merged manifest has markers
    await republish("studio", (work) => fs.writeFileSync(path.join(work, "plugins", "api", "manifest.json"), JSON.stringify({ name: "API", version: "1.1.0", permissions: ["routes"] }, null, 2)));
    const updated = (await (await call(`/v1/apps/${id}/update`, { method: "POST", body: JSON.stringify({ strategy: "agent" }) })).json()) as { status: string; conflicts: { path: string }[] };
    expect(updated.status).toBe("applied");
    expect(updated.conflicts.map((c) => c.path)).toContain("plugins/api/manifest.json");
    expect(fs.readFileSync(manifestPath, "utf8")).toContain("<<<<<<<");
    expect(grantsOf()[`${id}__api`]).toEqual(["routes"]);
    const broken = (await (await call(`/v1/apps/${id}/ping`)).json()) as { error: string };
    expect(broken.error).toContain("plugin api did not load");

    // the agent resolves the markers: the plugin answers again without anyone re-approving it
    fs.writeFileSync(manifestPath, JSON.stringify({ name: "API", version: "1.1.0", permissions: ["routes"], origin: "imported", source: { git: url } }, null, 2));
    invalidatePluginCache();
    expect((await call(`/v1/apps/${id}/ping`)).status).toBe(200);

    const settingsNow = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { pluginGrants: Record<string, string[]> };
    delete settingsNow.pluginGrants[`${id}__api`];
    fs.writeFileSync(p.settings, JSON.stringify(settingsNow));
    const locked = (await (await call(`/v1/apps/${id}/ping`)).json()) as { error: string };
    expect(locked.error).toBe("no route: plugin api is waiting for its routes permission to be approved");
  }, 60_000);

  it("importing a plugin's repository again updates that plugin in place", async () => {
    const id = await importApp(await publish("studio", { name: "Studio", version: "1.0.0", kind: "app" }));
    const work = path.join(repoDir, "extra-work");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "manifest.json"), JSON.stringify({ name: "Extra", version: "1.0.0", permissions: ["routes"] }));
    fs.writeFileSync(path.join(work, "plugin.js"), "export function handleRoute() { return null; }");
    await git(["init"], work);
    await git(["add", "-A"], work);
    await git(["commit", "-m", "init"], work);
    const bare = path.join(repoDir, "owner", "extra.git");
    await git(["clone", "--bare", work, bare]);
    await git(["update-server-info"], bare);
    const pluginUrl = `${owner}extra.git`;
    const importPlugin = async () => {
      const pv = (await (await call(`/v1/apps/${id}/plugins/import`, { method: "POST", body: JSON.stringify({ gitUrl: pluginUrl }) })).json()) as { head: string; installed: { id: string; version: string | null } | null };
      const done = (await (await call(`/v1/apps/${id}/plugins/import`, { method: "POST", body: JSON.stringify({ gitUrl: pluginUrl, confirm: true, head: pv.head }) })).json()) as { id: string; updated: boolean };
      return { pv, done };
    };
    const first = await importPlugin();
    expect(first.pv.installed).toBeNull();
    expect(first.done).toMatchObject({ id: "extra", updated: false });

    fs.writeFileSync(path.join(work, "manifest.json"), JSON.stringify({ name: "Extra", version: "1.1.0", permissions: ["routes"] }));
    await git(["commit", "-am", "next"], work);
    fs.rmSync(bare, { recursive: true, force: true });
    await git(["clone", "--bare", work, bare]);
    await git(["update-server-info"], bare);
    const second = await importPlugin();
    expect(second.pv.installed).toEqual({ id: "extra", version: "1.0.0" });
    expect(second.done).toMatchObject({ id: "extra", updated: true });
    const pluginsDir = path.join(userPaths(dataDir, "alice").apps, id, "plugins");
    expect(fs.readdirSync(pluginsDir).sort()).toEqual(["api", "extra"]);

    const listed = ((await (await call(`/v1/apps/${id}/plugins`)).json()) as { plugins: { id: string; version: string; repository: string | null }[] }).plugins;
    expect(listed.find((x) => x.id === "extra")).toMatchObject({ version: "1.1.0", repository: pluginUrl });
    // the app's own plugin updates with the app
    expect(listed.find((x) => x.id === "api")?.repository).toBeNull();
  }, 60_000);

  it("checks every app with a source at once, for the launcher badges", async () => {
    const url = await publish("studio", { name: "Studio", version: "1.0.0", kind: "app" });
    const id = await importApp(url);
    const p = userPaths(dataDir, "alice");
    // a locally created app has no upstream: never checked
    fs.mkdirSync(path.join(p.apps, "mine"), { recursive: true });
    fs.writeFileSync(path.join(p.apps, "mine", "manifest.json"), JSON.stringify({ name: "Mine", version: "1", kind: "app" }));
    const check = async () =>
      ((await (await call("/v1/apps/updates?fresh=1")).json()) as { apps: { id: string; available: boolean; remoteHead?: string | null }[] }).apps;
    // freshly installed: the stamped head is the remote's
    expect(await check()).toEqual([{ id, available: false, remoteHead: expect.any(String) }]);
    // an install with no stamped head (an adopted one) counts as behind
    const manifestPath = path.join(p.apps, id, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { source: { head?: string } };
    delete manifest.source.head;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(await check()).toEqual([{ id, available: true, remoteHead: expect.any(String) }]);
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
    expect(adoptFormerlyShipped(p)).toEqual([{ id: "roleplay", repository: "https://github.com/ProjectChrysalis/Roleplay-Chrysalis" }]);
    expect(adoptFormerlyShipped(p)).toEqual([]);
    expect(readInstallSource(p.appUpstream, "roleplay")).toEqual({ git: "https://github.com/ProjectChrysalis/Roleplay-Chrysalis", ref: "HEAD" });
    const manifest = JSON.parse(fs.readFileSync(path.join(p.apps, "roleplay", "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.official).toBeUndefined();
    expect(manifest.source).toEqual({ git: "https://github.com/ProjectChrysalis/Roleplay-Chrysalis", ref: "HEAD" });
  });

  it("remembers the day the Store was last looked at", async () => {
    expect(((await (await call("/v1/settings")).json()) as { storeSeen: string | null }).storeSeen).toBeNull();
    expect((await call("/v1/settings", { method: "PUT", body: JSON.stringify({ storeSeen: "2026-09-13" }) })).status).toBe(200);
    expect(((await (await call("/v1/settings")).json()) as { storeSeen: string | null }).storeSeen).toBe("2026-09-13");
    expect((await call("/v1/settings", { method: "PUT", body: JSON.stringify({ storeSeen: "soon" }) })).status).toBe(400);
  });
});
