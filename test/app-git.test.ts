/**
 * App git transport without a git program: the JS three-way merge agrees
 * with `git merge-file`, workspace history reads through isomorphic-git, and
 * clones and update checks work over smart HTTP (the protocol GitHub,
 * GitLab and Codeberg speak). The test machine's git only builds fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileHistory, gitClone, gitRemoteHead, mergeFile, readDirAt, showFile } from "../src/apps/git.js";
import { commitAll, initRepo } from "../src/git.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "appgit-"));
beforeAll(() => {
  process.env.CHRYSALIS_NO_SYSTEM_GIT = "1";
});
afterAll(() => {
  delete process.env.CHRYSALIS_NO_SYSTEM_GIT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sh = (args: string[], cwd?: string) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

function gitMergeFile(ours: string, base: string, theirs: string, favorOurs = false): { merged: string; conflicts: number } {
  const dir = fs.mkdtempSync(path.join(tmp, "mf-"));
  fs.writeFileSync(path.join(dir, "o"), ours);
  fs.writeFileSync(path.join(dir, "b"), base);
  fs.writeFileSync(path.join(dir, "t"), theirs);
  try {
    const merged = execFileSync("git", ["merge-file", "-p", ...(favorOurs ? ["--ours"] : []), "-L", "your version", "-L", "base", "-L", "update", "o", "b", "t"], { cwd: dir, encoding: "utf8" });
    return { merged, conflicts: 0 };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { merged: err.stdout, conflicts: err.status };
  }
}

describe("mergeFile", () => {
  const labels = { ours: "your version", base: "base", theirs: "update" };
  const cases: Array<[string, string, string, string]> = [
    ["separate edits", "a\nB\nc\nd\ne\n", "a\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n"],
    ["same edit on both sides", "a\nX\nc\n", "a\nb\nc\n", "a\nX\nc\n"],
    ["overlapping edits", "a\nmine\nc\n", "a\nb\nc\n", "a\ntheirs\nc\n"],
    ["no trailing newline in conflict", "a\nmine", "a\nb", "a\ntheirs"],
    ["additions at the end", "a\nb\nours\n", "a\nb\n", "a\nb\ntheirs\n"],
    ["empty base", "one\n", "", "two\n"],
  ];
  for (const [name, ours, base, theirs] of cases) {
    it(`matches git merge-file: ${name}`, () => {
      const files = { ours: Buffer.from(ours), base: Buffer.from(base), theirs: Buffer.from(theirs) };
      const js = mergeFile(files, labels);
      const ref = gitMergeFile(ours, base, theirs);
      expect(js.conflicts).toBe(ref.conflicts);
      if (ref.conflicts === 0) expect(js.merged.toString()).toBe(ref.merged);
      else expect(js.merged.toString()).toContain("<<<<<<< your version\n");
      expect(mergeFile(files, labels, true).merged.toString()).toBe(gitMergeFile(ours, base, theirs, true).merged);
    });
  }
});

describe("workspace history", () => {
  it("reads a file's commits, its old content and a folder at a commit", async () => {
    const repo = path.join(tmp, "ws");
    fs.mkdirSync(path.join(repo, "apps", "demo", "data"), { recursive: true });
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, "apps", "demo", "manifest.json"), '{"version":"1.0.0"}');
    fs.writeFileSync(path.join(repo, "apps", "demo", "index.html"), "<p>one</p>");
    fs.writeFileSync(path.join(repo, "apps", "demo", "data", "chat.json"), "{}");
    fs.writeFileSync(path.join(repo, "notes.md"), "elsewhere");
    await commitAll(repo, "u", "install");
    fs.writeFileSync(path.join(repo, "apps", "demo", "manifest.json"), '{"version":"1.1.0"}');
    fs.writeFileSync(path.join(repo, "apps", "demo", "index.html"), "<p>two</p>");
    await commitAll(repo, "u", "update");

    const history = await fileHistory(repo, "apps/demo/manifest.json");
    expect(history.length).toBe(2);
    expect((await showFile(repo, history[1]!, "apps/demo/manifest.json"))?.toString()).toBe('{"version":"1.0.0"}');
    expect(await showFile(repo, history[1]!, "apps/demo/missing.txt")).toBeNull();
    const tree = await readDirAt(repo, history[1]!, "apps/demo", ["data"]);
    expect([...tree.keys()].sort()).toEqual(["index.html", "manifest.json"]);
    expect(tree.get("index.html")?.toString()).toBe("<p>one</p>");
  });
});

describe("clone and update check over smart HTTP", () => {
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  let head: string;

  beforeAll(() => {
    const work = path.join(tmp, "work");
    fs.mkdirSync(work);
    sh(["init", "-q", "-b", "main"], work);
    fs.writeFileSync(path.join(work, "manifest.json"), '{"name":"Remote"}');
    fs.symlinkSync("/etc/passwd", path.join(work, "link"));
    sh(["add", "-A"], work);
    sh(["commit", "-qm", "first"], work);
    head = sh(["rev-parse", "HEAD"], work).trim();
    const bare = path.join(tmp, "remote.git");
    sh(["clone", "-q", "--bare", work, bare]);

    // git's smart HTTP protocol, served by `git upload-pack`
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        const run = (args: string[], body?: Uint8Array) =>
          new Promise<Buffer>((resolve) => {
            const child = spawn("git", args, { env: { ...process.env, GIT_PROTOCOL: req.headers.get("git-protocol") ?? "" } });
            const chunks: Buffer[] = [];
            child.stdout.on("data", (d: Buffer) => chunks.push(d));
            child.on("close", () => resolve(Buffer.concat(chunks)));
            child.stdin.end(body ? Buffer.from(body) : undefined);
          });
        if (u.pathname.endsWith("/info/refs")) {
          const adv = await run(["upload-pack", "--stateless-rpc", "--advertise-refs", bare]);
          const line = "# service=git-upload-pack\n";
          const pkt = (4 + line.length).toString(16).padStart(4, "0") + line + "0000";
          return new Response(Buffer.concat([Buffer.from(pkt), adv]), { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
        }
        if (u.pathname.endsWith("/git-upload-pack")) {
          const out = await run(["upload-pack", "--stateless-rpc", bare], new Uint8Array(await req.arrayBuffer()));
          return new Response(out, { headers: { "content-type": "application/x-git-upload-pack-result" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    url = `http://127.0.0.1:${server.port}/remote.git`;
  });
  afterAll(() => server.stop(true));

  it("finds the remote head", async () => {
    expect(await gitRemoteHead(url)).toBe(head);
    expect(await gitRemoteHead(url, "main")).toBe(head);
  });

  it("clones without git and drops symlinks", async () => {
    const dest = path.join(tmp, "clone");
    expect(await gitClone(url, dest)).toBe(head);
    expect(fs.readFileSync(path.join(dest, "manifest.json"), "utf8")).toBe('{"name":"Remote"}');
    expect(fs.existsSync(path.join(dest, "link"))).toBe(false);
  });

  it("explains that SSH addresses need git", async () => {
    await expect(gitClone("git@github.com:x/y.git", path.join(tmp, "ssh"))).rejects.toThrow(/https:\/\//);
  });
});
