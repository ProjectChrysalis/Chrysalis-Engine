import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

class Element {
  children: Element[] = [];
  listeners = new Map<string, (event: { isTrusted: boolean }) => void>();
  href = "";
  download = "";
  textContent = "";
  removed = false;
  open = false;
  clicks = 0;
  constructor(readonly tag: string) {}
  setAttribute() {}
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.children.push(child); }
  addEventListener(type: string, handler: (event: { isTrusted: boolean }) => void) { this.listeners.set(type, handler); }
  show() { this.open = true; }
  close() { this.open = false; }
  remove() { this.removed = true; }
  click() { this.clicks++; }
}

function host() {
  const handlers: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const window: Record<string, unknown> = { addEventListener: (_: string, handler: typeof handlers[number]) => handlers.push(handler) };
  const body = new Element("body");
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const timers: Array<() => void> = [];
  class ObjectURL extends URL {
    static createObjectURL(blob: Blob): `blob:${string}` { blobs.push(blob); return "blob:host/file"; }
    static revokeObjectURL(url: string) { revoked.push(url); }
  }
  const context = vm.createContext({
    window, document: { body, head: new Element("head"), createElement: (tag: string) => new Element(tag) },
    Blob, URL: ObjectURL, crypto: { getRandomValues: (bytes: Uint8Array) => bytes },
    localStorage: { getItem: () => null }, TextEncoder, TextDecoder, Uint8Array,
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    setTimeout: (callback: () => void) => timers.push(callback),
    fetch: () => { throw new Error("downloads must never fetch"); },
  });
  vm.runInContext(fs.readFileSync("client/public/app-bridge-host.js", "utf8"), context);
  const bridge = window.ChrysalisBridgeHost as { serve: (frame: { contentWindow: unknown }, appId: string, username: string) => () => void };
  const messages: Record<string, unknown>[] = [];
  const source = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
  const unregister = bridge.serve({ contentWindow: source }, "notes", "alice");
  const dispatch = (data: Record<string, unknown>, sender: unknown = source) => handlers.forEach((handler) => { handler({ source: sender, data: { __chrysalis: 1, ...data } }); });
  dispatch({ type: "hello" });
  const nonce = messages.find((m) => m.type === "init")!.nonce;
  const request = (fields: Record<string, unknown> = {}) => dispatch({ type: "download", nonce, blob: new Blob(["contents"]), filename: "notes.txt", ...fields });
  const panels = () => body.children.filter((element) => element.tag === "dialog" && !element.removed);
  return { request, dispatch, panels, body, blobs, revoked, timers, messages, unregister, nonce };
}

describe("app file downloads", () => {
  it("accepts bytes from a registered app, then requires a real shell click", async () => {
    const h = host();
    h.request({ filename: "../notes.txt" });
    const panel = h.panels()[0]!;
    expect(panel.children[0]!.textContent).toBe("Download from notes");
    expect(panel.children[1]!.textContent).toBe(".._notes.txt");
    expect(h.blobs).toHaveLength(0);
    const save = panel.children[2]!;
    save.listeners.get("click")!({ isTrusted: false });
    expect(h.blobs).toHaveLength(0);
    save.listeners.get("click")!({ isTrusted: true });
    expect(await h.blobs[0]!.text()).toBe("contents");
    expect(h.blobs[0]!.type).toBe("application/octet-stream");
    const anchor = h.body.children.find((e) => e.tag === "a")!;
    expect(anchor.download).toBe(".._notes.txt");
    expect(anchor.clicks).toBe(1);
    expect(h.panels()).toHaveLength(0);
    expect(h.revoked).toHaveLength(0);
    h.timers[0]!();
    expect(h.revoked).toEqual(["blob:host/file"]);
  });

  it("rejects unknown frames, stale nonces, URLs, and oversized blobs", () => {
    const h = host();
    h.dispatch({ type: "download", nonce: h.nonce, blob: new Blob(["bad"]), filename: "bad.txt" }, {});
    h.request({ nonce: "wrong" });
    h.request({ blob: "https://outside.example/secret" });
    h.request({ blob: new Blob([new Uint8Array(64 * 1024 * 1024 + 1)]) });
    expect(h.panels()).toHaveLength(0);
    expect(h.blobs).toHaveLength(0);
    expect(h.messages.filter((m) => m.type === "download-error")).toHaveLength(2);
  });

  it("caps pending files and releases them on cancel or app close", () => {
    const h = host();
    h.request();
    h.request({ filename: "second.txt" });
    expect(h.panels()).toHaveLength(1);
    expect(h.messages.at(-1)!.type).toBe("download-error");
    h.panels()[0]!.children[3]!.listeners.get("click")!({ isTrusted: true });
    expect(h.panels()).toHaveLength(0);
    h.request();
    h.unregister();
    expect(h.panels()).toHaveLength(0);
    expect(h.blobs).toHaveLength(0);
  });
});

it("bridges detached anchor clicks and ordinary links using only locally created blobs", () => {
  const messages: Record<string, unknown>[] = [];
  const handlers: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const clickHandlers: Array<(event: { target: unknown; preventDefault: () => void }) => void> = [];
  const parent = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
  const window = { parent, addEventListener: (_: string, handler: typeof handlers[number]) => handlers.push(handler) };
  let nextURL = 0;
  class ObjectURL extends URL {
    static createObjectURL(_blob: Blob): `blob:${string}` { return `blob:null/${++nextURL}`; }
    static revokeObjectURL(_url: string) {}
  }
  class Anchor extends Element {
    constructor() { super("a"); }
    hasAttribute(name: string) { return name === "download"; }
    closest() { return this; }
  }
  const context = vm.createContext({
    window, document: { addEventListener: (_: string, handler: typeof clickHandlers[number]) => clickHandlers.push(handler) },
    location: { href: "http://localhost:8788/app/alice/notes/", hash: "" },
    HTMLAnchorElement: Anchor, Blob, URL: ObjectURL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array,
    setInterval: () => 0, clearInterval: () => {}, console,
  });
  vm.runInContext(fs.readFileSync("client/public/app-bridge.js", "utf8"), context);
  handlers[0]!({ source: parent, data: { __chrysalis: 1, type: "init", nonce: "file-nonce" } });
  const blob = new Blob(["exported text"]);
  const anchor = new Anchor();
  anchor.href = ObjectURL.createObjectURL(blob);
  anchor.download = "export.txt";
  anchor.click();
  expect(anchor.clicks).toBe(0);
  expect(messages.at(-1)).toMatchObject({ type: "download", blob, filename: "export.txt", nonce: "file-nonce" });
  let prevented = false;
  clickHandlers[0]!({ target: anchor, preventDefault: () => { prevented = true; } });
  expect(prevented).toBe(true);
  ObjectURL.revokeObjectURL(anchor.href);
  anchor.click();
  expect(anchor.clicks).toBe(1);
  const remote = new Anchor();
  remote.href = "https://outside.example/file";
  remote.download = "file.txt";
  remote.click();
  expect(remote.clicks).toBe(1);
  expect(messages.filter((m) => m.type === "download")).toHaveLength(2);
});
