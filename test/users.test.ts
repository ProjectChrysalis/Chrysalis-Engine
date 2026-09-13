import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserService } from "../src/users.js";
import { bootstrapUserDir, userPaths, migrateConnectionsIntoDataRoot, migrateCredentialsIntoDataRoot, migrateMcpIntoDataRoot, migrateSpeechIntoDataRoot } from "../src/paths.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "users-test-"));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* watcher races */ }
});

describe("UserService", () => {
  it("creates a user and verifies its token", () => {
    const svc = new UserService(dir);
    const { user, token } = svc.create("alice", "user", { password: "test-pass-1" });
    expect(user.username).toBe("alice");
    expect(user.role).toBe("user");
    expect(token.length).toBeGreaterThan(20);
    expect(svc.verify(token)?.username).toBe("alice");
    expect(svc.verify("wrong-token")).toBeNull();
  });

  it("persists across instances", () => {
    const svc = new UserService(dir);
    const { token } = svc.create("bob", "admin", { password: "test-pass-1" });
    const svc2 = new UserService(dir);
    expect(svc2.verify(token)?.username).toBe("bob");
    expect(svc2.verify(token)?.role).toBe("admin");
  });

  it("rejects duplicates and deletes users", () => {
    const svc = new UserService(dir);
    svc.create("carol", "user", { password: "test-pass-1" });
    expect(() => svc.create("carol", "user", { password: "test-pass-1" })).toThrow();
    expect(svc.delete("carol")).toBe(true);
    expect(svc.delete("carol")).toBe(false);
  });

});

describe("credential relocation (auth.json outside the workspace)", () => {
  it("userPaths points auth at the data-root credentials dir, not the workspace", () => {
    const p = userPaths(dir, "alice");
    expect(p.auth).toBe(path.join(dir, "credentials", "alice", "auth.json"));
    expect(path.dirname(p.auth).startsWith(p.root)).toBe(false);
    // connections and speech sit on the same boundary as the keys
    expect(p.connections).toBe(path.join(dir, "credentials", "alice", "connections.json"));
    expect(p.speech).toBe(path.join(dir, "credentials", "alice", "speech.json"));
  });

  it("migration moves a legacy workspace auth.json out (content + 0600 intact)", () => {
    const p = bootstrapUserDir(dir, "alice");
    fs.writeFileSync(path.join(p.root, "auth.json"), '{"deepseek":{"type":"api_key","key":"sk-x"}}');
    expect(migrateCredentialsIntoDataRoot(dir, "alice")).toBe(true);
    expect(fs.existsSync(path.join(p.root, "auth.json"))).toBe(false);
    expect(fs.readFileSync(p.auth, "utf8")).toContain("sk-x");
    expect((fs.statSync(p.auth).mode & 0o777)).toBe(0o600);
    // idempotent
    expect(migrateCredentialsIntoDataRoot(dir, "alice")).toBe(false);
  });

  it("rename moves the credentials dir with the account", () => {
    const svc = new UserService(dir);
    svc.create("alice", "user", { password: "test-pass-1" });
    const p = userPaths(dir, "alice");
    fs.mkdirSync(path.dirname(p.auth), { recursive: true });
    fs.writeFileSync(p.auth, '{"deepseek":{"type":"api_key","key":"sk-x"}}');
    svc.rename("alice", "alyx");
    expect(fs.existsSync(userPaths(dir, "alyx").auth)).toBe(true);
    expect(fs.existsSync(userPaths(dir, "alice").auth)).toBe(false);
  });

  it("migration moves a legacy workspace mcp.json out (content intact, 0600)", () => {
    const p = bootstrapUserDir(dir, "alice");
    // an older install kept it in the workspace, where the agent could edit it
    fs.rmSync(p.mcp);
    const legacy = path.join(p.root, "mcp.json");
    fs.writeFileSync(legacy, '{"servers":{"dice":{"type":"stdio","command":"node"}}}');
    expect(migrateMcpIntoDataRoot(dir, "alice")).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(p.mcp, "utf8")).toContain("dice");
    expect(fs.statSync(p.mcp).mode & 0o777).toBe(0o600);
    // idempotent
    expect(migrateMcpIntoDataRoot(dir, "alice")).toBe(false);
  });

  it("a workspace copy planted beside the real file is dropped, never merged", () => {
    const p = bootstrapUserDir(dir, "alice");
    fs.writeFileSync(path.join(p.root, "mcp.json"), '{"servers":{"rogue":{"type":"stdio","command":"sh"}}}');
    expect(migrateMcpIntoDataRoot(dir, "alice")).toBe(false);
    expect(fs.existsSync(path.join(p.root, "mcp.json"))).toBe(false);
    // the authoritative file outside the workspace is untouched
    expect(fs.readFileSync(p.mcp, "utf8")).not.toContain("rogue");
  });

  it("migration moves a legacy workspace connections.json out (content intact, 0600)", () => {
    const p = bootstrapUserDir(dir, "alice");
    const legacy = path.join(p.root, "connections.json");
    fs.writeFileSync(legacy, '{"connections":{"c_a":{"name":"Mine","api":"openai-completions","baseUrl":"https://x.example/v1"}}}');
    expect(migrateConnectionsIntoDataRoot(dir, "alice")).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(p.connections, "utf8")).toContain("x.example");
    expect(fs.statSync(p.connections).mode & 0o777).toBe(0o600);
    // idempotent
    expect(migrateConnectionsIntoDataRoot(dir, "alice")).toBe(false);
  });

  it("migration moves a legacy workspace speech.json out, and an outside copy wins", () => {
    const p = bootstrapUserDir(dir, "alice");
    const legacy = path.join(p.root, "speech.json");
    fs.writeFileSync(legacy, '{"endpoints":{"e1":{"name":"Kokoro","baseUrl":"http://localhost:8880/v1","model":"kokoro"}}}');
    expect(migrateSpeechIntoDataRoot(dir, "alice")).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(p.speech, "utf8")).toContain("Kokoro");
    // a planted copy beside the authoritative file never merges
    fs.writeFileSync(legacy, '{"endpoints":{"rogue":{"name":"Rogue","baseUrl":"https://evil.example/v1","model":"m"}}}');
    expect(migrateSpeechIntoDataRoot(dir, "alice")).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(p.speech, "utf8")).not.toContain("Rogue");
  });
});

/** Every account path is derived from the username, and macOS (APFS) and
 *  Windows (NTFS) fold case: two names differing only in case would share one
 *  credentials dir, so one account could read the other's API keys. */
describe("account names cannot collide once a filesystem folds case", () => {
  it("refuses a second account whose name differs only in case", () => {
    const svc = new UserService(dir);
    svc.create("admin", "admin", { password: "test-pass-1" });
    expect(() => svc.create("Admin", "user", { password: "test-pass-1" })).toThrow(/already exists/);
    expect(() => svc.create("ADMIN", "user", { password: "test-pass-1" })).toThrow(/already exists/);
  });

  it("refuses a rename onto another account's case-variant, changing nothing", () => {
    const svc = new UserService(dir);
    svc.create("admin", "admin", { password: "test-pass-1" });
    svc.create("bob", "user", { password: "test-pass-1" });
    expect(() => svc.rename("bob", "Admin")).toThrow(/already exists/);
    expect(svc.get("bob")?.username).toBe("bob");
    expect(svc.list().map((u) => u.username).sort()).toEqual(["admin", "bob"]);
  });

  it("a refused rename never leaves the account holding another's credentials", () => {
    const svc = new UserService(dir);
    svc.create("admin", "admin", { password: "test-pass-1" });
    const victim = userPaths(dir, "admin");
    fs.mkdirSync(path.dirname(victim.auth), { recursive: true });
    fs.writeFileSync(victim.auth, '{"anthropic":{"type":"api_key","key":"sk-victim"}}');
    svc.create("bob", "user", { password: "test-pass-1" });
    expect(() => svc.rename("bob", "Admin")).toThrow();
    expect(fs.readFileSync(victim.auth, "utf8")).toContain("sk-victim");
    expect(svc.get("bob")?.username).toBe("bob");
    expect(svc.get("Admin")).toBeUndefined();
  });

  it("still lets an account restyle its own casing", () => {
    const svc = new UserService(dir);
    svc.create("bob", "user", { password: "test-pass-1" });
    expect(svc.rename("bob", "Bob").username).toBe("Bob");
  });

  it("refuses MS-DOS device names Windows cannot use as a directory", () => {
    const svc = new UserService(dir);
    for (const name of ["con", "PRN", "nul", "com1", "lpt9"]) {
      expect(() => svc.create(name, "user", { password: "test-pass-1" }), name).toThrow(/reserved device name/);
    }
  });
});
