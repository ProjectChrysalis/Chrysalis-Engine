/**
 * Backups in Google Drive, against a stand-in for Google's sign-in and
 * Drive APIs: the PKCE sign-in, resumable uploads in chunks, keeping only
 * the newest automatic copies, refusing a full Drive, and restoring.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBackup } from "../src/account-backup.js";
import { defaultInstanceConfig } from "../src/config.js";
import { DRIVE_RELAY, GoogleDrive } from "../src/google-drive.js";
import * as git from "../src/git.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";

interface StoredFile { id: string; name: string; mimeType?: string; parents: string[]; appProperties?: Record<string, string>; createdTime: string; data: Buffer }

function fakeGoogle() {
  const files = new Map<string, StoredFile>();
  const sessions = new Map<string, { meta: Omit<StoredFile, "id" | "data" | "createdTime">; parts: Buffer[] }>();
  const challenges = new Map<string, string>();
  const quota = { limit: 15 * 1024 ** 3, usage: 0 };
  const revoked: string[] = [];
  let seq = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/token") {
        const form = new URLSearchParams(await req.text());
        if (form.get("client_secret") !== "secret") return Response.json({ error: "invalid_client" }, { status: 401 });
        if (form.get("grant_type") === "refresh_token") return Response.json({ access_token: "at", expires_in: 3600 });
        const want = challenges.get(form.get("code") ?? "");
        const got = crypto.createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!want || want !== got || form.get("redirect_uri") !== DRIVE_RELAY) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: "at", expires_in: 3600, refresh_token: "rt" });
      }
      if (p === "/revoke") {
        revoked.push(url.searchParams.get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      if (req.headers.get("authorization") !== "Bearer at") return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
      if (p === "/api/about") return Response.json({ user: { emailAddress: "alice@example.com" }, storageQuota: { limit: String(quota.limit), usage: String(quota.usage) } });
      if (p === "/api/files" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const parent = /'([^']+)' in parents/.exec(q)?.[1];
        const list = [...files.values()].filter((f) => (parent ? f.parents.includes(parent) : q.includes(`name='${f.name}'`) && f.mimeType === "application/vnd.google-apps.folder"));
        return Response.json({ files: list.map((f) => ({ id: f.id, name: f.name, size: String(f.data.length), createdTime: f.createdTime, appProperties: f.appProperties })) });
      }
      if (p === "/api/files" && req.method === "POST") {
        const meta = (await req.json()) as { name: string; mimeType: string };
        const id = `folder${++seq}xxxxxx`;
        files.set(id, { id, ...meta, parents: [], createdTime: new Date().toISOString(), data: Buffer.alloc(0) });
        return Response.json({ id });
      }
      const one = /^\/api\/files\/([^/]+)$/.exec(p);
      if (one) {
        const f = files.get(one[1]!);
        if (!f) return Response.json({ error: { message: "not found" } }, { status: 404 });
        if (req.method === "DELETE") {
          files.delete(f.id);
          return new Response(null, { status: 204 });
        }
        if (url.searchParams.get("alt") === "media") return new Response(f.data);
        return Response.json({ id: f.id, size: String(f.data.length), parents: f.parents, trashed: false });
      }
      if (p === "/upload/files" && req.method === "POST") {
        const id = `s${++seq}`;
        sessions.set(id, { meta: (await req.json()) as StoredFile, parts: [] });
        return new Response(null, { status: 200, headers: { location: `${url.origin}/session/${id}` } });
      }
      const session = /^\/session\/(.+)$/.exec(p);
      if (session && req.method === "PUT") {
        const s = sessions.get(session[1]!)!;
        const range = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(req.headers.get("content-range") ?? "")!;
        const body = Buffer.from(await req.arrayBuffer());
        if (range[1] !== undefined) {
          // every chunk but the last is a multiple of 256 KiB
          if (range[3] === "*" && body.length % (256 * 1024) !== 0) return new Response("bad chunk", { status: 400 });
          s.parts.push(body);
        }
        if (range[3] === "*") return new Response(null, { status: 308 });
        const id = `file${++seq}xxxxxxxx`;
        const data = Buffer.concat(s.parts);
        files.set(id, { id, ...s.meta, createdTime: new Date().toISOString(), data });
        quota.usage += data.length;
        return Response.json({ id });
      }
      return new Response("unexpected", { status: 500 });
    },
  });
  const base = `http://localhost:${server.port}`;
  const endpoints = { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, api: `${base}/api`, upload: `${base}/upload` };
  /** What Google's page does: the user agrees, the code is tied to the challenge. */
  const consent = (authUrl: string) => {
    const u = new URL(authUrl);
    const code = `code${++seq}`;
    challenges.set(code, u.searchParams.get("code_challenge")!);
    return { code, state: u.searchParams.get("state")!, url: u };
  };
  return { server, files, quota, revoked, endpoints, consent };
}

let dataDir: string;
let google: ReturnType<typeof fakeGoogle>;
beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
  google = fakeGoogle();
});
afterEach(() => {
  google.server.stop(true);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const client = { id: "client", secret: "secret" };

async function account(name: string) {
  bootstrapUserDir(dataDir, name);
  const p = userPaths(dataDir, name);
  await git.initRepo(p.root);
  fs.mkdirSync(path.dirname(p.auth), { recursive: true });
  fs.writeFileSync(p.auth, JSON.stringify({ openai: { key: "sk-secret" } }));
  return p;
}

it("signs in with PKCE, uploads in chunks, keeps the newest automatic copies and leaves keys out", async () => {
  const p = await account("alice");
  const drive = new GoogleDrive({ dataDir, client, endpoints: google.endpoints });
  const { code, state, url } = google.consent(drive.begin("alice", "http://192.168.1.20:8788"));
  expect(url.searchParams.get("redirect_uri")).toBe(DRIVE_RELAY);
  expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
  expect(JSON.parse(Buffer.from(state, "base64url").toString()).o).toBe("http://192.168.1.20:8788");

  await expect(drive.finish("bob", state, code)).rejects.toThrow("expired");
  await drive.finish("alice", state, code);
  await expect(drive.finish("alice", state, code)).rejects.toThrow("expired");
  expect(drive.status("alice")).toMatchObject({ available: true, connected: true, email: "alice@example.com" });
  expect(fs.statSync(path.join(path.dirname(p.auth), "google-drive.json")).mode & 0o777).toBe(0o600);

  // big enough to need more than one chunk
  fs.writeFileSync(path.join(p.root, "notes", "big.bin"), crypto.randomBytes(9 * 1024 * 1024));
  const manual = (await createBackup(dataDir, "alice", "manual"))!;
  await drive.upload("alice", manual);
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(p.root, "notes", "day.md"), `day ${i}\n`);
    await drive.upload("alice", (await createBackup(dataDir, "alice", "auto"))!);
  }
  const listed = await drive.list("alice");
  expect(listed.map((b) => b.label)).toEqual(["auto", "auto", "manual"]);
  const tar = [...google.files.values()].find((f) => f.appProperties?.label === "manual")!.data;
  expect(tar.length).toBeGreaterThan(9 * 1024 * 1024);
  expect(tar.includes("big.bin")).toBe(true);
  expect(tar.includes("credentials/auth.json")).toBe(false);
  expect(tar.includes("sk-secret")).toBe(false);
  expect(drive.status("alice").last).toMatchObject({ name: expect.stringContaining("chrysalis-alice-") });

  google.quota.usage = google.quota.limit - 1024;
  await expect(drive.upload("alice", manual)).rejects.toThrow("not enough space");
  expect(drive.status("alice").last?.error).toContain("not enough space");

  await drive.disconnect("alice");
  expect(google.revoked).toEqual(["rt"]);
  expect(drive.status("alice").connected).toBe(false);
}, 60_000);

it("connects through the callback, copies a backup up, and restores from it", async () => {
  const users = new UserService(dataDir);
  const token = users.create("alice", "user", { password: "alice-pass-1" }).token;
  const p = await account("alice");
  const drive = new GoogleDrive({ dataDir, client, endpoints: google.endpoints });
  const config = defaultInstanceConfig();
  config.apps.packageDownloads = false;
  const app = buildApp({ users, sessions: new SessionService(dataDir), config, dataDir, bus: new EventBus(), drive });
  const call = (route: string, init: RequestInit = {}) => app.request(route, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const settle = async () => {
    for (let i = 0; i < 400; i++) {
      const { job } = (await (await call("/v1/account/backups")).json()) as { job: { phase: string; error?: string } | null };
      if (job && (job.phase === "done" || job.phase === "failed")) return job;
      await Bun.sleep(25);
    }
    throw new Error("the job never finished");
  };

  fs.writeFileSync(path.join(p.root, "notes", "story.md"), "the original\n");
  expect((await call("/v1/account/drive/connect", { method: "POST", body: JSON.stringify({ origin: "javascript:alert(1)" }) })).status).toBe(400);
  const { url } = (await (await call("/v1/account/drive/connect", { method: "POST", body: JSON.stringify({ origin: "http://localhost:8788" }) })).json()) as { url: string };
  const { code, state } = google.consent(url);
  const back = await call(`/v1/account/drive/callback?code=${code}&state=${encodeURIComponent(state)}`);
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe("/#drive=connected");
  expect((await settle()).phase).toBe("done");

  const { backups } = (await (await call("/v1/account/drive/backups")).json()) as { backups: { id: string }[] };
  expect(backups).toHaveLength(1);
  fs.writeFileSync(path.join(p.root, "notes", "story.md"), "changed since\n");
  expect((await call(`/v1/account/drive/backups/${backups[0]!.id}/restore`, { method: "POST" })).status).toBe(202);
  expect(await settle()).toMatchObject({ phase: "done" });
  expect(fs.readFileSync(path.join(p.root, "notes", "story.md"), "utf8")).toBe("the original\n");
  // a backup without keys keeps the ones already here
  expect(fs.readFileSync(p.auth, "utf8")).toContain("sk-secret");

  const denied = await call(`/v1/account/drive/callback?error=access_denied&state=${encodeURIComponent(state)}`);
  expect(denied.headers.get("location")).toBe("/#drive=cancelled");
}, 60_000);
