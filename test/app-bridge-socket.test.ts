import { expect, it } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

type Handler = (event: { source: unknown; data: unknown }) => void;
type Socket = { readyState: number; close: () => void; onopen: (() => void) | null };

function frame(ready = true) {
  const messages: Record<string, unknown>[] = [];
  const handlers: Handler[] = [];
  const parent = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
  const window = { parent, addEventListener: (_: string, handler: Handler) => handlers.push(handler) };
  const context = vm.createContext({ window, document: { addEventListener: () => {} },
    location: { href: "http://localhost:18878/app/alice/notes/", hash: "" },
    HTMLAnchorElement: class { click() {} }, URL, URLSearchParams, Blob, Request, Response, Headers,
    DOMException, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, btoa, atob,
    setInterval: () => 0, clearInterval: () => {}, setTimeout, console,
  });
  vm.runInContext(fs.readFileSync("client/public/app-bridge.js", "utf8"), context);
  const deliver = (data: Record<string, unknown>) => { for (const h of handlers) h({ source: parent, data: { __chrysalis: 1, ...data } }); };
  const init = () => deliver({ type: "init", nonce: "test" });
  if (ready) init();
  const open = () => new (window as typeof window & { WebSocket: new (url: string) => Socket }).WebSocket("ws://localhost:18878/v1/ws");
  return { messages, open, init, deliver };
}

it("opens a socket without leaving a request waiting for a reply", () => {
  const h = frame();
  const ws = h.open();
  const sent = h.messages.find((m) => m.type === "ws-open");
  expect(sent).toMatchObject({ url: "/v1/ws", nonce: "test" });
  // an id marks a request the bridge holds until the host answers; the host
  // never answers a socket open, so the socket would be held for good
  expect(sent?.id).toBeUndefined();
  let opened = false;
  ws.onopen = () => { opened = true; };
  h.deliver({ type: "ws-event", wsId: sent?.wsId, event: "open" });
  expect(opened).toBe(true);
  expect(ws.readyState).toBe(1);
});

it("does not open a socket closed while waiting for the handshake", () => {
  const h = frame(false);
  h.open().close();
  h.init();
  expect(h.messages.filter((m) => m.type === "ws-open")).toHaveLength(0);
});
