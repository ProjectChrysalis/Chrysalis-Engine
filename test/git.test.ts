import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import isomorphicGit from "isomorphic-git";
import { initRepo, commitAll, log, restoreFile, status, untrackBoundary, changedPaths, commitPaths } from "../src/git.js";
import { ensureGitignoreEntries } from "../src/paths.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-"));
  fs.writeFileSync(path.join(dir, "card.json"), '{"name":"v1"}');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* watcher races */ }
});

describe("git wrapper", () => {
  it("init → commit → log", async () => {
    await initRepo(dir);
    const oid = await commitAll(dir, "alice", "init: workspace");
    expect(oid).toBeTruthy();
    const commits = await log(dir, 10);
    expect(commits.length).toBe(1);
    expect(commits[0]!.message).toBe("init: workspace");
    expect(commits[0]!.author).toBe("alice");
  });

  it("commit is a no-op on clean tree", async () => {
    await initRepo(dir);
    await commitAll(dir, "alice", "first");
    expect(await commitAll(dir, "alice", "nothing")).toBeNull();
  });

  it("restore (undo) recovers file content", async () => {
    await initRepo(dir);
    const oid1 = (await commitAll(dir, "alice", "v1"))!;
    fs.writeFileSync(path.join(dir, "card.json"), '{"name":"v2-ruined"}');
    await commitAll(dir, "alice", "v2");
    await restoreFile(dir, "card.json", oid1, "alice");
    expect(fs.readFileSync(path.join(dir, "card.json"), "utf8")).toBe('{"name":"v1"}');
  });

  it("tracks deletions", async () => {
    await initRepo(dir);
    await commitAll(dir, "alice", "with file");
    fs.unlinkSync(path.join(dir, "card.json"));
    await commitAll(dir, "alice", "remove file");
    expect(fs.existsSync(path.join(dir, "card.json"))).toBe(false);
  });
});

describe("git boundary (credentials + chat logs + runtime state)", () => {
  it("commitAll never stages boundary paths, even without a .gitignore", async () => {
    await initRepo(dir);
    fs.writeFileSync(path.join(dir, "auth.json"), '{"deepseek":"sk-live-secret"}');
    fs.mkdirSync(path.join(dir, "agent", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agent", "sessions", "s1.jsonl"), '{"type":"run"}');
    const oid = await commitAll(dir, "alice", "changes");
    expect(oid).toBeTruthy();
    const committed = (await status(dir)).map((s) => s.path);
    expect(committed).not.toContain("auth.json");
    expect(committed).not.toContain("agent/sessions/s1.jsonl");
    // and they stay uncommitted on the next pass
    expect(await commitAll(dir, "alice", "again")).toBeNull();
  });

  it("untrackBoundary removes previously leaked files (index-only, disk intact)", async () => {
    await initRepo(dir);
    fs.writeFileSync(path.join(dir, "auth.json"), "SECRET");
    fs.mkdirSync(path.join(dir, "agent", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agent", "sessions", "s1.jsonl"), '{"type":"run"}');
    // simulate the old bug: boundary paths committed before the filter existed
    for (const f of ["card.json", "auth.json", "agent/sessions/s1.jsonl"]) {
      await isomorphicGit.add({ fs, dir, filepath: f });
    }
    await isomorphicGit.commit({ fs, dir, message: "leaky commit", author: { name: "old", email: "old@local" } });

    ensureGitignoreEntries(dir);
    await untrackBoundary(dir, "alice");

    const files = await isomorphicGit.listFiles({ fs, dir });
    expect(files).toContain("card.json");
    expect(files).not.toContain("auth.json");
    expect(files).not.toContain("agent/sessions/s1.jsonl");
    // working-tree files survive the untrack
    expect(fs.existsSync(path.join(dir, "agent", "sessions", "s1.jsonl"))).toBe(true);
    // tree is clean afterwards (gitignore covers the untracked files)
    expect(await status(dir)).toEqual([]);
    // idempotent: second run is a no-op
    await untrackBoundary(dir, "alice");
    const commits = await log(dir, 5);
    expect(commits.filter((c) => c.message.includes("untrack"))).toHaveLength(1);
  });

  it("restoreFile refuses git-boundary paths", async () => {
    await initRepo(dir);
    const oid = (await commitAll(dir, "alice", "v1"))!;
    // auth.json was never committable — restore targets it directly
    await expect(restoreFile(dir, "auth.json", oid, "alice")).rejects.toThrow(/git-boundary/);
    await expect(restoreFile(dir, "agent/sessions/s1.jsonl", oid, "alice")).rejects.toThrow(/git-boundary/);
  });
});

describe("commit ergonomics (CLI identity, reflog, path-scoped commits)", () => {
  it("commitAll provisions a CLI identity and writes a reflog entry", async () => {
    await initRepo(dir);
    const oid = (await commitAll(dir, "alice", "first"))!;
    expect(await isomorphicGit.getConfig({ fs, dir, path: "user.name" })).toBe("alice");
    expect(await isomorphicGit.getConfig({ fs, dir, path: "user.email" })).toBe("alice@local");
    const reflog = fs.readFileSync(path.join(dir, ".git", "logs", "HEAD"), "utf8");
    expect(reflog.startsWith("0".repeat(40))).toBe(true); // born branch → zeros as the old oid
    expect(reflog).toContain(oid);
    expect(reflog).toContain("commit: first");
    // second commit chains onto the first (content length differs — isomorphic-git's
    // same-second + same-size stat check would read an identical-length rewrite as clean)
    fs.writeFileSync(path.join(dir, "card.json"), '{"name":"v2-longer"}');
    const oid2 = (await commitAll(dir, "alice", "second"))!;
    const lines = fs.readFileSync(path.join(dir, ".git", "logs", "HEAD"), "utf8").trim().split("\n");
    expect(lines[1]!.startsWith(oid)).toBe(true);
    expect(lines[1]!).toContain(oid2);
  });

  it("commitPaths commits only the given paths — the rest stays pending", async () => {
    await initRepo(dir);
    await commitAll(dir, "alice", "base");
    fs.writeFileSync(path.join(dir, "a.json"), "A");
    fs.writeFileSync(path.join(dir, "b.json"), "B");
    const oid = await commitPaths(dir, "alice", "just a", ["a.json"]);
    expect(oid).toBeTruthy();
    expect(await changedPaths(dir)).toEqual(["b.json"]);
    // a follow-up commitAll still sweeps the remainder (undo parity)
    expect(await commitAll(dir, "alice", "rest")).toBeTruthy();
    expect(await changedPaths(dir)).toEqual([]);
  });

  it("changedPaths skips git-boundary paths", async () => {
    await initRepo(dir);
    await commitAll(dir, "alice", "base");
    fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agent", "x.jsonl"), "{}");
    fs.writeFileSync(path.join(dir, "c.json"), "C");
    expect(await changedPaths(dir)).toEqual(["c.json"]);
  });
});
