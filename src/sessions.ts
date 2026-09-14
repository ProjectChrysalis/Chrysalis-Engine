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

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "sessions.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { sessions?: SessionEntry[] };
      const now = Date.now();
      for (const s of raw.sessions ?? []) {
        if (typeof s?.hash === "string" && typeof s?.username === "string" && s.expiresAt > now) {
          this.sessions.set(s.hash, s);
        }
      }
    } catch {
      /* no sessions file yet */
    }
  }

  private save(): void {
    const sessions = [...this.sessions.values()];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ sessions }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  create(username: string): string {
    const token = crypto.randomBytes(32).toString("base64url");
    const entry: SessionEntry = { hash: sha256(token), username, expiresAt: Date.now() + SESSION_TTL_MS };
    this.sessions.set(entry.hash, entry);
    this.save();
    return token;
  }

  verify(token: string): { username: string } | null {
    if (!token) return null;
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
