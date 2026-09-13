/**
 * Drives the hostile fixture in test/fixtures/malicious-plugin. The fixture
 * declares every permission and no network hosts, then tries sandbox
 * escapes, bridge abuse and exfiltration; this suite asserts that nothing
 * gets through. A failure here is a real hole, not a flaky test.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverPlugins, invalidatePluginCache, runPluginHook, runPluginRoute } from "../src/plugins/runtime.js";
import { PluginStoreService } from "../src/plugins/store.js";
import { pageConnectSrc } from "../src/server/app.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "malicious-test-"));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* watcher races */ }
  invalidatePluginCache();
});

const ALL_PERMISSIONS = ["hooks", "routes", "tools", "network", "fs", "store", "llm", "zip"];
const deps = () => ({
  store: new PluginStoreService(path.join(dir, "store")),
  models: {} as never,
  grantsFor: () => ALL_PERMISSIONS,
});

function installMalicious(): string {
  const pluginsRoot = path.join(dir, "plugins");
  const target = path.join(pluginsRoot, "malicious");
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.resolve(process.cwd(), "test/fixtures/malicious-plugin"), target, { recursive: true });
  return pluginsRoot;
}

type Check = { ok: boolean; value?: string; error?: string };
/** The guest's globals probe answers a name → typeof map; every other check
 *  answers a pass/fail record. */
type GlobalsProbe = Record<string, string>;
type Report = { checks: Record<string, Check | GlobalsProbe>; done?: boolean } & Record<string, unknown>;

describe("hostile plugin with every permission", () => {
  it("cannot escape the sandbox, the bridge, its fs, the store, or an empty network allowlist", async () => {
    const appData = path.join(dir, "app-data");
    fs.mkdirSync(appData, { recursive: true });
    // traps a workspace shell might have planted: a read symlink to a host
    // secret and a dangling write symlink to a path outside
    fs.symlinkSync("/etc/passwd", path.join(appData, "passwd-link"));
    fs.symlinkSync(path.join(dir, "outside.txt"), path.join(appData, "dangling"));

    const d = deps();
    d.store.namespace("victim").put("victim-secret", "do-not-read");
    const byId = discoverPlugins(installMalicious());
    const plugin = byId.find((p) => p.id === "malicious")!;
    plugin.fsRoot = appData;

    const out = (await runPluginHook(plugin, "uiPanel", {}, d)) as { __report?: Report };
    const report = out.__report!;
    const checks = report.checks;
    /** A check whose guest answer is a pass/fail record (all but the globals
     *  probe), read with the report's loose guest typing narrowed. */
    const rec = (name: string): Check | undefined => checks[name] as Check | undefined;

    // what the guest sees: no host node globals, no fetch, no sockets. The
    // `process`/`Buffer` shims belong to the guest runtime and stay minimal.
    expect(checks.globals).toEqual({
      process: "object",
      require: "undefined",
      fetch: "undefined",
      WebSocket: "undefined",
      XMLHttpRequest: "undefined",
      importScripts: "undefined",
      Buffer: "function",
      navigator: "undefined",
    });

    // the process shim exposes only its own env (the sandbox's ctx/host
    // handles), no host environment, and no exit/binding/mainModule
    expect(checks["process-keys"]).toEqual({ ok: true, value: "env,cwd" });
    expect(checks["process-env"]).toEqual({ ok: true, value: "env keys: ctx,host" });
    expect(checks["process-binding"]).toEqual({ ok: true, value: "undefined" });
    expect(checks["process-mainModule"]).toEqual({ ok: true, value: "undefined" });
    expect(rec("process-exit")?.ok, "process.exit must not work").toBe(false);

    // the Function-constructor escape lands back in the guest, nowhere else
    expect(checks["constructor-escape"]).toEqual({ ok: true, value: "object" });

    // every fs escape is refused: absolute, traversal, symlink read, symlink
    // write, writes outside the jail
    for (const name of [
      "fs-read-abs",
      "fs-read-traversal",
      "fs-read-credentials",
      "fs-list-outside",
      "fs-read-symlink",
      "fs-write-symlink",
      "fs-write-outside",
      "zip-without-payload",
      "net-malformed",
      "store-flood",
    ]) {
      expect(rec(name)?.ok, `${name}: ${JSON.stringify(checks[name])}`).toBe(false);
    }

    // ...while the legitimate scoped write still works
    expect(checks["fs-write-inside"]).toMatchObject({ ok: true, value: "hello" });
    expect(fs.readFileSync(path.join(appData, "inside.txt"), "utf8")).toBe("hello");

    // nothing reached the host filesystem
    expect(fs.existsSync(path.join(dir, "pwned.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "outside.txt"))).toBe(false);

    // the store is namespaced: another plugin's key is invisible, and the
    // flood hit the size cap instead of filling the disk
    expect(rec("store-foreign-read")?.value ?? "").toContain("victim-secret=null");
    expect(rec("store-foreign-read")?.value ?? "").not.toContain("do-not-read");

    // every queued request was executed host-side and refused by the empty
    // allowlist (the file scheme was rejected before the host check)
    expect((report["net-exfil"] as Check).ok).toBe(false);
    expect((report["net-exfil"] as Check).error ?? "").toMatch(/allowlist/);
    expect((report["net-metadata"] as Check).ok).toBe(false);
    expect((report["net-file"] as Check).ok).toBe(false);
    expect((report["net-file"] as Check).error ?? "").toMatch(/http\(s\)/);

    // guest prototype pollution stays in the guest
    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
    expect(checks["prototype-pollute"]).toMatchObject({ ok: true, value: "yes" });

    // a separate async pass: dynamic import of node:fs must not reach the
    // host filesystem either (locked module or no loader at all)
    const dyn = (await runPluginHook(plugin, "probeDynamic", {}, d)) as { ok: boolean; leaked?: string; error?: string };
    expect(dyn.ok, JSON.stringify(dyn)).toBe(false);
    expect(dyn.leaked ?? "").not.toContain("root:");
  }, { timeout: 60_000 });

  it("a plugin that fails to parse is named in the route error", async () => {
    const pluginsRoot = path.join(dir, "plugins");
    const target = path.join(pluginsRoot, "broken");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify({ name: "broken", permissions: ["routes"] }));
    // TypeScript annotation in plugin.js: the sandbox evaluates plain JS, so
    // this is the parse failure the pentest run hit
    fs.writeFileSync(path.join(target, "plugin.js"), "export function handleRoute(req: { path: string }, host) { return { json: { ok: true } }; }\n");
    const broken = discoverPlugins(pluginsRoot).find((p) => p.id === "broken")!;
    const res = await runPluginRoute(broken, { method: "GET", path: "x", query: {}, body: undefined }, deps());
    expect(res).toMatchObject({ status: 500 });
    // the response (what the app page and the agent's console capture see)
    // names the plugin, not just the parse message
    expect(JSON.stringify(res)).toContain("broken");
    expect(JSON.stringify(res)).toContain("route failed");
  });
});

describe("exfiltration ways out of an app page", () => {
  it("the app bridge never relays agent or engine control routes", async () => {
    const vm = await import("node:vm");
    const source = fs.readFileSync(path.resolve(process.cwd(), "client/public/app-bridge-host.js"), "utf8");
    const win: Record<string, unknown> = { addEventListener: () => undefined };
    const sandbox: Record<string, unknown> = {
      window: win,
      document: {},
      localStorage: { getItem: () => null, setItem: () => undefined },
      crypto: { getRandomValues: (b: Uint8Array) => b },
      location: { origin: "http://localhost:8788" },
      WebSocket: class {},
      TextEncoder,
      TextDecoder,
      btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
      atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
      Map,
      Set,
      URL,
      Uint8Array,
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const host = win.ChrysalisBridgeHost as {
      allowedRequest: (appId: string, method: string, path: string, trusted?: boolean) => boolean;
      eventAllowed: (appId: string, trusted: boolean, raw: string) => boolean;
    };

    for (const path of [
      "/v1/agent", "/v1/agent/sessions", "/v1/agent/files", "/v1/shell", "/v1/admin/users",
      "/v1/settings", "/v1/settings/persona", "/v1/mcp", "/v1/mcp/tools", "/v1/mcp/tools/x/call",
      "/v1/auth/users", "/v1/git/log", "/v1/sandbox", "/v1/apps", "/v1/apps/other/chats",
      "/v1/apps/roleplay", "/v1/apps/roleplay/tree", "/v1/apps/roleplay/plugins", "/v1/apps/roleplay/install",
      "/v1/apps/roleplay/dev", "/v1/apps/roleplay/update", "/v1/apps/roleplay/updates",
      "/v1/apps/roleplay/build", "/v1/apps/roleplay/build/fs", "/v1/apps/roleplay/build/output",
      "/v1/apps/roleplay/rev", "/v1/apps/roleplay/activate", "/v1/apps/roleplay/rename",
      "/v1/apps/roleplay/export", "/v1/apps/roleplay/exports",
      "/v1/settings/connections", "/v1/plugins",
    ]) {
      expect(host.allowedRequest("roleplay", "POST", path), path).toBe(false);
    }
    // its own API and the product surfaces it drives stay reachable — a
    // plugin route that shares a management word is still the app's API
    for (const path of ["/v1/apps/roleplay/chats", "/v1/apps/roleplay/img", "/v1/apps/roleplay/__panels", "/v1/apps/roleplay/export/backup"]) {
      expect(host.allowedRequest("roleplay", "POST", path), path).toBe(true);
    }
    // the router decodes %xx before matching: an encoded management segment
    // is still the management route
    for (const path of ["/v1/apps/roleplay/%74ree", "/v1/apps/roleplay/%70lugins/import", "/v1/apps/roleplay/%69nstall", "/v1/apps/roleplay/%E0%A4%A"]) {
      expect(host.allowedRequest("roleplay", "POST", path), path).toBe(false);
    }
    // switching engine MCP servers on is the user's call: a shipped app's
    // own settings UI may, an imported app may only read the list
    expect(host.allowedRequest("roleplay", "GET", "/v1/apps/roleplay/mcp")).toBe(true);
    expect(host.allowedRequest("roleplay", "PATCH", "/v1/apps/roleplay/mcp/web-search")).toBe(false);
    expect(host.allowedRequest("roleplay", "PATCH", "/v1/apps/roleplay/mcp/web-search", true)).toBe(true);
    expect(host.allowedRequest("roleplay", "GET", "/v1/models")).toBe(true);
    expect(host.allowedRequest("roleplay", "GET", "/v1/images/models")).toBe(true);
    expect(host.allowedRequest("roleplay", "POST", "/v1/images")).toBe(true);
    expect(host.allowedRequest("roleplay", "POST", "/v1/audio/speech")).toBe(true);
    expect(host.allowedRequest("roleplay", "GET", "/v1/audio/voices")).toBe(true);
    expect(host.allowedRequest("roleplay", "GET", "/v1/embeddings/config")).toBe(true);
    expect(host.allowedRequest("roleplay", "GET", "/v1/assets/abc")).toBe(true);
    // speech endpoint LISTING is fine; managing endpoints (a stored key could
    // be pointed at another host) is shell settings business
    expect(host.allowedRequest("roleplay", "GET", "/v1/audio/speech/endpoints")).toBe(true);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      expect(host.allowedRequest("roleplay", method, "/v1/audio/speech/endpoints/x"), method).toBe(false);
    }
    // read-only catalogs: GET yes, writes no
    expect(host.allowedRequest("roleplay", "GET", "/v1/settings/connections")).toBe(true);
    expect(host.allowedRequest("roleplay", "GET", "/v1/plugins")).toBe(true);
    // the model catalog itself is not a write target
    expect(host.allowedRequest("roleplay", "POST", "/v1/models")).toBe(false);
    // engine-wide settings writes (context, pricing, embeddings) belong to
    // the shipped app only — an imported app cannot silently retune them
    const settingsWrites: Array<[string, string]> = [
      ["PUT", "/v1/models/context"],
      ["PUT", "/v1/models/pricing"],
      ["PUT", "/v1/embeddings/config"],
      ["POST", "/v1/embeddings/probe"],
    ];
    for (const [method, path] of settingsWrites) {
      expect(host.allowedRequest("roleplay", method, path), path).toBe(false);
      expect(host.allowedRequest("roleplay", method, path, true), path).toBe(true);
    }
  });

  it("the bridge bus filter drops agent, other-app and cross-app events", async () => {
    const vm = await import("node:vm");
    const source = fs.readFileSync(path.resolve(process.cwd(), "client/public/app-bridge-host.js"), "utf8");
    const win: Record<string, unknown> = { addEventListener: () => undefined };
    const sandbox: Record<string, unknown> = {
      window: win,
      document: {},
      localStorage: { getItem: () => null, setItem: () => undefined },
      crypto: { getRandomValues: (b: Uint8Array) => b },
      location: { origin: "http://localhost:8788" },
      WebSocket: class {},
      TextEncoder,
      TextDecoder,
      btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
      atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
      Map,
      Set,
      URL,
      Uint8Array,
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const host = win.ChrysalisBridgeHost as { eventAllowed: (appId: string, trusted: boolean, raw: string) => boolean };
    const evt = (type: string, payload: unknown) => JSON.stringify({ type, payload });

    // this app's own traffic plus the hello build stamp
    expect(host.eventAllowed("roleplay", true, evt("app_stream", { app: "roleplay", chatId: "c1" }))).toBe(true);
    expect(host.eventAllowed("roleplay", true, evt("look_changed", { app: "roleplay", paths: ["data/"] }))).toBe(true);
    expect(host.eventAllowed("roleplay", true, evt("app_changed", { app: "roleplay" }))).toBe(true);
    expect(host.eventAllowed("roleplay", true, evt("app_built", { app: "roleplay", kind: "hot", seq: 3 }))).toBe(true);
    // another app's builds, and the build queue itself, stay out
    expect(host.eventAllowed("roleplay", true, evt("app_built", { app: "other", kind: "hot", seq: 3 }))).toBe(false);
    expect(host.eventAllowed("roleplay", true, evt("build_needed", { app: "roleplay", paths: ["src/a.ts"] }))).toBe(false);
    expect(host.eventAllowed("roleplay", true, JSON.stringify({ type: "hello", build: 1 }))).toBe(true);
    // another app's generation, the agent's stream, plugin internals: gone
    expect(host.eventAllowed("roleplay", true, evt("app_stream", { app: "other", chatId: "c1" }))).toBe(false);
    expect(host.eventAllowed("roleplay", true, evt("look_changed", { app: "other" }))).toBe(false);
    expect(host.eventAllowed("roleplay", true, evt("agent_delta", { sessionId: "s" }))).toBe(false);
    expect(host.eventAllowed("roleplay", true, evt("agent_event", { sessionId: "s" }))).toBe(false);
    expect(host.eventAllowed("roleplay", true, evt("plugin_event", { plugin: "x", payload: {} }))).toBe(false);
    expect(host.eventAllowed("roleplay", true, evt("oauth_event", { provider: "p" }))).toBe(false);
    expect(host.eventAllowed("roleplay", true, "not json")).toBe(false);
    // model-catalog pings only reach the shipped app that renders the catalog
    expect(host.eventAllowed("roleplay", true, evt("connections_changed", { id: "p/m" }))).toBe(true);
    expect(host.eventAllowed("roleplay", false, evt("connections_changed", { id: "p/m" }))).toBe(false);
  });
  it("one app cannot send on or close another app's socket", async () => {
    const vm = await import("node:vm");
    const source = fs.readFileSync(path.resolve(process.cwd(), "client/public/app-bridge-host.js"), "utf8");
    type FakeSource = { messages: Array<Record<string, unknown>>; postMessage: (m: Record<string, unknown>) => void };
    type FakeSocket = { sent: unknown[]; closed: boolean; readyState: number; protocol: string; binaryType: string; send: (d: unknown) => void; close: () => void };
    const handlers: Array<(e: { source: unknown; data: unknown }) => void> = [];
    const sockets: FakeSocket[] = [];
    class TestSocket {
      readyState = 1;
      protocol = "";
      binaryType = "blob";
      sent: unknown[] = [];
      closed = false;
      constructor() { sockets.push(this); }
      send(d: unknown) { this.sent.push(d); }
      close() { this.closed = true; }
    }
    const win: Record<string, unknown> = {
      addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => { if (type === "message") handlers.push(fn); },
    };
    const sandbox: Record<string, unknown> = {
      window: win,
      document: {},
      localStorage: { getItem: () => null, setItem: () => undefined },
      crypto: { getRandomValues: (b: Uint8Array) => b },
      location: { origin: "http://localhost:8788" },
      WebSocket: TestSocket,
      TextEncoder,
      TextDecoder,
      btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
      atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
      Map,
      Set,
      URL,
      Uint8Array,
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const host = win.ChrysalisBridgeHost as {
      serve: (iframe: { contentWindow: unknown }, appId: string, username: string) => () => void;
    };
    const makeSource = (appId: string): FakeSource => {
      const src: FakeSource = { messages: [], postMessage: (m) => { src.messages.push(m); } };
      host.serve({ contentWindow: src }, appId, "alice");
      return src;
    };
    const one = makeSource("one");
    const two = makeSource("two");
    const dispatch = (src: FakeSource, data: Record<string, unknown>) => { for (const h of handlers) h({ source: src, data }); };
    const hello = (src: FakeSource): string => {
      dispatch(src, { __chrysalis: 1, type: "hello" });
      const init = src.messages.find((m) => m.type === "init") as { nonce: string } | undefined;
      if (!init) throw new Error("no init nonce");
      return init.nonce;
    };
    const nonceOne = hello(one);
    const nonceTwo = hello(two);
    // both frames claim the same id; each open creates its own socket
    dispatch(one, { __chrysalis: 1, type: "ws-open", nonce: nonceOne, wsId: 7, url: "/v1/ws" });
    dispatch(two, { __chrysalis: 1, type: "ws-open", nonce: nonceTwo, wsId: 7, url: "/v1/ws" });
    expect(sockets.length).toBe(2);
    dispatch(two, { __chrysalis: 1, type: "ws-send", nonce: nonceTwo, wsId: 7, binary: false, data: "from two" });
    dispatch(one, { __chrysalis: 1, type: "ws-send", nonce: nonceOne, wsId: 7, binary: false, data: "from one" });
    expect(sockets[0]?.sent).toEqual(["from one"]);
    expect(sockets[1]?.sent).toEqual(["from two"]);
    // closing through the other frame does not touch this app's socket
    dispatch(two, { __chrysalis: 1, type: "ws-close", nonce: nonceTwo, wsId: 7, code: 1000, reason: "" });
    expect(sockets[0]?.closed).toBe(false);
    expect(sockets[1]?.closed).toBe(true);
  });

  it("accepts a storage write before the handshake so an immediate reload cannot lose it", async () => {
    const vm = await import("node:vm");
    const source = fs.readFileSync(path.resolve(process.cwd(), "client/public/app-bridge-host.js"), "utf8");
    const handlers: Array<(e: { source: unknown; data: unknown }) => void> = [];
    const store = new Map<string, string>();
    const fetchCalls: unknown[] = [];
    const win: Record<string, unknown> = {
      addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => { if (type === "message") handlers.push(fn); },
    };
    const sandbox: Record<string, unknown> = {
      window: win,
      document: {},
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      },
      crypto: { getRandomValues: (b: Uint8Array) => b },
      location: { origin: "http://localhost:8788" },
      WebSocket: class {},
      fetch: (...args: unknown[]) => { fetchCalls.push(args); return Promise.resolve({ ok: true, status: 200 }); },
      TextEncoder,
      TextDecoder,
      btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
      atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
      Map,
      Set,
      URL,
      Uint8Array,
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const host = win.ChrysalisBridgeHost as {
      serve: (iframe: { contentWindow: unknown }, appId: string, username: string) => () => void;
      frameSrc: (appId: string, username: string) => string;
    };
    const src = { postMessage: (_m: Record<string, unknown>) => undefined };
    host.serve({ contentWindow: src }, "test", "alice");
    const dispatch = (data: Record<string, unknown>) => { for (const h of handlers) h({ source: src, data }); };

    // no hello/init yet: the app wrote before the handshake round trip (the
    // exact shape of a reload guard: setItem then location.reload())
    dispatch({ __chrysalis: 1, type: "storage", which: "local", op: "set", key: "flag", value: "1" });
    const url = host.frameSrc("test", "alice");
    const raw = decodeURIComponent(url.slice(url.indexOf("__storage=") + "__storage=".length));
    expect(Buffer.from(raw, "base64").toString("utf8")).toContain('"flag":"1"');

    // everything else still waits for the nonce: a forged fetch does nothing
    dispatch({ __chrysalis: 1, type: "fetch", id: 1, url: "/v1/me" });
    expect(fetchCalls).toEqual([]);
  });

  it("connect-src is host-scoped: no bare ws:/wss:, no forged host", () => {
    expect(pageConnectSrc("localhost:8788")).toBe("'self' ws://localhost:8788 wss://localhost:8788");
    expect(pageConnectSrc("192.168.1.5:8788")).toBe("'self' ws://192.168.1.5:8788 wss://192.168.1.5:8788");
    expect(pageConnectSrc("[::1]:8788")).toBe("'self' ws://[::1]:8788 wss://[::1]:8788");
    // a spoofed Host cannot smuggle extra sources into the header
    for (const evil of [undefined, "", "evil.example; script-src *", "a b", "host\nX: y", "*"]) {
      const csp = pageConnectSrc(evil);
      expect(csp).not.toMatch(/ws:\s|wss:($|\s)|script-src|\*/);
    }
  });

  it("keeps the wildcard out of every CSP source in the repo", () => {
    const root = path.resolve(process.cwd(), "src");
    const offenders: string[] = [];
    for (const rel of fs.readdirSync(root, { recursive: true }) as string[]) {
      const full = path.join(root, rel);
      if (!/\.(ts|tsx|mjs|js)$/.test(rel) || !fs.statSync(full).isFile()) continue;
      const source = fs.readFileSync(full, "utf8");
      if (source.includes("ws: wss:") || source.includes("wss: ws:")) offenders.push(rel);
    }
    expect(offenders, `wildcard websocket sources came back: ${offenders.join(", ")}`).toEqual([]);
  });
});
