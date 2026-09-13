import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
import { createAppSkeleton, listApps, validateAppManifest, appDataDir } from "../src/apps/manager.js";
import { discoverAppPlugins, readPluginExport, runPluginTool, runPluginRoute } from "../src/plugins/runtime.js";
import { PluginStoreService } from "../src/plugins/store.js";
import { invalidatePluginCache } from "../src/plugins/runtime.js";

let dataDir: string;
let token: string;
let app: Hono<AppEnv>;
let dbgUsers: UserService | null = null;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-int-"));
  const users = new UserService(dataDir);
  users.create("admin", "admin", { password: "admin-pass-1" });
  token = users.create("alice", "user", { password: "test-pass-1" }).token;
  dbgUsers = users;
  bootstrapUserDir(dataDir, "alice");
  const bus = new EventBus();
  app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus });
});
afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
  invalidatePluginCache();
});

const h = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

function writeAppPlugin(appsDir: string, appId: string, pluginId: string, manifest: Record<string, unknown>, code: string): void {
  const p = path.join(appsDir, appId, "plugins", pluginId);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(p, "plugin.js"), code);
}

describe("app manager", () => {
  it("skeleton create → list → validate", () => {
    const appsDir = path.join(dataDir, "users", "alice", "apps");
    const { id } = createAppSkeleton(appsDir, { id: "demo", name: "Demo App", description: "test" });
    expect(id).toBe("demo");
    const apps = listApps(appsDir);
    expect(apps.map((a) => a.id)).toEqual(["demo"]);
    // the UI kind is the DEFAULT app kind; the runtime-ESM
    // look tier is opt-in via kind "app"/"skin"
    expect(apps[0]!.manifest.kind).toBe("web");
    expect(fs.existsSync(path.join(appsDir, "demo", "index.html"))).toBe(true);
    expect(apps[0]!.hasData).toBe(true);
    // explicit legacy kind still works
    createAppSkeleton(appsDir, { id: "legacy", name: "Legacy", kind: "app" });
    expect(fs.existsSync(path.join(appsDir, "legacy", "index.html"))).toBe(false);
    expect(validateAppManifest({ name: "x", version: "1", kind: "skin" })).toBeTruthy();
    expect(validateAppManifest({ name: "", version: "1", kind: "skin" })).toBeNull();
    expect(validateAppManifest({ name: "x", version: "1", kind: "wat" })).toBeNull();
  });
});

describe("app plugin primitives (module level)", () => {
  it("app-bundled plugins get namespaced ids + fs scope = app data dir", () => {
    const p = userPaths(dataDir, "alice");
    createAppSkeleton(p.apps, { id: "vn", name: "VN" });
    writeAppPlugin(p.apps, "vn", "engine", { name: "E", version: "1", permissions: ["hooks", "fs", "tools", "routes"] }, "export const TOOLS=[];");
    const plugins = discoverAppPlugins(p.apps, "vn");
    expect(plugins[0]!.id).toBe("vn__engine");
    expect(plugins[0]!.fsRoot).toBe(appDataDir(p.apps, "vn"));
  });

  it("readPluginExport reads TOOLS; runPluginTool executes handleTool with fs + store", async () => {
    const p = userPaths(dataDir, "alice");
    createAppSkeleton(p.apps, { id: "vn", name: "VN" });
    writeAppPlugin(
      p.apps, "vn", "engine",
      { name: "E", version: "1", permissions: ["hooks", "fs", "tools", "store"], origin: "local" },
      `export const TOOLS = [
        { name: "make_choice", description: "Pick a story branch", parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } },
      ];
export function handleTool(name, args, host) {
  if (name !== "make_choice") return { text: "unknown", isError: true };
  const n = (host.store.get("choices") ?? 0) + 1;
  host.store.put("choices", n);
  host.fs.write("choices/" + n + ".json", JSON.stringify({ label: args.label, at: 123 }));
  return { text: "choice #" + n + " recorded: " + args.label };
}`,
    );
    const plugin = discoverAppPlugins(p.apps, "vn")[0]!;
    const tools = await readPluginExport(plugin, "TOOLS");
    expect((tools as { name: string }[])[0]!.name).toBe("make_choice");

    const deps = { store: new PluginStoreService(path.join(dataDir, "users", "alice", "store")), models: {} as never, grantsFor: () => [] };
    const r1 = await runPluginTool(plugin, "make_choice", { label: "follow the light" }, deps);
    expect(r1).toEqual({ ok: true, text: "choice #1 recorded: follow the light" });
    const r2 = await runPluginTool(plugin, "make_choice", { label: "stay in the dark" }, deps);
    expect(r2!.text).toContain("choice #2");
    // file landed in the app data dir (git-tracked userland!)
    expect(fs.readFileSync(path.join(appDataDir(p.apps, "vn"), "choices", "2.json"), "utf8")).toContain("stay in the dark");
    // store persisted host-side
    expect(deps.store.namespace("vn__engine").get("choices")).toBe(2);
  }, 30_000);

  it("fs scope blocks escapes from the app data dir", async () => {
    const p = userPaths(dataDir, "alice");
    createAppSkeleton(p.apps, { id: "evil", name: "Evil" });
    writeAppPlugin(
      p.apps, "evil", "sneak",
      { name: "S", version: "1", permissions: ["fs", "routes"], origin: "local" },
      `export function handleRoute(req, host) {
  try { host.fs.write("../../../../../tmp/pwned.txt", "x"); return { status: 200, json: { pwned: true } }; }
  catch (e) { return { status: 200, json: { blocked: String(e && e.message).slice(0, 40) } }; }
}`,
    );
    const plugin = discoverAppPlugins(p.apps, "evil")[0]!;
    const deps = { store: new PluginStoreService(path.join(p.store)), models: {} as never, grantsFor: () => [] };
    const res = await runPluginRoute(plugin, { method: "GET", path: "/pwn", query: {}, body: undefined }, deps);
    expect(res!.json).toMatchObject({ blocked: expect.stringContaining("escapes") });
    expect(fs.existsSync("/tmp/pwned.txt")).toBe(false);
  }, 30_000);

  it("routes permission required: no permission → no dispatch", async () => {
    const p = userPaths(dataDir, "alice");
    createAppSkeleton(p.apps, { id: "noroute", name: "NR" });
    writeAppPlugin(
      p.apps, "noroute", "web",
      { name: "W", version: "1", permissions: ["hooks"] }, // no routes!
      `export function handleRoute(req) { return { status: 200, json: { leaked: true } }; }`,
    );
    const plugin = discoverAppPlugins(p.apps, "noroute")[0]!;
    const deps = { store: new PluginStoreService(path.join(p.store)), models: {} as never, grantsFor: () => [] };
    const res = await runPluginRoute(plugin, { method: "GET", path: "/", query: {}, body: undefined }, deps);
    expect(res).toBeNull();
  }, 30_000);
});

describe("app HTTP surface (integration)", () => {
  it("create → routes dispatch for any installed app → activate sets the default", async () => {
    // create app via API
    let res = await app.request("/v1/apps", { method: "POST", headers: h(), body: JSON.stringify({ id: "demo", name: "Demo" }) });
    expect(res.status).toBe(200);

    // write a route-serving plugin into it (as the agent would)
    const p = userPaths(dataDir, "alice");
    writeAppPlugin(
      p.apps, "demo", "api",
      { name: "API", version: "1", permissions: ["routes", "store"], origin: "local" },
      `export function handleRoute(req, host) {
  if (req.method === "GET" && req.path === "/hello") return { status: 200, json: { hello: "world" } };
  if (req.method === "POST" && req.path === "/echo") return { status: 201, json: { you: req.body } };
  if (req.method === "POST" && req.path === "/count") { host.store.put("n", (host.store.get("n") ?? 0) + 1); return { status: 200, json: { count: host.store.get("n") } }; }
  return null;
}`,
    );
    invalidatePluginCache();

    // routes dispatch for any INSTALLED app (active only gates agent tools,
    // hooks, and the launch default) — side-by-side app tabs all work
    res = await app.request("/v1/apps/demo/hello", { headers: h() });
    expect(await res.json()).toEqual({ hello: "world" });

    // activate
    res = await app.request("/v1/apps/demo/activate", { method: "POST", headers: h() });
    expect(res.status).toBe(200);
    res = await app.request("/v1/apps/active", { headers: h() });
    expect(await res.json()).toMatchObject({ app: "demo" });

    // routes live
    res = await app.request("/v1/apps/demo/hello", { headers: h() });
    expect(await res.json()).toEqual({ hello: "world" });
    res = await app.request("/v1/apps/demo/count", { method: "POST", headers: h(), body: "{}" });
    expect(await res.json()).toEqual({ count: 1 });
    res = await app.request("/v1/apps/demo/count", { method: "POST", headers: h(), body: "{}" });
    expect(await res.json()).toEqual({ count: 2 }); // store persists across requests

    // unmatched path inside namespace → 404 no route
    res = await app.request("/v1/apps/demo/nope", { headers: h() });
    expect(res.status).toBe(404);
  }, 60_000);

  it("unknown app 404s; create validates id", async () => {
    let res = await app.request("/v1/apps/ghost/thing", { headers: h() });
    expect(res.status).toBe(404);
    res = await app.request("/v1/apps", { method: "POST", headers: h(), body: JSON.stringify({ id: "../evil", name: "x" }) });
    expect(res.status).toBe(400);
  });
});

describe("home flow contract (SPEC-v2 §12.5)", () => {
  // users created through the REAL journey (admin route) get rp seeded+active
  let flowToken: string;
  beforeEach(async () => {
    const adminToken = dbgUsers!.create("boss", "admin", { password: "test-pass-1" }).token;
    const res = await app.request("/v1/admin/users", {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "flow", password: "test-pass-1" }),
    });
    flowToken = ((await res.json()) as { token: string }).token;
  });
  const fh = () => ({ authorization: `Bearer ${flowToken}`, "content-type": "application/json" });

  it("first boot: the single shipped app → launch defaults straight into it", async () => {
    const res = await app.request("/v1/launch", { headers: fh() });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { apps: { id: string }[]; agent: boolean; default: string | null };
    expect(j.apps.map((a) => a.id)).toEqual(["roleplay"]);
    expect(j.agent).toBe(true);
    expect(j.default).toBe("roleplay"); // only one app → auto-enter, no picker
  });

  it("more apps → default becomes null (picker), launchDefault pins a choice", async () => {
    await app.request("/v1/apps", { method: "POST", headers: fh(), body: JSON.stringify({ id: "vn", name: "My VN" }) });
    let j = (await (await app.request("/v1/launch", { headers: fh() })).json()) as { default: string | null };
    expect(j.default).toBeNull(); // picker time
    const pin = await app.request("/v1/settings", { method: "PUT", headers: fh(), body: JSON.stringify({ launchDefault: "vn" }) });
    expect(pin.status).toBe(200);
    j = (await (await app.request("/v1/launch", { headers: fh() })).json()) as { default: string | null };
    expect(j.default).toBe("vn");
    const bad = await app.request("/v1/settings", { method: "PUT", headers: fh(), body: JSON.stringify({ launchDefault: "nope" }) });
    expect(bad.status).toBe(404);
    const got = (await (await app.request("/v1/settings", { headers: fh() })).json()) as { launchDefault: string | null };
    expect(got.launchDefault).toBe("vn");
  });

  it("provider credentials: write-only keys, never echoed, file mode 0600", async () => {
    const p = userPaths(dataDir, "flow");
    const list1 = (await (await app.request("/v1/settings/providers", { headers: fh() })).json()) as { providers: { id: string; hasKey: boolean }[] };
    expect(list1.providers.length).toBeGreaterThan(5);
    expect(list1.providers.some((x) => x.id === "openai")).toBe(true);
    expect(JSON.stringify(list1)).not.toMatch(/sk-/);
    const deepseek = list1.providers.find((x) => x.id === "deepseek");
    expect(deepseek!.hasKey).toBe(false);
    // add a key
    const put = await app.request("/v1/settings/providers/deepseek/key", { method: "PUT", headers: fh(), body: JSON.stringify({ key: "sk-test-123" }) });
    expect(put.status).toBe(200);
    expect(JSON.stringify(await put.json())).not.toContain("sk-test-123");
    const onDisk = JSON.parse(fs.readFileSync(p.auth, "utf8")) as Record<string, { type: string; key: string }>;
    expect(onDisk.deepseek).toEqual({ type: "api_key", key: "sk-test-123" });
    expect(fs.statSync(p.auth).mode & 0o777).toBe(0o600);
    const list2 = (await (await app.request("/v1/settings/providers", { headers: fh() })).json()) as { providers: { id: string; hasKey: boolean }[] };
    expect(list2.providers.find((x) => x.id === "deepseek")!.hasKey).toBe(true);
    // bad requests
    expect((await app.request("/v1/settings/providers/unknown-x/key", { method: "PUT", headers: fh(), body: JSON.stringify({ key: "x" }) })).status).toBe(404);
    expect((await app.request("/v1/settings/providers/deepseek/key", { method: "PUT", headers: fh(), body: JSON.stringify({ key: "" }) })).status).toBe(400);
    // delete
    expect((await app.request("/v1/settings/providers/deepseek/key", { method: "DELETE", headers: fh() })).status).toBe(200);
    expect((await app.request("/v1/settings/providers/deepseek/key", { method: "DELETE", headers: fh() })).status).toBe(404);
    const list3 = (await (await app.request("/v1/settings/providers", { headers: fh() })).json()) as { providers: { id: string; hasKey: boolean }[] };
    expect(list3.providers.find((x) => x.id === "deepseek")!.hasKey).toBe(false);
  });

  it("providers whose endpoint lives on each model are still pickable", async () => {
    // opencode/opencode-go carry no top-level baseUrl; their models do. They
    // must surface as normal API-key providers, not "needs-setup".
    const j = (await (await app.request("/v1/settings/providers", { headers: fh() })).json()) as {
      providers: { id: string; kind: string; baseUrl: string | null; apiKeyAuth: boolean }[];
    };
    for (const id of ["opencode", "opencode-go"]) {
      const p = j.providers.find((x) => x.id === id);
      expect(p, id).toBeDefined();
      expect(p!.kind).toBe("builtin");
      expect(p!.baseUrl).toBeNull();
      expect(p!.apiKeyAuth).toBe(true);
    }
    // radius still needs its gateway sign-in, not a bare key
    expect(j.providers.find((x) => x.id === "radius")!.kind).toBe("needs-setup");
  });

  it("example bot + agent docs ship with the seeded rp app", async () => {
    const p = userPaths(dataDir, "flow");
    expect(fs.existsSync(path.join(p.root, "apps/roleplay/data/characters/example-bot/card.json"))).toBe(true);
    expect(fs.existsSync(path.join(p.root, "apps/roleplay/AGENTS.md"))).toBe(true);
    // the bot is reachable through the app's own route (new studio engine list)
    const res = await app.request("/v1/apps/roleplay/characters", { headers: fh() });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { characters: { id: string }[] };
    expect(j.characters.map((x) => x.id)).toContain("example-bot");
  });
});

describe("kernel chrome client + agent session history", () => {
  it("compresses text responses and leaves already-compressed bytes alone", async () => {
    // an uncompressed engine ships its whole boot payload and every bundle in
    // full to each phone on the LAN; these are the two halves that matter
    const json = await app.request("/v1/models", { headers: { ...h(), "accept-encoding": "gzip" } });
    expect(json.status).toBe(200);
    expect(json.headers.get("content-encoding")).toBe("gzip");
    expect(json.headers.get("vary") ?? "").toMatch(/accept-encoding/i);

    // a client that cannot decode still gets a readable body
    const plain = await app.request("/v1/models", { headers: { ...h(), "accept-encoding": "identity" } });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(Array.isArray(((await plain.json()) as { models?: unknown[] }).models)).toBe(true);
  });

  it("never serves anything outside the built client bundle", async () => {
    // the traversal guard must be checked whether or not the client is built —
    // a dist-gated assertion silently passes on a machine that never ran the
    // client build, which is exactly where a regression would land unseen
    expect([400, 404]).toContain((await app.request("/client/../src/server/app.ts", { headers: h() })).status);
    expect((await app.request("/client/nope.js", { headers: h() })).status).toBe(404);
  });

  it("serves the client shell with CSP", async () => {
    const dist = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "client", "dist", "index.html");
    if (!fs.existsSync(dist)) return; // requires npm run build:client
    const res = await app.request("/", { headers: h() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    const html = await res.text();
    expect(html).toMatch(/chrysalis/i);
    const asset = /href="(\/client\/assets\/[^"]+\.css)"/.exec(html)?.[1];
    if (asset) {
      const css = await app.request(asset, { headers: h() });
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");
    }
  });

  it("agent session transcript endpoint returns runs (client replay)", async () => {
    const p = userPaths(dataDir, "alice");
    const sessDir = path.join(p.root, "agent", "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, "s1.jsonl"), JSON.stringify({ type: "run", at: 1, user: "hi", assistant: "hello", tools: [{ name: "read_file", ok: true }] }) + "\n");
    const res = await app.request("/v1/agent/sessions/s1", { headers: h() });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { runs: { user: string; assistant: string; tools: { name: string }[] }[] };
    expect(j.runs[0]!.user).toBe("hi");
    expect(j.runs[0]!.tools[0]!.name).toBe("read_file");
    expect((await app.request("/v1/agent/sessions/..%2Fpwn", { headers: h() })).status).toBe(400);
  });
});
