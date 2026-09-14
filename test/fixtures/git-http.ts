/**
 * A repository served over git's smart HTTP protocol (what GitHub, GitLab and
 * Codeberg speak), answered by the test machine's `git upload-pack`.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const sh = (args: string[], cwd?: string) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

/** Commit `files` (and a symlink named link) in a fresh repository under
 *  `tmp` and serve it. */
export function serveRepo(tmp: string, files: Record<string, string>): { url: string; head: string; stop: () => void } {
  const work = fs.mkdtempSync(path.join(tmp, "work-"));
  sh(["init", "-q", "-b", "main"], work);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  fs.symlinkSync("/etc/passwd", path.join(work, "link"));
  sh(["add", "-A"], work);
  sh(["commit", "-qm", "first"], work);
  const head = sh(["rev-parse", "HEAD"], work).trim();
  const bare = `${work}.git`;
  sh(["clone", "-q", "--bare", work, bare]);

  const server = Bun.serve({
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
  return { url: `http://127.0.0.1:${server.port}/remote.git`, head, stop: () => server.stop(true) };
}
