/**
 * The browser sandbox runner: commands execute in the user's browser, inside
 * a sandboxed frame running wasmsh (WebAssembly), never on the host. The
 * engine owns the workspace files: the shell host mounts them, runs commands,
 * and posts changed files back through the workspace route.
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

interface HostState {
  hostId: string;
  lastSeen: number;
  ready: boolean;
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
   *  never execute the same command. */
  hello(username: string, hostId: string, ready: boolean): void {
    const cur = this.hosts.get(username);
    this.hosts.set(username, { hostId, lastSeen: Date.now(), ready: ready || (cur?.hostId === hostId && cur.ready) });
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
    const ready = [...this.hosts.values()].filter((h) => h.ready && Date.now() - h.lastSeen <= HOST_TTL).length;
    return {
      provider: "browser",
      available: ready > 0,
      reason: ready
        ? "commands run in this browser, in a WebAssembly sandbox (wasmsh): bash + 88 utilities and Python, workspace mounted at /workspace, internet when the user allows it, no host access"
        : "no sandbox is connected — open Chrysalis in a browser tab to run shell commands (they never run on the host)",
      running: this.pending.size,
      unsafe: false,
      isolation: "wasm",
    };
  }

  async run(username: string, _userRoot: string, input: SandboxRunInput): Promise<SandboxRunResult | { error: string }> {
    if (this.cfg.provider === "off") return { error: "the shell is off on this instance (agent.shell in config.yaml)" };
    const h = this.host(username);
    if (!h) return { error: "No sandbox is connected. Open Chrysalis in a browser tab; commands run there, never on the host." };
    if (!h.ready) return { error: "The browser sandbox is still starting up. Try again in a moment." };
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
