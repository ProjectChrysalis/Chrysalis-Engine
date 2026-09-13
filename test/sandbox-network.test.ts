/**
 * Internet access for the agent sandbox: the worker lockdown sends http(s)
 * to the engine proxy (and only when a token was handed over), the proxy
 * refuses this machine and its network, and the setting and token gate the
 * route.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";
import type { AppEnv } from "../src/server/app.js";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import { defaultInstanceConfig } from "../src/config.js";
import { workerLockdown } from "../src/sandbox/browser/lockdown.js";
import { proxySandboxRequest } from "../src/sandbox/network.js";
import { TOP_LEVEL_DOMAINS } from "../src/sandbox/browser/tlds.js";

const WORKER = "http://engine.test/client/sandbox/wasmsh/abc/browser-worker.js";
const NET = { token: "tok123", url: "http://engine.test/v1/sandbox/net" };

/** A bare worker global: records what the real fetch and XHR were asked. */
function workerScope(net: typeof NET | null) {
  const fetches: { url: string; init?: RequestInit }[] = [];
  const opened: { method: string; url: string; headers: [string, string][]; body: unknown }[] = [];
  class FakeXHR {
    rec = { method: "", url: "", headers: [] as [string, string][], body: undefined as unknown };
    open(method: string, url: string) {
      this.rec = { method, url, headers: [], body: undefined };
    }
    setRequestHeader(k: string, v: string) {
      this.rec.headers.push([k, v]);
    }
    send(body: unknown) {
      this.rec.body = body;
      opened.push(this.rec);
    }
  }
  const self: Record<string, unknown> = {
    fetch: (url: string, init?: RequestInit) => {
      fetches.push({ url: String(url), init });
      return Promise.resolve(new Response("ok"));
    },
    XMLHttpRequest: FakeXHR,
    setTimeout,
    setInterval,
  };
  const context = vm.createContext({ self, URL, Request, Response, DOMException, WeakMap, Promise, JSON, encodeURIComponent, Object });
  vm.runInContext(workerLockdown(WORKER, net), context);
  return { self, fetches, opened };
}

describe("sandbox worker lockdown", () => {
  it("with internet on, fetch and XHR go to the engine proxy with the token", async () => {
    const w = workerScope(NET);
    const fetchFn = w.self.fetch as (u: string, i?: RequestInit) => Promise<Response>;
    await fetchFn("https://pypi.org/simple/rich/", { method: "POST", headers: { accept: "text/html" }, body: "q=1" });
    const sent = w.fetches[0]!;
    expect(sent.url).toBe(NET.url);
    const h = sent.init!.headers as Record<string, string>;
    expect(h["x-sandbox-token"]).toBe("tok123");
    expect(h["x-sandbox-url"]).toBe("https://pypi.org/simple/rich/");
    expect(h["x-sandbox-method"]).toBe("POST");
    expect(JSON.parse(decodeURIComponent(h["x-sandbox-headers"]!))).toContainEqual(["accept", "text/html"]);
    expect(new TextDecoder().decode(sent.init!.body as ArrayBuffer)).toBe("q=1");

    // the runtime's own assets still load directly
    await fetchFn("http://engine.test/client/sandbox/wasmsh/abc/assets/x.wasm");
    expect(w.fetches[1]!.url).toBe("http://engine.test/client/sandbox/wasmsh/abc/assets/x.wasm");

    const Xhr = w.self.XMLHttpRequest as new () => { open: (m: string, u: string, a?: boolean) => void; setRequestHeader: (k: string, v: string) => void; send: (b?: unknown) => void };
    const x = new Xhr();
    x.open("GET", "https://example.com/file.txt", false);
    x.setRequestHeader("Range", "bytes=0-10");
    x.send("ignored for GET");
    const rec = w.opened[0]!;
    expect([rec.method, rec.url, rec.body]).toEqual(["POST", NET.url, null]);
    const hx = Object.fromEntries(rec.headers);
    expect(hx["x-sandbox-url"]).toBe("https://example.com/file.txt");
    expect(hx["x-sandbox-method"]).toBe("GET");
    expect(JSON.parse(decodeURIComponent(hx["x-sandbox-headers"]!))).toEqual([["Range", "bytes=0-10"]]);
  });

  it("with internet off, nothing leaves", async () => {
    const w = workerScope(null);
    await expect((w.self.fetch as (u: string) => Promise<Response>)("https://example.com/")).rejects.toThrow(/network is disabled/);
    const Xhr = w.self.XMLHttpRequest as new () => { open: (m: string, u: string) => void };
    expect(() => new Xhr().open("GET", "https://example.com/")).toThrow(/network is disabled/);
    expect(w.fetches).toEqual([]);
  });

  it("the host list names every top-level domain", () => {
    expect(TOP_LEVEL_DOMAINS.length).toBeGreaterThan(1000);
    for (const tld of ["com", "org", "io", "dev", "uk", "xn--p1ai"]) expect(TOP_LEVEL_DOMAINS).toContain(tld);
  });
});

describe("sandbox proxy", () => {
  it("refuses this machine and the local network, by name, literal and redirect", async () => {
    const local = http.createServer((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/" });
      res.end();
    });
    await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
    try {
      const port = (local.address() as AddressInfo).port;
      for (const url of [`http://127.0.0.1:${port}/`, "http://localhost:8788/v1/health", "http://192.168.1.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd"]) {
        const res = await proxySandboxRequest({ url, method: "GET", headers: [], body: null });
        expect(res.status, url).toBe(502);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      }
    } finally {
      local.close();
    }
  });
});

describe("sandbox internet setting", () => {
  let dataDir: string;
  let token: string;
  let app: Hono<AppEnv>;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-net-"));
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    token = users.create("root", "admin", { password: "test-pass-1" }).token;
    app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const call = (url: string, init: Record<string, unknown> = {}) =>
    app.request(url, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...init });

  it("is on by default, lives outside the workspace, and switching it off stops the proxy at once", async () => {
    expect(await (await call("/v1/settings/sandbox")).json()).toEqual({ internet: true });
    const cfg = (await (await call("/v1/sandbox/config")).json()) as { internet: boolean; token: string };
    expect(cfg.internet).toBe(true);

    const pre = await app.request("/v1/sandbox/net", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");

    const proxied = (t: string | null) =>
      app.request("/v1/sandbox/net", { method: "POST", headers: { ...(t ? { "x-sandbox-token": t } : {}), "x-sandbox-url": "http://10.0.0.1/", "x-sandbox-method": "GET" } });
    expect((await proxied(null)).status).toBe(401);
    expect((await proxied("forged")).status).toBe(401);
    // a real token reaches the guard, which refuses the private address
    expect((await proxied(cfg.token)).status).toBe(502);

    expect((await call("/v1/settings/sandbox", { method: "PUT", body: JSON.stringify({ internet: false }) })).status).toBe(200);
    expect(fs.existsSync(path.join(dataDir, "credentials", "root", "sandbox.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "users", "root", "sandbox.json"))).toBe(false);
    expect((await proxied(cfg.token)).status).toBe(401);
    expect(await (await call("/v1/sandbox/config")).json()).toEqual({ internet: false, token: null });
  });

  it("a token outlives an engine restart", async () => {
    const cfg = (await (await call("/v1/sandbox/config")).json()) as { token: string };
    // a fresh engine over the same data dir, as after a restart
    const app2 = buildApp({ users: new UserService(dataDir), sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
    const res = await app2.request("/v1/sandbox/net", {
      method: "POST",
      headers: { "x-sandbox-token": cfg.token, "x-sandbox-url": "http://10.0.0.1/", "x-sandbox-method": "GET" },
    });
    // reached the address guard rather than failing auth
    expect(res.status).toBe(502);
  });
});
