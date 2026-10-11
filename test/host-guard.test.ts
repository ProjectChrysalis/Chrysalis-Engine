import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/server/app.js";
import { defaultInstanceConfig } from "../src/config.js";
import { UserService } from "../src/users.js";
import { SessionService } from "../src/sessions.js";
import { EventBus } from "../src/server/ws.js";

let dataDir: string;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-guard-")); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

it("a wildcard host name allows every name under it and nothing else", async () => {
  const config = defaultInstanceConfig();
  config.allowedHosts = ["box.lan", "*.tunnel.example"];
  const app = buildApp({ users: new UserService(dataDir), sessions: new SessionService(dataDir), config, dataDir, bus: new EventBus() });
  const refused = async (host: string) => (await app.request("/v1/health", { headers: { host } })).status === 403;
  for (const host of ["localhost:8788", "192.168.1.20:8788", "box.lan", "one.tunnel.example", "a.b.tunnel.example:443"]) expect([host, await refused(host)]).toEqual([host, false]);
  for (const host of ["tunnel.example", "eviltunnel.example", "one.tunnel.example.evil.com", "other.lan"]) expect([host, await refused(host)]).toEqual([host, true]);
  config.allowedHosts = [];
  expect(await refused("one.tunnel.example")).toBe(true);
});
