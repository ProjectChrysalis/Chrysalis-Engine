/**
 * Main-thread sandbox manager: one worker thread owns the QuickJS runtime.
 * Timeout/abort → terminate the worker and respawn on next use. A poisoned
 * wasm state can never take down the server process (SPEC-v2 §S1).
 */
import { Worker } from "node:worker_threads";
import path from "node:path";
import { log } from "../logger.js";

/** A packaged build bundles the worker as its own entry point and names it:
 *  "./…" is the worker's source path, which a compiled executable maps to
 *  its embedded copy on every OS; anything else is a file beside the engine
 *  bundle. */
declare const CHRYSALIS_SANDBOX_WORKER: string | undefined;
const WORKER_PATH =
  typeof CHRYSALIS_SANDBOX_WORKER !== "string" ? path.join(import.meta.dir, "sandbox-worker.mjs") :
  CHRYSALIS_SANDBOX_WORKER.startsWith("./") ? CHRYSALIS_SANDBOX_WORKER :
  path.join(import.meta.dir, CHRYSALIS_SANDBOX_WORKER);
const CALL_TIMEOUT_MS = 20_000; // includes worker boot; sandbox itself caps at 10s
/** Room on top of a call's own execution limit for boot and the round trip. */
const CALL_OVERHEAD_MS = 10_000;

export interface SandboxRequest {
  source: string;
  hook: string;
  ctx: unknown;
  storeSnapshot: Record<string, unknown>;
  storeAllowed?: boolean;
  llmAllowed?: boolean;
  llmResults?: Record<string, unknown>;
  netAllowed?: boolean;
  netResults?: Record<string, unknown>;
  embedResults?: Record<string, unknown>;
  maxStoreBytes?: number;
  fsAllowed?: boolean;
  fsRoot?: string | null;
  zipAllowed?: boolean;
  zipBase64?: string;
  /** Safe reads may be repeated once when the WASM runtime aborts during teardown. */
  retryOnPoison?: boolean;
  /** Execution and memory limits for this call, above the 10 s and 64 MB
   *  defaults. Only for work that is allowed to be long, on its own sandbox:
   *  a worker runs one call at a time. */
  executionTimeoutMs?: number;
  memoryLimitBytes?: number;
}

export interface SandboxResponse {
  ok: boolean;
  out?: unknown;
  error?: string;
  storeWrites?: Record<string, unknown>;
  llmRequests?: { key: string; req: unknown }[];
  netRequests?: { key: string; req: unknown }[];
  embedRequests?: { key: string; req: { texts?: unknown; model?: unknown } }[];
  logs?: string[];
  /** The worker's shared wasm heap after this call (see HEAP_RETIRE_BYTES). */
  heapBytes?: number;
}

/** The wasm heap only grows, a few MB per large route, so a worker retires past
 *  this and hands new calls to a fresh one; ending the thread is the only way
 *  that memory comes back. */
const HEAP_RETIRE_BYTES = 256 * 1024 * 1024;

/** Errors after which this worker must not serve another call. */
const POISONED = /timed out|aborted|exited|worker error|out of memory/;

class SandboxWorkerHandle {
  worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: SandboxResponse) => void }>();
  private retiring = false;

  constructor() {
    // execArgv: [] — don't inherit runner flags (loader flags break/hang workers)
    this.worker = new Worker(WORKER_PATH, { execArgv: [] });
    this.worker.unref();
    this.worker.on("message", (msg: SandboxResponse & { id: number }) => {
      this.pending.get(msg.id)?.resolve(msg);
      this.pending.delete(msg.id);
    });
    this.worker.on("error", (err) => this.failAll(`worker error: ${err.message}`));
    this.worker.on("exit", (code) => this.failAll(`worker exited (${code})`));
  }

  private failAll(reason: string): void {
    for (const { resolve } of this.pending.values()) resolve({ ok: false, error: reason });
    this.pending.clear();
  }

  call(req: SandboxRequest, timeoutMs = req.executionTimeoutMs ? req.executionTimeoutMs + CALL_OVERHEAD_MS : CALL_TIMEOUT_MS): Promise<SandboxResponse> {
    const id = this.nextId++;
    return new Promise<SandboxResponse>((resolve) => {
      let settled = false;
      const finish = (r: SandboxResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        if (this.retiring && this.pending.size === 0) void this.dispose();
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, error: `sandbox call timed out after ${timeoutMs}ms` }), timeoutMs);
      this.pending.set(id, { resolve: finish });
      this.worker.postMessage({ id, ...req });
    });
  }

  /** Take no new work; the thread ends once its in-flight calls have answered. */
  retire(): void {
    this.retiring = true;
    if (this.pending.size === 0) void this.dispose();
  }

  async dispose(): Promise<void> {
    await this.worker.terminate();
  }
}

export class PluginSandbox {
  private handle: SandboxWorkerHandle | null = null;
  private recovering = new WeakMap<SandboxWorkerHandle, Promise<void>>();

  private getHandle(): SandboxWorkerHandle {
    this.handle ??= new SandboxWorkerHandle();
    return this.handle;
  }

  private recoverHandle(h: SandboxWorkerHandle): Promise<void> {
    const pending = this.recovering.get(h);
    if (pending) return pending;
    if (this.handle === h) this.handle = null;
    const recovery = h.dispose()
      .catch(() => undefined)
      .finally(() => this.recovering.delete(h));
    this.recovering.set(h, recovery);
    return recovery;
  }

  private async evalAttempt(req: SandboxRequest, mayRetry: boolean): Promise<SandboxResponse> {
    const h = this.getHandle();
    const res = await h.call(req);
    if ((res.heapBytes ?? 0) > HEAP_RETIRE_BYTES && this.handle === h) {
      this.handle = null;
      h.retire();
    }
    if (!res.ok && POISONED.test(res.error ?? "")) {
      if (!this.recovering.has(h)) {
        log.warn(`[sandbox] worker poisoned (${res.error}) — terminating and respawning`);
      }
      await this.recoverHandle(h);
      if (mayRetry && !/timed out/.test(res.error ?? "")) return this.evalAttempt(req, false);
    }
    return res;
  }

  /** Run one eval; poisoned workers are replaced before another call uses them. */
  async eval(req: SandboxRequest): Promise<SandboxResponse> {
    return this.evalAttempt(req, req.retryOnPoison === true);
  }

  async dispose(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    await h?.dispose().catch(() => undefined);
  }
}

/** Process-wide singleton. */
export const sandbox = new PluginSandbox();
