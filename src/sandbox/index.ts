/**
 * The agent shell runs ONLY in the user's browser: commands execute inside a
 * WebAssembly sandbox (wasmsh) in a sandboxed, network-less frame on every
 * platform — Windows, macOS, Linux, Android — and never on the host. There is
 * no local execution path: `provider: "off"` just disables the shell.
 */
import type { EventBus } from "../server/ws.js";
import { BrowserSandbox } from "./browser.js";

export type SandboxProviderName = "browser" | "off";

export interface SandboxConfig {
  provider: SandboxProviderName;
  /** Per-exec timeout ceiling (ms). */
  timeoutMs: number;
}

export function defaultSandboxConfig(): SandboxConfig {
  return { provider: "browser", timeoutMs: 120_000 };
}

export interface SandboxRunInput {
  command: string;
  timeoutMs?: number;
}

export interface SandboxRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  provider: "browser";
}

export interface SandboxStatus {
  provider: SandboxProviderName;
  available: boolean;
  reason: string;
  running: number;
  /** Always false: nothing ever runs on the host. */
  unsafe: boolean;
  /** "wasm" = inside the browser sandbox | "off" = shell disabled. */
  isolation: "wasm" | "off";
}

const OUT_CAP = 64 * 1024; // total per stream
const OUT_HEAD = 16 * 1024; // keep this much from the top …
const OUT_TAIL = OUT_CAP - OUT_HEAD; // … and this much from the bottom

/** Keep head+tail of oversized output with a clear seam. */
export function capOutput(s: string): { text: string; truncated: boolean } {
  if (s.length <= OUT_CAP) return { text: s, truncated: false };
  const dropped = s.length - OUT_CAP;
  return {
    text: s.slice(0, OUT_HEAD) + `\n[... ${dropped} bytes truncated ...]\n` + s.slice(s.length - OUT_TAIL),
    truncated: true,
  };
}

export interface SandboxRunner {
  readonly config: SandboxConfig;
  readonly enabled: boolean;
  status(): SandboxStatus;
  run(username: string, userRoot: string, input: SandboxRunInput): Promise<SandboxRunResult | { error: string }>;
}

/** The only shell that exists: the browser sandbox. */
export function createSandbox(cfg: SandboxConfig, bus: EventBus): SandboxRunner {
  return new BrowserSandbox(cfg, bus);
}
