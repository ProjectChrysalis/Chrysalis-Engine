/**
 * Main-thread sandbox manager: one worker thread owns the QuickJS runtime.
 * Timeout/abort → terminate the worker and respawn on next use. A poisoned
 * wasm state can never take down the server process (SPEC-v2 §S1).
 */
import { Worker } from "node:worker_threads";
import path from "node:path";
import { availableParallelism } from "node:os";
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
  fsReadOnly?: boolean;
  zipAllowed?: boolean;
  zipBase64?: string;
  zipEntries?: Record<string, unknown>;
  fsTransaction?: string;
  /** Safe reads may be repeated once when the WASM runtime aborts during teardown. */
  retryOnPoison?: boolean;
  /** The call only reads its folder, so it may run beside other reads of it. */
  fsShared?: boolean;
  /** Report what the call read (SandboxResponse.reads) when its result could
   *  be given again for the same request. */
  trackReads?: boolean;
  /** Execution and memory limits for this call, above the 10 s and 256 MB
   *  defaults. Only for work that is allowed to be long, on its own sandbox:
   *  a worker runs one call at a time. */
  executionTimeoutMs?: number;
  memoryLimitBytes?: number;
}

export interface SandboxResponse {
  ok: boolean;
  out?: unknown;
  error?: string;
  /** Keys the call set, and keys it deleted. */
  storeWrites?: Record<string, unknown>;
  storeDeletes?: string[];
  llmRequests?: { key: string; req: unknown }[];
  netRequests?: { key: string; req: unknown }[];
  embedRequests?: { key: string; req: { texts?: unknown; model?: unknown } }[];
  logs?: string[];
  fsWrites?: string[];
  /** The worker's shared wasm heap after this call (see HEAP_RETIRE_BYTES). */
  heapBytes?: number;
  /** With trackReads, on a result that depends only on the request, the store
   *  and these files: [kind + path, signature] as each stood when read. */
  reads?: [string, string][];
  /** Length of the serialized result, with reads. */
  outBytes?: number;
}

/** The wasm heap only grows, a few MB per large route, so a worker past this
 *  is ended after its call and a fresh one takes its slot; ending the thread
 *  is the only way that memory comes back. */
const HEAP_RETIRE_BYTES = 256 * 1024 * 1024;

/** Errors after which this worker must not serve another call. */
const POISONED = /timed out|aborted|exited|worker error|out of memory/;

class SandboxWorkerHandle {
  worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: SandboxResponse) => void }>();

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
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, error: `sandbox call timed out after ${timeoutMs}ms` }), timeoutMs);
      this.pending.set(id, { resolve: finish });
      this.worker.postMessage({ id, ...req });
    });
  }

  async dispose(): Promise<void> {
    await this.worker.terminate();
  }
}

/** Calls on one data folder: reads share it, anything that may write has it
 *  alone, so a route's read-modify-write never interleaves with another's
 *  even when they run on different workers. Waiters are served in arrival
 *  order, so a queued write is not starved by a stream of reads. */
class FolderLock {
  private readers = 0;
  private writing = false;
  private queue: { shared: boolean; grant: () => void }[] = [];

  acquire(shared: boolean): Promise<void> {
    return new Promise((grant) => {
      this.queue.push({ shared, grant });
      this.drain();
    });
  }

  release(shared: boolean): void {
    if (shared) this.readers--;
    else this.writing = false;
    this.drain();
  }

  get idle(): boolean {
    return this.readers === 0 && !this.writing && this.queue.length === 0;
  }

  private drain(): void {
    while (this.queue.length) {
      const next = this.queue[0]!;
      if (this.writing || (!next.shared && this.readers > 0)) return;
      this.queue.shift();
      if (next.shared) this.readers++;
      else this.writing = true;
      next.grant();
    }
  }
}

const folderLocks = new Map<string, FolderLock>();

async function withFolder<T>(req: SandboxRequest, run: () => Promise<T>): Promise<T> {
  const root = req.fsAllowed && req.fsRoot ? req.fsRoot : null;
  if (!root) return run();
  const shared = req.fsShared === true || req.fsReadOnly === true;
  let lock = folderLocks.get(root);
  if (!lock) folderLocks.set(root, (lock = new FolderLock()));
  await lock.acquire(shared);
  try {
    return await run();
  } finally {
    lock.release(shared);
    if (lock.idle) folderLocks.delete(root);
  }
}

/** Idle workers beyond the first end after this long. */
const IDLE_WORKER_MS = 60_000;

/**
 * Runs sandbox calls on up to `size` worker threads, one call per worker at a
 * time. A slow call holds only its own worker, and a worker that fails takes
 * down only the call it was running.
 */
export class PluginSandbox {
  private idle: SandboxWorkerHandle[] = [];
  private busy = new Set<SandboxWorkerHandle>();
  private waiting: ((h: SandboxWorkerHandle) => void)[] = [];
  private idleTimers = new Map<SandboxWorkerHandle, ReturnType<typeof setTimeout>>();

  constructor(private size = 1) {}

  /** Live worker threads (busy or idle). */
  get workers(): number {
    return this.idle.length + this.busy.size;
  }

  private acquire(): Promise<SandboxWorkerHandle> {
    const h = this.idle.pop();
    if (h) {
      clearTimeout(this.idleTimers.get(h));
      this.idleTimers.delete(h);
      this.busy.add(h);
      return Promise.resolve(h);
    }
    if (this.workers < this.size) {
      const fresh = new SandboxWorkerHandle();
      this.busy.add(fresh);
      return Promise.resolve(fresh);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Hand the worker to the next waiting call, or park it. A worker that must
   *  not serve again is ended and its slot goes to a fresh one. */
  private release(h: SandboxWorkerHandle, reusable: boolean): void {
    this.busy.delete(h);
    if (!reusable) void h.dispose().catch(() => undefined);
    const next = this.waiting.shift();
    if (next) {
      const worker = reusable ? h : new SandboxWorkerHandle();
      this.busy.add(worker);
      next(worker);
      return;
    }
    if (!reusable) return;
    this.idle.push(h);
    if (this.idle.length > 1) {
      const timer = setTimeout(() => {
        this.idleTimers.delete(h);
        const at = this.idle.indexOf(h);
        if (at < 0 || this.idle.length <= 1) return;
        this.idle.splice(at, 1);
        void h.dispose().catch(() => undefined);
      }, IDLE_WORKER_MS);
      timer.unref?.();
      this.idleTimers.set(h, timer);
    }
  }

  private async evalAttempt(req: SandboxRequest, mayRetry: boolean): Promise<SandboxResponse> {
    const h = await this.acquire();
    let res: SandboxResponse;
    try {
      res = await h.call(req);
    } catch (e) {
      this.release(h, false);
      throw e;
    }
    const poisoned = !res.ok && POISONED.test(res.error ?? "");
    if (poisoned) log.warn(`[sandbox] worker poisoned (${res.error}) — terminating and respawning`);
    this.release(h, !poisoned && (res.heapBytes ?? 0) <= HEAP_RETIRE_BYTES);
    // a call that ran out of time or memory would do so again
    if (poisoned && mayRetry && !/timed out|out of memory/.test(res.error ?? "")) return this.evalAttempt(req, false);
    return res;
  }

  /** Run one eval; poisoned workers are replaced before another call uses them. */
  async eval(req: SandboxRequest): Promise<SandboxResponse> {
    return withFolder(req, () => this.evalAttempt(req, req.retryOnPoison === true));
  }

  async dispose(): Promise<void> {
    const all = [...this.idle, ...this.busy];
    this.idle = [];
    this.busy.clear();
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    await Promise.all(all.map((h) => h.dispose().catch(() => undefined)));
  }
}

/** Workers for the process-wide sandbox: enough that one heavy route leaves
 *  room for the rest, few enough that each keeps its heap. */
const SHARED_WORKERS = Math.min(4, Math.max(2, availableParallelism() - 1));

/** Process-wide pool. */
export const sandbox = new PluginSandbox(SHARED_WORKERS);
