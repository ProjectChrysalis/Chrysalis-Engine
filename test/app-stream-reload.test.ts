import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

function hostFrame() {
  type Source = { messages: Record<string, unknown>[]; postMessage: (message: Record<string, unknown>) => void };
  const handlers: ((event: { source: Source; data: unknown }) => void)[] = [];
  const sockets: Socket[] = [];
  class Socket {
    readyState = 1;
    protocol = "";
    closed = false;
    sent: unknown[] = [];
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    constructor() { sockets.push(this); }
    close() { this.closed = true; }
    send(data: unknown) { this.sent.push(data); }
    delta() { this.onmessage?.({ data: JSON.stringify({ type: "app_stream", payload: { app: "roleplay", chatId: "chat", delta: "word" } }) }); }
  }
  const window = { addEventListener: (_type: string, handler: typeof handlers[number]) => handlers.push(handler) };
  const context = vm.createContext({ window, document: {}, location: { origin: "http://localhost:8788" },
    localStorage: { getItem: () => null }, crypto, WebSocket: Socket, URL, TextEncoder, TextDecoder, btoa, atob, Uint8Array });
  vm.runInContext(fs.readFileSync("client/public/app-bridge-host.js", "utf8"), context);
  const host = (window as typeof window & { ChrysalisBridgeHost: { serve: (frame: { contentWindow: Source }, app: string, user: string) => () => void } }).ChrysalisBridgeHost;
  const dispatch = (source: Source, data: Record<string, unknown>) => handlers.forEach((handler) => handler({ source, data: { __chrysalis: 1, ...data } }));
  const frame = () => {
    const source: Source = { messages: [], postMessage: (message) => source.messages.push(message) };
    const stop = host.serve({ contentWindow: source }, "roleplay", "alice");
    let nonce: unknown;
    const hello = (documentId: string) => {
      dispatch(source, { type: "hello", documentId });
      nonce = source.messages.at(-1)?.nonce;
    };
    const open = (wsId = 1) => dispatch(source, { type: "ws-open", nonce, wsId, url: "/v1/ws" });
    const send = () => dispatch(source, { type: "ws-send", nonce, wsId: 1, data: "hello" });
    return { source, hello, open, send, stop };
  };
  return { frame, sockets };
}

describe("app stream socket ownership", () => {
  it("reload closes old sockets and ignores their late messages and close events", () => {
    const { frame, sockets } = hostFrame();
    const app = frame();
    app.hello("first");
    app.open();
    app.open(2);
    app.hello("second");
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets[1]?.closed).toBe(true);
    app.open();
    app.hello("second");
    expect(sockets[2]?.closed).toBe(false);
    app.source.messages.length = 0;
    sockets.forEach((socket) => socket.delta());
    expect(app.source.messages).toHaveLength(1);
    sockets[0]?.onclose?.({ code: 1000, reason: "old page" });
    app.send();
    expect(sockets[2]?.sent).toEqual(["hello"]);
    app.stop();
    expect(sockets[2]?.closed).toBe(true);
    sockets[2]?.delta();
    expect(app.source.messages).toHaveLength(1);
  });

  it("same app frames with the same socket id stay independent", () => {
    const { frame, sockets } = hostFrame();
    const one = frame();
    const two = frame();
    one.hello("one"); two.hello("two");
    one.open(); two.open();
    one.open();
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets[1]?.closed).toBe(false);
    one.source.messages.length = 0;
    two.source.messages.length = 0;
    sockets.forEach((socket) => socket.delta());
    expect(one.source.messages).toHaveLength(1);
    expect(two.source.messages).toHaveLength(1);
    one.stop(); two.stop();
    expect(sockets.every((socket) => socket.closed)).toBe(true);
  });
});
