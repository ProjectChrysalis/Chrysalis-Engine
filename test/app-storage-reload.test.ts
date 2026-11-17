import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

function frame(hash: string, deniedHistory = false) {
  const messages: unknown[] = [];
  const location = { href: "http://localhost:8788/app/alice/roleplay/", hash, replace: (value: string) => { location.hash = value; } };
  const window = {
    parent: { postMessage: (message: unknown) => messages.push(message) },
    addEventListener: () => {},
    history: { replaceState: (_state: unknown, _title: string, value: string) => {
      if (deniedHistory) throw new Error("opaque origin");
      location.hash = value;
    } },
  };
  const context = vm.createContext({ window, location, document: { addEventListener: () => {} },
    HTMLAnchorElement: class { click() {} }, URL, URLSearchParams, Blob, TextEncoder, TextDecoder, Uint8Array, btoa, atob,
    setInterval: () => 0, clearInterval: () => {}, console,
  });
  vm.runInContext(fs.readFileSync("client/public/app-bridge.js", "utf8"), context);
  const storage = window as typeof window & { localStorage: Storage; sessionStorage: Storage };
  return { location, storage, messages };
}

describe("app storage survives a frame reload", () => {
  for (const denied of [false, true]) {
    it(`reloads the latest chat and session state with history ${denied ? "blocked" : "available"}`, () => {
      const old = { local: { "chrysalis-store-v2": JSON.stringify({ state: { activeChatId: "old-chat" } }) }, session: {} };
      const initial = "#__storage=" + encodeURIComponent(btoa(JSON.stringify(old))) + "&view=chat";
      const first = frame(initial, denied);
      const latest = JSON.stringify({ state: { activeChatId: "new-chat", view: "chat", inputHistory: ["你好"] } });
      first.storage.localStorage.setItem("chrysalis-store-v2", latest);
      first.storage.sessionStorage.setItem("reload-note", "New code");
      expect(new URLSearchParams(first.location.hash.slice(1)).get("view")).toBe("chat");
      const reloaded = frame(first.location.hash, denied);
      expect(reloaded.storage.localStorage.getItem("chrysalis-store-v2")).toBe(latest);
      expect(reloaded.storage.sessionStorage.getItem("reload-note")).toBe("New code");
      reloaded.storage.localStorage.removeItem("chrysalis-store-v2");
      reloaded.storage.sessionStorage.clear();
      const cleared = frame(reloaded.location.hash, denied);
      expect(cleared.storage.localStorage.getItem("chrysalis-store-v2")).toBeNull();
      expect(cleared.storage.sessionStorage.length).toBe(0);
      expect(first.messages).toContainEqual(expect.objectContaining({ type: "storage", op: "set" }));
    });
  }
});

describe("app storage writes stay cheap", () => {
  it("does not send a value the frame already holds", () => {
    const f = frame("#view=chat");
    const ops = () => f.messages.filter((m) => (m as { type?: string }).type === "storage").length;
    f.storage.localStorage.setItem("draft", "hello");
    f.storage.localStorage.setItem("draft", "hello");
    f.storage.localStorage.removeItem("missing");
    (f.storage.localStorage as unknown as Record<string, string>).draft = "hello";
    expect(ops()).toBe(1);
    f.storage.localStorage.setItem("draft", "hello!");
    (f.storage.localStorage as unknown as Record<string, string>).draft = "bye";
    expect(ops()).toBe(3);
    expect(f.storage.localStorage.getItem("draft")).toBe("bye");
  });

  it("stops offering the browser a snapshot URL it refused", () => {
    const f = frame("#view=chat");
    let tries = 0;
    // both ways of updating the URL refuse a hash past 4000 characters
    const refuse = (value: string) => {
      tries++;
      if (value.length > 4000) throw new Error("URL too long");
      f.location.hash = value;
    };
    f.location.replace = refuse;
    f.storage.history.replaceState = (_state: unknown, _title: string, value: string) => refuse(value);
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      f.storage.localStorage.setItem("big", "x".repeat(5000));
      const afterBig = tries;
      f.storage.localStorage.setItem("big", "y".repeat(6000));
      expect(tries).toBe(afterBig);
      expect(warnings).toHaveLength(1);
      f.storage.localStorage.setItem("big", "small");
      expect(tries).toBe(afterBig + 1);
      expect(new URLSearchParams(f.location.hash.slice(1)).get("view")).toBe("chat");
      expect(frame(f.location.hash).storage.localStorage.getItem("big")).toBe("small");
    } finally { console.warn = warn; }
  });
});

function shell(stored: Record<string, string> = {}) {
  const handlers = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const window: Record<string, unknown> = { addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, [...(handlers.get(type) ?? []), handler]) };
  const reads: string[] = [];
  const localStorage = {
    getItem: (key: string) => { reads.push(key); return stored[key] ?? null; },
    setItem: (key: string, value: string) => { stored[key] = value; },
  };
  const context = vm.createContext({ window, document: { body: {}, head: {} }, URL, crypto: { getRandomValues: (bytes: Uint8Array) => bytes },
    localStorage, TextEncoder, TextDecoder, Uint8Array, btoa: (value: string) => Buffer.from(value, "binary").toString("base64"), setTimeout: () => 0 });
  vm.runInContext(fs.readFileSync("client/public/app-bridge-host.js", "utf8"), context);
  const bridge = window.ChrysalisBridgeHost as { serve: (frame: { contentWindow: unknown }, appId: string, username: string) => () => void; storageKey: (u: string, a: string) => string };
  const source = { postMessage: () => {} };
  bridge.serve({ contentWindow: source }, "notes", "alice");
  const fire = (type: string, event: Record<string, unknown>) => handlers.get(type)?.forEach((handler) => handler(event));
  const write = (key: string, value: string) => fire("message", { source, data: { __chrysalis: 1, type: "storage", which: "local", op: "set", key, value } });
  return { stored, reads, write, fire, key: bridge.storageKey("alice", "notes") };
}

describe("the shell keeps an app's storage", () => {
  it("reads the stored copy once, and again after another tab wrote it", () => {
    const s = shell();
    s.stored[s.key] = JSON.stringify({ local: { kept: "1" }, session: {} });
    s.write("a", "1");
    s.write("b", "2");
    expect(s.reads).toHaveLength(1);
    expect(JSON.parse(s.stored[s.key]!).local).toEqual({ kept: "1", a: "1", b: "2" });
    s.stored[s.key] = JSON.stringify({ local: { other: "tab" }, session: {} });
    s.fire("storage", { key: s.key });
    s.write("c", "3");
    expect(s.reads).toHaveLength(2);
    expect(JSON.parse(s.stored[s.key]!).local).toEqual({ other: "tab", c: "3" });
  });

  it("refuses a write past the app's share and keeps what it had", () => {
    const s = shell();
    s.write("a", "1");
    s.write("huge", "x".repeat(2 * 1024 * 1024));
    expect(JSON.parse(s.stored[s.key]!).local).toEqual({ a: "1" });
    s.write("b", "2");
    expect(JSON.parse(s.stored[s.key]!).local).toEqual({ a: "1", b: "2" });
  });
});
