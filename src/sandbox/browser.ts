/**
 * The browser sandbox runner: commands execute in the user's browser, in a
 * sandboxed frame's worker running a WebAssembly shell, never on the host.
 * The engine owns the workspace files: the page's sandbox host lists them for
 * the runtime, which reads contents as commands need them, and posts changed
 * files back through the workspace route.
 *
 * The engine talks to the host over the event bus (run requests go out as
 * `sandbox_run`, results come back on /v1/sandbox/result) and treats a host
 * that stopped heartbeating as gone: with no browser tab there is no shell,
 * which is the point.
 */
import type { EventBus } from "../server/ws.js";
import type { SandboxConfig, SandboxRunInput, SandboxRunResult, SandboxRunner, SandboxStatus } from "./index.js";
import { capOutput } from "./index.js";

/** How long a host heartbeat stays valid. */
const HOST_TTL = 45_000;
/** Grace on top of the requested timeout for browser-side scheduling. */
const RUN_GRACE = 15_000;
/** How long a run waits for a connected host to finish mounting the workspace. */
const READY_WAIT_MS = 10_000;

interface HostState {
  hostId: string;
  lastSeen: number;
  ready: boolean;
  /** The page said its host bundle predates the engine's current one. */
  stale: boolean;
  /** Why the page's runtime did not start, when it said. */
  error: string | null;
}

interface PendingRun {
  resolve: (r: SandboxRunResult | { error: string }) => void;
  timer: NodeJS.Timeout;
}

export class BrowserSandbox implements SandboxRunner {
  private hosts = new Map<string, HostState>();
  private pending = new Map<string, PendingRun>();

  constructor(
    private cfg: SandboxConfig,
    private bus: EventBus,
    private readyWaitMs = READY_WAIT_MS,
  ) {}

  get config(): SandboxConfig {
    return this.cfg;
  }

  get enabled(): boolean {
    return this.cfg.provider !== "off";
  }

  /** Host heartbeat (and registration). `ready` is true once the workspace is
   *  mounted; the run path refuses to queue commands before that. The most
   *  recent heartbeating host is the one addressed by runs, so two open tabs
   *  never execute the same command. `stale` marks a page from an older load
   *  whose host bundle no longer matches this engine: it cannot run commands
   *  and only a reload fixes it, so say so instead of waiting on it. */
  hello(username: string, hostId: string, ready: boolean, stale = false, error: string | null = null): void {
    const cur = this.hosts.get(username);
    const same = cur?.hostId === hostId;
    this.hosts.set(username, {
      hostId,
      lastSeen: Date.now(),
      ready: ready || (same && cur!.ready && !error),
      stale: same ? stale || cur!.stale : stale,
      error,
    });
  }

  /** A page that is going away says so, and runs stop being sent to it. */
  forget(username: string, hostId: string): void {
    if (this.hosts.get(username)?.hostId === hostId) this.hosts.delete(username);
  }

  private host(username: string): HostState | null {
    const h = this.hosts.get(username);
    if (!h) return null;
    if (Date.now() - h.lastSeen > HOST_TTL) {
      this.hosts.delete(username);
      return null;
    }
    return h;
  }

  status(): SandboxStatus {
    if (this.cfg.provider === "off") {
      return { provider: "off", available: false, reason: "shell is off (agent.shell in config.yaml)", running: 0, unsafe: false, isolation: "off" };
    }
    const known = [...this.hosts.values()].filter((h) => Date.now() - h.lastSeen <= HOST_TTL);
    const ready = known.filter((h) => h.ready).length;
    const failed = known.find((h) => h.error);
    const reason = ready
      ? "commands run in this browser, in a sandboxed WebAssembly shell: busybox, git, python 3, node, jq, rg, curl, with the workspace at /workspace and no access to this machine"
      : known.some((h) => h.stale)
        ? "this page is running an older sandbox than the engine; reload the tab to start the shell"
        : failed
          ? `the sandbox in this tab did not start: ${failed.error}`
          : known.length
            ? "the sandbox in this tab is starting up; reload the page if this sticks"
            : "no sandbox is connected: open Chrysalis in a browser tab to run shell commands (they never run on the host)";
    return {
      provider: "browser",
      available: ready > 0,
      reason,
      running: this.pending.size,
      unsafe: false,
      isolation: "wasm",
    };
  }

  async run(username: string, _userRoot: string, input: SandboxRunInput): Promise<SandboxRunResult | { error: string }> {
    if (this.cfg.provider === "off") return { error: "the shell is off on this instance (agent.shell in config.yaml)" };
    let h = this.host(username);
    if (!h) return { error: "No sandbox is connected. Open Chrysalis in a browser tab; commands run there, never on the host." };
    if (!h.ready) {
      // A fresh page mounts the workspace before it can run anything, and a
      // heartbeat replaces the record, so re-read until ready or out of time.
      const deadline = Date.now() + this.readyWaitMs;
      while (!h.ready && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        h = this.host(username);
        if (!h) break;
      }
      if (!h) return { error: "No sandbox is connected. Open Chrysalis in a browser tab; commands run there, never on the host." };
      if (!h.ready) {
        return {
          error: h.stale
            ? "The sandbox in this tab is from an older page load and cannot run commands. Reload the browser tab, then try again."
            : h.error
              ? `The sandbox in this tab did not start (${h.error}). Reload the browser tab, then try again.`
              : "The sandbox in this tab did not start. Reload the browser tab, then try again.",
        };
      }
    }
    const timeout = Math.min(Math.max(1000, Math.floor(input.timeoutMs ?? this.cfg.timeoutMs)), this.cfg.timeoutMs);
    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(`${username}:${id}`);
        resolve({ error: `The sandbox did not answer within ${timeout}ms (the browser tab may have been closed or the command stopped responding).` });
      }, timeout + RUN_GRACE);
      timer.unref?.();
      this.pending.set(`${username}:${id}`, { resolve, timer });
      this.bus.emit(username, "sandbox_run", { id, host: h.hostId, command: input.command, timeoutMs: timeout });
    });
  }

  /** A host finished a command. */
  resolve(username: string, id: unknown, result: { exitCode?: number | null; stdout?: string; stderr?: string; timedOut?: boolean; truncated?: boolean }): boolean {
    if (typeof id !== "string") return false;
    const key = `${username}:${id}`;
    const p = this.pending.get(key);
    if (!p) return false;
    this.pending.delete(key);
    clearTimeout(p.timer);
    const so = capOutput(String(result.stdout ?? ""));
    const se = capOutput(String(result.stderr ?? ""));
    p.resolve({
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      stdout: so.text,
      stderr: se.text,
      timedOut: result.timedOut === true,
      truncated: result.truncated === true || so.truncated || se.truncated,
      provider: "browser",
    });
    return true;
  }
}
