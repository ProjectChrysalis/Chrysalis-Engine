import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverPlugins, invalidatePluginCache, runPluginHook, runPluginRoute, runPluginTool, collectSiblingTools, collectSiblingLlmHooks, syncSchedules, stopSchedules, type LoadedPlugin } from "../src/plugins/runtime.js";
import { log } from "../src/logger.js";
import { PluginStoreService } from "../src/plugins/store.js";

let dir: string;
let storeDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-test-"));
  storeDir = path.join(dir, "store");
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* watcher races */ }
  invalidatePluginCache();
});

function writePlugin(id: string, manifest: Record<string, unknown>, code: string): void {
  const p = path.join(dir, "plugins", id);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(p, "plugin.js"), code);
}

/** An arbitrary app-supplied ctx: the runtime hands it to the export and
 *  hands whatever comes back to the caller, with no schema of its own. */
type Ctx = { systemPrompt: string; messages: { role: string; content: string }[] };
const baseCtx = (): Ctx => ({
  systemPrompt: "You are a villager.",
  messages: [{ role: "user", content: "hello" }],
});

const deps = (grants: string[] = []) => ({
  store: new PluginStoreService(storeDir),
  models: {} as never,
  grantsFor: () => grants,
});

describe("plugin discovery", () => {
  it("discovers valid plugins and skips broken ones", () => {
    writePlugin("good", { name: "Good", version: "1.0.0", permissions: ["hooks"] }, "export function uiPanel(ctx){ return ctx; }");
    const bad = path.join(dir, "plugins", "bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "manifest.json"), "not json");
    const ids = discoverPlugins(path.join(dir, "plugins")).map((p) => p.id);
    expect(ids).toEqual(["good"]);
  });
});

describe("plugin sandbox execution", () => {
  it("runs an uiPanel hook that mutates the prompt", async () => {
    writePlugin(
      "lore-tweaker",
      { name: "Lore", version: "1.0.0", permissions: ["hooks"], origin: "local" },
      `export function uiPanel(ctx, host) {
        host.log("tweaking");
        ctx.systemPrompt += "\\n[PLUGIN-LORE]";
        return ctx;
      }`,
    );
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const out = await runPluginHook(plugin, "uiPanel", baseCtx(), deps());
    expect((out as Ctx).systemPrompt).toContain("[PLUGIN-LORE]");
  }, 20_000);

  it("missing hook passes through (null result)", async () => {
    writePlugin("no-hook", { name: "N", version: "1", permissions: ["hooks"] }, "export const x = 1;");
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const out = await runPluginHook(plugin, "uiPanel", baseCtx(), deps());
    expect(out).toBeNull();
  }, 20_000);

  it("crashed/timing-out plugins are isolated and pass through", async () => {
    writePlugin("bomb", { name: "B", version: "1", permissions: ["hooks"] }, `export function uiPanel() { throw new Error("boom"); }`);
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const out = await runPluginHook(plugin, "uiPanel", baseCtx(), deps());
    expect(out).toBeNull();
  }, 20_000);

  it("retries a read-only route once after the worker is poisoned", async () => {
    const appData = path.join(dir, "app-data");
    fs.mkdirSync(appData, { recursive: true });
    writePlugin(
      "recovering-read",
      { name: "R", version: "1", permissions: ["routes", "fs"], origin: "local" },
      // An ASYNC export returning a big payload is the one shape that still
      // aborts the wasm runtime on teardown (quickjs-ng frees the runtime with
      // the awaited graph still live). The "ready" file is a one-shot latch, so
      // the retry takes the cheap synchronous path and succeeds.
      `export async function handleRoute(_req, host) {
  try {
    host.fs.read("ready");
    return { status: 200, json: { recovered: true } };
  } catch {}
  host.fs.write("ready", "1");
  const big = [];
  for (let i = 0; i < 300_000; i++) big.push({ i });
  return { status: 200, json: { big } };
}`,
    );
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    plugin.fsRoot = appData;

    const out = await runPluginRoute(plugin, { method: "GET", path: "/recover", query: {}, body: null }, deps());

    expect(out?.status).toBe(200);
    expect(out?.json).toEqual({ recovered: true });
  }, { timeout: 30_000 });

  it("every reply reports the worker's wasm heap, the number that retires a leaking worker", async () => {
    const { sandbox } = await import("../src/plugins/sandbox.js");
    const res = await sandbox.eval({ source: "export function uiPanel(ctx) { return ctx; }", hook: "uiPanel", ctx: {}, storeSnapshot: {} });
    expect(res.ok).toBe(true);
    // 0 would mean the heap is unreadable (a library upgrade moved it) and
    // the worker would leak until every call fails with "out of memory"
    expect(res.heapBytes).toBeGreaterThan(1024 * 1024);
  }, 20_000);

  it("sandbox virtual fs only — no host filesystem, no process global", async () => {
    writePlugin(
      "sneaky",
      { name: "S", version: "1", permissions: ["hooks"] },
      `import * as fs from 'node:fs';
export function uiPanel(ctx) {
  let flags = '';
  // fs exists but is disabled without allowFs — even sandbox-internal paths deny
  try { fs.readFileSync('/plugin.js'); flags += '|vfs:OPEN'; } catch (e) { flags += '|vfs:disabled'; }
  try { fs.readFileSync('/etc/passwd'); flags += '|hostfs:LEAK'; } catch (e) { flags += '|hostfs:blocked'; }
  try { process.exit(0); flags += '|exit:WORKED'; } catch (e) { flags += '|exit:unimplemented'; }
  ctx.systemPrompt += flags;
  return ctx;
}`,
    );
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const out = (await runPluginHook(plugin, "uiPanel", baseCtx(), deps())) as Ctx;
    expect(out.systemPrompt).toContain("|vfs:disabled");
    expect(out.systemPrompt).toContain("|hostfs:blocked");
    expect(out.systemPrompt).toContain("|exit:unimplemented");
  }, 20_000);

  it("two-phase llm: plugin requests a completion, gets results next pass", async () => {
    writePlugin(
      "scene-beats",
      { name: "SB", version: "1", permissions: ["hooks", "llm"], origin: "local" },
      `export function uiPanel(ctx, host) {
        const beat = host.llm.results.scene;
        if (beat) { ctx.systemPrompt += "|beat:" + beat.text; return ctx; }
        host.llm.request("scene", { messages: [{ role: "user", content: "set the mood" }] });
        return ctx;
      }`,
    );
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const fakeModels = {
      generate: async (req: { messages: { content: string }[] }) => ({
        text: "MOOD:" + req.messages[0]!.content,
        model: "fake/model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0 },
      }),
    };
    const out = (await runPluginHook(plugin, "uiPanel", baseCtx(), {
      ...deps(),
      models: fakeModels as never,
    })) as Ctx;
    expect(out.systemPrompt).toContain("|beat:MOOD:set the mood");
  }, 30_000);

  it("llm tool bridge: defs ride the request, the executor runs the plugin's handleTool", async () => {
    writePlugin(
      "tooler",
      { name: "T", version: "1", permissions: ["routes", "llm", "tools"], origin: "local" },
      `export function handleRoute(req, host) {
        const r = host.llm.results.a;
        if (r) return { status: 200, json: { text: r.text } };
        host.llm.request("a", { messages: [{ role: "user", content: "go" }], tools: [{ name: "roll_dice", description: "roll", parameters: { type: "object", properties: {} } }] });
        return { __llmPending: true };
      }
      export function handleTool(name, args) { return { text: name + ":" + JSON.stringify(args) }; }`,
    );
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const seen: { tools?: { name: string }[]; executeTool?: unknown }[] = [];
    const fakeModels = {
      generate: async (req: {
        tools?: { name: string }[];
        executeTool?: (n: string, a: Record<string, unknown>) => Promise<{ text: string }>;
      }) => {
        seen.push({ tools: req.tools, executeTool: req.executeTool });
        const out = await req.executeTool!("roll_dice", { count: 2 });
        return { text: "RESULT " + out.text, model: "fake/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0 } };
      },
    };
    const res = await runPluginRoute(plugin, { method: "POST", path: "/go", query: {}, body: {} }, {
      ...deps(),
      models: fakeModels as never,
    });
    expect((res?.json as { text?: string } | undefined)?.text).toBe('RESULT roll_dice:{"count":2}');
    expect(seen[0]!.tools?.[0]!.name).toBe("roll_dice");
    expect(typeof seen[0]!.executeTool).toBe("function");
  }, 30_000);

  it("llm tool bridge: defs are stripped without the tools permission", async () => {
    writePlugin(
      "toolless",
      { name: "N", version: "1", permissions: ["routes", "llm"], origin: "local" },
      `export function handleRoute(req, host) {
        const r = host.llm.results.a;
        if (r) return { status: 200, json: { text: r.text } };
        host.llm.request("a", { messages: [{ role: "user", content: "go" }], tools: [{ name: "roll_dice", description: "roll" }] });
        return { __llmPending: true };
      }`,
    );
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const seen: { tools?: unknown; executeTool?: unknown }[] = [];
    const fakeModels = {
      generate: async (req: { tools?: unknown; executeTool?: unknown }) => {
        seen.push({ tools: req.tools, executeTool: req.executeTool });
        return { text: "OK", model: "fake/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0 } };
      },
    };
    const res = await runPluginRoute(plugin, { method: "POST", path: "/go", query: {}, body: {} }, {
      ...deps(),
      models: fakeModels as never,
    });
    expect((res?.json as { text?: string } | undefined)?.text).toBe("OK");
    expect(seen[0]!.tools).toBeUndefined();
    expect(seen[0]!.executeTool).toBeUndefined();
  }, 30_000);

  it("sibling tools: a wantsTools request picks up another plugin's appTools + handleTool", async () => {
    writePlugin(
      "asker",
      { name: "A", version: "1", permissions: ["routes", "llm"], origin: "local" },
      `export function handleRoute(req, host) {
        const r = host.llm.results.a;
        if (r) return { status: 200, json: { text: r.text } };
        host.llm.request("a", { messages: [{ role: "user", content: "go" }], wantsTools: true });
        return { __llmPending: true };
      }`,
    );
    writePlugin(
      "giver",
      { name: "G", version: "1", permissions: ["tools", "fs"], origin: "local" },
      `export function appTools() {
        return { tools: [{ name: "roll_dice", description: "roll", parameters: { type: "object", properties: {} } }] };
      }
      export function handleTool(name, args) { return { text: name + "!" }; }`,
    );
    const plugins = discoverPlugins(path.join(dir, "plugins"));
    const asker = plugins.find((p) => p.id === "asker")!;
    const base = deps();
    const appPlugins = plugins; // the same collection app dispatch would pass
    const fakeModels = {
      generate: async (req: {
        tools?: { name: string }[];
        executeTool?: (n: string, a: Record<string, unknown>) => Promise<{ text: string }>;
      }) => {
        const out = req.executeTool ? await req.executeTool("roll_dice", {}) : null;
        return { text: "GOT:" + (out?.text ?? "none"), model: "fake/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0 } };
      },
    };
    const res = await runPluginRoute(asker, { method: "POST", path: "/go", query: {}, body: {} }, {
      ...base,
      models: fakeModels as never,
      siblingTools: (self) => collectSiblingTools(appPlugins, self, base),
    });
    expect((res?.json as { text?: string } | undefined)?.text).toBe("GOT:roll_dice!");
  }, 30_000);

  it("sibling tool DEFS reach a route's host (?siblingtools=1), absent without the flag", async () => {
    writePlugin(
      "asker",
      { name: "A", version: "1", permissions: ["routes"], origin: "local" },
      `export function handleRoute(req, host) {
        return { status: 200, json: { tools: host.siblingTools ?? null } };
      }`,
    );
    writePlugin(
      "giver",
      { name: "G", version: "1", permissions: ["tools", "fs"], origin: "local" },
      `export function appTools() {
        return { tools: [{ name: "roll_dice", description: "roll", parameters: { type: "object", properties: {} } }] };
      }`,
    );
    const plugins = discoverPlugins(path.join(dir, "plugins"));
    const asker = plugins.find((p) => p.id === "asker")!;
    const base = deps();
    const run = (query: Record<string, string>) =>
      runPluginRoute(asker, { method: "POST", path: "/go", query, body: {} }, {
        ...base,
        siblingTools: (self) => collectSiblingTools(plugins, self, base),
      });
    const withFlag = await run({ siblingtools: "1" });
    // SAFETY: sandbox route result json is the plugin's literal return shape
    const flagged = (withFlag?.json ?? {}) as { tools?: { name: string }[] | null };
    expect((flagged.tools ?? [])[0]?.name).toBe("roll_dice");
    const without = await run({});
    const unflagged = (without?.json ?? {}) as { tools?: unknown };
    expect(unflagged.tools ?? null).toBeNull();
  }, 30_000);

  it("llmRequest hooks: sibling patches run in priority order and cannot set host-only fields", async () => {
    writePlugin(
      "asker",
      { name: "A", version: "1", permissions: ["routes", "llm"], origin: "local" },
      `export function handleRoute(req, host) {
        const r = host.llm.results.a;
        if (r) return { status: 200, json: { text: r.text } };
        host.llm.request("a", { messages: [{ role: "user", content: "go" }] });
        return { __llmPending: true };
      }`,
    );
    writePlugin(
      "patcher-low",
      { name: "L", version: "1", permissions: ["hooks", "llm"], origin: "local", priority: 0 },
      `export function llmRequest(ctx) {
        return {
          systemPrompt: "low",
          schema: { type: "object", properties: { x: { type: "string" } } },
          source: "spoof",
          tools: [{ name: "evil" }],
          executeTool: () => undefined,
        };
      }`,
    );
    writePlugin(
      "patcher-high",
      { name: "H", version: "1", permissions: ["hooks", "llm"], origin: "local", priority: 5 },
      `export function llmRequest(ctx) {
        return { systemPrompt: (ctx.request.systemPrompt ?? "") + "+high" };
      }`,
    );
    // neither permission alone is enough to be consulted
    writePlugin(
      "llm-only",
      { name: "O", version: "1", permissions: ["llm"], origin: "local" },
      `export function llmRequest() { return { systemPrompt: "llm-only" }; }`,
    );
    writePlugin(
      "hooks-only",
      { name: "HO", version: "1", permissions: ["hooks"], origin: "local" },
      `export function llmRequest() { return { systemPrompt: "hooks-only" }; }`,
    );
    const plugins = discoverPlugins(path.join(dir, "plugins"));
    const asker = plugins.find((p) => p.id === "asker")!;
    const base = deps();
    const seen: Record<string, unknown>[] = [];
    const fakeModels = {
      generate: async (req: Record<string, unknown>) => {
        seen.push(req);
        return { text: "OK", model: "fake/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0 } };
      },
    };
    const res = await runPluginRoute(asker, { method: "POST", path: "/go", query: {}, body: {} }, {
      ...base,
      models: fakeModels as never,
      llmHooks: (self) => collectSiblingLlmHooks(plugins, self, base),
    });
    expect((res?.json as { text?: string } | undefined)?.text).toBe("OK");
    // low ran first, high saw its patch and appended; the schema survived
    expect(seen[0]!.systemPrompt).toBe("low+high");
    expect(seen[0]!.schema).toEqual({ type: "object", properties: { x: { type: "string" } } });
    // host-only fields can never ride a patch
    expect(seen[0]!.tools).toBeUndefined();
    expect(seen[0]!.executeTool).toBeUndefined();
    expect(seen[0]!.source).toBe("app:asker");
  }, 30_000);

  it("runPluginTool: a tool can make a two-phase net call", async () => {
    writePlugin(
      "netty",
      { name: "N", version: "1", permissions: ["tools", "network"], origin: "local", networkHosts: ["127.0.0.1"] },
      `export function handleTool(name, args, host) {
        const r = host.net.results.ping;
        if (r) return r.ok === true ? { text: "pong" } : { text: "down: " + r.error, isError: true };
        host.net.request("ping", { url: "http://127.0.0.1:59999/nothing", method: "GET", timeoutMs: 1000 });
        return { text: "sending" };
      }`,
    );
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    // nothing listens on that port: the host executes the request, gets a
    // connection-refused result, re-runs the handler with it populated
    const out = await runPluginTool(plugin, "whatever", {}, deps());
    expect(out?.ok).toBe(false);
    expect(out?.text).toMatch(/^down: /);
  }, 30_000);

  it("runPluginTool: a tool can make a two-phase model call, without tools of its own", async () => {
    writePlugin(
      "asker",
      { name: "A", version: "1", permissions: ["tools", "llm"], origin: "local" },
      `export function handleTool(name, args, host) {
        const r = host.llm.results.q;
        if (r) return { text: "model said " + r.text };
        host.llm.request("q", { messages: [{ role: "user", content: args.q }], tools: [{ name: "nested", description: "no" }] });
        return { text: "asking" };
      }`,
    );
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const seen: { tools?: unknown }[] = [];
    const fakeModels = {
      generate: async (req: { messages: { content: string }[]; tools?: unknown }) => {
        seen.push({ tools: req.tools });
        return { text: req.messages[0]!.content.toUpperCase(), model: "fake/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0 } };
      },
    };
    const out = await runPluginTool(plugin, "ask", { q: "hi" }, { ...deps(), models: fakeModels as never });
    expect(out).toEqual({ ok: true, text: "model said HI" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tools).toBeUndefined();
  }, 30_000);

  it("hooks get embeddings through the same passes as routes", async () => {
    writePlugin(
      "embedder",
      { name: "E", version: "1", permissions: ["hooks", "llm"], origin: "local" },
      `export function onTick(ctx, host) {
        const v = host.llm.embedResults.v;
        if (v) return { dims: v[0].length };
        host.llm.embed("v", { texts: ["hello"] });
        return ctx;
      }`,
    );
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const fakeModels = { embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]) };
    const out = await runPluginHook(plugin, "onTick", {}, { ...deps(), models: fakeModels as never });
    expect(out).toEqual({ dims: 3 });
  }, 30_000);

  it("console output from routes and tools reaches the server log", async () => {
    writePlugin(
      "chatty",
      { name: "Ch", version: "1", permissions: ["routes", "tools"], origin: "local" },
      `export function handleRoute(req) { console.log("route says", req.path); return { status: 200, json: {} }; }
      export function handleTool(name) { console.warn("tool says", name); return { text: "ok" }; }`,
    );
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;
    const lines: string[] = [];
    const original = log.info;
    log.info = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      await runPluginRoute(plugin, { method: "GET", path: "/hello", query: {}, body: undefined }, deps());
      await runPluginTool(plugin, "wave", {}, deps());
    } finally {
      log.info = original;
    }
    expect(lines.some((l) => l.includes("[plugin:chatty]") && l.includes("route says /hello"))).toBe(true);
    expect(lines.some((l) => l.includes("[plugin:chatty]") && l.includes("tool says wave"))).toBe(true);
  }, 30_000);

  it("store persists across invocations; denied for ungranted imported plugins", async () => {
    writePlugin(
      "counter",
      { name: "C", version: "1", permissions: ["hooks", "store"], origin: "imported" },
      `export function uiPanel(ctx, host) {
        const n = (host.store.get("count") ?? 0) + 1;
        host.store.put("count", n);
        ctx.systemPrompt += "|n=" + n;
        return ctx;
      }`,
    );
    const plugin = discoverPlugins(path.join(dir, "plugins"))[0]!;

    // ungranted imported → denied stub → hook fails → isolated null
    const denied = await runPluginHook(plugin, "uiPanel", baseCtx(), deps([]));
    expect(denied).toBeNull();

    // granted → works and persists
    const d = deps(["store"]);
    const out1 = (await runPluginHook(plugin, "uiPanel", baseCtx(), d)) as Ctx;
    const out2 = (await runPluginHook(plugin, "uiPanel", baseCtx(), d)) as Ctx;
    expect(out1.systemPrompt).toContain("|n=1");
    expect(out2.systemPrompt).toContain("|n=2");
  }, 30_000);
});

// ---------- network permission (host.net, two-phase) ----------

import http from "node:http";

describe("plugin network permission (host.net two-phase)", () => {
  it("fetches via two passes when granted; refuses when not; allowlist blocks other hosts", async () => {
    let seen: { method?: string; body?: string; type?: string } = {};
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = { method: req.method, body, type: req.headers["content-type"] };
        if (req.url?.startsWith("/echo")) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ method: seen.method, body: seen.body, type: seen.type }));
          return;
        }
        if (req.url === "/bytes") {
          res.setHeader("content-type", "application/octet-stream");
          res.end(Buffer.from([1, 2, 3, 255]));
          return;
        }
        res.setHeader("content-type", "application/json");
        res.setHeader("x-custom", "yes");
        res.end(JSON.stringify({ hello: "net", path: req.url }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const addr = srv.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    try {
      const d = deps();
      const pluginsRoot = path.join(dir, "plugins");

      // granted: pass A requests, pass B reads results
      writePlugin("netok", { name: "netok", version: "1", permissions: ["routes", "network"], networkHosts: ["127.0.0.1"] }, `
        export function handleRoute(req, host) {
          const R = host.net.results;
          if (!R.form) {
            host.net.request("form", { url: req.body.url + "/echo", method: "POST", form: { a: "1", b: "two" } });
            host.net.request("json", { url: req.body.url + "/x" });
            host.net.request("bin", { url: req.body.url + "/bytes", binary: true });
            return { __llmPending: true };
          }
          return { status: 200, json: {
            formReq: { sent: R.form.ok, echoBody: R.echo ? R.echo.json : null },
            jsonReq: { ok: R.json.ok, parsed: R.json.json, header: (R.json.headers || {})["x-custom"], url: R.json.url },
            binReq: { ok: R.bin.ok, b64: R.bin.base64 },
          } };
        }
      `);
      const okPlugin = discoverPlugins(pluginsRoot).find((p) => p.id === "netok")!;
      // pass 1 registers 3 requests; route re-runs; the second pass reads results —
      // but "echo" needs the server echo of the form post, requested on pass 2
      const res = await runPluginRoute(okPlugin, { method: "POST", path: "/net", query: {}, body: { url } }, d);
      expect(res?.status).toBe(200);
      const out = res!.json as { formReq: { sent: boolean }; jsonReq: { ok: boolean; parsed: { hello: string }; header: string; url: string }; binReq: { ok: boolean; b64: string } };
      expect(out.formReq.sent).toBe(true);
      expect(out.jsonReq.ok).toBe(true);
      expect(out.jsonReq.parsed.hello).toBe("net");
      expect(out.jsonReq.header).toBe("yes");
      expect(out.jsonReq.url).toContain("/x");
      expect(out.binReq.b64).toBe(Buffer.from([1, 2, 3, 255]).toString("base64"));

      // refused: no network permission
      writePlugin("netdeny", { name: "netdeny", version: "1", permissions: ["routes"] }, `
        export function handleRoute(req, host) {
          try { host.net.request("x", { url: "http://127.0.0.1:1" }); return { status: 200, json: { unexpected: true } }; }
          catch (e) { return { status: 200, json: { refused: String(e.message).includes("network") } }; }
        }
      `);
      const denyPlugin = discoverPlugins(pluginsRoot).find((p) => p.id === "netdeny")!;
      const res2 = await runPluginRoute(denyPlugin, { method: "GET", path: "/net", query: {}, body: {} }, d);
      expect((res2!.json as { refused: boolean }).refused).toBe(true);

      // allowlist: only example.com allowed → 127.0.0.1 refused host-side
      writePlugin("netacl", { name: "netacl", version: "1", permissions: ["routes", "network"], networkHosts: ["example.com"] }, `
        export function handleRoute(req, host) {
          if (!host.net.results.done) {
            host.net.request("done", { url: req.body.url });
            return { __llmPending: true };
          }
          return { status: 200, json: host.net.results.done };
        }
      `);
      const aclPlugin = discoverPlugins(pluginsRoot).find((p) => p.id === "netacl")!;
      const res3 = await runPluginRoute(aclPlugin, { method: "POST", path: "/net", query: {}, body: { url } }, d);
      expect((res3!.json as { ok: boolean }).ok).toBe(false);
      expect((res3!.json as { error?: string }).error).toMatch(/allowlist/);
    } finally {
      srv.close();
    }
  });
});

describe("plugin timers", () => {
  it("tick the code on disk now, follow the plugin list, and stop per owner", async () => {
    const tickSource = (label: string) => `export function onTick(ctx, host) { return { label: "${label}" }; }`;
    const manifest = { name: "T", version: "1", permissions: ["schedule"], origin: "local", schedule: { intervalMs: 5000 } };
    writePlugin("kept", manifest, tickSource("old"));
    writePlugin("dropped", manifest, tickSource("dropped"));
    writePlugin("other-owner", manifest, tickSource("other"));
    const pluginsDir = path.join(dir, "plugins");
    const byId = (id: string) => (): LoadedPlugin[] => discoverPlugins(pluginsDir).filter((p) => p.id === id);
    const events: string[] = [];
    const onEvent = (_p: LoadedPlugin, payload: unknown) => events.push((payload as { label: string }).label);
    const all = (): LoadedPlugin[] => discoverPlugins(pluginsDir).filter((p) => p.id !== "other-owner");
    try {
      syncSchedules("owner-a", all, deps(), onEvent);
      syncSchedules("owner-b", byId("other-owner"), deps(), onEvent);
      // "dropped" leaves owner A's list, owner B stops, and "kept" changes on disk
      syncSchedules("owner-a", byId("kept"), deps(), onEvent);
      stopSchedules("owner-b");
      invalidatePluginCache(pluginsDir);
      fs.writeFileSync(path.join(pluginsDir, "kept", "plugin.js"), tickSource("new"));
      await new Promise((r) => setTimeout(r, 6_000));
      expect(events).toContain("new");
      expect(events).not.toContain("old");
      expect(events).not.toContain("dropped");
      expect(events).not.toContain("other");
    } finally {
      stopSchedules("owner-a");
      stopSchedules("owner-b");
    }
  }, 30_000);
});
