/**
 * Browser sandbox: the engine half (host registry + run routing) and the
 * workspace file policy the host mounts/syncs through. No browser here: the
 * tests drive a fake bus and a fake workspace tree.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { BrowserSandbox } from "../src/sandbox/browser.js";
import { defaultSandboxConfig } from "../src/sandbox/index.js";
import { MAX_MOUNT_FILE, listWorkspaceFiles, sandboxPathAllowed, workspaceFs } from "../src/sandbox/workspace.js";
import { sandboxAsset, wasmshAsset } from "../src/sandbox/assets.js";
import type { EventBus } from "../src/server/ws.js";

let tmp: string;
let events: { username: string; type: string; payload: Record<string, unknown> }[];

const bus = (): EventBus =>
  ({
    emit: (username: string, type: string, payload: unknown) => {
      events.push({ username, type, payload: payload as Record<string, unknown> });
    },
  }) as unknown as EventBus;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-wasm-"));
  events = [];
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("browser sandbox runner", () => {
  it("refuses a run with no connected host and says why", async () => {
    const sb = new BrowserSandbox(defaultSandboxConfig(), bus());
    const r = await sb.run("admin", tmp, { command: "echo hi" });
    expect("error" in r && r.error).toMatch(/no sandbox is connected/i);
    expect(sb.status().available).toBe(false);
    expect(sb.status().isolation).toBe("wasm");
  });

  it("routes a run to the live host and resolves its result", async () => {
    const sb = new BrowserSandbox(defaultSandboxConfig(), bus());
    sb.hello("admin", "host12345678", true);
    expect(sb.status().available).toBe(true);
    const p = sb.run("admin", tmp, { command: "echo hi", timeoutMs: 5000 });
    const sent = events.find((e) => e.type === "sandbox_run");
    expect(sent?.payload.command).toBe("echo hi");
    expect(sent?.payload.host).toBe("host12345678");
    expect(sb.resolve("admin", sent?.payload.id, { exitCode: 0, stdout: "hi\n", stderr: "", timedOut: false })).toBe(true);
    const r = await p;
    expect("exitCode" in r && r.exitCode).toBe(0);
    expect("stdout" in r && r.stdout).toBe("hi\n");
  });

  it("ignores results for runs that are no longer waiting", () => {
    const sb = new BrowserSandbox(defaultSandboxConfig(), bus());
    expect(sb.resolve("admin", "nope", { exitCode: 0 })).toBe(false);
  });

  it("treats a stopped heartbeat as gone", async () => {
    vi.useFakeTimers();
    const sb = new BrowserSandbox(defaultSandboxConfig(), bus());
    sb.hello("admin", "host12345678", true);
    expect(sb.status().available).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sb.status().available).toBe(false);
    const r = await sb.run("admin", tmp, { command: "echo hi" });
    expect("error" in r).toBe(true);
  });

  it("refuses before the workspace is mounted", async () => {
    const sb = new BrowserSandbox(defaultSandboxConfig(), bus());
    sb.hello("admin", "host12345678", false);
    const r = await sb.run("admin", tmp, { command: "echo hi" });
    expect("error" in r && r.error).toMatch(/starting up/i);
  });
});

describe("workspace file policy", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmp, "apps", "demo", "src"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "apps", "demo", "data"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "apps", "demo", "node_modules", "x"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "agent", "sessions"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "apps", "demo", "src", "main.ts"), "console.log(1)\n");
    fs.writeFileSync(path.join(tmp, "apps", "demo", "data", "chat.json"), "{}\n");
    fs.writeFileSync(path.join(tmp, "apps", "demo", "node_modules", "x", "index.js"), "x\n");
    fs.writeFileSync(path.join(tmp, "agent", "sessions", "s.json"), "[]\n");
    fs.writeFileSync(path.join(tmp, "auth.json"), "SECRET\n");
    fs.writeFileSync(path.join(tmp, "apps", "demo", "big.txt"), "x".repeat(MAX_MOUNT_FILE + 1));
  });

  it("lists only mountable files and never auth.json or derived dirs", () => {
    const { files } = listWorkspaceFiles(tmp);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("apps/demo/src/main.ts");
    expect(paths).toContain("apps/demo/data/chat.json");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes("agent/"))).toBe(false);
    expect(paths.some((p) => p.includes(".git"))).toBe(false);
    expect(paths.some((p) => p.includes("auth.json"))).toBe(false);
    expect(paths.some((p) => p.includes("big.txt"))).toBe(false);
  });

  it("rejects traversal, absolute paths and credential names", () => {
    expect(sandboxPathAllowed("../outside")).toBeTruthy();
    expect(sandboxPathAllowed("/etc/passwd")).toBeTruthy();
    expect(sandboxPathAllowed("apps/demo/node_modules/x")).toBeTruthy();
    expect(sandboxPathAllowed("auth.json")).toBeTruthy();
    expect(sandboxPathAllowed("apps/demo/src/main.ts")).toBeNull();
  });

  it("reads, writes and deletes inside the workspace", () => {
    const read = workspaceFs(tmp, { op: "read", paths: ["apps/demo/src/main.ts"] });
    expect(read.files?.[0]?.b64 && Buffer.from(read.files[0]!.b64, "base64").toString()).toBe("console.log(1)\n");
    const write = workspaceFs(tmp, { op: "write", files: [{ path: "apps/demo/src/new.ts", b64: Buffer.from("ok\n").toString("base64") }] });
    expect(write.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, "apps", "demo", "src", "new.ts"), "utf8")).toBe("ok\n");
    const del = workspaceFs(tmp, { op: "delete", paths: ["apps/demo/src/new.ts"] });
    expect(del.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp, "apps", "demo", "src", "new.ts"))).toBe(false);
  });

  it("refuses to write through a symlink out of the workspace", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-out-"));
    try {
      fs.symlinkSync(outside, path.join(tmp, "link"));
      expect(() => workspaceFs(tmp, { op: "write", files: [{ path: "link/evil.txt", b64: "eA==" }] })).toThrow(/symlink|outside/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses denied targets (git internals, credentials shape)", () => {
    expect(() => workspaceFs(tmp, { op: "write", files: [{ path: ".git/config", b64: "eA==" }] })).toThrow(/Refused/);
    expect(() => workspaceFs(tmp, { op: "read", paths: ["auth.json"] })).toThrow(/Refused/);
  });
});

describe("sandbox assets", () => {
  it("serves the frame bundle and refuses package paths outside the wasmsh dir", async () => {
    const frame = await sandboxAsset("frame.html");
    expect(frame?.type).toContain("text/html");
    expect(frame?.body.toString()).toContain("/client/sandbox/frame.js");
    expect(wasmshAsset("browser-worker.js")?.body.length).toBeGreaterThan(1000);
    expect(wasmshAsset("../../package.json")).toBeNull();
    expect(wasmshAsset("assets/../package.json")).toBeNull();
  });
});
