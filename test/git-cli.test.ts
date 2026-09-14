/**
 * The agent's git command line over the workspace repository: the reads a
 * review needs, the writes an undo needs, and the files it must not touch.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as repo from "../src/git.js";
import { runGitCli, splitArgs } from "../src/agent/git-cli.js";

let dir: string;
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
const run = (args: string, readOnly = false) => runGitCli({ dir, username: "alice", readOnly }, args);

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-cli-")));
  await repo.initRepo(dir);
  write("apps/demo/src/App.tsx", "one\ntwo\nthree\n");
  write("apps/demo/data/notes.json", "{\"a\":1}\n");
  write("settings.json", "{\"pluginGrants\":{}}\n");
  await repo.commitAll(dir, "alice", "first");
  write("apps/demo/src/App.tsx", "one\nTWO\nthree\n");
  write("apps/demo/src/extra.ts", "export {}\n");
  await repo.commitAll(dir, "alice", "second");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("agent git command line", () => {
  it("splits arguments like a shell and drops a leading git", () => {
    expect(splitArgs(`git commit -m "fix the \\"quoted\\" bit" --  'a b.txt'`)).toEqual(["commit", "-m", 'fix the "quoted" bit', "--", "a b.txt"]);
    expect(() => splitArgs(`commit -m "open`)).toThrow(/quote/);
  });

  it("status, diff and log read the workspace like the command line", async () => {
    expect(await run("status")).toContain("working tree clean");
    write("apps/demo/src/App.tsx", "one\nTWO\nthree\nfour\n");
    write("apps/demo/new.txt", "fresh\n");
    expect(await run("status -s")).toBe(" M apps/demo/src/App.tsx\n?? apps/demo/new.txt");
    const d = await run("diff");
    expect(d).toContain("diff --git a/apps/demo/src/App.tsx b/apps/demo/src/App.tsx");
    expect(d).toContain("+four");
    expect(d).not.toContain("new.txt");
    expect(await run("diff -- apps/demo/data")).toBe("");

    // a revision against the files on disk, and two revisions against each other
    const sinceFirst = await run("diff HEAD~1 --name-status");
    expect(sinceFirst).toBe("M\tapps/demo/src/App.tsx\nA\tapps/demo/src/extra.ts");
    expect(await run("diff HEAD~1 HEAD --stat")).toContain("2 files changed, 2 insertions(+), 1 deletion(-)");
    expect(await run("diff HEAD~1..HEAD -- apps/demo/src/extra.ts")).toContain("+export {}");

    expect(await run("log --oneline")).toMatch(/^[0-9a-f]{8} second\n[0-9a-f]{8} first$/);
    expect(await run("log --oneline -- apps/demo/src/extra.ts")).toMatch(/^[0-9a-f]{8} second$/);
    expect(await run("log -1")).toContain("Author: alice <alice@local>");
    await expect(run("log nope")).rejects.toThrow(/bad revision/);
  });

  it("show prints a commit's patch, a file as it was, and a folder's listing", async () => {
    const first = (await run("rev-parse HEAD~1")).slice(0, 8);
    expect(await run("show --stat")).toContain("apps/demo/src/extra.ts");
    expect(await run(`show ${first}:apps/demo/src/App.tsx`)).toBe("one\ntwo\nthree\n");
    expect(await run("show HEAD:apps/demo/src")).toBe("App.tsx\nextra.ts");
    await expect(run(`show ${first}:apps/demo/src/extra.ts`)).rejects.toThrow(/does not exist/);
  });

  it("never shows or restores the files the agent may not read or write", async () => {
    await expect(run("show HEAD~1:settings.json")).rejects.toThrow(/settings/);
    write("settings.json", "{\"pluginGrants\":{\"x\":[\"network\"]}}\n");
    expect(await run("diff")).toContain("content hidden");
    expect(await run("diff")).not.toContain("network");
    await expect(run("restore --source HEAD~1 -- settings.json")).rejects.toThrow(/settings/);
    await expect(run("show HEAD:../outside")).rejects.toThrow(/outside the workspace/);
  });

  it("restore and checkout put files back and commit that", async () => {
    write("apps/demo/src/App.tsx", "broken\n");
    const out = await run("restore --source HEAD~1 -- apps/demo/src/App.tsx");
    expect(out).toContain("restored apps/demo/src/App.tsx");
    expect(read("apps/demo/src/App.tsx")).toBe("one\ntwo\nthree\n");
    expect(await run("log --oneline -1")).toContain("restore: apps/demo/src/App.tsx");
    expect(await run("status")).toContain("working tree clean");

    write("apps/demo/src/extra.ts", "changed\n");
    await run("checkout HEAD -- apps/demo/src");
    expect(read("apps/demo/src/extra.ts")).toBe("export {}\n");
    await expect(run("restore --source HEAD~2 -- apps/demo/src/extra.ts")).rejects.toThrow(/did not match/);
    await expect(run("restore -- .")).rejects.toThrow(/not the whole workspace/);
  });

  it("revert undoes a commit, and refuses when its files changed since", async () => {
    await run("revert HEAD");
    expect(read("apps/demo/src/App.tsx")).toBe("one\ntwo\nthree\n");
    expect(fs.existsSync(path.join(dir, "apps/demo/src/extra.ts"))).toBe(false);
    expect(await run("log --oneline -1")).toContain('Revert "second"');

    write("apps/demo/src/App.tsx", "later work\n");
    await repo.commitAll(dir, "alice", "later");
    await expect(run("revert HEAD~2")).rejects.toThrow(/changed after/);
    expect(read("apps/demo/src/App.tsx")).toBe("later work\n");
  });

  it("pathspecs follow the shell's folder, and ls-tree and ls-files list what a commit holds", async () => {
    const inApp = (args: string) => runGitCli({ dir, username: "alice", readOnly: false, cwd: "apps/demo" }, args);
    write("apps/demo/src/App.tsx", "changed\n");
    expect(await inApp("diff --name-only -- src")).toBe("apps/demo/src/App.tsx");
    expect(await inApp("show HEAD:./src/extra.ts")).toBe("export {}\n");
    expect(await inApp("show HEAD:apps/demo/src/extra.ts")).toBe("export {}\n");
    await expect(inApp("diff -- ../../..")).rejects.toThrow(/outside the workspace/);
    expect(await run("ls-tree --name-only HEAD")).toBe("apps\nsettings.json");
    expect(await run("ls-tree HEAD -- apps/demo/src/extra.ts")).toMatch(/^100644 blob [0-9a-f]{40}\tapps\/demo\/src\/extra.ts$/);
    expect(await run("ls-tree --name-only HEAD apps/demo")).toBe("apps/demo/data\napps/demo/src");
    expect(await run("ls-tree -r --name-only HEAD apps/demo/src")).toBe("apps/demo/src/App.tsx\napps/demo/src/extra.ts");
    expect(await inApp("ls-files src")).toBe("apps/demo/src/App.tsx\napps/demo/src/extra.ts");
  });

  it("commit takes every change; the rest explains itself", async () => {
    await expect(run("commit")).rejects.toThrow(/needs a message/);
    expect(await run("commit -m nothing")).toContain("nothing to commit");
    write("apps/demo/data/notes.json", "{\"a\":2}\n");
    expect(await run(`commit -am "bump a"`)).toMatch(/^\[main [0-9a-f]{8}\] bump a$/);
    await expect(run("push")).rejects.toThrow(/no remote/);
    await expect(run("reset --hard HEAD~1")).rejects.toThrow(/revert/);
    await expect(run("commit -m x", true)).rejects.toThrow(/Plan mode/);
    expect(await run("help")).toContain("Supported");
  });
});
