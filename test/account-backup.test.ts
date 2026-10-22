/**
 * Account backups: backups on this device (linked to the one before), the
 * tar a download or a transfer carries, restoring either, and pulling an
 * account from another engine with a transfer code.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import type { AppEnv } from "../src/server/app.js";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";
import * as git from "../src/git.js";
import { accountBackupsDir, extractAccountTar, runAutoBackups, suggestedFolders, tarStream } from "../src/account-backup.js";
import { invalidatePluginCache } from "../src/plugins/runtime.js";

interface Engine {
  dataDir: string;
  app: Hono<AppEnv>;
  token: string;
  userToken: string;
  call: (route: string, init?: RequestInit, as?: "admin" | "bob") => Promise<Response>;
}

const engines: Engine[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];

async function engine(instance: string): Promise<Engine> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-backup-"));
  const users = new UserService(dataDir);
  const token = users.create("admin", "admin", { password: "admin-pass-1" }).token;
  const userToken = users.create("bob", "user", { password: "bob-pass-1" }).token;
  for (const name of ["admin", "bob"]) {
    bootstrapUserDir(dataDir, name);
    await git.initRepo(userPaths(dataDir, name).root);
  }
  const config = defaultInstanceConfig();
  config.apps.packageDownloads = false;
  const app = buildApp({ users, sessions: new SessionService(dataDir), config, dataDir, bus: new EventBus(), instance });
  const call = async (route: string, init: RequestInit = {}, as: "admin" | "bob" = "admin") =>
    await app.request(route, {
      ...init,
      headers: { authorization: `Bearer ${as === "admin" ? token : userToken}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    });
  const e = { dataDir, app, token, userToken, call };
  engines.push(e);
  return e;
}

async function settle(e: Engine, as: "admin" | "bob" = "admin"): Promise<{ phase: string; error?: string }> {
  for (let i = 0; i < 400; i++) {
    const { job } = (await (await e.call("/v1/account/backups", {}, as)).json()) as { job: { phase: string; error?: string } | null };
    if (!job || job.phase === "done" || job.phase === "failed") return job ?? { phase: "done" };
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job did not finish");
}

function writeApp(dataDir: string, user: string, id: string, files: Record<string, string>): string {
  const dir = path.join(userPaths(dataDir, user).apps, id);
  for (const [rel, body] of Object.entries({ "manifest.json": JSON.stringify({ name: id, version: "1.0.0", kind: "app" }), ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const listBackups = async (e: Engine) =>
  ((await (await e.call("/v1/account/backups")).json()) as { backups: { id: string; label: string; files: number; bytes: number; added: number }[] }).backups;

async function uploadTar(e: Engine, bytes: Uint8Array, as: "admin" | "bob" = "admin"): Promise<Response> {
  const start = (await (await e.call("/v1/account/import", { method: "POST", body: JSON.stringify({ size: bytes.length }) }, as)).json()) as { id: string; chunk: number };
  for (let at = 0; at < bytes.length; at += start.chunk) {
    const res = await e.call(`/v1/account/import/${start.id}?offset=${at}`, { method: "PUT", body: bytes.subarray(at, at + start.chunk), headers: { "content-type": "application/octet-stream" } }, as);
    expect(res.status).toBe(200);
  }
  return e.call(`/v1/account/import/${start.id}/finish`, { method: "POST" }, as);
}

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const e of engines.splice(0)) {
    try { fs.rmSync(e.dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
  }
  invalidatePluginCache();
});

describe("backups on this device", () => {
  let a: Engine;
  beforeEach(async () => {
    a = await engine("a");
  });

  it("links what did not change, copies what did, and never links a live file", async () => {
    const dir = writeApp(a.dataDir, "admin", "studio", { "data/chat.jsonl": "one\n", "data/big.bin": "x".repeat(50_000) });
    fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "derived");
    fs.writeFileSync(path.join(dataDirCreds(a, "admin"), "auth.json"), JSON.stringify({ openai: { key: "sk-1" } }));

    expect((await a.call("/v1/account/backups", { method: "POST" })).status).toBe(202);
    expect((await settle(a)).phase).toBe("done");
    fs.appendFileSync(path.join(dir, "data", "chat.jsonl"), "two\n");
    expect((await a.call("/v1/account/backups", { method: "POST" })).status).toBe(202);
    expect((await settle(a)).phase).toBe("done");

    const [second, first] = await listBackups(a);
    expect(first!.label).toBe("manual");
    expect(second!.added).toBe(8);
    const base = accountBackupsDir(a.dataDir, "admin");
    const big = (id: string) => fs.statSync(path.join(base, id, "workspace", "apps", "studio", "data", "big.bin"));
    expect(big(second!.id).ino).toBe(big(first!.id).ino);
    expect(fs.statSync(path.join(dir, "data", "big.bin")).nlink).toBe(1);
    expect(fs.readFileSync(path.join(base, first!.id, "workspace", "apps", "studio", "data", "chat.jsonl"), "utf8")).toBe("one\n");
    expect(fs.existsSync(path.join(base, first!.id, "workspace", "apps", "studio", "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(base, first!.id, "workspace", ".git"))).toBe(false);
    expect(fs.existsSync(path.join(base, first!.id, "credentials", "auth.json"))).toBe(true);
  });

  it("restores a backup, keeps one of the account as it was, and keeps git history and packages", async () => {
    const dir = writeApp(a.dataDir, "admin", "studio", { "data/chat.jsonl": "kept\n" });
    await a.call("/v1/account/backups", { method: "POST" });
    await settle(a);
    const [taken] = await listBackups(a);

    fs.writeFileSync(path.join(dir, "data", "chat.jsonl"), "overwritten\n");
    writeApp(a.dataDir, "admin", "later", {});
    fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "installed");
    await git.commitAll(userPaths(a.dataDir, "admin").root, "admin", "before restore");

    expect((await a.call(`/v1/account/backups/${taken!.id}/restore`, { method: "POST" })).status).toBe(202);
    expect(await settle(a)).toEqual(expect.objectContaining({ phase: "done" }));
    expect(fs.readFileSync(path.join(dir, "data", "chat.jsonl"), "utf8")).toBe("kept\n");
    expect(fs.existsSync(path.join(userPaths(a.dataDir, "admin").apps, "later"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "node_modules", "dep", "index.js"), "utf8")).toBe("installed");
    const log = await git.log(userPaths(a.dataDir, "admin").root, 5);
    expect(log.map((c: { message: string }) => c.message.trim())).toContain("before restore");
    const labels = (await listBackups(a)).map((b) => b.label);
    expect(labels).toContain("before-restore");
    // the backup it was restored from is untouched by later writes
    fs.writeFileSync(path.join(dir, "data", "chat.jsonl"), "changed again\n");
    expect(fs.readFileSync(path.join(accountBackupsDir(a.dataDir, "admin"), taken!.id, "workspace", "apps", "studio", "data", "chat.jsonl"), "utf8")).toBe("kept\n");
  });

  it("an automatic backup is skipped when nothing changed, and old ones are pruned", async () => {
    writeApp(a.dataDir, "admin", "studio", { "data/a.json": "{}" });
    expect((await a.call("/v1/account/backups/settings", { method: "PUT", body: JSON.stringify({ auto: true, keep: 1 }) })).status).toBe(200);
    await runAutoBackups(a.dataDir, ["admin"]);
    expect((await listBackups(a)).map((b) => b.label)).toEqual(["auto"]);
    // a day later with no change: nothing new
    const base = accountBackupsDir(a.dataDir, "admin");
    const only = (await listBackups(a))[0]!;
    const meta = JSON.parse(fs.readFileSync(path.join(base, only.id, "backup.json"), "utf8"));
    meta.createdAt = new Date(Date.now() - 2 * 86400_000).toISOString();
    fs.writeFileSync(path.join(base, only.id, "backup.json"), JSON.stringify(meta));
    await runAutoBackups(a.dataDir, ["admin"]);
    expect((await listBackups(a)).length).toBe(1);
    fs.writeFileSync(path.join(userPaths(a.dataDir, "admin").apps, "studio", "data", "a.json"), "{\"b\":1}");
    await runAutoBackups(a.dataDir, ["admin"]);
    const after = await listBackups(a);
    expect(after.length).toBe(1);
    expect(after[0]!.id).not.toBe(only.id);
    expect((await a.call("/v1/account/backups/settings", { method: "PUT", body: JSON.stringify({ auto: true, keep: 0 }) })).status).toBe(400);
  });

  it("one account cannot see or restore another's backups", async () => {
    await a.call("/v1/account/backups", { method: "POST" });
    await settle(a);
    const [taken] = await listBackups(a);
    expect((await a.call(`/v1/account/backups/${taken!.id}/download`, {}, "bob")).status).toBe(404);
    expect((await a.call(`/v1/account/backups/${taken!.id}/restore`, { method: "POST" }, "bob")).status).toBe(404);
    expect((await a.call("/v1/account/backups/..%2F..%2Fadmin/restore", { method: "POST" }, "bob")).status).toBe(404);
  });
});

describe("a backup folder", () => {
  let a: Engine;
  let folder: string;
  beforeEach(async () => {
    a = await engine("a");
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "backup-folder-"));
  });
  afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));

  const put = (body: unknown, as: "admin" | "bob" = "admin") => a.call("/v1/account/backups/settings", { method: "PUT", body: JSON.stringify(body) }, as);

  it("takes new backups, lists them with the ones made before, and restores from it", async () => {
    const dir = writeApp(a.dataDir, "admin", "studio", { "data/chat.jsonl": "first\n" });
    await a.call("/v1/account/backups", { method: "POST" });
    await settle(a);
    expect((await put({ folder })).status).toBe(200);
    fs.writeFileSync(path.join(dir, "data", "chat.jsonl"), "second\n");
    await a.call("/v1/account/backups", { method: "POST" });
    await settle(a);

    const [inFolder, onDevice] = await listBackups(a) as (Awaited<ReturnType<typeof listBackups>>[number] & { inFolder?: boolean })[];
    expect(inFolder!.inFolder).toBe(true);
    expect(onDevice!.inFolder).toBeUndefined();
    const real = fs.realpathSync(folder);
    expect(fs.readFileSync(path.join(real, "Chrysalis", "admin", inFolder!.id, "workspace", "apps", "studio", "data", "chat.jsonl"), "utf8")).toBe("second\n");

    fs.writeFileSync(path.join(dir, "data", "chat.jsonl"), "third\n");
    await a.call(`/v1/account/backups/${inFolder!.id}/restore`, { method: "POST" });
    expect((await settle(a)).phase).toBe("done");
    expect(fs.readFileSync(path.join(dir, "data", "chat.jsonl"), "utf8")).toBe("second\n");

    // going back to the data folder keeps the folder's backups out of the list
    expect((await put({ folder: null })).status).toBe(200);
    expect((await listBackups(a)).every((b) => !(b as { inFolder?: boolean }).inFolder)).toBe(true);
  });

  it("is an admin's choice, outside the data folder, and says when it is away", async () => {
    expect((await put({ folder }, "bob")).status).toBe(403);
    expect((await a.call("/v1/account/backups/folders", {}, "bob")).status).toBe(403);
    expect((await put({ folder: path.join(a.dataDir, "users") })).status).toBe(400);
    expect((await put({ folder: path.join(folder, "missing") })).status).toBe(400);
    expect((await put({ folder: "relative/path" })).status).toBe(400);

    const listed = (await (await a.call(`/v1/account/backups/folders?path=${encodeURIComponent(path.dirname(folder))}`)).json()) as { folders: string[] };
    expect(listed.folders).toContain(path.basename(folder));

    const away = path.join(folder, "drive");
    fs.mkdirSync(away);
    expect((await put({ folder: away })).status).toBe(200);
    fs.rmSync(away, { recursive: true });
    expect((await put({ auto: false })).status).toBe(200);
    await a.call("/v1/account/backups", { method: "POST" });
    expect((await settle(a)).error).toContain("not reachable");
  });

  it("finds cloud folders a desktop app syncs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
    for (const p of ["My Drive", "Dropbox", "OneDrive - Work", "Documents", "Pictures"]) fs.mkdirSync(path.join(home, p));
    expect(suggestedFolders(home).map((s) => s.label)).toEqual(["Google Drive", "Dropbox", "OneDrive", "Documents"]);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

function dataDirCreds(e: Engine, user: string): string {
  return path.dirname(userPaths(e.dataDir, user).auth);
}

describe("backup files", () => {
  it("a download restores on another engine, with keys only when asked for and no app arriving official", async () => {
    const a = await engine("a");
    const b = await engine("b");
    writeApp(a.dataDir, "admin", "studio", { "data/chat.jsonl": "from a\n", [`data/${"long-name-".repeat(15)}ünï.json`]: "{}" });
    const creds = dataDirCreds(a, "admin");
    fs.writeFileSync(path.join(creds, "auth.json"), JSON.stringify({ openai: { key: "sk-secret" } }));
    fs.mkdirSync(path.join(creds, "app-upstream"), { recursive: true });
    fs.writeFileSync(path.join(creds, "app-upstream", "studio.source.json"), JSON.stringify({ git: "https://github.com/ProjectChrysalis/studio", ref: "HEAD" }));
    const secret = path.join(a.dataDir, "outside.txt");
    fs.writeFileSync(secret, "not the account's");
    fs.symlinkSync(secret, path.join(userPaths(a.dataDir, "admin").root, "leak.txt"));

    const withoutKeys = new Uint8Array(await (await a.call("/v1/account/export")).arrayBuffer());
    expect(Buffer.from(withoutKeys).includes("sk-secret")).toBe(false);
    expect(Buffer.from(withoutKeys).includes("not the account's")).toBe(false);
    const res = await a.call("/v1/account/export?keys=1");
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    const withKeys = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(withKeys).includes("sk-secret")).toBe(true);

    expect((await uploadTar(b, withKeys)).status).toBe(202);
    expect(await settle(b)).toEqual(expect.objectContaining({ phase: "done" }));
    const bApps = userPaths(b.dataDir, "admin").apps;
    expect(fs.readFileSync(path.join(bApps, "studio", "data", "chat.jsonl"), "utf8")).toBe("from a\n");
    expect(fs.existsSync(path.join(bApps, "studio", "data", `${"long-name-".repeat(15)}ünï.json`))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dataDirCreds(b, "admin"), "auth.json"), "utf8"))).toEqual({ openai: { key: "sk-secret" } });
    expect(JSON.parse(fs.readFileSync(path.join(dataDirCreds(b, "admin"), "app-upstream", "studio.source.json"), "utf8")).restored).toBe(true);
  });

  it("a restore into an account that is not an admin drops MCP servers that run programs", async () => {
    const a = await engine("a");
    writeApp(a.dataDir, "admin", "studio", {});
    fs.writeFileSync(path.join(dataDirCreds(a, "admin"), "mcp.json"), JSON.stringify({ servers: { local: { type: "stdio", command: "evil" }, web: { type: "http", url: "https://example.com/mcp" } } }));
    const tar = new Uint8Array(await (await a.call("/v1/account/export")).arrayBuffer());
    expect((await uploadTar(a, tar, "bob")).status).toBe(202);
    expect((await settle(a, "bob")).phase).toBe("done");
    const mcp = JSON.parse(fs.readFileSync(path.join(dataDirCreds(a, "bob"), "mcp.json"), "utf8"));
    expect(Object.keys(mcp.servers)).toEqual(["web"]);
    expect(fs.existsSync(path.join(userPaths(a.dataDir, "bob").apps, "studio", "manifest.json"))).toBe(true);
  });

  it("refuses names that leave the folder and files that are not backups", async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "tar-in-"));
    const enc = new TextEncoder();
    const evil = tarStream([{ name: "backup.json", data: enc.encode("{}") }, { name: "workspace/../../escape.txt", data: enc.encode("x") }]);
    await expect(extractAccountTar(evil, path.join(dest, "one"), { maxBytes: 1e9 })).rejects.toThrow(/outside its own folder/);
    expect(fs.existsSync(path.join(dest, "escape.txt"))).toBe(false);
    const junk = new Blob([new Uint8Array(2048).fill(7)]).stream();
    await expect(extractAccountTar(junk, path.join(dest, "two"), { maxBytes: 1e9 })).rejects.toThrow(/not a tar archive/);
    const unknown = tarStream([{ name: "backup.json", data: enc.encode(JSON.stringify({ format: 1, kind: "chrysalis-account" })) }, { name: "elsewhere/file", data: enc.encode("x") }, { name: "credentials/services-approved.json", data: enc.encode("{}") }]);
    await extractAccountTar(unknown, path.join(dest, "three"), { maxBytes: 1e9 });
    expect(fs.readdirSync(path.join(dest, "three"))).toEqual(["backup.json"]);
    const big = tarStream([{ name: "backup.json", data: enc.encode("{}") }, { name: "workspace/x", data: new Uint8Array(4096) }]);
    await expect(extractAccountTar(big, path.join(dest, "four"), { maxBytes: 1000 })).rejects.toThrow(/larger than/);
    const cut = new Uint8Array(await new Response(tarStream([{ name: "workspace/x", data: new Uint8Array(4096) }])).arrayBuffer()).subarray(0, 1500);
    await expect(extractAccountTar(new Blob([cut]).stream(), path.join(dest, "five"), { maxBytes: 1e9 })).rejects.toThrow(/ended early/);
    fs.rmSync(dest, { recursive: true, force: true });
  });
});

describe("moving an account between devices", () => {
  const serve = (e: Engine) => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => e.app.fetch(req) });
    servers.push(server);
    return `127.0.0.1:${server.port}`;
  };

  it("pulls the account with a code that works once", async () => {
    const a = await engine("a");
    const b = await engine("b");
    writeApp(a.dataDir, "admin", "studio", { "data/chat.jsonl": "moved\n" });
    writeApp(b.dataDir, "admin", "old", {});
    const address = serve(a);

    const offer = (await (await a.call("/v1/account/transfer", { method: "POST", body: JSON.stringify({ keys: false }) })).json()) as { code: string };
    expect(offer.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const wrong = await b.call("/v1/account/transfer/peek", { method: "POST", body: JSON.stringify({ address, code: "AAAA-AAAA" }) });
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as { error: string }).error).toBe("wrong code");

    const peek = (await (await b.call("/v1/account/transfer/peek", { method: "POST", body: JSON.stringify({ address, code: offer.code.toLowerCase() }) })).json()) as { from: string; files: number };
    expect(peek.from).toBe("admin");
    expect(peek.files).toBeGreaterThan(1);
    // the sending device cannot receive its own code
    expect((await a.call("/v1/account/transfer/peek", { method: "POST", body: JSON.stringify({ address, code: offer.code }) })).status).toBe(400);
    // receiving is an admin's to do
    expect((await b.call("/v1/account/transfer/receive", { method: "POST", body: JSON.stringify({ address, code: offer.code }) }, "bob")).status).toBe(403);

    expect((await b.call("/v1/account/transfer/receive", { method: "POST", body: JSON.stringify({ address: `http://${address}/#transfer=x`, code: offer.code }) })).status).toBe(202);
    expect(await settle(b)).toEqual(expect.objectContaining({ phase: "done" }));
    const bApps = userPaths(b.dataDir, "admin").apps;
    expect(fs.readFileSync(path.join(bApps, "studio", "data", "chat.jsonl"), "utf8")).toBe("moved\n");
    expect(fs.existsSync(path.join(bApps, "old"))).toBe(false);
    expect(((await (await a.call("/v1/account/transfer")).json()) as { offer: { state: string } }).offer.state).toBe("sent");

    const again = await b.call("/v1/account/transfer/peek", { method: "POST", body: JSON.stringify({ address, code: offer.code }) });
    expect(((await again.json()) as { error: string }).error).toMatch(/used or has expired/);
  });

  it("stops every code after too many wrong guesses", async () => {
    const a = await engine("a");
    await a.call("/v1/account/transfer", { method: "POST", body: "{}" });
    for (let i = 0; i < 20; i++) {
      const res = await a.app.request("/v1/transfer/info", { headers: { "x-chrysalis-transfer": `WRONG${String(i).padStart(3, "0")}` } });
      expect(res.status).toBe(403);
    }
    const locked = await a.app.request("/v1/transfer/info", { headers: { "x-chrysalis-transfer": "ANYTHING" } });
    expect(locked.status).toBe(429);
    expect(((await (await a.call("/v1/account/transfer")).json()) as { offer: unknown }).offer).toBeNull();
  });
});
