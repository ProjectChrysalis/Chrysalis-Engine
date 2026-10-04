import { expect, it } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

it("stops the browser worker, skips queued commands, and discards late writes", async () => {
  const calls: { url: string; method?: string; body: Record<string, unknown> }[] = [];
  const frames: { removed: boolean; contentWindow: { postMessage: (...args: unknown[]) => void } }[] = [];
  const ports: { onmessage?: (event: unknown) => void; closed: boolean; commands: Record<string, unknown>[] }[] = [];
  const listeners = new Set<(event: unknown) => void>();
  let socket!: { onmessage: (event: { data: string }) => void };
  const context = vm.createContext({
    console, AbortController, Uint8Array, Map, Set, Promise, Math, Date,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, queueMicrotask,
    location: { protocol: "http:", host: "localhost", origin: "http://localhost" },
    window: {},
    fetch: async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url, method: init?.method, body });
      return { ok: true, json: async () => url === "/v1/sandbox/fs" ? { tree: { files: [], truncated: false } } : {} };
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => { if (type === "message") listeners.add(listener); },
    removeEventListener: (_type: string, listener: (event: unknown) => void) => listeners.delete(listener),
    WebSocket: class { constructor() { socket = this as unknown as typeof socket; } },
    MessageChannel: class {
      port1 = { closed: false, commands: [] as Record<string, unknown>[], onmessage: undefined as ((event: unknown) => void) | undefined,
        postMessage(message: Record<string, unknown>) { this.commands.push(message); },
        close() { this.closed = true; },
      };
      port2 = this.port1;
      constructor() { ports.push(this.port1); }
    },
    document: {
      readyState: "complete",
      createElement: () => {
        const frame = { removed: false, style: {}, setAttribute() {}, remove() { this.removed = true; },
          contentWindow: { postMessage: (...args: unknown[]) => {
            const port = (args[2] as typeof ports)[0]!;
            queueMicrotask(() => port.onmessage?.({ data: { type: "ready", runtime: "test" } }));
          } },
        };
        frames.push(frame);
        return frame;
      },
      body: { appendChild: (frame: typeof frames[number]) => queueMicrotask(() => {
        for (const listener of listeners) listener({ source: frame.contentWindow, data: { __chrysalisSandbox: 1, t: "loaded" } });
      }) },
    },
  });
  const helper = fs.readFileSync(`${import.meta.dir}/../src/cancellation.ts`, "utf8").replace("export function", "function");
  const source = fs.readFileSync(`${import.meta.dir}/../src/sandbox/browser/host.ts`, "utf8")
    .replace('import { abortable } from "../../cancellation.js";', helper);
  vm.runInContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source), context);
  const send = (type: string, payload: Record<string, unknown>) => socket.onmessage({ data: JSON.stringify({ type, payload }) });
  const settle = async () => { for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 0)); };
  const host = (context.window as { ChrysalisSandbox: { host: string } }).ChrysalisSandbox.host;
  send("sandbox_run", { host, id: "first", command: "sleep 60", timeoutMs: 60_000 });
  await settle();
  expect(ports[0]!.commands).toHaveLength(1);
  send("sandbox_run", { host, id: "queued", command: "touch bad", timeoutMs: 60_000 });
  send("sandbox_cancel", { host, id: "queued" });
  send("sandbox_cancel", { host, id: "first" });
  await settle();
  expect(frames[0]!.removed).toBe(true);
  expect(ports[0]!.closed).toBe(true);
  ports[0]!.onmessage?.({ data: { type: "result", id: 1, exitCode: 0, stdout: "late", stderr: "", writes: [["bad", new Uint8Array([1])]], deletes: [] } });
  await settle();
  expect(calls.filter((call) => call.url === "/v1/sandbox/fs" && call.method === "PUT")).toEqual([]);
  send("sandbox_run", { host, id: "next", command: "true", timeoutMs: 60_000 });
  await settle();
  expect(frames).toHaveLength(2);
  expect(ports[1]!.commands).toHaveLength(1);
  ports[1]!.onmessage?.({ data: { type: "result", id: 1, exitCode: 0, stdout: "ok", stderr: "", writes: [], deletes: [] } });
  await settle();
  expect(calls.some((call) => call.url === "/v1/sandbox/result" && call.body.id === "next" && call.body.stdout === "ok")).toBe(true);
  send("sandbox_run", { host, id: "timeout", command: "sleep 10", timeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(frames[1]!.removed).toBe(true);
  expect(calls.some((call) => call.url === "/v1/sandbox/result" && call.body.id === "timeout" && call.body.timedOut === true)).toBe(true);
  send("sandbox_run", { host, id: "recovered", command: "echo recovered", timeoutMs: 60_000 });
  await settle();
  expect(frames).toHaveLength(3);
  ports[2]!.onmessage?.({ data: { type: "result", id: 1, exitCode: 0, stdout: "recovered", stderr: "", writes: [], deletes: [] } });
  await settle();
  expect(calls.some((call) => call.url === "/v1/sandbox/result" && call.body.id === "recovered" && call.body.stdout === "recovered")).toBe(true);
});
