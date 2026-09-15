/**
 * Cookie-backed login sessions. Tokens are
 * random 32-byte strings handed to the browser in an HttpOnly cookie; only
 * their sha256 hash is persisted (data/sessions.json, outside user repos).
 * Bearer tokens remain valid for headless/API access — these are the web
 * client's sessions.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionEntry {
  hash: string;
  username: string;
  expiresAt: number;
}

export class SessionService {
  private file: string;
  private sessions = new Map<string, SessionEntry>();
  /** mtime of the file as loaded, so a reload is one stat when nothing has
   *  changed — which is every request but the few that follow a write. */
  private loadedMtime = -1;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "sessions.json");
    this.load();
  }

  /** Re-read the file. More than one process writes it — the engine, and a
   *  `chrysalis api` call on the same machine minting one for itself — so a
   *  long-running engine cannot treat what it read at boot as the whole
   *  truth, and a short-lived command must not save over what it never saw. */
  private load(): void {
    const fresh = new Map<string, SessionEntry>();
    try {
      this.loadedMtime = fs.statSync(this.file).mtimeMs;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { sessions?: SessionEntry[] };
      const now = Date.now();
      for (const s of raw.sessions ?? []) {
        if (typeof s?.hash === "string" && typeof s?.username === "string" && s.expiresAt > now) {
          fresh.set(s.hash, s);
        }
      }
    } catch {
      this.loadedMtime = -1; /* no sessions file yet */
    }
    this.sessions = fresh;
  }

  /** True when the file has been written since this process read it. */
  private changedOnDisk(): boolean {
    try {
      return fs.statSync(this.file).mtimeMs !== this.loadedMtime;
    } catch {
      return this.loadedMtime !== -1;
    }
  }

  private save(): void {
    const sessions = [...this.sessions.values()];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ sessions }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
    try { this.loadedMtime = fs.statSync(this.file).mtimeMs; } catch { /* stat failed: next read reloads */ }
  }

  create(username: string): string {
    this.load(); // never write back a file we have not just read
    const token = crypto.randomBytes(32).toString("base64url");
    const entry: SessionEntry = { hash: sha256(token), username, expiresAt: Date.now() + SESSION_TTL_MS };
    this.sessions.set(entry.hash, entry);
    this.save();
    return token;
  }

  verify(token: string): { username: string } | null {
    if (!token) return null;
    // More than one process writes this file, so what was read at boot is not
    // the whole truth: a session another one minted has to be honoured, and
    // one it revoked has to stop working here. A stat per check settles both,
    // and the file only moves when something actually signs in or out.
    if (this.changedOnDisk()) this.load();
    const entry = this.sessions.get(sha256(token));
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(entry.hash);
      this.save();
      return null;
    }
    return { username: entry.username };
  }

  destroy(token: string): void {
    this.load();
    if (this.sessions.delete(sha256(token))) this.save();
  }

  /** Sign an account out everywhere, except the session `keep` belongs to.
   *  A new password must end the sessions it replaces, and a deleted
   *  account's sessions must not come back with the next account of that
   *  name. */
  destroyUser(username: string, keep?: string): void {
    const kept = keep ? sha256(keep) : null;
    let changed = false;
    for (const [hash, entry] of this.sessions) {
      if (entry.username === username && hash !== kept) {
        this.sessions.delete(hash);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Keep sessions valid across an account rename. */
  renameUser(oldUsername: string, next: string): void {
    let changed = false;
    for (const entry of this.sessions.values()) {
      if (entry.username === oldUsername) {
        entry.username = next;
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}
