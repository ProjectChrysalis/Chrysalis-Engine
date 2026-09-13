/**
 * users.json management: accounts with a mandatory login password (pick your
 * account on the login screen, then enter it) and bcrypt-hashed bearer
 * tokens for headless API access. No signup: the first account comes from
 * the first-run setup link, the rest from an admin. Tokens are shown once at
 * creation.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { log } from "./logger.js";

/** Native bcrypt; same $2b$ format (and cost) as the library that wrote the
 *  hashes already on disk, so old records verify unchanged. */
const hashSecret = (value: string): string => Bun.password.hashSync(value, { algorithm: "bcrypt", cost: 10 });
const verifySecret = (value: string, hash: string): boolean => Bun.password.verifySync(value, hash);

export type UserRole = "admin" | "user";

export interface UserRecord {
  id: string;
  username: string;
  role: UserRole;
  tokenHash: string;
  /** bcrypt hash of the login password. Absent only on accounts from before
   *  passwords were mandatory, until the next boot mints one. */
  passwordHash?: string;
  /** disabled accounts cannot log in or use API tokens (admin control) */
  enabled?: boolean;
  createdAt: number;
}

export interface PublicUser {
  username: string;
  role: UserRole;
  hasPassword: boolean;
  enabled: boolean;
  createdAt: number;
}

// no dots: they break the parallel dir-name rule and are hostile to Windows dir names
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// MS-DOS device names. Windows refuses them as directory names whatever the
// extension, so an account called "con" could never get a workspace there.
const RESERVED_DIR_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

interface UsersFile {
  users: UserRecord[];
}

export class UserService {
  private file: string;
  private users: UserRecord[] = [];

  constructor(private dataDir: string) {
    this.file = path.join(dataDir, "users.json");
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as UsersFile;
      this.users = raw.users ?? [];
    }
  }

  /** Profile pictures: data/avatars/<username>.<ext> (outside user git repos). */
  avatarPath(username: string): string | null {
    for (const ext of ["png", "jpg", "jpeg", "webp", "gif"]) {
      const p = path.join(this.dataDir, "avatars", `${username}.${ext}`);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  writeAvatar(username: string, bytes: Buffer, ext: "png" | "jpg" | "jpeg" | "webp" | "gif"): void {
    const dir = path.join(this.dataDir, "avatars");
    fs.mkdirSync(dir, { recursive: true });
    for (const e of ["png", "jpg", "jpeg", "webp", "gif"]) {
      const old = path.join(dir, `${username}.${e}`);
      if (fs.existsSync(old)) fs.rmSync(old);
    }
    fs.writeFileSync(path.join(dir, `${username}.${ext}`), bytes, { mode: 0o600 });
  }

  deleteAvatar(username: string): void {
    const p = this.avatarPath(username);
    if (p) fs.rmSync(p);
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ users: this.users }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* umask oddity — best effort */ }
  }

  list(): UserRecord[] {
    return [...this.users];
  }

  get(username: string): UserRecord | undefined {
    return this.users.find((u) => u.username === username);
  }

  /** Case-insensitive lookup. Every account path — workspace, credentials,
   *  avatar — is derived from the username, and macOS (APFS) and Windows
   *  (NTFS) fold case: two accounts differing only in case would share one
   *  credentials dir, so one could read the other's keys. Uniqueness is
   *  therefore decided case-folded, even though the stored name keeps its
   *  casing. */
  getFolded(username: string): UserRecord | undefined {
    const folded = username.toLowerCase();
    return this.users.find((u) => u.username.toLowerCase() === folded);
  }

  /** Create a user; returns the plaintext token exactly once. A password is
   *  mandatory — every account gates the whole engine (agent included). */
  create(username: string, role: UserRole = "user", opts: { password: string }): { user: UserRecord; token: string } {
    if (!USERNAME_RE.test(username)) throw new Error(`invalid username: ${username} (letters, digits, _, -; max 32)`);
    if (RESERVED_DIR_NAME.test(username)) throw new Error(`invalid username: ${username} (reserved device name)`);
    if (this.getFolded(username)) throw new Error(`user already exists: ${username}`);
    if (typeof opts.password !== "string" || opts.password.length < 4 || opts.password.length > 128) {
      throw new Error("password required (4-128 chars)");
    }
    const token = crypto.randomBytes(24).toString("base64url");
    const user: UserRecord = {
      id: crypto.randomUUID(),
      username,
      role,
      tokenHash: hashSecret(token),
      passwordHash: hashSecret(opts.password),
      createdAt: Date.now(),
    };
    this.users.push(user);
    this.save();
    return { user, token };
  }

  delete(username: string): boolean {
    const before = this.users.length;
    this.users = this.users.filter((u) => u.username !== username);
    if (this.users.length === before) return false;
    this.save();
    return true;
  }

  /** Tokens that already passed bcrypt, by sha256 (they are 24 random bytes,
   *  so a fast hash is enough to recognise them again). Pinned to the hash
   *  they matched: a deleted and re-created account does not inherit them. */
  private verifiedTokens = new Map<string, { username: string; tokenHash: string }>();
  /** bcrypt runs synchronously, once per account, for every unknown token:
   *  an unauthenticated client sending `Bearer x` in a loop would otherwise
   *  hold the event loop and take the whole engine down. Unknown tokens get a
   *  small budget per second, bucketed BY CALLER: one peer spraying garbage
   *  must not spend the budget a genuine headless client needs for its first
   *  request (after an engine restart that is every client). Recognised
   *  tokens skip bcrypt entirely. */
  private unknownTokenBudget = new Map<string, { second: number; used: number }>();

  verify(token: string, bucket = "global"): UserRecord | null {
    if (!token || token.length > 256) return null;
    const digest = crypto.createHash("sha256").update(token).digest("hex");
    const known = this.verifiedTokens.get(digest);
    if (known !== undefined) {
      const u = this.get(known.username);
      if (u && u.enabled !== false && u.tokenHash === known.tokenHash) return u;
      this.verifiedTokens.delete(digest);
    }
    const second = Math.floor(Date.now() / 1000);
    // a peer rotating its address must not grow this map without bound
    if (this.unknownTokenBudget.size > 4096) {
      for (const [k, v] of this.unknownTokenBudget) if (v.second !== second) this.unknownTokenBudget.delete(k);
    }
    let budget = this.unknownTokenBudget.get(bucket);
    if (!budget || budget.second !== second) {
      budget = { second, used: 0 };
      this.unknownTokenBudget.set(bucket, budget);
    }
    if (++budget.used > 5) return null;
    for (const u of this.users) {
      if (u.enabled === false) continue;
      if (verifySecret(token, u.tokenHash)) {
        this.verifiedTokens.set(digest, { username: u.username, tokenHash: u.tokenHash });
        return u;
      }
    }
    return null;
  }

  /** Login-view list: usernames + whether each is password-protected. */
  publicList(): PublicUser[] {
    return this.users
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((u) => ({
        username: u.username,
        role: u.role,
        hasPassword: !!u.passwordHash,
        enabled: u.enabled !== false,
        createdAt: u.createdAt,
      }));
  }

  hasPassword(username: string): boolean {
    return !!this.get(username)?.passwordHash;
  }

  checkPassword(username: string, password: string): boolean {
    const hash = this.get(username)?.passwordHash;
    return !!hash && typeof password === "string" && verifySecret(password, hash);
  }

  /** Set the login password. */
  setPassword(username: string, password: string): boolean {
    const u = this.get(username);
    if (!u) return false;
    if (password.length < 4 || password.length > 128) throw new Error("password must be 4-128 chars");
    u.passwordHash = hashSecret(password);
    this.save();
    return true;
  }

  setEnabled(username: string, enabled: boolean): boolean {
    const u = this.get(username);
    if (!u) return false;
    u.enabled = enabled;
    this.save();
    return true;
  }

  /** Rename an account: same workspace, new identity. Avatar + credentials
   *  move with it.
   *
   *  Every filesystem move happens BEFORE users.json is written, so a move
   *  that fails leaves the account exactly as it was. The reverse order
   *  persisted the new name while the credentials dir still sat under the old
   *  one, which on a case-folding filesystem pointed the renamed account at
   *  another user's keys. */
  rename(oldUsername: string, next: string): UserRecord {
    if (!USERNAME_RE.test(next)) throw new Error(`invalid username: ${next} (letters, digits, _, -; max 32)`);
    if (RESERVED_DIR_NAME.test(next)) throw new Error(`invalid username: ${next} (reserved device name)`);
    if (next === oldUsername) throw new Error("that is already your username");
    // only a case change of THIS account may match case-folded; anything else
    // is a different account whose directories we would land on top of
    const sameFolded = oldUsername.toLowerCase() === next.toLowerCase();
    const clash = this.getFolded(next);
    if (clash && clash.username !== oldUsername) throw new Error(`user already exists: ${next}`);
    const u = this.get(oldUsername);
    if (!u) throw new Error(`user not found: ${oldUsername}`);

    // credentials dir moves with the account (lives outside the workspace).
    // existsSync answers case-folded on APFS/NTFS, so this refuses a target
    // that only collides once the filesystem folds it.
    const credsDir = path.join(this.dataDir, "credentials");
    const oldCreds = path.join(credsDir, oldUsername);
    const newCreds = path.join(credsDir, next);
    if (!sameFolded && fs.existsSync(newCreds)) throw new Error(`credentials already exist for ${next}`);
    const movedCreds = fs.existsSync(oldCreds);
    if (movedCreds) {
      fs.mkdirSync(credsDir, { recursive: true });
      fs.renameSync(oldCreds, newCreds);
    }
    const avatar = this.avatarPath(oldUsername);
    try {
      if (avatar) {
        this.writeAvatar(next, fs.readFileSync(avatar), path.extname(avatar).slice(1) as "png");
        this.deleteAvatar(oldUsername);
      }
      u.username = next;
      this.save();
    } catch (e) {
      // nothing is persisted yet: put the credentials back so the account
      // still resolves to its own keys
      u.username = oldUsername;
      if (movedCreds) {
        try { fs.renameSync(newCreds, oldCreds); } catch { /* best effort */ }
      }
      throw e;
    }
    return u;
  }

  /** Legacy accounts created before passwords were mandatory get a generated
   *  one at boot (printed once). Forgotten: the reset code flow
   *  (/v1/auth/forgot) or `chrysalis reset-password`. */
  ensurePasswords(): { username: string; password: string }[] {
    const out: { username: string; password: string }[] = [];
    for (const u of this.users) {
      if (u.passwordHash) continue;
      const password = crypto.randomBytes(9).toString("base64url");
      u.passwordHash = hashSecret(password);
      out.push({ username: u.username, password });
    }
    if (out.length) this.save();
    return out;
  }
}
