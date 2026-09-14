/**
 * The sandbox shell's prelude in a real wasmsh session: git answered by the
 * engine through the sandbox network route, and cd keeping $PWD absolute.
 * These cover shell quirks the functions work around, so they run the real
 * runtime rather than a mock.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNodeSession, type WasmshSession } from "@mayflowergmbh/wasmsh-pyodide";
import { SANDBOX_GIT_HOST, SHELL_PRELUDE } from "../src/sandbox/browser/prelude.js";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import { defaultInstanceConfig } from "../src/config.js";
import { commitAll } from "../src/git.js";

let dataDir: string;
let session: WasmshSession;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-shell-"));
  const users = new UserService(dataDir);
  users.create("admin", "admin", { password: "admin-pass-1" });
  const bearer = users.create("root", "admin", { password: "test-pass-1" }).token;
  const app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
  const root = path.join(dataDir, "users", "root");
  fs.mkdirSync(path.join(root, "apps", "demo"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps", "demo", "a b.txt"), "one\ntwo\n");
  await commitAll(root, "root", "first");
  fs.writeFileSync(path.join(root, "apps", "demo", "a b.txt"), "one\nTWO\n");
  await commitAll(root, "root", "second");
  const { token } = (await (await app.request("/v1/sandbox/config", { headers: { authorization: `Bearer ${bearer}` } })).json()) as { token: string };
  // stands in for the worker lockdown: the request reaches the engine's
  // sandbox route with the token and the shell's headers forwarded
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const res = await app.request("/v1/sandbox/net", {
        method: "POST",
        body: await req.arrayBuffer(),
        headers: {
          "x-sandbox-token": token,
          "x-sandbox-url": `http://${SANDBOX_GIT_HOST}/`,
          "x-sandbox-method": "POST",
          "x-sandbox-headers": encodeURIComponent(JSON.stringify([["x-git-cwd", req.headers.get("x-git-cwd") ?? ""]])),
        },
      });
      return new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers });
    },
  });
  session = await createNodeSession({ allowedHosts: ["127.0.0.1"] });
  await session.run(SHELL_PRELUDE.replace(`http://${SANDBOX_GIT_HOST}/`, `http://127.0.0.1:${server.port}/`));
  await session.run("mkdir -p /workspace/apps/demo && printf 'hi\\n' > /workspace/apps/demo/.gitignore");
}, 120_000);

afterAll(async () => {
  await session?.close();
  server?.stop(true);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const sh = async (command: string) => {
  const r = await session.run(`cd /workspace\n${command}`);
  return { out: r.stdout, err: r.stderr };
};

describe("sandbox shell prelude", () => {
  it("relative cd keeps paths resolving once, and refuses a folder that is not there", async () => {
    expect(await sh("cd apps/demo && for f in x; do :; done; cat .gitignore; pwd")).toEqual({ out: "hi\n/workspace/apps/demo\n", err: "" });
    const missing = await sh(`cd nope; echo "rc=$?"; pwd`);
    expect(missing.out).toBe("rc=1\n/workspace\n");
    expect(missing.err).toContain("No such file or directory");
  }, 60_000);

  it("git runs against the workspace repository with pipes, redirects, quoting and cwd", async () => {
    expect((await sh("cd apps/demo && git log --oneline | head -1")).out).toMatch(/^[0-9a-f]{8} second\n$/);
    expect((await sh(`cd apps/demo && git show "HEAD~1:./a b.txt" > /tmp/old.txt && cat /tmp/old.txt`)).out).toBe("one\ntwo\n");
    expect((await sh(`diff <(git show "HEAD~1:apps/demo/a b.txt") <(git show "HEAD:apps/demo/a b.txt")`)).out).toBe("2c2\n< two\n---\n> TWO\n");
    const bad = await sh(`git show HEAD:nope.txt; echo "rc=$?"`);
    expect(bad.out).toBe("rc=1\n");
    expect(bad.err).toMatch(/^path 'nope.txt' does not exist in [0-9a-f]{8}\n$/);
    expect((await sh(`cd /tmp && git status; echo "rc=$?"`)).out).toBe("rc=128\n");
  }, 60_000);
});
