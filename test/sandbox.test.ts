/**
 * Agent shell: browser-only execution. Config plumbing (browser default, off
 * switch), output caps, the bash tool's wiring to the runner, and the browser
 * runner's readiness messaging. Nothing here touches a host process because no
 * host execution path exists.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { defaultInstanceConfig, loadConfig, sandboxConfigOf } from "../src/config.js";
import { WRITE_TOOLS, buildUserTools } from "../src/agent/tools.js";
import { EventBus } from "../src/server/ws.js";
import { BrowserSandbox } from "../src/sandbox/browser.js";
import { capOutput, createSandbox, defaultSandboxConfig, type SandboxRunner } from "../src/sandbox/index.js";
import { workspaceFs } from "../src/sandbox/workspace.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A runner that records the command and replays it as stdout. */
function stubRunner(): SandboxRunner & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    config: defaultSandboxConfig(),
    enabled: true,
    status: () => ({ provider: "browser", available: true, reason: "test", running: 0, unsafe: false, isolation: "wasm" }),
    run: async (_username, _root, input) => {
      commands.push(input.command);
      return { exitCode: 0, stdout: `${input.command}\n`, stderr: "", timedOut: false, truncated: false, provider: "browser" };
    },
  };
}

describe("shell config", () => {
  it("defaults: browser (wasm sandbox in the user's tab)", () => {
    const d = defaultSandboxConfig();
    expect(d.provider).toBe("browser");
    expect(d.timeoutMs).toBeGreaterThan(0);
    expect(sandboxConfigOf(defaultInstanceConfig()).provider).toBe("browser");
  });

  it("agent.shell: false in config.yaml switches the shell off", () => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "agent:\n  shell: false\n  shellTimeoutSeconds: 30\n");
    const cfg = sandboxConfigOf(loadConfig(tmp, { env: {} }).config);
    expect(cfg.provider).toBe("off");
    expect(cfg.timeoutMs).toBe(30_000);
  });

  it("an out-of-range timeout keeps the default and warns", () => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "agent:\n  shellTimeoutSeconds: 999999\n");
    const loaded = loadConfig(tmp, { env: {} });
    expect(sandboxConfigOf(loaded.config).timeoutMs).toBe(defaultSandboxConfig().timeoutMs);
    expect(loaded.warnings.join("\n")).toMatch(/shellTimeoutSeconds/);
  });

  it("the factory always builds the browser runner", () => {
    const sb = createSandbox(defaultSandboxConfig(), new EventBus());
    expect(sb.enabled).toBe(true);
    expect(sb.status().provider).toBe("browser");
    expect(sb.status().isolation).toBe("wasm");
  });

  it("off: status and run both refuse with a reason", async () => {
    const sb = createSandbox({ provider: "off", timeoutMs: 60_000 }, new EventBus());
    expect(sb.enabled).toBe(false);
    expect(sb.status().available).toBe(false);
    expect(sb.status().isolation).toBe("off");
    const res = await sb.run("u", tmp, { command: "echo hi" });
    expect("error" in res && res.error).toContain("shell is off");
  });
});

describe("capOutput", () => {
  it("keeps head+tail with a seam when oversized", () => {
    const big = "a".repeat(16 * 1024) + "B".repeat(200_000) + "z".repeat(1000);
    const { text, truncated } = capOutput(big);
    expect(truncated).toBe(true);
    expect(text.startsWith("a".repeat(16 * 1024))).toBe(true);
    expect(text.endsWith("z".repeat(1000))).toBe(true);
    expect(text).toContain("bytes truncated");
  });

  it("passes small output through untouched", () => {
    expect(capOutput("hi")).toEqual({ text: "hi", truncated: false });
  });
});

describe("agent bash tool", () => {
  it("is a write tool (stripped in plan mode) and routes through the runner", async () => {
    expect(WRITE_TOOLS.has("bash")).toBe(true);
    bootstrapUserDir(tmp, "alice");
    const p = userPaths(tmp, "alice");
    const sandbox = stubRunner();
    const tools = buildUserTools("alice", p, { dataDir: tmp, sandbox });
    const bash = tools.find((t) => t.name === "bash")!;
    const res = (await bash.execute("id", { command: "echo tool-time" })) as { content: { type: "text"; text: string }[]; details: unknown };
    expect(res.content[0]!.text).toContain("tool-time");
    expect(sandbox.commands).toEqual(["echo tool-time"]);
    const details = res.details as { command: string; exitCode: number; provider: string };
    expect(details.exitCode).toBe(0);
    expect(details.provider).toBe("browser");
  });

  it("refuses cleanly when no shell is configured", async () => {
    bootstrapUserDir(tmp, "alice");
    const p = userPaths(tmp, "alice");
    const tools = buildUserTools("alice", p, { dataDir: tmp });
    const bash = tools.find((t) => t.name === "bash")!;
    await expect(bash.execute("id", { command: "echo nope" })).rejects.toThrow(/No shell is configured/);
  });

  it("surfaces a runner error as a tool error", async () => {
    bootstrapUserDir(tmp, "alice");
    const p = userPaths(tmp, "alice");
    const sandbox: SandboxRunner = {
      ...stubRunner(),
      run: async () => ({ error: "No sandbox is connected." }),
    };
    const tools = buildUserTools("alice", p, { dataDir: tmp, sandbox });
    const bash = tools.find((t) => t.name === "bash")!;
    await expect(bash.execute("id", { command: "echo nope" })).rejects.toThrow(/Sandbox unavailable/);
  });
});

/** mcp.json moved out of the workspace: a stdio entry runs a command on the
 *  host and an http entry is unrestricted egress, so neither the file tools nor
 *  the shell's sync-back — the same agent by another route — can author one. */
describe("mcp.json is out of the shell's reach", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("sits outside the workspace, and the sync-back refuses the name", () => {
    const p = bootstrapUserDir(tmp, "alice");
    expect(p.mcp.startsWith(p.root)).toBe(false);
    expect(() =>
      workspaceFs(p.root, { op: "write", files: [{ path: "mcp.json", b64: b64('{"servers":{"x":{"type":"stdio","command":"sh"}}}') }] }),
    ).toThrow(/Refused/);
    expect(() => workspaceFs(p.root, { op: "delete", paths: ["mcp.json"] })).toThrow(/Refused/);
    // the real file, beside the credentials, never saw it
    const servers = (JSON.parse(fs.readFileSync(p.mcp, "utf8")) as { servers: Record<string, unknown> }).servers;
    expect(servers["x"]).toBeUndefined();
  });

  it("every other workspace file still syncs normally", () => {
    const p = bootstrapUserDir(tmp, "alice");
    expect(workspaceFs(p.root, { op: "write", files: [{ path: "notes.md", b64: b64("hi") }] })).toEqual({ ok: true });
  });
});

describe("workspace mount caps", () => {
  it("mounts git object packs over the file cap, while big regular files stay out", () => {
    const p = bootstrapUserDir(tmp, "alice");
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const packDir = path.join(p.root, ".git", "objects", "pack");
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, "big.pack"), big);
    fs.writeFileSync(path.join(p.root, "big.bin"), big);
    const tree = workspaceFs(p.root, { op: "tree" }) as { tree?: { files: { path: string; size: number }[] } };
    const paths = (tree.tree?.files ?? []).map((f) => f.path);
    expect(paths).toContain(".git/objects/pack/big.pack");
    expect(paths).not.toContain("big.bin");
  });
});

describe("browser runner readiness", () => {
  const cfg = defaultSandboxConfig();
  function busStub() {
    const emitted: [string, string, Record<string, unknown>][] = [];
    const bus = {
      emit: (username: string, type: string, payload: Record<string, unknown>) => {
        emitted.push([username, type, payload]);
      },
    } as unknown as EventBus;
    return { bus, emitted };
  }

  it("waits for a mounting host, then says the tab needs a reload", async () => {
    const { bus, emitted } = busStub();
    const runner = new BrowserSandbox(cfg, bus, 300);
    runner.hello("alice", "host123456", false);
    const started = Date.now();
    const res = await runner.run("alice", "/tmp", { command: "ls" });
    expect("error" in res && res.error).toMatch(/did not start.*Reload/s);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(emitted).toEqual([]);
  });

  it("names a stale page as such", async () => {
    const runner = new BrowserSandbox(cfg, busStub().bus, 50);
    runner.hello("alice", "host123456", false, true);
    const res = await runner.run("alice", "/tmp", { command: "ls" });
    expect("error" in res && res.error).toMatch(/older page load/);
  });

  it("queues on a ready host and resolves the run", async () => {
    const { bus, emitted } = busStub();
    const runner = new BrowserSandbox(cfg, bus, 50);
    runner.hello("alice", "host123456", true);
    const pending = runner.run("alice", "/tmp", { command: "uname" });
    await new Promise((r) => setTimeout(r, 10));
    const [, type, payload] = emitted[0]!;
    expect(type).toBe("sandbox_run");
    expect(payload.command).toBe("uname");
    expect(runner.resolve("alice", payload.id as string, { exitCode: 0, stdout: "wasi\n" })).toBe(true);
    const res = await pending;
    expect("stdout" in res && res.stdout).toBe("wasi\n");
  });

  it("status tells the truth about a host that never mounted", () => {
    const runner = new BrowserSandbox(cfg, busStub().bus, 50);
    expect(runner.status().reason).toMatch(/no sandbox is connected/);
    runner.hello("alice", "host123456", false);
    expect(runner.status().reason).toMatch(/starting up/);
    runner.hello("alice", "host123456", false, true);
    expect(runner.status().reason).toMatch(/older sandbox/);
  });
});
