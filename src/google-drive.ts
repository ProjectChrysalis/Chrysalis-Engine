/**
 * Account backups in the user's Google Drive.
 *
 * Signing in goes through Google's web flow with PKCE. Every engine has its
 * own address, so Google sends the user back to one fixed page on the
 * project site, which hands the code to the engine named in `state`. The
 * code alone is worthless: only the engine that started the flow holds the
 * verifier that redeems it.
 *
 * The scope is drive.file: Chrysalis sees the files it made and nothing else
 * in the Drive. Uploads leave API keys and sign-ins out, and the refresh
 * token sits with the account's credentials, outside the workspace and out of
 * every backup.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backupSources, tarStream, type BackupInfo, type BackupJob, AccountBackupError } from "./account-backup.js";

export const DRIVE_RELAY = "https://projectchrysalis.github.io/assets/google-drive.html";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Chrysalis backups";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Resumable upload chunks must be a multiple of 256 KiB. */
const CHUNK = 32 * 256 * 1024;
const FLOW_MS = 15 * 60 * 1000;
/** Every copy in Drive is a whole account, and free Drives hold 15 GB:
 *  only the newest automatic copies stay. Ones made by hand stay too. */
const DRIVE_KEEP = 2;

export interface GoogleClient {
  id: string;
  secret: string;
}

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  api: string;
  upload: string;
}

const GOOGLE: GoogleEndpoints = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  api: "https://www.googleapis.com/drive/v3",
  upload: "https://www.googleapis.com/upload/drive/v3",
};

interface DriveLink {
  refreshToken: string;
  email: string | null;
  folderId: string | null;
  connectedAt: string;
  /** The last upload, or why it failed. */
  last?: { at: string; name?: string; error?: string };
}

export interface DriveStatus {
  /** This server has a Google sign-in to offer. */
  available: boolean;
  connected: boolean;
  email: string | null;
  last: DriveLink["last"] | null;
}

export interface DriveBackup {
  id: string;
  name: string;
  bytes: number;
  createdAt: string;
  /** The account it was taken of. */
  from: string | null;
  label: string | null;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export class GoogleDrive {
  private flows = new Map<string, { username: string; verifier: string; expires: number }>();
  private tokens = new Map<string, { token: string; expires: number }>();
  private readonly ep: GoogleEndpoints;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: { dataDir: string; client: GoogleClient | null; endpoints?: GoogleEndpoints; fetch?: typeof fetch }) {
    this.ep = opts.endpoints ?? GOOGLE;
    this.fetch = opts.fetch ?? fetch;
  }

  private file(username: string): string {
    return path.join(this.opts.dataDir, "credentials", username, "google-drive.json");
  }

  private read(username: string): DriveLink | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(username), "utf8")) as DriveLink;
      return typeof raw.refreshToken === "string" && raw.refreshToken ? raw : null;
    } catch {
      return null;
    }
  }

  private write(username: string, link: DriveLink): void {
    const file = this.file(username);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(link, null, 2) + "\n", { mode: 0o600 });
  }

  private client(): GoogleClient {
    if (!this.opts.client) throw new AccountBackupError("Google Drive is not set up on this server", 422);
    return this.opts.client;
  }

  status(username: string): DriveStatus {
    const link = this.read(username);
    return { available: !!this.opts.client, connected: !!link, email: link?.email ?? null, last: link?.last ?? null };
  }

  connected(username: string): boolean {
    return !!this.opts.client && !!this.read(username);
  }

  /** The Google sign-in page for this account. `origin` is where the engine
   *  is open in the user's browser; the relay page sends them back there. */
  begin(username: string, origin: string): string {
    const client = this.client();
    const now = Date.now();
    for (const [k, f] of this.flows) if (f.expires < now) this.flows.delete(k);
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(Buffer.from(JSON.stringify({ o: origin, n: b64url(crypto.randomBytes(16)) })));
    this.flows.set(state, { username, verifier, expires: now + FLOW_MS });
    const q = new URLSearchParams({
      client_id: client.id,
      redirect_uri: DRIVE_RELAY,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      state,
    });
    return `${this.ep.auth}?${q}`;
  }

  /** Redeem the code Google sent back and remember the account. */
  async finish(username: string, state: string, code: string): Promise<void> {
    const flow = this.flows.get(state);
    if (!flow || flow.username !== username || flow.expires < Date.now()) throw new AccountBackupError("this sign-in expired: connect again", 400);
    this.flows.delete(state);
    const client = this.client();
    const got = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: client.id,
      client_secret: client.secret,
      redirect_uri: DRIVE_RELAY,
      code_verifier: flow.verifier,
    });
    if (!got.refresh_token) throw new AccountBackupError("Google did not grant offline access: connect again", 422);
    this.tokens.set(username, { token: got.access_token, expires: Date.now() + (got.expires_in - 60) * 1000 });
    const link: DriveLink = { refreshToken: got.refresh_token, email: null, folderId: null, connectedAt: new Date().toISOString() };
    this.write(username, link);
    const about = (await this.api(username, "GET", "/about?fields=user(emailAddress)")) as { user?: { emailAddress?: string } };
    this.write(username, { ...link, email: about.user?.emailAddress ?? null });
  }

  async disconnect(username: string): Promise<void> {
    const link = this.read(username);
    fs.rmSync(this.file(username), { force: true });
    this.tokens.delete(username);
    if (link) await this.fetch(`${this.ep.revoke}?token=${encodeURIComponent(link.refreshToken)}`, { method: "POST" }).catch(() => undefined);
  }

  private async tokenRequest(form: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const res = await this.fetch(this.ep.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      const reason = body.error === "invalid_grant" ? "Google access was removed: connect again" : `Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`;
      throw new AccountBackupError(reason, 422);
    }
    return { access_token: body.access_token, expires_in: body.expires_in ?? 3600, ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}) };
  }

  private async token(username: string): Promise<string> {
    const cached = this.tokens.get(username);
    if (cached && cached.expires > Date.now()) return cached.token;
    const link = this.read(username);
    if (!link) throw new AccountBackupError("Google Drive is not connected", 400);
    const client = this.client();
    const got = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: link.refreshToken, client_id: client.id, client_secret: client.secret });
    this.tokens.set(username, { token: got.access_token, expires: Date.now() + (got.expires_in - 60) * 1000 });
    return got.access_token;
  }

  private async call(username: string, method: string, url: string, init: { headers?: Record<string, string>; body?: string | Uint8Array } = {}): Promise<Response> {
    const res = await this.fetch(url, { method, headers: { authorization: `Bearer ${await this.token(username)}`, ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}) });
    if (res.status === 401) this.tokens.delete(username);
    return res;
  }

  private async api(username: string, method: string, rel: string, json?: unknown): Promise<unknown> {
    const res = await this.call(username, method, `${this.ep.api}${rel}`, json === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
    if (res.status === 204) return null;
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) throw new AccountBackupError(`Google Drive: ${body?.error?.message ?? res.status}`, 422);
    return body;
  }

  /** The "Chrysalis backups" folder, made on first use. */
  private async folder(username: string): Promise<string> {
    const link = this.read(username);
    if (!link) throw new AccountBackupError("Google Drive is not connected", 400);
    if (link.folderId) {
      const f = (await this.api(username, "GET", `/files/${link.folderId}?fields=id,trashed`).catch(() => null)) as { trashed?: boolean } | null;
      if (f && !f.trashed) return link.folderId;
    }
    const q = encodeURIComponent(`mimeType='${FOLDER_MIME}' and name='${FOLDER_NAME}' and trashed=false`);
    const found = (await this.api(username, "GET", `/files?q=${q}&fields=files(id)&spaces=drive`)) as { files?: { id: string }[] };
    const id = found.files?.[0]?.id ?? ((await this.api(username, "POST", "/files?fields=id", { name: FOLDER_NAME, mimeType: FOLDER_MIME })) as { id: string }).id;
    this.write(username, { ...link, folderId: id });
    return id;
  }

  /** Upload one backup as a .tar, then drop older automatic copies. */
  async upload(username: string, backup: BackupInfo, job?: BackupJob): Promise<void> {
    const link = this.read(username);
    if (!link) return;
    const name = `chrysalis-${username}-${backup.createdAt.slice(0, 16).replace(":", "-")}.tar`;
    try {
      const parent = await this.folder(username);
      const about = (await this.api(username, "GET", "/about?fields=storageQuota(limit,usage)")) as { storageQuota?: { limit?: string; usage?: string } };
      const limit = Number(about.storageQuota?.limit ?? NaN);
      // an older automatic copy goes after this one lands, so it does not count as room
      if (Number.isFinite(limit) && limit - Number(about.storageQuota?.usage ?? 0) < backup.bytes) {
        throw new AccountBackupError("not enough space in your Google Drive for this backup", 507);
      }
      const meta = {
        name,
        parents: [parent],
        mimeType: "application/x-tar",
        appProperties: { chrysalis: "backup", account: username, label: backup.label, createdAt: backup.createdAt },
      };
      const start = await this.call(username, "POST", `${this.ep.upload}/files?uploadType=resumable`, {
        headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": "application/x-tar" },
        body: JSON.stringify(meta),
      });
      const session = start.headers.get("location");
      if (!start.ok || !session) throw new AccountBackupError(`Google Drive refused the upload (${start.status})`, 422);
      if (job) {
        job.phase = "uploading";
        job.done = 0;
        job.total = backup.bytes;
      }
      await this.sendChunks(username, session, tarStream(backupSources(this.opts.dataDir, username, backup.id, false)), job);
      this.write(username, { ...(this.read(username) ?? link), last: { at: new Date().toISOString(), name } });
      await this.prune(username, parent);
    } catch (e) {
      const current = this.read(username);
      if (current) this.write(username, { ...current, last: { at: new Date().toISOString(), name, error: (e as Error).message } });
      throw e;
    }
  }

  private async sendChunks(username: string, session: string, stream: ReadableStream<Uint8Array>, job?: BackupJob): Promise<void> {
    const reader = stream.getReader();
    let buf = new Uint8Array(CHUNK);
    let fill = 0;
    let sent = 0;
    const put = async (bytes: Uint8Array, total: number | null) => {
      const range = bytes.length ? `bytes ${sent}-${sent + bytes.length - 1}/${total ?? "*"}` : `bytes */${total}`;
      for (let attempt = 0; ; attempt++) {
        const res = await this.call(username, "PUT", session, { headers: { "content-range": range }, body: bytes });
        if (res.status === 308 || res.ok) break;
        if (res.status < 500 || attempt >= 3) throw new AccountBackupError(`Google Drive stopped the upload (${res.status})`, 422);
        await Bun.sleep(1000 * 2 ** attempt);
      }
      sent += bytes.length;
      if (job) job.done = sent;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      let at = 0;
      while (at < value.length) {
        const take = Math.min(CHUNK - fill, value.length - at);
        buf.set(value.subarray(at, at + take), fill);
        fill += take;
        at += take;
        if (fill === CHUNK) {
          await put(buf, null);
          buf = new Uint8Array(CHUNK);
          fill = 0;
        }
      }
    }
    await put(buf.subarray(0, fill), sent + fill);
  }

  private async prune(username: string, parent: string): Promise<void> {
    const autos = (await this.list(username, parent)).filter((b) => b.label === "auto" && b.from === username);
    for (const old of autos.slice(DRIVE_KEEP)) await this.api(username, "DELETE", `/files/${old.id}`);
  }

  /** Backups in the Drive folder, newest first. */
  async list(username: string, parent?: string): Promise<DriveBackup[]> {
    const folder = parent ?? (await this.folder(username));
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
    const out: DriveBackup[] = [];
    let page = "";
    do {
      const got = (await this.api(username, "GET", `/files?q=${q}&orderBy=createdTime desc&pageSize=100&fields=nextPageToken,files(id,name,size,createdTime,appProperties)${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`)) as {
        nextPageToken?: string;
        files?: { id: string; name: string; size?: string; createdTime: string; appProperties?: Record<string, string> }[];
      };
      for (const f of got.files ?? []) {
        out.push({ id: f.id, name: f.name, bytes: Number(f.size ?? 0), createdAt: f.appProperties?.createdAt ?? f.createdTime, from: f.appProperties?.account ?? null, label: f.appProperties?.label ?? null });
      }
      page = got.nextPageToken ?? "";
    } while (page);
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Download a backup from the Drive folder into `file`. */
  async download(username: string, id: string, file: string, job?: BackupJob): Promise<void> {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new AccountBackupError("unknown backup", 404);
    const folder = await this.folder(username);
    const meta = (await this.api(username, "GET", `/files/${id}?fields=size,parents`)) as { size?: string; parents?: string[] };
    if (!meta.parents?.includes(folder)) throw new AccountBackupError("unknown backup", 404);
    const res = await this.call(username, "GET", `${this.ep.api}/files/${id}?alt=media`);
    if (!res.ok || !res.body) throw new AccountBackupError(`Google Drive could not send the backup (${res.status})`, 422);
    if (job) {
      job.phase = "downloading";
      job.done = 0;
      job.total = Number(meta.size ?? 0);
    }
    const out = fs.createWriteStream(file, { mode: 0o600 });
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
        if (job) job.done += chunk.length;
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
  }
}

/** The Google OAuth client Chrysalis ships; null until one is registered. */
const SHIPPED_CLIENT: GoogleClient | null = null;

export function googleClientOf(cfg: { google: { clientId: string | null; clientSecret: string | null } }): GoogleClient | null {
  if (cfg.google.clientId && cfg.google.clientSecret) return { id: cfg.google.clientId, secret: cfg.google.clientSecret };
  return SHIPPED_CLIENT;
}
