/**
 * Internet access for the agent sandbox: the engine proxy refuses this
 * machine and its network, and the setting and token gate the route.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";
import type { AppEnv } from "../src/server/app.js";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import { defaultInstanceConfig } from "../src/config.js";
import { proxySandboxRequest } from "../src/sandbox/network.js";

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

    const proxied = (t: string | null) =>
      app.request(`/v1/sandbox/proxy${t ? `?token=${encodeURIComponent(t)}&url=${encodeURIComponent("http://10.0.0.1/")}` : `?url=${encodeURIComponent("http://10.0.0.1/")}`}`);
    expect((await proxied(null)).status).toBe(401);
    expect((await proxied("forged")).status).toBe(401);
    // a real token reaches the guard, which refuses the private address
    expect((await proxied(cfg.token)).status).toBe(502);

    expect((await call("/v1/settings/sandbox", { method: "PUT", body: JSON.stringify({ internet: false }) })).status).toBe(200);
    expect(fs.existsSync(path.join(dataDir, "credentials", "root", "sandbox.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "users", "root", "sandbox.json"))).toBe(false);
    expect((await proxied(cfg.token)).status).toBe(401);
    const off = (await (await call("/v1/sandbox/config")).json()) as { internet: boolean; token: string };
    expect(off.internet).toBe(false);
    // a fresh token still refuses the internet: it only carries the proxy when on
    expect((await proxied(off.token)).status).toBe(403);
  });

  it("a token outlives an engine restart", async () => {
    const cfg = (await (await call("/v1/sandbox/config")).json()) as { token: string };
    // a fresh engine over the same data dir, as after a restart
    const app2 = buildApp({ users: new UserService(dataDir), sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
    const res = await app2.request(`/v1/sandbox/proxy?token=${encodeURIComponent(cfg.token)}&url=${encodeURIComponent("http://10.0.0.1/")}`);
    // reached the address guard rather than failing auth
    expect(res.status).toBe(502);
  });
});

describe("sandbox frame routes", () => {
  let dataDir: string;
  let token: string;
  let app: Hono<AppEnv>;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-frame-"));
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

  it("reads workspace files only with a valid token, and only what the mount allows", async () => {
    const cfg = (await (await call("/v1/sandbox/config")).json()) as { fsToken: string };
    const root = path.join(dataDir, "users", "root");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "hello.txt"), "hi there");
    fs.writeFileSync(path.join(root, "settings.json"), "{}");
    const read = (t: string, p: string) => app.request(`/v1/sandbox/file?token=${encodeURIComponent(t)}&path=${encodeURIComponent(p)}`);
    const ok = await read(cfg.fsToken, "hello.txt");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("hi there");
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect((await read("forged.token", "hello.txt")).status).toBe(401);
    expect((await read(cfg.fsToken, "settings.json")).status).toBe(404);
    expect((await read(cfg.fsToken, "../../users.json")).status).toBe(404);
    // the proxy token is not a file token, nor the other way round
    const net = (await (await call("/v1/sandbox/config")).json()) as { token: string };
    expect((await read(net.token, "hello.txt")).status).toBe(401);
  });

  it("marks the proxy's own answers and answers preflights", async () => {
    const res = await app.request(`/v1/sandbox/proxy?url=${encodeURIComponent("http://10.0.0.1/")}`);
    expect(res.headers.get("x-chrysalis-proxy")).toBe("error");
    const pre = await app.request("/v1/sandbox/proxy?token=x&url=y", { method: "OPTIONS", headers: { "access-control-request-headers": "x-a, content-type" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toBe("x-a, content-type");
  });
});
