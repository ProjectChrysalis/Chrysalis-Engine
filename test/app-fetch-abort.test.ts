import { expect, it } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

type Handler = (event: { source: unknown; data: unknown }) => void;

function frame(ready = true) {
  const messages: Record<string, unknown>[] = [];
  const handlers: Handler[] = [];
  const parent = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
  const window = { parent, addEventListener: (_: string, handler: Handler) => handlers.push(handler) };
  const context = vm.createContext({ window, document: { addEventListener: () => {} },
    location: { href: "http://localhost:18878/app/alice/notes/", hash: "" },
    HTMLAnchorElement: class { click() {} }, URL, URLSearchParams, Blob, Request, Response, Headers,
    DOMException, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, btoa, atob,
    setInterval: () => 0, clearInterval: () => {}, console,
  });
  vm.runInContext(fs.readFileSync("client/public/app-bridge.js", "utf8"), context);
  const init = () => { for (const h of handlers) h({ source: parent, data: { __chrysalis: 1, type: "init", nonce: "test" } }); };
  if (ready) init();
  const fetch = (window as typeof window & { fetch: typeof globalThis.fetch }).fetch;
  return { messages, fetch, init };
}

it("never sends an already aborted request", async () => {
  const h = frame();
  const ctrl = new AbortController();
  ctrl.abort();
  await expect(h.fetch("http://localhost:18878/v1/models", { signal: ctrl.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(h.messages.filter((m) => m.type === "fetch")).toHaveLength(0);
});

it("rejects and cancels an in-flight bridged request", async () => {
  const h = frame();
  const ctrl = new AbortController();
  const result = h.fetch("http://localhost:18878/v1/models", { signal: ctrl.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sent = h.messages.find((m) => m.type === "fetch");
  expect(sent).toBeDefined();
  ctrl.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(h.messages).toContainEqual(expect.objectContaining({ type: "fetch-abort", id: sent?.id }));
});

it("does not dispatch requests cancelled while waiting for the handshake", async () => {
  const h = frame(false);
  const ctrl = new AbortController();
  const result = h.fetch("http://localhost:18878/v1/models", { signal: ctrl.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  ctrl.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  h.init();
  expect(h.messages.filter((m) => m.type === "fetch")).toHaveLength(0);
});

it("host cancellation is scoped to the frame and nonce, and reload releases requests", () => {
  const handlers: Handler[] = [];
  const signals: AbortSignal[] = [];
  const window = { addEventListener: (_: string, handler: Handler) => handlers.push(handler) };
  const context = vm.createContext({ window, document: {}, location: { origin: "http://localhost:18878" },
    localStorage: { getItem: () => null }, crypto, URL, AbortController, ArrayBuffer, Uint8Array, TextEncoder, TextDecoder, btoa, atob,
    fetch: (_url: string, init: RequestInit) => { signals.push(init.signal ?? AbortSignal.abort()); return new Promise(() => {}); },
  });
  vm.runInContext(fs.readFileSync("client/public/app-bridge-host.js", "utf8"), context);
  const host = (window as typeof window & { ChrysalisBridgeHost: { serve: (frame: { contentWindow: unknown }, app: string, user: string) => () => void } }).ChrysalisBridgeHost;
  const make = () => {
    const messages: Record<string, unknown>[] = [];
    const source = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
    const stop = host.serve({ contentWindow: source }, "notes", "alice");
    const dispatch = (data: Record<string, unknown>) => { for (const h of handlers) h({ source, data: { __chrysalis: 1, ...data } }); };
    dispatch({ type: "hello", documentId: "first" });
    const nonce = messages.at(-1)?.nonce;
    dispatch({ type: "fetch", nonce, id: 1, method: "GET", url: "/v1/models" });
    return { dispatch, nonce, stop };
  };
  const a = make();
  const b = make();
  a.dispatch({ type: "fetch-abort", nonce: "wrong", id: 1 });
  expect(signals.map((s) => s.aborted)).toEqual([false, false]);
  a.dispatch({ type: "fetch-abort", nonce: a.nonce, id: 1 });
  expect(signals.map((s) => s.aborted)).toEqual([true, false]);
  b.dispatch({ type: "hello", documentId: "second" });
  expect(signals.map((s) => s.aborted)).toEqual([true, true]);
  b.dispatch({ type: "fetch", nonce: b.nonce, id: 2, method: "GET", url: "/v1/models" });
  b.stop();
  expect(signals.at(-1)?.aborted).toBe(true);
});
