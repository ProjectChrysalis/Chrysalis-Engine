/**
 * Distribution tests — git app/plugin import over a local dumb-HTTP git
 * server, the divergence ("modified since install") content hash, and the
 * engine identity in the launch payload. Uses the same buildApp harness as
 * profiles.test.ts (Hono app.request, no socket).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import type { AppEnv } from "../src/server/app.js";
import type { Hono } from "hono";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import { defaultInstanceConfig } from "../src/config.js";
import { userPaths } from "../src/paths.js";
import { invalidatePluginCache } from "../src/plugins/runtime.js";

let dataDir: string;
let adminToken: string;
let app: Hono<AppEnv>;
let repoDir: string;
let server: http.Server;
let repoUrl: string;

const git = (args: string[], cwd?: string) =>
  new Promise<void>((resolve, reject) => {
    execFile(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@test", ...args],
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err) => (err ? reject(err) : resolve()),
    );
  });

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dist-"));
  const users = new UserService(dataDir);
  users.create("admin", "admin", { password: "admin-pass-1" });
  adminToken = users.create("root", "admin", { password: "test-pass-1" }).token;
  app = buildApp({
    users,
    sessions: new SessionService(dataDir),
    config: defaultInstanceConfig(),
    dataDir,
    bus: new EventBus(),
  });

  // a working repo with an app manifest + one plugin → bare clone → dumb HTTP
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  const work = path.join(repoDir, "work");
  fs.mkdirSync(path.join(work, "plugins", "greeter"), { recursive: true });
  fs.writeFileSync(
    path.join(work, "manifest.json"),
    JSON.stringify({ name: "Dist App", version: "1.0.0", kind: "app" }),
  );
  fs.writeFileSync(path.join(work, "plugins", "greeter", "manifest.json"), JSON.stringify({ name: "Greeter", version: "1.0.0" }));
  fs.writeFileSync(path.join(work, "plugins", "greeter", "plugin.js"), "export function onRoute() { return { status: 200, json: { ok: true } }; }");
  fs.mkdirSync(path.join(work, "data"), { recursive: true });
  fs.writeFileSync(path.join(work, "data", "keep.txt"), "user data");
  await git(["init"], work);
  await git(["add", "-A"], work);
  await git(["commit", "-m", "init"], work);
  const bare = path.join(repoDir, "repo.git");
  await git(["clone", "--bare", work, bare]);
  await git(["update-server-info"], bare);

  server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\/+/, "");
    const file = path.join(repoDir, rel);
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  repoUrl = `http://127.0.0.1:${addr.port}/repo.git`;
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
  try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* keep going */ }
  server.closeAllConnections?.();
  server.close();
  invalidatePluginCache();
});

const H = () => ({ authorization: `Bearer ${adminToken}`, "content-type": "application/json" });
const call = (pathName: string, init: Record<string, unknown> = {}) =>
  app.request(pathName, { headers: H(), ...init }) as Promise<Response>;

describe("shareable plugins (git import, scoped to an app)", () => {
  const setupPluginRepo = async () => {
    const plug = path.join(repoDir, "plug");
    fs.mkdirSync(plug, { recursive: true });
    fs.writeFileSync(
      path.join(plug, "manifest.json"),
      JSON.stringify({ name: "Echo Plugin", version: "0.3.0", author: "Community", permissions: ["routes", "store"], networkHosts: ["example.com"] }),
    );
    fs.writeFileSync(path.join(plug, "plugin.js"), "export function onRoute() { return { status: 200, json: {} }; }");
    await git(["init"], plug);
    await git(["add", "-A"], plug);
    await git(["commit", "-m", "plugin"], plug);
    const plugBare = path.join(repoDir, "plug.git");
    await git(["clone", "--bare", plug, plugBare]);
    await git(["update-server-info"], plugBare);
    const addr = server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}/plug.git`;
  };

  it("two-phase import into an app: preview → confirm installs with grants; removal cleans up; app reports modified", async () => {
    // the plugin lands INSIDE an app — import one first
    const appImp = await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl: repoUrl, confirm: true }) });
    expect(appImp.status).toBe(200);
    const appId = ((await appImp.json()) as { id: string }).id;
    const plugUrl = await setupPluginRepo();

    const importPath = `/v1/apps/${appId}/plugins/import`;
    const preview = await call(importPath, { method: "POST", body: JSON.stringify({ gitUrl: plugUrl }) });
    expect(preview.status).toBe(200);
    const pv = (await preview.json()) as { staged: boolean; manifest: { name: string }; permissions: string[]; networkHosts: string[] };
    expect(pv.staged).toBe(true);
    expect(pv.manifest.name).toBe("Echo Plugin");
    expect(pv.permissions).toContain("routes");
    expect(pv.networkHosts).toContain("example.com");
    // preview must not have installed anything yet
    const root = userPaths(dataDir, "root").root;
    expect(fs.readdirSync(path.join(root, "apps", appId, "plugins"))).toEqual(["greeter"]);

    const confirm = await call(importPath, { method: "POST", body: JSON.stringify({ gitUrl: plugUrl, confirm: true }) });
    expect(confirm.status).toBe(200);
    const cr = (await confirm.json()) as { ok: boolean; id: string };
    expect(cr.ok).toBe(true);

    const installedDir = path.join(root, "apps", appId, "plugins", cr.id);
    const installedManifest = JSON.parse(fs.readFileSync(path.join(installedDir, "manifest.json"), "utf8")) as { origin?: string; source?: { git?: string } };
    expect(installedManifest.origin).toBe("imported");
    expect(installedManifest.source?.git).toBe(plugUrl);

    // listed as one of the app's plugins
    const list = await call(`/v1/apps/${appId}/plugins`);
    const lv = (await list.json()) as { plugins: { id: string; permissions: string[] }[] };
    const mine = lv.plugins.find((x) => x.id === cr.id);
    expect(mine?.permissions).toContain("store");

    // reviewed capabilities pre-granted (app plugin ids are namespaced)
    const settings = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")) as { pluginGrants?: Record<string, string[]> };
    expect(settings.pluginGrants?.[`${appId}__${cr.id}`]).toContain("store");

    // a git-imported app with an imported plugin has diverged from its source
    const upd = await call(`/v1/apps/${appId}/updates`);
    const uv = (await upd.json()) as { modified: boolean | null };
    expect(uv.modified).toBe(true);

    // delete removes the plugin AND its grant
    const del = await call(`/v1/apps/${appId}/plugins/${cr.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(fs.existsSync(installedDir)).toBe(false);
    const settings2 = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")) as { pluginGrants?: Record<string, string[]> };
    expect(settings2.pluginGrants?.[`${appId}__${cr.id}`]).toBeUndefined();
  }, 60_000);

  it("update merges: overlapping edits stop it, taking the update keeps data + imported plugins", async () => {
    const appImp = await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl: repoUrl, confirm: true }) });
    const appId = ((await appImp.json()) as { id: string }).id;
    const root = userPaths(dataDir, "root").root;
    const plugUrl = await setupPluginRepo();
    const imp = await call(`/v1/apps/${appId}/plugins/import`, { method: "POST", body: JSON.stringify({ gitUrl: plugUrl, confirm: true }) });
    const pluginId = ((await imp.json()) as { id: string }).id;

    // user data + a local code edit
    fs.mkdirSync(path.join(root, "apps", appId, "data", "chats"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", appId, "data", "chats", "live.jsonl"), "user chat line\n");
    fs.appendFileSync(path.join(root, "apps", appId, "plugins", "greeter", "plugin.js"), "\n// local edit\n");

    // advance the remote: v2.0.0 + a changed bundled plugin
    const work = path.join(repoDir, "work");
    const manifest = JSON.parse(fs.readFileSync(path.join(work, "manifest.json"), "utf8")) as { version: string };
    manifest.version = "2.0.0";
    fs.writeFileSync(path.join(work, "manifest.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(work, "plugins", "greeter", "plugin.js"), "export function onRoute() { return { status: 200, json: { v: 2 } }; }");
    await git(["add", "-A"], work);
    await git(["commit", "-m", "v2"], work);
    fs.rmSync(path.join(repoDir, "repo.git"), { recursive: true, force: true });
    await git(["clone", "--bare", work, path.join(repoDir, "repo.git")]);
    await git(["update-server-info"], path.join(repoDir, "repo.git"));

    const appDir = path.join(root, "apps", appId);
    // the local edit and the new version both rewrote the same plugin: the
    // first attempt reports the conflict and changes nothing
    const tried = await call(`/v1/apps/${appId}/update`, { method: "POST" });
    expect(tried.status).toBe(200);
    const tv = (await tried.json()) as { status: string; conflicts: { path: string; reason: string }[] };
    expect(tv.status).toBe("conflicts");
    expect(tv.conflicts).toEqual([{ path: "plugins/greeter/plugin.js", reason: "both edited" }]);
    expect(fs.readFileSync(path.join(appDir, "plugins", "greeter", "plugin.js"), "utf8")).toContain("local edit");

    const upd = await call(`/v1/apps/${appId}/update`, { method: "POST", body: JSON.stringify({ strategy: "theirs" }) });
    expect(upd.status).toBe(200);
    const uv = (await upd.json()) as { status: string; to: string };
    expect(uv.status).toBe("applied");
    expect(uv.to).toBe("2.0.0");

    // data survives
    expect(fs.readFileSync(path.join(appDir, "data", "keep.txt"), "utf8")).toBe("user data");
    expect(fs.existsSync(path.join(appDir, "data", "chats", "live.jsonl"))).toBe(true);
    // the user-imported plugin rides across the swap
    const carried = JSON.parse(fs.readFileSync(path.join(appDir, "plugins", pluginId, "manifest.json"), "utf8")) as { origin?: string };
    expect(carried.origin).toBe("imported");
    // taking the update replaces the local edit (it stays in git history)
    expect(fs.readFileSync(path.join(appDir, "plugins", "greeter", "plugin.js"), "utf8")).not.toContain("local edit");
    // up to date, and still diverged by the plugin the user added
    const after = await call(`/v1/apps/${appId}/updates`);
    const av = (await after.json()) as { upToDate: boolean; modified: boolean | null };
    expect(av.upToDate).toBe(true);
    expect(av.modified).toBe(true);

    // a dependency-changing update installs over the packages the app has
    {
      const work = path.join(repoDir, "work");
      const m2 = JSON.parse(fs.readFileSync(path.join(work, "manifest.json"), "utf8")) as { version: string };
      m2.version = "2.1.0";
      fs.writeFileSync(path.join(work, "manifest.json"), JSON.stringify(m2));
      fs.writeFileSync(path.join(work, "vite.config.ts"), "export default {}\n");
      fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "depapp", version: "2.1.0", dependencies: { leftpad: "1.0.0" } }, null, 2));
      await git(["add", "-A"], work);
      await git(["commit", "-m", "v2.1 new dep"], work);
      fs.rmSync(path.join(repoDir, "repo.git"), { recursive: true, force: true });
      await git(["clone", "--bare", work, path.join(repoDir, "repo.git")]);
      await git(["update-server-info"], path.join(repoDir, "repo.git"));
      // an installed package: an update whose install fails must not leave the app with none
      const installed = path.join(appDir, "node_modules", "installed-pkg");
      fs.mkdirSync(installed, { recursive: true });
      fs.writeFileSync(path.join(installed, "index.js"), "old");
      // first pass WITHOUT confirmation: reports the dependency diff, swaps nothing
      const preview = await call(`/v1/apps/${appId}/update`, { method: "POST" });
      expect(preview.status).toBe(200);
      const pv2 = (await preview.json()) as { needsDepConfirm?: boolean; deps?: { added: { name: string; spec: string }[]; changed: unknown[]; removed: string[]; nonRegistry: string[] } };
      expect(pv2.needsDepConfirm).toBe(true);
      expect(pv2.deps?.added).toEqual([{ name: "leftpad", spec: "1.0.0" }]);
      expect(pv2.deps?.removed).toEqual([]);
      const manifestStill = JSON.parse(fs.readFileSync(path.join(appDir, "manifest.json"), "utf8")) as { version: string };
      expect(manifestStill.version).toBe("2.0.0"); // untouched until confirmed
      expect(fs.existsSync(installed)).toBe(true);
      // confirmed pass: applies the update
      const upd2 = await call(`/v1/apps/${appId}/update`, { method: "POST", body: JSON.stringify({ confirmDeps: true }) });
      expect(upd2.status).toBe(200);
      expect((JSON.parse(fs.readFileSync(path.join(appDir, "manifest.json"), "utf8")) as { version: string }).version).toBe("2.1.0");
      expect(fs.readFileSync(path.join(appDir, "data", "keep.txt"), "utf8")).toBe("user data");
    }

    // importing the same repository again is refused: new versions come
    // through the update, which merges edits and upgrades data
    fs.writeFileSync(path.join(appDir, "data", "keep2.txt"), "more user data");
    const before = fs.readFileSync(path.join(appDir, "manifest.json"), "utf8");
    const reimp = await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl: repoUrl, confirm: true }) });
    expect(reimp.status).toBe(409);
    expect(((await reimp.json()) as { installed?: string }).installed).toBe(appId);
    expect(fs.readFileSync(path.join(appDir, "manifest.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(appDir, "data", "keep2.txt"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, "plugins", pluginId))).toBe(true);
  }, 90_000);

  it("rejects repos that are not plugins", async () => {
    const appImp = await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl: repoUrl, confirm: true }) });
    const appId = ((await appImp.json()) as { id: string }).id;
    // the app repo has manifest.json at root but no plugin.js
    const r = await call(`/v1/apps/${appId}/plugins/import`, { method: "POST", body: JSON.stringify({ gitUrl: repoUrl }) });
    expect(r.status).toBe(422);
    // and an unknown app 404s before any cloning
    const noApp = await call("/v1/apps/nope/plugins/import", { method: "POST", body: JSON.stringify({ gitUrl: repoUrl }) });
    expect(noApp.status).toBe(404);
  }, 60_000);

  it("disabling a plugin stops it executing: route 404s, listings flag it, re-enable restores, delete cleans up", async () => {
    const appImp = await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl: repoUrl, confirm: true }) });
    const appId = ((await appImp.json()) as { id: string }).id;
    await call(`/v1/apps/${appId}/activate`, { method: "POST" });

    // a plugin whose handleRoute is the app's only real dispatcher
    const plug = path.join(repoDir, "router");
    fs.mkdirSync(plug, { recursive: true });
    fs.writeFileSync(path.join(plug, "manifest.json"), JSON.stringify({ name: "Router Plugin", version: "1.0.0", permissions: ["routes"] }));
    fs.writeFileSync(path.join(plug, "plugin.js"), "export function handleRoute() { return { status: 200, json: { pong: true } }; }");
    await git(["init"], plug);
    await git(["add", "-A"], plug);
    await git(["commit", "-m", "router"], plug);
    const bare = path.join(repoDir, "router.git");
    await git(["clone", "--bare", plug, bare]);
    await git(["update-server-info"], bare);
    const addr = server.address() as { port: number };
    const plugUrl = `http://127.0.0.1:${addr.port}/router.git`;

    const imp = await call(`/v1/apps/${appId}/plugins/import`, { method: "POST", body: JSON.stringify({ gitUrl: plugUrl, confirm: true }) });
    expect(imp.status).toBe(200);
    const pid = ((await imp.json()) as { id: string }).id;

    const hit = await call(`/v1/apps/${appId}/ping`);
    expect(hit.status).toBe(200);
    expect(((await hit.json()) as { pong?: boolean }).pong).toBe(true);

    // off: no route answers, both listings say disabled
    const off = await call(`/v1/apps/${appId}/plugins/${pid}/disable`, { method: "POST" });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { disabled?: boolean }).disabled).toBe(true);
    const miss = await call(`/v1/apps/${appId}/ping`);
    expect(miss.status).toBe(404);
    const list = await call(`/v1/apps/${appId}/plugins`);
    const row = ((await list.json()) as { plugins: { id: string; disabled?: boolean }[] }).plugins.find((x) => x.id === pid);
    expect(row?.disabled).toBe(true);
    const reg = await call("/v1/plugins");
    const regRow = ((await reg.json()) as { plugins: { id: string; disabled?: boolean }[] }).plugins.find((x) => x.id === `${appId}__${pid}`);
    expect(regRow?.disabled).toBe(true);

    // back on: the route answers again
    const on = await call(`/v1/apps/${appId}/plugins/${pid}/enable`, { method: "POST" });
    expect(on.status).toBe(200);
    const hit2 = await call(`/v1/apps/${appId}/ping`);
    expect(hit2.status).toBe(200);

    // deleting a disabled plugin drops the flag from settings.json
    await call(`/v1/apps/${appId}/plugins/${pid}/disable`, { method: "POST" });
    const del = await call(`/v1/apps/${appId}/plugins/${pid}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const root = userPaths(dataDir, "root").root;
    const settings = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")) as { disabledPlugins?: string[] };
    expect(settings.disabledPlugins ?? []).not.toContain(`${appId}__${pid}`);
  }, 90_000);
});

describe("app updates stay whole", () => {
  /** Commit the work tree as the repository's new head. */
  const publish = async (message: string) => {
    const work = path.join(repoDir, "work");
    await git(["add", "-A"], work);
    await git(["commit", "-m", message], work);
    fs.rmSync(path.join(repoDir, "repo.git"), { recursive: true, force: true });
    await git(["clone", "--bare", work, path.join(repoDir, "repo.git")]);
    await git(["update-server-info"], path.join(repoDir, "repo.git"));
  };
  const setVersion = (version: string) => {
    const file = path.join(repoDir, "work", "manifest.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), version }));
  };
  const install = async () => {
    const res = await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl: repoUrl, confirm: true }) });
    const id = ((await res.json()) as { id: string }).id;
    return { id, dir: path.join(userPaths(dataDir, "root").root, "apps", id) };
  };

  it("puts every file back when writing the update fails partway", async () => {
    fs.writeFileSync(path.join(repoDir, "work", "a.txt"), "one\n");
    await publish("a");
    const { id, dir } = await install();
    fs.writeFileSync(path.join(repoDir, "work", "a.txt"), "two\n");
    fs.mkdirSync(path.join(repoDir, "work", "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "work", "src", "new.ts"), "export {}\n");
    setVersion("2.0.0");
    await publish("v2");
    // something local sits where the update writes a file
    fs.mkdirSync(path.join(dir, "src", "new.ts"), { recursive: true });

    const res = await call(`/v1/apps/${id}/update`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/nothing changed/);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect((JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as { version: string }).version).toBe("1.0.0");
  }, 60_000);

  it("applies one update of an app at a time", async () => {
    const { id } = await install();
    setVersion("2.0.0");
    await publish("v2");
    const replies = await Promise.all([1, 2].map(() => call(`/v1/apps/${id}/update`, { method: "POST" })));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
  }, 60_000);

  it("reports a data upgrade that fails, and finishes it before the app's next request", async () => {
    const { id, dir } = await install();
    const plugin = path.join(repoDir, "work", "plugins", "migrator");
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, "manifest.json"), JSON.stringify({ name: "Migrator", version: "1.0.0", permissions: ["routes", "fs"] }));
    fs.writeFileSync(path.join(plugin, "plugin.js"), `
      export function onAppUpdate(ctx, host) {
        host.fs.read("ready.txt");
        host.fs.write("upgraded.txt", ctx.from + ">" + ctx.to);
        return {};
      }
      export function handleRoute(req) { return req.path === "/ping" ? { status: 200, json: { ok: true } } : null; }
    `);
    setVersion("2.0.0");
    await publish("v2 with a data upgrade");

    // a community update asking for new permissions is reviewed first
    const review = (await (await call(`/v1/apps/${id}/update`, { method: "POST" })).json()) as { needsDepConfirm?: boolean; head?: string };
    expect(review.needsDepConfirm).toBe(true);
    const applied = (await (await call(`/v1/apps/${id}/update`, { method: "POST", body: JSON.stringify({ confirmDeps: true, head: review.head }) })).json()) as {
      status: string;
      upgradeFailed?: { plugin: string; error: string }[];
    };
    expect(applied.status).toBe("applied");
    expect(applied.upgradeFailed?.map((f) => f.plugin)).toEqual(["Migrator"]);
    expect(fs.existsSync(path.join(dir, "data", "upgraded.txt"))).toBe(false);

    fs.writeFileSync(path.join(dir, "data", "ready.txt"), "yes");
    const ping = await call(`/v1/apps/${id}/ping`);
    expect(ping.status).toBe(200);
    expect(fs.readFileSync(path.join(dir, "data", "upgraded.txt"), "utf8")).toBe("1.0.0>2.0.0");
    expect(fs.existsSync(path.join(userPaths(dataDir, "root").appUpstream, `${id}.upgrade.json`))).toBe(false);
  }, 60_000);
});

describe("remote manifest", () => {
  it("reads a GitHub repository's manifest at a commit, and nothing elsewhere", async () => {
    const { remoteManifest } = await import("../src/apps/git.js");
    const commit = "a".repeat(40);
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      return Response.json({ version: "2.0.0", engine: ">=9.0.0", name: "X" });
    }) as unknown as typeof fetch;
    expect(await remoteManifest("https://github.com/owner/app.git", commit, fetcher)).toEqual({ version: "2.0.0", engine: ">=9.0.0" });
    expect(asked).toEqual([`https://raw.githubusercontent.com/owner/app/${commit}/manifest.json`]);
    expect(await remoteManifest("https://gitlab.com/owner/app", commit, fetcher)).toBeNull();
    expect(await remoteManifest("https://github.com/owner/app", "main", fetcher)).toBeNull();
  });
});

describe("app divergence (modified since install)", () => {
  it("stamps a content hash at import; code edits mark modified, data edits never do", async () => {
    const confirm = await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl: repoUrl, confirm: true }) });
    expect(confirm.status).toBe(200);
    const cr = (await confirm.json()) as { ok: boolean; id: string };
    const root = userPaths(dataDir, "root").root;

    const fresh = await call(`/v1/apps/${cr.id}/updates`);
    const fv = (await fresh.json()) as { upToDate: boolean; modified: boolean | null };
    expect(fv.upToDate).toBe(true);
    expect(fv.modified).toBe(false);

    // touching app CODE diverges
    const src = path.join(root, "apps", cr.id, "plugins", "greeter", "plugin.js");
    fs.appendFileSync(src, "\n// local edit\n");
    const afterCode = await call(`/v1/apps/${cr.id}/updates`);
    const av = (await afterCode.json()) as { modified: boolean | null };
    expect(av.modified).toBe(true);

    // user DATA never counts as a modification
    fs.writeFileSync(path.join(root, "apps", cr.id, "data", "new-file.txt"), "more user data");
    fs.writeFileSync(src, fs.readFileSync(src, "utf8").replace("\n// local edit\n", ""));
    const afterData = await call(`/v1/apps/${cr.id}/updates`);
    const dv = (await afterData.json()) as { modified: boolean | null };
    expect(dv.modified).toBe(false);
  }, 60_000);
});

describe("bundled plugins of git-imported apps (grant system)", () => {
  it("app import stamps bundled plugin manifests as imported and pre-grants their capabilities", async () => {
    const confirm = await call("/v1/apps/import", { method: "POST", body: JSON.stringify({ gitUrl: repoUrl, confirm: true }) });
    expect(confirm.status).toBe(200);
    const cr = (await confirm.json()) as { id: string };
    const root = userPaths(dataDir, "root").root;

    // the repo shipped plugins/greeter with NO origin — after import it must
    // be stamped so its capabilities go through the approval system
    const pm = JSON.parse(fs.readFileSync(path.join(root, "apps", cr.id, "plugins", "greeter", "manifest.json"), "utf8")) as { origin?: string; source?: { git?: string } };
    expect(pm.origin).toBe("imported");
    expect(pm.source?.git).toBe(repoUrl);

    // grants recorded under the namespaced id (empty perms → empty grant list)
    const settings = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")) as { pluginGrants?: Record<string, string[]> };
    expect(Array.isArray(settings.pluginGrants?.[`${cr.id}__greeter`])).toBe(true);

    // and the stamp happened BEFORE the content hash: the app is not "modified"
    const upd = await call(`/v1/apps/${cr.id}/updates`);
    const uv = (await upd.json()) as { modified: boolean | null };
    expect(uv.modified).toBe(false);
  }, 60_000);
});

describe("engine identity", () => {
  it("launch payload carries the engine version and repository", async () => {
    const r = await call("/v1/launch");
    const v = (await r.json()) as { engine?: { version?: string; repository?: string | null } };
    expect(typeof v.engine?.version).toBe("string");
    expect(v.engine!.version).not.toBe("");
  });
});

describe("the command line an outside agent uses", () => {
  const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it("offers workspace, api and install-cli, and --help names them", () => {
    const help = /const HELP = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
    expect(help).not.toBe("");
    for (const verb of ["workspace", "api", "install-cli", "uninstall-cli"]) {
      expect(src, `no "${verb}" case`).toContain(`case "${verb}":`);
      expect(help, `"${verb}" is not in --help`).toContain(verb);
    }
  });

  it("never puts a PATH through setx, which truncates it", () => {
    // the comment explaining why may name it; a call would quote it
    expect(src).not.toContain('"setx"');
    expect(src).not.toContain("'setx'");
  });

  it("says how to run itself per install, not just 'chrysalis'", () => {
    // a downloaded build is not on PATH: the examples have to be pasteable
    expect(src).toContain('if (INSTALL_KIND === "npm") return "chrysalis"');
    expect(src).toContain("process.execPath");
  });
});
