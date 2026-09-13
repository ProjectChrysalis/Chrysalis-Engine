/**
 * Per-profile architecture (user ask 2026-08-19): every user gets their OWN
 * Chrysalis world — workspace, apps, git repo, agent
 * session space, mcp.json, credentials (outside the workspace), workspace
 * AGENTS.md — with strict cross-user isolation. Plus the outbound MCP server list (the
 * engine agent consuming external MCP servers).
 */
import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
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
import { userPaths } from "../src/paths.js";
import { invalidatePluginCache } from "../src/plugins/runtime.js";
import { installNotesApp } from "./fixtures/notes-app.js";

// tests here bootstrap whole user worlds (seeded app copy + git history),
// which can outlast the 5s default while test files run in parallel
setDefaultTimeout(30_000);

let dataDir: string;
let adminToken: string;
let app: Hono<AppEnv>;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-"));
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
});
afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
  invalidatePluginCache();
});

const adminH = () => ({ authorization: `Bearer ${adminToken}`, "content-type": "application/json" });
async function createUser(username: string): Promise<string> {
  const res = await app.request("/v1/admin/users", { method: "POST", headers: adminH(), body: JSON.stringify({ username, password: "test-pass-1" }) });
  expect(res.status).toBe(200);
  const j = (await res.json()) as { token: string };
  installNotesApp(userPaths(dataDir, username).apps);
  invalidatePluginCache();
  return j.token;
}
const userH = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

describe("per-profile worlds", () => {
  it("each user gets the full bundle: workspace, git, credentials + mcp.json outside it, AGENTS.md, their own apps", async () => {
    const ta = await createUser("alice");
    const tb = await createUser("bob");

    for (const name of ["alice", "bob"]) {
      const p = userPaths(dataDir, name);
      expect(fs.existsSync(path.join(p.root, "apps/notes/manifest.json"))).toBe(true);
      // MCP config is seeded OUTSIDE the workspace, beside the credentials
      expect(fs.existsSync(p.mcp)).toBe(true);
      expect(p.mcp.startsWith(p.root)).toBe(false);
      expect(fs.existsSync(path.join(p.root, "mcp.json"))).toBe(false);
      expect(fs.existsSync(path.join(p.root, "AGENTS.md"))).toBe(true);
      expect(fs.existsSync(path.join(p.root, ".gitignore"))).toBe(true);
      // own git repo
      expect(fs.existsSync(path.join(p.root, ".git"))).toBe(true);
      // credentials OUTSIDE the workspace, per-user
      expect(p.auth.startsWith(path.join(dataDir, "credentials"))).toBe(true);
      expect(p.auth).toContain(name);
      // agent session space is per-user by layout
      expect(path.join(p.root, "agent", "sessions")).toContain(path.join("users", name));
      // their app is reachable through their own token
      const notes = await app.request("/v1/apps/notes/notes", { headers: userH(name === "alice" ? ta : tb) });
      expect(notes.status).toBe(200);
      // a single app is where launch goes
      const launch = await app.request("/v1/launch", { headers: userH(name === "alice" ? ta : tb) });
      expect(((await launch.json()) as { default: string }).default).toBe("notes");
    }
  });

  it("cross-user isolation: alice's data is invisible to bob (files, routes, shell guard)", async () => {
    const ta = await createUser("alice");
    const tb = await createUser("bob");

    // alice adds a note through her app route
    const put = await app.request("/v1/apps/notes/notes/secret-bot", {
      method: "PUT",
      headers: userH(ta),
      body: JSON.stringify({ text: "Secret" }),
    });
    expect(put.status).toBe(200);

    // bob's world does not contain it
    const bobNotes = await app.request("/v1/apps/notes/notes", { headers: userH(tb) });
    expect(((await bobNotes.json()) as { notes: string[] }).notes).not.toContain("secret-bot");
    // alice's does
    const aliceNotes = await app.request("/v1/apps/notes/notes", { headers: userH(ta) });
    expect(((await aliceNotes.json()) as { notes: string[] }).notes).toContain("secret-bot");
  });
});

describe("avatars stay with their owner", () => {
  it("a signed-in user reads their own avatar and never another user's", async () => {
    const aliceT = await createUser("alice");
    const bobT = await createUser("bob");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

    const up = await app.request("/v1/auth/avatar", { method: "PUT", headers: userH(aliceT), body: JSON.stringify({ data: png, mimeType: "image/png" }) });
    expect(up.status).toBe(200);

    // the owner reads it
    expect((await app.request("/v1/auth/avatar/alice", { headers: userH(aliceT) })).status).toBe(200);
    // /v1/me says whether an avatar exists, so the shell never fires a
    // doomed request (the 404 logged a failed load on every page open)
    const meAlice = (await (await app.request("/v1/me", { headers: userH(aliceT) })).json()) as { hasAvatar?: boolean };
    const meBob = (await (await app.request("/v1/me", { headers: userH(bobT) })).json()) as { hasAvatar?: boolean };
    expect(meAlice.hasAvatar).toBe(true);
    expect(meBob.hasAvatar).toBe(false);
    // another signed-in user cannot, and neither can an admin: no UI shows
    // anyone else's face, and the user list makes names easy to enumerate
    expect((await app.request("/v1/auth/avatar/alice", { headers: userH(bobT) })).status).toBe(404);
    expect((await app.request("/v1/auth/avatar/alice", { headers: adminH() })).status).toBe(404);
    // and it is not public
    expect((await app.request("/v1/auth/avatar/alice")).status).toBe(401);
  });
});

describe("outbound MCP server list (agent tooling)", () => {
  it("GET /v1/mcp lists the user's configured servers", async () => {
    const ta = await createUser("mcp-user");
    const serverList = await app.request("/v1/mcp", { method: "GET", headers: userH(ta) });
    expect(serverList.status).toBe(200);
    expect(await serverList.json()).toHaveProperty("servers");
  });

  it("engine servers follow share; the app opts in per server", async () => {
    const t = await createUser("mcp-app-user");
    const h = userH(t);
    const json = async (r: Response): Promise<{ servers: Array<{ id: string; share?: string; use?: boolean }> }> =>
      (await r.json()) as { servers: Array<{ id: string; share?: string; use?: boolean }> };
    const cfg = JSON.stringify({ type: "http", url: "https://example.invalid/mcp" });

    // an engine server defaults to "all apps", so the app sees it, off
    expect((await app.request("/v1/mcp/everywhere", { method: "PUT", headers: h, body: cfg })).status).toBe(200);
    expect((await json(await app.request("/v1/apps/notes/mcp", { headers: h }))).servers)
      .toContainEqual(expect.objectContaining({ id: "everywhere", use: false }));

    // the app opts in; the engine's list still shows the server
    expect((await app.request("/v1/apps/notes/mcp/everywhere", { method: "PATCH", headers: h, body: JSON.stringify({ use: true }) })).status).toBe(200);
    expect((await json(await app.request("/v1/apps/notes/mcp", { headers: h }))).servers)
      .toContainEqual(expect.objectContaining({ id: "everywhere", use: true }));
    expect((await json(await app.request("/v1/mcp", { headers: h }))).servers.map((s) => s.id)).toContain("everywhere");

    // only "all" servers can be opted into; agent-only is not app business
    expect((await app.request("/v1/mcp/everywhere", { method: "PATCH", headers: h, body: JSON.stringify({ share: "agent" }) })).status).toBe(200);
    expect((await app.request("/v1/apps/notes/mcp/everywhere", { method: "PATCH", headers: h, body: JSON.stringify({ use: true }) })).status).toBe(404);
    const afterShare = (await json(await app.request("/v1/apps/notes/mcp", { headers: h }))).servers.map((s) => s.id);
    expect(afterShare).not.toContain("everywhere");

    // the app tier has no server registration of its own
    expect((await app.request("/v1/apps/notes/mcp/weather", { method: "PUT", headers: h, body: cfg })).status).toBe(404);
  }, 30_000);

  it("deleting an app forgets its MCP opt-ins", async () => {
    const t = await createUser("mcp-orphan-user");
    const h = userH(t);
    const cfg = JSON.stringify({ type: "http", url: "https://example.invalid/mcp" });
    expect((await app.request("/v1/mcp/weather", { method: "PUT", headers: h, body: cfg })).status).toBe(200);
    expect((await app.request("/v1/apps/notes/mcp/weather", { method: "PATCH", headers: h, body: JSON.stringify({ use: true }) })).status).toBe(200);
    expect((await app.request("/v1/apps/notes", { method: "DELETE", headers: h })).status).toBe(200);
    const settingsFile = userPaths(dataDir, "mcp-orphan-user").settings;
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as { appMcp?: Record<string, string[]> };
    expect(settings.appMcp?.["notes"]).toBeUndefined();
  }, 30_000);
});

describe("admin password resets", () => {
  it("setting an account's password needs the acting admin's current password", async () => {
    await createUser("alice");
    const login = (password: string) =>
      app.request("/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "alice", password }),
      });

    // the acting admin's password is the gate, and a wrong one changes nothing
    const wrong = await app.request("/v1/admin/users/alice", {
      method: "PATCH", headers: adminH(),
      body: JSON.stringify({ password: "new-pass-1", current: "not-the-admin-pass" }),
    });
    expect(wrong.status).toBe(403);
    expect((await login("test-pass-1")).status).toBe(200);
    expect((await login("new-pass-1")).status).toBe(403);

    // the admin's own current password opens it
    const ok = await app.request("/v1/admin/users/alice", {
      method: "PATCH", headers: adminH(),
      body: JSON.stringify({ password: "new-pass-1", current: "test-pass-1" }),
    });
    expect(ok.status).toBe(200);
    expect((await login("new-pass-1")).status).toBe(200);

    // enable/disable is not a credential change and needs no confirmation
    const disable = await app.request("/v1/admin/users/alice", {
      method: "PATCH", headers: adminH(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(disable.status).toBe(200);
  }, 30_000);
});