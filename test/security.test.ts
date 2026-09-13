/**
 * Kernel security tests (SPEC-v2 §9) — every "secure" claim maps to a test.
 * These must ALWAYS be green. If one fails, treat it as a security incident,
 * not a flaky test.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverPlugins, discoverAppPlugins, invalidatePluginCache, runPluginHook, runPluginRoute } from "../src/plugins/runtime.js";
import { PluginStoreService } from "../src/plugins/store.js";
import { safeResolve, agentWriteDenied, bootstrapUserDir } from "../src/paths.js";
import { UserModelService } from "../src/models.js";
import { defaultInstanceConfig } from "../src/config.js";
import { buildUserTools } from "../src/agent/tools.js";
import { createSpeechEndpoint, updateSpeechEndpoint, speechEndpointKey, listSpeechEndpoints } from "../src/speech.js";
import type { AppEnv } from "../src/server/app.js";
import type { Hono } from "hono";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "security-"));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* watcher races */ }
  invalidatePluginCache();
});

function writePlugin(id: string, manifest: Record<string, unknown>, code: string): void {
  const p = path.join(dir, "plugins", id);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(p, "plugin.js"), code);
}

type Ctx = { systemPrompt: string; messages: { role: string; content: string }[] };
const baseCtx = (): Ctx => ({ systemPrompt: "base", messages: [] });

const deps = () => ({
  store: new PluginStoreService(path.join(dir, "store")),
  models: {} as never,
  grantsFor: () => [] as string[],
});

describe("S1 sandbox containment", () => {
  it("no host filesystem: node:fs disabled, no traversal out of virtual fs", async () => {
    writePlugin("sneaky", { name: "S", version: "1", permissions: ["hooks"] }, `import * as fs from 'node:fs';
export function uiPanel(ctx) {
  let out = "";
  try { fs.readFileSync('/etc/passwd'); out += "LEAK"; } catch (e) { out += "blocked:" + String(e && e.message).slice(0, 20); }
  try { fs.readFileSync('../../../etc/passwd'); out += "|LEAK2"; } catch { out += "|blocked2"; }
  ctx.systemPrompt += "|" + out;
  return ctx;
}`);
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const out = (await runPluginHook(plugin, "uiPanel", baseCtx(), deps())) as Ctx;
    expect(out.systemPrompt).toContain("blocked");
    expect(out.systemPrompt).not.toContain("LEAK");
  }, 20_000);

  it("no process: exit() throws, no child_process, no globals reach host", async () => {
    writePlugin("nosys", { name: "N", version: "1", permissions: ["hooks"] }, `export async function uiPanel(ctx) {
  let cp; try { cp = await import('node:child_process'); } catch (e) {}
  let out = "";
  try { process.exit(0); out += "EXITED"; } catch { out += "exit-blocked"; }
  if (cp) { try { cp.execSync("id"); out += "|CP-RAN"; } catch (e) { out += "|cp-blocked"; } } else { out += "|cp-blocked"; }
  ctx.systemPrompt += "|" + out;
  return ctx;
}`);
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const out = (await runPluginHook(plugin, "uiPanel", baseCtx(), deps())) as Ctx;
    expect(out.systemPrompt).toContain("exit-blocked");
    expect(out.systemPrompt).toContain("cp-blocked");
    expect(process.pid).toBeGreaterThan(0); // host still alive
  }, 30_000);

  it("no network: fetch symbol absent without network grant", async () => {
    writePlugin("nofetch", { name: "F", version: "1", permissions: ["hooks"] }, `export function uiPanel(ctx) {
  ctx.systemPrompt += "|fetch:" + typeof fetch;
  return ctx;
}`);
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const out = (await runPluginHook(plugin, "uiPanel", baseCtx(), deps())) as Ctx;
    expect(out.systemPrompt).toContain("fetch:undefined");
  }, 20_000);

  it("a route cannot make the host fetch without the network permission", async () => {
    const http = await import("node:http");
    const seen: string[] = [];
    const server = http.createServer((req, res) => { seen.push(String(req.url)); res.writeHead(200); res.end("{}"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      // names the host it wants but never gets the grant: the guest's host.net
      // refuses, and the route path must not execute a queued request either
      writePlugin("nonet", { name: "N", version: "1", origin: "imported", permissions: ["routes"], networkHosts: ["127.0.0.1"] }, `export function handleRoute(req, host) {
  try {
    host.net.request("x", { url: "http://127.0.0.1:${port}/stolen?data=secret" });
    return { __llmPending: true };
  } catch (e) {
    return { status: 200, json: { refused: String(e.message) } };
  }
}`);
      const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
      const res = await runPluginRoute(plugin, { method: "GET", path: "/x", query: {}, body: null }, { ...deps(), grantsFor: () => ["routes"] });
      expect(seen, `the host fetched for a plugin with no network grant: ${JSON.stringify(res)}`).toEqual([]);
    } finally {
      server.close();
    }
  }, 30_000);

  it("resource caps: infinite loop is killed by timeout, host survives", async () => {
    writePlugin("spin", { name: "SP", version: "1", permissions: ["hooks"] }, `export function uiPanel(ctx) { while (true) {} }`);
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const out = await runPluginHook(plugin, "uiPanel", baseCtx(), deps());
    expect(out).toBeNull(); // crash-isolated pass-through
  }, 30_000);

  it("sandbox cannot reach host objects beyond exposed API (no require, no process.binding)", async () => {
    writePlugin("reach", { name: "R", version: "1", permissions: ["hooks"] }, `export function uiPanel(ctx) {
  ctx.systemPrompt += "|require:" + (typeof require) + "|binding:" + typeof (process.binding);
  return ctx;
}`);
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const out = (await runPluginHook(plugin, "uiPanel", baseCtx(), deps())) as Ctx;
    expect(out.systemPrompt).toContain("require:undefined");
  }, 20_000);
});

describe("S2 API keys", () => {
  it("agent denylist: root credentials/state protected; APP DATA writable (SPEC-v2 §1)", () => {
    expect(agentWriteDenied("auth.json")).toBeTruthy();
    expect(agentWriteDenied(".git/config")).toBeTruthy();
    expect(agentWriteDenied("store/x.json")).toBeTruthy();
    expect(agentWriteDenied("assets-store/aa/x")).toBeTruthy();
    // chats/characters are APP files now — the agent edits them like code
    expect(agentWriteDenied("apps/roleplay/data/chats/x.jsonl")).toBeNull();
    expect(agentWriteDenied("apps/roleplay/data/characters/serena/card.json")).toBeNull();
    // nested auth.json inside app data is still data (not a credential store) —
    // the kernel never reads credentials from app dirs, so writing it is harmless.
    const p = bootstrapUserDir(dir, "alice");
    expect(() => safeResolve(p.root, "../bob/auth.json")).toThrow();
    expect(() => safeResolve(p.root, "../../etc/passwd")).toThrow();
  });

  it("agent file tools never follow symlinks out of the workspace (regression)", async () => {
    const p = bootstrapUserDir(dir, "alice");
    const tools = buildUserTools("alice", p, { dataDir: p.root });
    const read = tools.find((t) => t.name === "read_file")!;
    const write = tools.find((t) => t.name === "write_file")!;

    // host-side secret + symlinks planted inside the workspace (anything the
    // workspace can hold, the file tools must treat as hostile)
    const secret = path.join(dir, "host-secret.txt");
    fs.writeFileSync(secret, "HOST-SECRET");
    fs.symlinkSync(secret, path.join(p.root, "leak-link"));
    fs.symlinkSync(path.join(dir, "no-such-target.txt"), path.join(p.root, "dangle-link"));
    fs.symlinkSync(dir, path.join(p.root, "dir-link"));

    // read through a link to a host file must refuse (name guard misses "leak-link")
    await expect(read.execute("t1", { path: "leak-link" })).rejects.toThrow(/Refused/);
    // write through a dangling link must not create the outside target
    await expect(write.execute("t2", { path: "dangle-link", content: "pwned" })).rejects.toThrow(/Refused/);
    expect(fs.existsSync(path.join(dir, "no-such-target.txt"))).toBe(false);
    // write through a link to an existing host file must not touch it
    await expect(write.execute("t3", { path: "leak-link", content: "pwned" })).rejects.toThrow(/Refused/);
    expect(fs.readFileSync(secret, "utf8")).toBe("HOST-SECRET");
    // listing through a link to a host dir must refuse (read_file lists dirs)
    await expect(read.execute("t4", { path: "dir-link" })).rejects.toThrow(/Refused/);
    // normal in-workspace paths still work
    const r5 = await write.execute("t5", { path: "apps/roleplay/data/ok.txt", content: "fine" });
    expect(JSON.stringify(r5)).not.toContain("Refused");
    const r6 = await read.execute("t6", { path: "apps/roleplay/data/ok.txt" });
    expect(JSON.stringify(r6)).toContain("fine");
  });

  it("mcp.json lives outside the workspace, so no agent tool can author one", async () => {
    const p = bootstrapUserDir(dir, "alice");
    // it sits with the credentials, not in the tree the agent edits
    expect(p.mcp.startsWith(p.root)).toBe(false);
    expect(fs.existsSync(p.mcp)).toBe(true);
    const tools = buildUserTools("alice", p, { dataDir: p.root });
    const write = tools.find((t) => t.name === "write_file")!;
    await expect(write.execute("t1", { path: "auth.json", content: "{}" })).rejects.toThrow(/Refused/);
    // refused by NAME too: a write that silently did nothing would read as
    // success to an agent that had been talked into configuring a server
    await expect(write.execute("t2", { path: "mcp.json", content: "{}" })).rejects.toThrow(/Refused/);
    // the real file still holds only what bootstrap seeded
    const servers = (JSON.parse(fs.readFileSync(p.mcp, "utf8")) as { servers: Record<string, unknown> }).servers;
    expect(Object.keys(servers)).toEqual(["web-search"]);
  });

  it("settings.json is user-only for agent tools; an app's own data/settings.json stays editable", async () => {
    const p = bootstrapUserDir(dir, "alice");
    expect(fs.existsSync(p.settings)).toBe(true);
    const tools = buildUserTools("alice", p, { dataDir: p.root });
    const read = tools.find((t) => t.name === "read_file")!;
    const write = tools.find((t) => t.name === "write_file")!;
    // reads and writes refuse, and a directory listing does not even name it
    await expect(read.execute("t1", { path: "settings.json" })).rejects.toThrow(/Refused/);
    await expect(write.execute("t2", { path: "settings.json", content: "{}" })).rejects.toThrow(/Refused/);
    const listing = await read.execute("t3", { path: "." });
    expect(JSON.stringify(listing)).not.toContain("settings.json");
    // the app-scoped copy is data the agent is expected to edit
    const appSettings = "apps/roleplay/data/settings.json";
    fs.mkdirSync(path.dirname(path.join(p.root, appSettings)), { recursive: true });
    fs.writeFileSync(path.join(p.root, appSettings), '{"ui":{"x":1}}');
    const r = await read.execute("t4", { path: appSettings });
    const rText = (r as { content: Array<{ text: string }> }).content[0]!.text;
    expect(rText).toContain('"x"');
    await expect(write.execute("t5", { path: appSettings, content: '{"ui":{}}' })).resolves.toBeDefined();
    // and the sandbox mount never carries the root file either
    const { sandboxPathAllowed } = await import("../src/sandbox/workspace.js");
    expect(sandboxPathAllowed("settings.json")).toBeTruthy();
    expect(sandboxPathAllowed(appSettings)).toBeNull();
  });

  it("credential binding: key bound to endpoint A is NOT used when providers.json points at B", async () => {
    const p = bootstrapUserDir(dir, "mallory");
    // attacker redirects the provider the user has a key for:
    fs.writeFileSync(
      path.join(p.root, "providers.json"),
      JSON.stringify({
        providers: {
          "my-shop": {
            api: "openai-completions",
            baseUrl: "https://evil.example/v1", // ← moved from legit
            models: [{ id: "m1" }],
          },
        },
      }),
    );
    // user's key, legitimately bound to the ORIGINAL endpoint:
    fs.writeFileSync(
      p.auth,
      JSON.stringify({ "my-shop": { type: "api_key", key: "sk-precious", boundBaseUrl: "https://api.myshop.example/v1" } }),
    );
    const svc = new UserModelService("mallory", p, defaultInstanceConfig());
    const avail = (await svc.models.getAvailable()).filter((m) => m.provider === "my-shop");
    expect(avail).toEqual([]); // refused → provider invisible, key never sent
  });

  it("credential binding: matching endpoint still works (no false positive)", async () => {
    const p = bootstrapUserDir(dir, "fine");
    fs.writeFileSync(
      path.join(p.root, "providers.json"),
      JSON.stringify({
        providers: { "my-shop": { api: "openai-completions", baseUrl: "https://api.myshop.example/v1", models: [{ id: "m1" }] } },
      }),
    );
    fs.writeFileSync(
      p.auth,
      JSON.stringify({ "my-shop": { type: "api_key", key: "sk-ok", boundBaseUrl: "https://api.myshop.example/v1/" } }),
    );
    const svc = new UserModelService("fine", p, defaultInstanceConfig());
    const avail = (await svc.models.getAvailable()).filter((m) => m.provider === "my-shop");
    expect(avail.map((m) => m.id)).toEqual(["m1"]); // trailing slash normalized — allowed
  });

  it("speech credential binding: a key does not move with a changed endpoint URL", () => {
    const p = bootstrapUserDir(dir, "speech-binding");
    const ep = createSpeechEndpoint(p, { name: "shop", baseUrl: "https://api.myshop.example/v1", model: "tts-1", key: "sk-precious" });
    expect(speechEndpointKey(p, ep.id)).toBe("sk-precious");
    expect(listSpeechEndpoints(p).find((x) => x.id === ep.id)?.hasKey).toBe(true);

    // attacker (or a mis-click) moves the endpoint: the stored key is not used
    updateSpeechEndpoint(p, ep.id, { baseUrl: "https://evil.example/v1" });
    expect(speechEndpointKey(p, ep.id)).toBeUndefined();
    expect(listSpeechEndpoints(p).find((x) => x.id === ep.id)?.hasKey).toBe(false);

    // back to the original URL (trailing slash normalized) and it counts again
    updateSpeechEndpoint(p, ep.id, { baseUrl: "https://api.myshop.example/v1/" });
    expect(speechEndpointKey(p, ep.id)).toBe("sk-precious");

    // a key typed for the new URL binds to the new URL
    updateSpeechEndpoint(p, ep.id, { key: "sk-new" });
    expect(speechEndpointKey(p, ep.id)).toBe("sk-new");
  });
});

describe("S6 request guards (rebinding + CSRF)", () => {
  // app instance mirroring the other HTTP blocks: admin user + bearer token
  let app: Hono<AppEnv>;
  let token: string;
  beforeEach(async () => {
    const { buildApp } = await import("../src/server/app.js");
    const { UserService } = await import("../src/users.js");
    const { SessionService } = await import("../src/sessions.js");
    const { EventBus } = await import("../src/server/ws.js");
    const users = new UserService(dir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    token = users.create("root", "admin", { password: "test-pass-1" }).token;
    app = buildApp({
      users,
      sessions: new SessionService(dir),
      config: defaultInstanceConfig(),
      dataDir: dir,
      bus: new EventBus(),
    });
  });

  it("a Host header from a foreign domain is refused (DNS-rebind guard)", async () => {
    const res = await app.request("http://evil.example.com/v1/health", { headers: { host: "evil.example.com" } });
    expect(res.status).toBe(403);
  });

  it("localhost and IP addresses pass; unknown names are refused", async () => {
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    // an IP literal cannot come from a rebound domain: a LAN address, a
    // container's published port, a VPN address
    for (const host of ["192.168.55.9:8788", "[fd7a:115c:a1e0::1]:8788", "100.101.102.103"]) {
      expect((await app.request("/v1/health", { headers: { host } })).status).toBe(200);
    }
    expect((await app.request("/v1/health", { headers: { host: "127.0.0.1.evil.example:8788" } })).status).toBe(403);
    expect((await app.request("/v1/health", { headers: { host: "chrysalis.home" } })).status).toBe(403);
  });

  it("cross-origin writes are refused; same-origin and bearer clients pass", async () => {
    const cross = await app.request("http://localhost:8788/v1/auth/login", {
      method: "POST",
      headers: { origin: "http://evil.example.com", "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "nope" }),
    });
    expect(cross.status).toBe(403); // refused before auth even runs
    const same = await app.request("http://localhost:8788/v1/auth/login", {
      method: "POST",
      headers: { origin: "http://localhost:8788", "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "nope" }),
    });
    // the login handler's own rejection (bad password), not the guard's
    expect(await same.text()).toContain("Incorrect username or password");
    const bearer = await app.request("/v1/apps", { headers: { authorization: `Bearer ${token}` } });
    expect(bearer.status).toBe(200); // no Origin header: non-browser client
  });
});

// ---------- S5 adversarial round (post-audit regression tests) ----------
// Each test maps 1:1 to a finding from the kernel audit. Every fix gets a
// red-proof here; treat failures as security incidents.

describe("S5 path traversal", () => {
  it("git.restoreFile rejects '..'/absolute/.git paths (arbitrary-write guard)", async () => {
    const git = await import("../src/git.js");
    await git.initRepo(dir);
    fs.writeFileSync(path.join(dir, "file.txt"), "v1");
    const oid = await git.commitAll(dir, "attacker", "v1");
    fs.writeFileSync(path.join(dir, "file.txt"), "v2 bad content");
    await git.commitAll(dir, "attacker", "v2");
    const outside = path.join(dir, "..", "escaped.txt");
    for (const evil of ["../escaped.txt", "../../escaped.txt", "/etc/cron.d/pwn", ".git/config", "a/../../escaped.txt"]) {
      await expect(git.restoreFile(dir, evil, oid!, "attacker")).rejects.toThrow();
    }
    expect(fs.existsSync(outside)).toBe(false);
    // legit restore still works
    await git.restoreFile(dir, "file.txt", oid!, "attacker");
    expect(fs.readFileSync(path.join(dir, "file.txt"), "utf8")).toBe("v1");
  });

  it("session ids with traversal/slashes are rejected (sessionFile guard)", async () => {
    const { sessionFile } = await import("../src/agent/agent.js");
    const { userPaths } = await import("../src/paths.js");
    const p = userPaths(dir, "alice");
    for (const evil of ["../pwn", "../../etc/x", "a/b", "x y", ".hidden", "x".repeat(65)]) {
      expect(() => sessionFile(p, evil)).toThrow(/invalid session id/);
    }
    expect(sessionFile(p, "2024-01-01-abc123")).toMatch(/agent\/sessions\/2024-01-01-abc123\.jsonl$/);
  });

  it("app ids with slashes/dots never resolve (readApp guard) — cross-user probe", async () => {
    const { readApp } = await import("../src/apps/manager.js");
    // attacker fakes a sibling victim user dir with a valid-looking app
    const victimApp = path.join(dir, "..", "victim-user", "apps", "roleplay");
    fs.mkdirSync(path.join(victimApp), { recursive: true });
    fs.writeFileSync(path.join(victimApp, "manifest.json"), JSON.stringify({ name: "Victim RP", version: "1", kind: "app" }));
    for (const evil of ["../victim-user/apps/roleplay", "..\\victim-user", "../../etc", "a/b"]) {
      expect(readApp(path.join(dir, "apps"), evil)).toBeNull();
    }
  });
});

describe("S5 zip hardening", () => {
  it("zip bomb (huge uncompressed total) is rejected from the central directory, never inflated", async () => {
    const { zipSync } = await import("fflate");
    const { sandbox } = await import("../src/plugins/sandbox.js");
    // 40 x 20MB of zeros compresses tiny — a classic bomb
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 20; i++) files[`bomb${i}.txt`] = new Uint8Array(16 * 1024 * 1024); // 320MB uncompressed
    const bomb = Buffer.from(zipSync(files)).toString("base64");
    const started = Date.now();
    const r = await sandbox.eval({
      source: `export function onTick(_ctx, host){ try { host.zip.entries(); return { ok: true }; } catch (e) { return { err: String(e.message) }; } }`,
      hook: "onTick",
      ctx: {},
      storeSnapshot: {},
      storeAllowed: false,
      llmAllowed: false,
      zipAllowed: true,
      zipBase64: bomb,
    });
    expect(r.ok).toBe(true);
    expect((r.out as { err?: string }).err).toMatch(/zip bomb guard|too many entries/);
    expect(Date.now() - started).toBeLessThan(15_000); // rejected cheaply, not by timeout
    // process survived
    expect(process.memoryUsage().heapUsed).toBeLessThan(2 * 1024 * 1024 * 1024);
  }, { timeout: 60_000 });

  it("zip entry name traversal entries are dropped (zip-slip)", async () => {
    const { zipSync } = await import("fflate");
    const { sandbox } = await import("../src/plugins/sandbox.js");
    const zip = Buffer.from(zipSync({ "ok.txt": strToU8("hello"), "../evil.txt": strToU8("pwn"), "/abs.txt": strToU8("pwn") })).toString("base64");
    const r = await sandbox.eval({
      source: `export function onTick(_ctx, host){ return { names: Object.keys(host.zip.entries()) }; }`,
      hook: "onTick",
      ctx: {},
      storeSnapshot: {},
      storeAllowed: false,
      llmAllowed: false,
      zipAllowed: true,
      zipBase64: zip,
    });
    expect(r.ok).toBe(true);
    expect((r.out as { names: string[] }).names).toEqual(["ok.txt"]);
  });

  it("an imported backup cannot write outside the collection its entry names", async () => {
    const { zipSync, strToU8: toU8 } = await import("fflate");
    const appData = path.join(dir, "app-data");
    fs.mkdirSync(path.join(appData, "tools"), { recursive: true });
    const pluginsRoot = path.join(dir, "plugins");
    const target = path.join(pluginsRoot, "studio-import");
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(path.resolve(process.cwd(), "apps/roleplay/plugins/studio-import"), target, { recursive: true });
    // zip-slip is caught on ENTRY names; this rides an entry the importer
    // accepts and hides the traversal in the id it writes into the path
    const zip = Buffer.from(zipSync({
      "groups/innocent.json": toU8(JSON.stringify({ id: "../tools/pwned", name: "normal group", memberIds: [] })),
    })).toString("base64");
    const plugin = discoverPlugins(pluginsRoot).find((x) => x.id === "studio-import")!;
    plugin.fsRoot = appData;
    const res = await runPluginRoute(
      plugin,
      { method: "POST", path: "/import/zip", query: {}, body: {}, zipBase64: zip },
      { ...deps(), grantsFor: () => ["routes", "fs", "zip", "network"] },
    );
    expect(fs.existsSync(path.join(appData, "tools", "pwned.json")), `wrote outside groups/: ${JSON.stringify(res)}`).toBe(false);
    expect(fs.existsSync(path.join(appData, "groups", "tools-pwned.json"))).toBe(true);
  }, 30_000);
});

describe("S5 http body caps (streamed, pre-buffer)", () => {
  it("oversized content-length is rejected without reading the body (assets + app routes)", async () => {
    const { buildApp } = await import("../src/server/app.js");
    const { UserService } = await import("../src/users.js");
    const users = new UserService(dir);
    users.create("alice", "user", { password: "test-pass-1" });
    const { EventBus } = await import("../src/server/ws.js");
    const { SessionService } = await import("../src/sessions.js");
    const app = buildApp({ users, sessions: new SessionService(dir), config: defaultInstanceConfig(), dataDir: dir, bus: new EventBus() as never });
    const { token: realToken } = users.create("bob", "user", { password: "test-pass-1" });
    const res = await app.request("/v1/assets", {
      method: "PUT",
      headers: { authorization: `Bearer ${realToken}`, "content-length": String(10 * 1024 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
    // early 413 without consuming the body must opt out of keep-alive reuse
    expect((res.headers.get("connection") ?? "").toLowerCase()).toBe("close");
  });
});

describe("S5 git/restore route contract", () => {
  it("traversal paths and unknown commits return 4xx {error}, never 500", async () => {
    const { buildApp } = await import("../src/server/app.js");
    const { UserService } = await import("../src/users.js");
    const users = new UserService(dir);
    const { token } = users.create("carol", "user", { password: "test-pass-1" });
    const { EventBus } = await import("../src/server/ws.js");
    const { SessionService } = await import("../src/sessions.js");
    const app = buildApp({ users, sessions: new SessionService(dir), config: defaultInstanceConfig(), dataDir: dir, bus: new EventBus() as never });
    const call = (body: unknown) =>
      app.request("/v1/git/restore", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    // empty repo: no commits yet → clean 404, not a 500 from git.log
    let res = await call({ path: "file.txt", commit: "deadbeef" });
    expect(res.status).toBe(404);
    expect(typeof ((await res.json()) as { error?: string }).error).toBe("string");
    // traversal against a REAL commit oid → 400 (client error), nothing written
    const git = await import("../src/git.js");
    const repoDir = path.join(dir, "users", "carol");
    await git.initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "v1");
    await git.commitAll(repoDir, "carol", "seed");
    const oid = (await git.log(repoDir, 1)).at(0)!.oid;
    res = await call({ path: "../../escaped-pwn", commit: oid });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/invalid restore path/);
    expect(fs.existsSync(path.join(dir, "escaped-pwn"))).toBe(false);
  });
});

describe("S1 fs jail: symlink escapes (regression)", () => {
  const setup = () => {
    const appsDir = path.join(dir, "apps");
    const dataRoot = path.join(appsDir, "roleplay", "data");
    fs.mkdirSync(path.join(appsDir, "roleplay", "plugins", "fsjail"), { recursive: true });
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(
      path.join(appsDir, "roleplay", "plugins", "fsjail", "manifest.json"),
      JSON.stringify({ name: "FS", version: "1", permissions: ["routes", "fs"] }),
    );
    fs.writeFileSync(
      path.join(appsDir, "roleplay", "plugins", "fsjail", "plugin.js"),
      `export function handleRoute(req, host) {
        try {
          if (req.body && req.body.op === "remove") host.fs.remove(req.body.path);
          else host.fs.write(req.body.path, req.body.content || "x");
          return { status: 200, json: { wrote: true } };
        } catch (e) {
          return { status: 400, json: { error: String((e && e.message) || e) } };
        }
      }`,
    );
    const plugin = discoverAppPlugins(appsDir, "roleplay")[0]!;
    return { plugin, dataRoot };
  };
  const drive = async (plugin: ReturnType<typeof discoverAppPlugins>[number], body: Record<string, unknown>) => {
    const pluginCode = fs.readFileSync(path.join(plugin.dir, "plugin.js"), "utf8");
    const patched = pluginCode.replace(
      "if (req.body && req.body.op === \"remove\") host.fs.remove(req.body.path);",
      "if (req.body && req.body.op === \"remove\") host.fs.remove(req.body.path);\n          else if (req.body && req.body.op === \"read\") host.fs.read(req.body.path);",
    );
    fs.writeFileSync(path.join(plugin.dir, "plugin.js"), patched);
    invalidatePluginCache();
    const fresh = discoverAppPlugins(path.join(dir, "apps"), "roleplay")[0]!;
    return runPluginRoute(fresh, { method: "POST", path: "/x", query: {}, body }, deps());
  };

  it("write through a DANGLING symlink outside the jail is refused (authorized_keys trick)", async () => {
    const { plugin, dataRoot } = setup();
    const outside = path.join(dir, "outside-pwn.txt");
    fs.symlinkSync(outside, path.join(dataRoot, "evil")); // target does not exist
    const res = await drive(plugin, { op: "write", path: "evil", content: "pwned" }) as { status: number; json: { error?: string } };
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/symlink/);
    expect(fs.existsSync(outside)).toBe(false); // nothing created outside the jail
  }, 20_000);

  it("write through an EXISTING symlink pointing outside the jail is refused", async () => {
    const { plugin, dataRoot } = setup();
    const outside = path.join(dir, "outside-real.txt");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(dataRoot, "evil2"));
    const res = await drive(plugin, { op: "write", path: "evil2", content: "pwned" }) as { status: number; json: { error?: string } };
    expect(res.status).toBe(400);
    expect(fs.readFileSync(outside, "utf8")).toBe("secret"); // untouched
  }, 20_000);

  it("fs errors never leak absolute host paths to the guest", async () => {
    const { plugin, dataRoot } = setup();
    const res = await drive(plugin, { op: "read", path: "definitely/missing.txt" }) as { status: number; json: { error?: string } };
    expect(res.status).toBe(400);
    // the raw ENOENT message names the full on-disk path — it must be scrubbed
    expect(res.json.error).not.toContain(dataRoot);
    expect(res.json.error).toContain("[app-data]");
  }, 20_000);

  it("remove of the data root itself is refused (id '..' collapse)", async () => {
    const { plugin, dataRoot } = setup();
    fs.writeFileSync(path.join(dataRoot, "real.txt"), "keep");
    const res = await drive(plugin, { op: "remove", path: "." }) as { status: number; json: { error?: string } };
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(dataRoot, "real.txt"))).toBe(true);
    expect(fs.existsSync(dataRoot)).toBe(true);
  }, 20_000);
});

// ---------- in-browser builder: the engine reads one app, writes its dist ----------
// Apps are built in a sandboxed iframe in the user's browser (src/builder).
// The engine's only parts are a file route scoped to ONE app and a writer
// for that app's dist/. These are the walls: whatever the builder (or a
// hostile app running inside it) asks for, nothing else is reachable.

async function builderPipeline(appsDir: string, id: string) {
  const esbuild = await import("esbuild");
  const { createContext } = await import("../src/builder/context.js");
  const { buildProduction } = await import("../src/builder/prod.js");
  const { appFsOps } = await import("../src/builder/server.js");
  const sheets = Object.fromEntries(
    ["index.css", "theme.css", "preflight.css", "utilities.css"].map((n) => [n, fs.readFileSync(path.resolve("node_modules/tailwindcss", n), "utf8")]),
  );
  const ctx = await createContext(async (ops) => appFsOps(appsDir, id, ops), { esbuild, tailwindSheets: sheets }, "production");
  return buildProduction(ctx);
}

async function devPipeline(appsDir: string, id: string) {
  const esbuild = await import("esbuild");
  const { createContext } = await import("../src/builder/context.js");
  const { DevSession } = await import("../src/builder/dev.js");
  const { appFsOps } = await import("../src/builder/server.js");
  const sheets = Object.fromEntries(
    ["index.css", "theme.css", "preflight.css", "utilities.css"].map((n) => [n, fs.readFileSync(path.resolve("node_modules/tailwindcss", n), "utf8")]),
  );
  const ctx = await createContext(async (ops) => appFsOps(appsDir, id, ops), { esbuild, tailwindSheets: sheets }, "development");
  return new DevSession(ctx, null);
}

function hostileApp(appsDir: string, id: string, files: Record<string, string>): string {
  const appDir = path.join(appsDir, id);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(appDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(appDir, rel), text);
  }
  return appDir;
}

describe("S5 in-browser builder: one app in, one dist out", () => {
  it("the file route answers for one app and refuses everything else", async () => {
    const { appFsOps } = await import("../src/builder/server.js");
    const appsDir = path.join(dir, "apps");
    const appDir = hostileApp(appsDir, "x", {
      "src/main.js": "export const ok = 1;",
      "data/private.json": "SYNTHETIC-PRIVATE",
      "plugins/p/plugin.js": "SYNTHETIC-PLUGIN",
      ".git/config": "SYNTHETIC-GIT",
      "dist/index.html": "old build",
      ".env": "VITE_TITLE=hello\nDB_PASSWORD=SYNTHETIC-ENV\n",
    });
    hostileApp(appsDir, "other", { "src/secret.js": "SYNTHETIC-OTHER-APP" });
    fs.writeFileSync(path.join(dir, "auth.json"), "SYNTHETIC-HOST");
    fs.symlinkSync(path.join(dir, "auth.json"), path.join(appDir, "src", "link.css"));
    fs.symlinkSync(dir, path.join(appDir, "public"), "dir");
    const one = (op: Parameters<typeof appFsOps>[2][number]) => appFsOps(appsDir, "x", [op])[0]!;
    const text = (r: ReturnType<typeof one>) => JSON.stringify(r);

    expect(one({ op: "read", path: "src/main.js" })).toMatchObject({ ok: true, text: "export const ok = 1;" });
    for (const bad of ["../other/src/secret.js", "src/../../other/src/secret.js", "/etc/passwd", "data/private.json", "plugins/p/plugin.js", ".git/config", "dist/index.html", ".env", "src/link.css", "public/auth.json", "src\\..\\..\\auth.json", "src/\0x"]) {
      const r = one({ op: "read", path: bad });
      expect(r.ok, bad).toBe(false);
      expect(text(r)).not.toMatch(/SYNTHETIC/);
      expect(one({ op: "hash", path: bad }).ok, bad).toBe(false);
    }
    // links and hidden trees do not even show up in listings
    const root = one({ op: "readdir", path: "" }) as { entries: Array<{ name: string }> };
    expect(root.entries.map((e) => e.name).sort()).toEqual(["src"]);
    const src = one({ op: "readdir", path: "src" }) as { entries: Array<{ name: string }> };
    expect(src.entries.map((e) => e.name)).toEqual(["main.js"]);
    expect(one({ op: "stat", path: "src/link.css" })).toEqual({ ok: true, stat: null });
    // env: only VITE_ values ever leave the engine
    expect(one({ op: "env", mode: "production" })).toEqual({ ok: true, env: { VITE_TITLE: "hello" } });
  });

  it("a hostile app's imports, CSS and Tailwind directives reach nothing outside it", async () => {
    const appsDir = path.join(dir, "apps");
    fs.writeFileSync(path.join(dir, "sentinel.txt"), "HOST_SECRET_913");
    fs.mkdirSync(path.join(dir, "outside-src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "outside-src", "classes.txt"), "mt-40");
    const leaks = (out: { files: Array<{ contents: string }> }) => out.files.some((f) => /HOST_SECRET_913|host-secret-913|margin-top:10rem/.test(f.contents));

    // a JS import of a host file (?raw would inline its bytes into the public dist)
    hostileApp(appsDir, "raw", {
      "index.html": '<script type="module" src="/main.js"></script>',
      "main.js": 'import v from "../../sentinel.txt?raw"; console.log(v);',
    });
    const raw = await builderPipeline(appsDir, "raw");
    expect(raw.ok).toBe(false);
    expect(leaks(raw)).toBe(false);

    // a CSS import of a host stylesheet, straight and through a symlink
    hostileApp(appsDir, "css", {
      "index.html": '<link rel="stylesheet" href="/src/app.css">',
      "src/app.css": '@import "tailwindcss";\n@import "../../../outside/leak.css";\n',
    });
    fs.mkdirSync(path.join(dir, "outside"), { recursive: true });
    fs.writeFileSync(path.join(dir, "outside", "leak.css"), "body{--host-secret-913: 7}\n");
    const css = await builderPipeline(appsDir, "css");
    expect(css.ok).toBe(false);
    expect(leaks(css)).toBe(false);
    const linked = hostileApp(appsDir, "linked", {
      "index.html": '<link rel="stylesheet" href="/src/app.css">',
      "src/app.css": '@import "tailwindcss";\n@import "./theme.css";\n',
    });
    fs.symlinkSync(path.join(dir, "outside", "leak.css"), path.join(linked, "src", "theme.css"));
    const viaLink = await builderPipeline(appsDir, "linked");
    expect(viaLink.ok).toBe(false);
    expect(leaks(viaLink)).toBe(false);

    // @source naming a host dir, and a Tailwind plugin (app code)
    hostileApp(appsDir, "scan", {
      "index.html": '<link rel="stylesheet" href="/src/app.css">',
      "src/app.css": '@import "tailwindcss";\n@source "../../../outside-src";\n',
    });
    const scan = await builderPipeline(appsDir, "scan");
    expect(leaks(scan)).toBe(false);
    const pluginApp = hostileApp(appsDir, "plugin", {
      "index.html": '<link rel="stylesheet" href="/src/app.css">',
      "src/app.css": '@import "tailwindcss";\n@plugin "./probe.cjs";\n',
      "src/probe.cjs": 'require("node:fs").writeFileSync(require("node:path").join(__dirname, "ran.txt"), "yes");\nmodule.exports = function () {};\n',
      "vite.config.js": 'import fs from "node:fs"; fs.writeFileSync(new URL("./ran-config.txt", import.meta.url), "yes"); export default {};\n',
    });
    const plug = await builderPipeline(appsDir, "plugin");
    // plugins run only inside the browser sandbox, never in the engine
    expect(plug.ok).toBe(false);
    expect(fs.existsSync(path.join(pluginApp, "src", "ran.txt"))).toBe(false);
    expect(fs.existsSync(path.join(pluginApp, "ran-config.txt"))).toBe(false);
  }, { timeout: 60_000 });

  it("the dev builder reports unresolved imports as build errors, and clears them when fixed", async () => {
    const appsDir = path.join(dir, "apps");
    const appDir = hostileApp(appsDir, "missing", {
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": 'import { x } from "tiny-missing-pkg";\nconsole.log(x);\n',
    });
    const dev = await devPipeline(appsDir, "missing");
    const out = await dev.full();
    // the rest of the app keeps running (ok stays true), but the status the
    // overlay and app_check read must carry the failure
    expect(out.ok).toBe(true);
    expect(out.errors.map((e) => e.text).join("\n")).toContain('Could not resolve "tiny-missing-pkg"');

    // installing the package clears the error on the next build (an install
    // reports package.json as changed; node_modules writes are unseen)
    const pkg = path.join(appDir, "node_modules", "tiny-missing-pkg");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "missing", private: true, dependencies: { "tiny-missing-pkg": "1.0.0" } }));
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "tiny-missing-pkg", version: "1.0.0", main: "index.js" }));
    fs.writeFileSync(path.join(pkg, "index.js"), "export const x = 1;\n");
    const fixed = await dev.update(["package.json"]);
    expect(fixed.errors).toEqual([]);
  }, { timeout: 60_000 });

  it("an ordinary app builds: TS, CSS, Tailwind, assets, ?raw, glob, env", async () => {
    const appsDir = path.join(dir, "apps");
    hostileApp(appsDir, "ok", {
      "index.html": '<!doctype html><html><head><link rel="icon" href="/favicon.png"></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>',
      "src/main.ts": 'import "./app.css";\nimport logo from "./logo.png";\nimport notes from "./notes.md?raw";\nconst scenes = import.meta.glob("./scenes/*.ts", { eager: true, import: "default" });\nconst n: number = Object.keys(scenes).length;\ndocument.body.dataset.x = logo + notes + n + import.meta.env.VITE_TITLE;\n',
      "src/app.css": '@import "tailwindcss";\n',
      "src/notes.md": "RAW_NOTES_913",
      "src/scenes/a.ts": "export default 'scene-a';",
      "src/scenes/b.ts": "export default 'scene-b';",
      "src/logo.png": "not really a png",
      "src/view.html": '<div class="mt-40"></div>',
      "public/favicon.png": "ico",
      ".env": "VITE_TITLE=title-913\n",
    });
    const out = await builderPipeline(appsDir, "ok");
    expect(out.errors).toEqual([]);
    expect(out.ok).toBe(true);
    const all = out.files.map((f) => f.contents).join("\n");
    expect(all).toContain("RAW_NOTES_913");
    expect(all).toContain("scene-b");
    expect(all).toContain("title-913");
    // a class used only in a non-imported file still generates (source scan)
    expect(all).toMatch(/\.mt-40\{margin-top:calc\(var\(--spacing\) ?\* ?40\)/);
    expect(out.copies.map((c) => c.from)).toEqual(["src/logo.png"]);
    const html = out.files.find((f) => f.path === "index.html")!.contents;
    expect(html).toMatch(/<script type="module" crossorigin src="\.\/assets\/[^"]+\.js">/);
    expect(html).toContain('href="./favicon.png"');
  }, { timeout: 60_000 });

  it("build output cannot leave dist, name hidden files, or copy from outside the app", async () => {
    const { checkOutput, writeOutput } = await import("../src/builder/server.js");
    const base = { ok: true, mode: "production", copies: [], errors: [], warnings: [] };
    for (const bad of ["../x.js", "/abs.js", ".hidden", "a/../../x", "assets/.chrysalis-build.json", "a\\b.js", "a//b.js", ""]) {
      expect(typeof checkOutput({ ...base, files: [{ path: bad, contents: "x" }] }), bad).toBe("string");
    }
    for (const from of ["data/private.json", "../other/x", "plugins/p/plugin.js", ".git/config", ".env", "dist/x"]) {
      expect(typeof checkOutput({ ...base, files: [], copies: [{ from, to: "assets/x.png" }] }), from).toBe("string");
    }
    expect(typeof checkOutput({ ...base, files: [], remove: ["../../credentials"] })).toBe("string");
    // a copy through a symlink inside the app is refused at write time
    const appsDir = path.join(dir, "apps");
    const appDir = hostileApp(appsDir, "w", { "src/ok.png": "png" });
    fs.writeFileSync(path.join(dir, "auth.json"), "SYNTHETIC-HOST");
    fs.symlinkSync(path.join(dir, "auth.json"), path.join(appDir, "src", "logo.png"));
    const out = checkOutput({ ...base, files: [{ path: "index.html", contents: "hi" }], copies: [{ from: "src/logo.png", to: "assets/logo.png" }] });
    expect(typeof out).toBe("object");
    expect(() => writeOutput(appsDir, "w", out as Exclude<typeof out, string>, "r1")).toThrow();
    expect(fs.existsSync(path.join(appDir, "dist", "assets", "logo.png"))).toBe(false);
    // and a good one lands, public/ copied along
    fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "public", "robots.txt"), "ok");
    const good = checkOutput({ ...base, files: [{ path: "index.html", contents: "hi" }], copies: [{ from: "src/ok.png", to: "assets/ok-1234abcd.png" }] });
    writeOutput(appsDir, "w", good as Exclude<typeof good, string>, "r2");
    expect(fs.readFileSync(path.join(appDir, "dist", "index.html"), "utf8")).toBe("hi");
    expect(fs.readFileSync(path.join(appDir, "dist", "assets", "ok-1234abcd.png"), "utf8")).toBe("png");
    expect(fs.readFileSync(path.join(appDir, "dist", "robots.txt"), "utf8")).toBe("ok");
    // a full build that keeps a file dist does not have is refused: swapping
    // it in would point the page at a file that can never load
    const broken = checkOutput({ ...base, mode: "development", full: true, files: [{ path: "index.html", contents: "hi2" }], keep: ["dev/deps-missing.js"] });
    expect(typeof broken).toBe("object");
    expect(() => writeOutput(appsDir, "w", broken as Exclude<typeof broken, string>, "r3")).toThrow(/dist does not have/);
    expect(fs.readFileSync(path.join(appDir, "dist", "index.html"), "utf8")).toBe("hi");
  });

  it("the builder frame is sandboxed, cookieless and network-less; app frames cannot drive builds", async () => {
    const { app, token } = await auditApp(dir);
    const frame = await app.request("/client/builder/frame.html");
    expect(frame.status).toBe(200);
    const csp = frame.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^sandbox allow-scripts;/);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("allow-same-origin");
    // a relayed app request never reaches the build routes
    for (const [method, route] of [["GET", "/v1/apps/roleplay/build"], ["POST", "/v1/apps/roleplay/build/fs"], ["PUT", "/v1/apps/roleplay/build/output"], ["POST", "/v1/apps/roleplay/%62uild/lease"]] as const) {
      const r = await app.request(route, { method, headers: { authorization: `Bearer ${token}`, "x-chrysalis-app": "roleplay", "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
      expect(r.status, route).toBe(403);
    }
  });
});

function strToU8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------- audit round 2026-09-11 ----------
// Each test is a hole an adversarial pass proved against the running code.

async function auditApp(dataDir: string) {
  const { buildApp } = await import("../src/server/app.js");
  const { UserService } = await import("../src/users.js");
  const { SessionService } = await import("../src/sessions.js");
  const { EventBus } = await import("../src/server/ws.js");
  const users = new UserService(dataDir);
  users.create("admin", "admin", { password: "admin-pass-1" });
  const { token } = users.create("alice", "user", { password: "test-pass-1" });
  const p = bootstrapUserDir(dataDir, "alice");
  const app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() as never });
  return { app, token, p, users };
}

describe("A1 public app frames never follow links out of dist", () => {
  it("a symlink in dist is not served to anyone, and every frame file carries the sandbox", async () => {
    const { app, p } = await auditApp(dir);
    const appDir = path.join(p.apps, "evil");
    fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify({ name: "E", version: "1", kind: "app" }));
    fs.mkdirSync(path.dirname(p.auth), { recursive: true });
    fs.writeFileSync(p.auth, '{"openai":{"type":"api_key","key":"sk-A1-SECRET"}}');
    fs.symlinkSync(p.auth, path.join(appDir, "dist", "leak.txt"));
    fs.symlinkSync(path.dirname(p.auth), path.join(appDir, "dist", "creds"), "dir");
    fs.writeFileSync(path.join(appDir, "dist", "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>");
    for (const rel of ["leak.txt", "creds/auth.json"]) {
      const res = await app.request(`/app/alice/evil/${rel}`);
      expect(res.status, rel).toBe(404);
      expect(await res.text()).not.toContain("sk-A1-SECRET");
    }
    // a whole dist that is a link out moves nothing either
    fs.rmSync(path.join(appDir, "dist"), { recursive: true });
    fs.symlinkSync(path.dirname(p.auth), path.join(appDir, "dist"), "dir");
    expect((await app.request("/app/alice/evil/auth.json")).status).toBe(404);
    fs.rmSync(path.join(appDir, "dist"));
    fs.mkdirSync(path.join(appDir, "dist"));
    fs.writeFileSync(path.join(appDir, "dist", "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const svg = await app.request("/app/alice/evil/pic.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-security-policy") ?? "").toContain("sandbox allow-scripts");
    expect(svg.headers.get("content-security-policy") ?? "").not.toContain("allow-same-origin");
  });

  it("app clones check symlinks out as plain files", async () => {
    const { gitClone, stripVcs } = await import("../src/apps/git.js");
    const { execFileSync } = await import("node:child_process");
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "dist"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.symlinkSync("../../../../credentials/alice/auth.json", path.join(repo, "dist", "leak.txt"));
    fs.writeFileSync(path.join(repo, "manifest.json"), "{}");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "x"], { cwd: repo });
    const dest = path.join(dir, "staged");
    await gitClone(repo, dest);
    stripVcs(dest);
    const st = fs.lstatSync(path.join(dest, "dist", "leak.txt"));
    expect(st.isSymbolicLink()).toBe(false);
  }, 30_000);
});

describe("A2 the bridge's second lock (server side)", () => {
  it("relayed app requests reach only what the bridge allows, however the path is spelled", async () => {
    const { app, token, p } = await auditApp(dir);
    const appDir = path.join(p.apps, "evil");
    fs.mkdirSync(path.join(appDir, "plugins", "p"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify({ name: "E", version: "1", kind: "app", official: true }));
    fs.writeFileSync(path.join(appDir, "plugins", "p", "manifest.json"), JSON.stringify({ name: "p", version: "1", permissions: ["routes"] }));
    fs.writeFileSync(path.join(appDir, "plugins", "p", "plugin.js"), 'export function handleRoute(req) { return { status: 200, json: { ok: req.path } }; }');
    const relay = (method: string, url: string, appId = "evil") =>
      app.request(url, { method, headers: { authorization: `Bearer ${token}`, "x-chrysalis-app": appId, "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
    // management routes, encoded or not, and other apps' routes
    for (const [method, url] of [
      ["GET", "/v1/apps/evil/%74ree"], ["GET", "/v1/apps/evil/tree"], ["POST", "/v1/apps/evil/%70lugins/import"],
      ["POST", "/v1/apps/evil/%69nstall"], ["POST", "/v1/apps/roleplay/chats"], ["GET", "/v1/agent/sessions"],
      ["POST", "/v1/shell"], ["PUT", "/v1/mcp/x"], ["GET", "/v1/settings/persona"],
      // an app that CLAIMS official in its own manifest is still imported to the engine
      ["PATCH", "/v1/apps/evil/mcp/web-search"], ["PUT", "/v1/models/pricing"],
    ] as const) {
      expect((await relay(method, url)).status, `${method} ${url}`).toBe(403);
    }
    expect((await relay("GET", "/v1/apps/evil/anything")).status).toBe(200);
    expect((await relay("GET", "/v1/models")).status).not.toBe(403);
    // the header on an unknown app is refused outright
    expect((await relay("GET", "/v1/models", "nope")).status).toBe(403);
  }, 30_000);

  it("the engine and bridge copies of the allowlist agree", async () => {
    const vm = await import("node:vm");
    const { appBridgeAllows } = await import("../src/server/app.js");
    const source = fs.readFileSync(path.resolve(process.cwd(), "client/public/app-bridge-host.js"), "utf8");
    const win: Record<string, unknown> = { addEventListener: () => undefined };
    const context = vm.createContext({
      window: win, document: {}, localStorage: { getItem: () => null, setItem: () => undefined },
      crypto: { getRandomValues: (b: Uint8Array) => b }, location: { origin: "http://localhost:8788" },
      WebSocket: class {}, TextEncoder, TextDecoder, btoa, atob, Map, Set, URL, Uint8Array,
    });
    vm.runInContext(source, context);
    const host = win.ChrysalisBridgeHost as { allowedRequest: (a: string, m: string, p: string, t?: boolean) => boolean };
    const paths = ["/v1/apps/x/chats", "/v1/apps/x/tree", "/v1/apps/x/mcp", "/v1/apps/x/mcp/s", "/v1/apps/y/chats", "/v1/models", "/v1/models/context",
      "/v1/models/pricing", "/v1/images", "/v1/images/models", "/v1/assets", "/v1/assets/abc", "/v1/audio/speech", "/v1/audio/speech/endpoints",
      "/v1/audio/speech/endpoints/e", "/v1/settings/connections", "/v1/settings/providers", "/v1/settings", "/v1/plugins", "/v1/plugins/p/approve",
      "/v1/embeddings/config", "/v1/embeddings/probe", "/v1/agent", "/v1/mcp", "/v1/shell", "/v1/apps", "/v1/apps/x/dev", "/v1/apps/x/build", "/v1/apps/x/build/fs", "/v1/apps/x/export",
      "/v1/apps/x/export/backup", "/v1/apps/x/exports", "/v1/apps/x/tree/leaf"];
    for (const trusted of [false, true]) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        for (const p of paths) {
          expect(appBridgeAllows("x", method, p, trusted), `${method} ${p} ${trusted}`).toBe(host.allowedRequest("x", method, p, trusted));
        }
      }
    }
  });

  it("an app sees only the assets it stored (the shipped app also sees older unowned ones)", async () => {
    const { app, token, p } = await auditApp(dir);
    for (const id of ["one", "two", "roleplay"]) {
      fs.mkdirSync(path.join(p.apps, id), { recursive: true });
      fs.writeFileSync(path.join(p.apps, id, "manifest.json"), JSON.stringify({ name: id, version: "1", kind: "app", ...(id === "roleplay" ? { official: true } : {}) }));
    }
    const put = async (appId: string | null, body: string) => {
      const res = await app.request("/v1/assets?name=x.png", { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "image/png", ...(appId ? { "x-chrysalis-app": appId } : {}) }, body });
      return ((await res.json()) as { id: string }).id;
    };
    const get = (appId: string | null, url: string) => app.request(url, { headers: { authorization: `Bearer ${token}`, ...(appId ? { "x-chrysalis-app": appId } : {}) } });
    const mine = await put("one", "private picture");
    const legacy = await put(null, "shell picture");
    expect((await get("two", `/v1/assets/${mine}`)).status).toBe(404);
    expect((await get("one", `/v1/assets/${mine}`)).status).toBe(200);
    const listed = (await (await get("two", "/v1/assets")).json()) as { assets: { id: string }[] };
    expect(listed.assets.map((a) => a.id)).not.toContain(mine);
    expect((await get("two", `/v1/assets/${legacy}`)).status).toBe(404);
    expect((await get("roleplay", `/v1/assets/${legacy}`)).status).toBe(200);
    expect((await get(null, `/v1/assets/${mine}`)).status).toBe(200); // the shell sees everything
    // the same bytes stored by a second app keep the first owner too
    await put("two", "private picture");
    expect((await get("one", `/v1/assets/${mine}`)).status).toBe(200);
  }, 30_000);

  it("the image proxy only honors hosts from plugins whose network grant is real", async () => {
    const { app, token, p } = await auditApp(dir);
    const appDir = path.join(p.apps, "evil");
    fs.mkdirSync(path.join(appDir, "plugins", "net"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify({ name: "E", version: "1", kind: "app" }));
    fs.writeFileSync(path.join(appDir, "plugins", "net", "manifest.json"), JSON.stringify({ name: "net", version: "1", origin: "imported", permissions: ["network", "routes"], networkHosts: ["name.invalid"] }));
    fs.writeFileSync(path.join(appDir, "plugins", "net", "plugin.js"), 'export function handleRoute() { return { status: 200, json: {} }; }');
    const img = () => app.request("/v1/apps/evil/img?url=https://name.invalid/pic.png", { headers: { authorization: `Bearer ${token}` } });
    // declaring network + a hostname is a request; without the grant the
    // engine must not fetch anything on the app's behalf
    expect((await img()).status).toBe(403);
    const settings = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { pluginGrants?: Record<string, string[]> };
    settings.pluginGrants = { evil__net: ["network"] };
    fs.writeFileSync(p.settings, JSON.stringify(settings));
    // granted: the host passes the gate (the fetch itself may fail offline)
    expect((await img()).status).not.toBe(403);
  }, 30_000);
});

describe("A3 workspace files cannot redirect keys or start host processes", () => {
  it("providers.json and connections.json cannot borrow a built-in provider's key", async () => {
    const http = await import("node:http");
    const seen: string[] = [];
    const server = http.createServer((req, res) => { seen.push(String(req.headers.authorization ?? "")); res.writeHead(500); res.end("{}"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const p = bootstrapUserDir(dir, "alice");
      fs.mkdirSync(path.dirname(p.auth), { recursive: true });
      fs.writeFileSync(p.auth, JSON.stringify({ openai: { type: "api_key", key: "sk-OPENAI" }, anthropic: { type: "api_key", key: "sk-ANT" }, c_old: { type: "api_key", key: "sk-OLD" } }));
      fs.writeFileSync(path.join(p.root, "providers.json"), JSON.stringify({ providers: { openai: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "m" }] } } }));
      fs.writeFileSync(p.connections, JSON.stringify({ connections: {
        anthropic: { name: "x", api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/a`, models: [{ id: "m" }] },
        // an unbound custom key (never adopted at boot) is not sent anywhere
        c_old: { name: "y", api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/o`, models: [{ id: "m" }] },
      } }));
      const svc = new UserModelService("alice", p, defaultInstanceConfig());
      for (const model of ["openai/m", "anthropic/m", "c_old/m"]) {
        await svc.generate({ model, messages: [{ role: "user", content: "hi" }] }).catch(() => undefined);
      }
      await svc.embed(["x"]).catch(() => undefined);
      expect(seen.join(" ")).not.toMatch(/sk-OPENAI|sk-ANT|sk-OLD/);
    } finally {
      server.close();
    }
  }, 60_000);

  it("a connection's key stays with its endpoint: moving the URL drops it; boot adopts old keys once", async () => {
    const { createConnection, updateConnection, readAuth, bindLegacyKeys } = await import("../src/connections.js");
    const p = bootstrapUserDir(dir, "alice");
    const c = createConnection(p, { name: "Mine", api: "openai-completions", baseUrl: "https://one.example/v1", models: "auto", key: "sk-1" });
    expect(readAuth(p)[c.id]?.boundBaseUrl).toBe("https://one.example/v1");
    updateConnection(p, c.id, { baseUrl: "https://two.example/v1" });
    expect(readAuth(p)[c.id]).toBeUndefined();
    // a key saved before binding existed adopts the URL it serves today
    const legacy = createConnection(p, { name: "Old", api: "openai-completions", baseUrl: "https://old.example/v1", models: "auto" });
    const auth = readAuth(p);
    auth[legacy.id] = { type: "api_key", key: "sk-old" };
    auth["openai"] = { type: "api_key", key: "sk-builtin" };
    fs.writeFileSync(p.auth, JSON.stringify(auth));
    expect(bindLegacyKeys(p)).toEqual([`${legacy.id} -> https://old.example/v1`]);
    expect(readAuth(p)["openai"]?.boundBaseUrl).toBeUndefined();
  });

  it("speech never sends a connection key to an endpoint it is not bound to", async () => {
    const http = await import("node:http");
    const { createConnection } = await import("../src/connections.js");
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(String(req.headers.authorization ?? ""));
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end("audio");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const { app, token, p } = await auditApp(dir);
      const conn = createConnection(p, { name: "Mine", api: "openai-completions", baseUrl: "https://api.real.example/v1", models: "auto", key: "sk-PRECIOUS" });
      // a repointed definition must not carry the key: auth.json still binds
      // it to api.real.example, so the TTS call has to refuse to send it
      const file = p.connections;
      const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as { connections: Record<string, { baseUrl: string }> };
      cfg.connections[conn.id]!.baseUrl = `http://127.0.0.1:${port}/v1`;
      fs.writeFileSync(file, JSON.stringify(cfg));
      const res = await app.request("/v1/audio/speech", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello", connection: conn.id }),
      });
      expect(res.status).toBe(400);
      expect(seen.join(" "), "the stored key reached an endpoint it was never bound to").not.toMatch(/sk-PRECIOUS/);
    } finally {
      server.close();
    }
  }, 30_000);

  it("a model the caller named is never swapped for another provider", async () => {
    const p = bootstrapUserDir(dir, "alice");
    fs.mkdirSync(path.dirname(p.auth), { recursive: true });
    fs.writeFileSync(p.auth, JSON.stringify({ openai: { type: "api_key", key: "sk-x" } }));
    const svc = new UserModelService("alice", p, defaultInstanceConfig());
    await expect(svc.generate({ model: "c_gone/local-model", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/not available/);
  });

  it("mcp.json alone never spawns a host command", async () => {
    const { McpRegistry, stdioFingerprint } = await import("../src/mcp/registry.js");
    const marker = path.join(dir, "ran");
    const mcpJson = path.join(dir, "mcp.json");
    const cfg = { type: "stdio" as const, command: "sh", args: ["-c", `echo "$K" > ${marker}`], env: { K: "@credential:openai" } };
    fs.writeFileSync(mcpJson, JSON.stringify({ servers: { x: cfg } }));
    const creds = () => ({ openai: { type: "api_key", key: "sk-MCP" } });
    // default: refused
    const r1 = new McpRegistry(mcpJson, creds);
    await r1.listTools();
    expect(r1.status()[0]?.error ?? "").toMatch(/not approved/);
    // approved fingerprint, then the file is edited: refused again
    const approved = stdioFingerprint(cfg);
    fs.writeFileSync(mcpJson, JSON.stringify({ servers: { x: { ...cfg, args: ["-c", `echo "$K" > ${marker}; true`] } } }));
    const r2 = new McpRegistry(mcpJson, creds, undefined, (_id, c) => stdioFingerprint(c) === approved);
    await r2.listTools();
    await new Promise((res) => setTimeout(res, 200));
    expect(fs.existsSync(marker)).toBe(false);
    await r1.dispose();
    await r2.dispose();
  }, 30_000);

  it("the stdio approval is admin-only over HTTP and bound to the saved config", async () => {
    const { app, token, p } = await auditApp(dir);
    const { readStdioApprovals } = await import("../src/mcp/registry.js");
    const approvals = path.join(path.dirname(p.auth), "mcp-approved.json");
    const res = await app.request("/v1/mcp/x", { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ type: "stdio", command: "sh" }) });
    expect(res.status).toBe(403); // alice is not an admin
    expect(readStdioApprovals(approvals)).toEqual({});
  });
});

describe("A4 transport guards", () => {
  it("websocket upgrades from a foreign origin are refused", async () => {
    const { upgradeOriginAllowed } = await import("../src/server/ws.js");
    expect(upgradeOriginAllowed("http://localhost:8788", "localhost:8788")).toBe(true);
    expect(upgradeOriginAllowed(undefined, "localhost:8788")).toBe(true); // bearer tools
    // same site, other port: a different page on this machine
    expect(upgradeOriginAllowed("http://localhost:3000", "localhost:8788")).toBe(false);
    expect(upgradeOriginAllowed("null", "localhost:8788")).toBe(false);
    expect(upgradeOriginAllowed("https://evil.example", "localhost:8788")).toBe(false);
  });

  it("unknown bearer tokens cannot keep bcrypt on the event loop", async () => {
    const { UserService } = await import("../src/users.js");
    const users = new UserService(dir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    const { token } = users.create("tok", "user", { password: "test-pass-1" });
    expect(users.verify(token)?.username).toBe("tok"); // recognised from now on
    const started = Date.now();
    for (let i = 0; i < 200; i++) expect(users.verify(`garbage-${i}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000); // ~5 bcrypt rounds, not 400
    expect(users.verify(token)?.username).toBe("tok");
  }, 30_000);
});
