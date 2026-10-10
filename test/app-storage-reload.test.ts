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
