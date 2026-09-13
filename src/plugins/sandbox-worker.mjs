/**
 * Plugin sandbox worker — owns the QuickJS wasm runtime OFF the main thread.
 * A hung/aborting plugin poisons only this worker; the host terminates and
 * respawns it (SPEC-v2 §S1: no sandbox failure may take down the server).
 *
 * Protocol (all plain JSON-serializable objects):
 *   → { id, source, hook, ctx, storeSnapshot, maxStoreBytes }
 *   ← { id, ok: true, out, storeWrites, llmRequests, logs }
 *     | { id, ok: false, error }
 *
 * Host API inside the sandbox:
 *   host.log(...)                       → collected, returned to host
 *   host.store.get/put/delete/keys      → snapshot-backed; writes returned
 *   host.llm.request(key, req)          → collected for two-phase execution
 *   host.llm.results                    → map injected from previous pass
 *   host.llm.embed(key, {texts, model}) → two-phase embeddings; results in
 *                                         host.llm.embedResults next pass
 *   host.siblingTools                   → tool DEFS a wantsTools llm request
 *                                         would carry, when the dispatch asked
 *                                         (?siblingtools=1); absent otherwise
 *   fetch                               → ALWAYS throws (network disabled in
 *                                         this engine build until an async
 *                                         solution exists — SPEC-v2 §S1)
 */
import { parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";

const utf8 = new TextDecoder("utf-8");
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
// the wasm travels with the code: a compiled engine has no node_modules for
// the emscripten loader to find it in
import wasmFile from "@jitl/quickjs-ng-wasmfile-release-sync/wasm" with { type: "file" };
import { newVariant } from "quickjs-emscripten-core";
import { loadQuickJs } from "@sebastianwessel/quickjs";

const port = parentPort;
if (!port) throw new Error("sandbox worker requires worker_threads");

let quickJsP = null;
let quickJs = null;
async function getRun() {
  // a bundled (not compiled) engine gets the path relative to this file
  quickJsP ??= Bun.file(path.resolve(import.meta.dir, wasmFile))
    .arrayBuffer()
    .then((wasmBinary) => loadQuickJs(newVariant(variant, { wasmBinary })))
    .then((s) => (quickJs = s));
  return (await quickJsP).runSandboxed;
}

/**
 * Size of the wasm heap every runtime in this worker shares. It never shrinks,
 * and a runtime that does not fully free itself on teardown (a big route's
 * leftover object graph) stays in it for good, a few MB per fat call. Every
 * reply carries the size so the host can retire the worker before the heap
 * hits the wasm ceiling, where every later call dies with "out of memory".
 */
function heapBytes() {
  return quickJs?.module?.module?.HEAPU8?.buffer?.byteLength ?? 0;
}

function reply(msg) {
  port.postMessage({ ...msg, heapBytes: heapBytes() });
}

/**
 * The harness must not suspend the guest while a large result is live. Any
 * `await` that parks an async frame with a big heap behind it leaves the wasm
 * runtime unable to free itself: teardown trips `Assertion failed:
 * list_empty(&rt->gc_obj_list)` in JS_FreeRuntime and the whole worker aborts.
 * A fat route (the roleplay engine's GET /bootstrap, ~1.6MB across ~100k
 * objects) crossed that line on every single call.
 *
 * So the harness suspends as little as it can:
 *   - static imports, never `await import(...)` — top-level await alone is
 *     enough to trip it once the guest heap has had to grow past ~10MB
 *   - the plugin's return value is awaited ONLY when it is actually a
 *     thenable, so a sync export (the normal shape — SPEC-v2 models async host
 *     calls as a two-phase exchange precisely because async is fragile here)
 *     never parks a frame at all
 *   - the serialized JSON is kept, the object graph behind it is dropped
 *
 * An async export returning a payload this size can still trip it; that one is
 * upstream, and the two-phase protocol is the reason plugins do not need it.
 */
function harnessCode(hook) {
  // guard.js first: static imports evaluate in order, so `fetch` is already
  // neutralized before the plugin module's top-level code runs
  const preamble = `import "guard.js";\nimport * as mod from "plugin.js";\n`;
  const wrap = (body) => `${preamble}export default (async () => {
try {
${body}
if (out && typeof out.then === "function") out = await out;
const json = JSON.stringify({ ok: true, value: out === undefined ? null : out });
out = null;
return json;
} catch (e) {
return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
}
})();
`;
  // pseudo-hooks for kernel services (SPEC-v2 §3)
  if (hook.startsWith("__export:")) {
    const name = JSON.stringify(hook.slice("__export:".length));
    return wrap(`let out = mod[${name}] ?? null;`);
  }
  if (hook === "__tool") {
    return wrap(`let out;
if (typeof mod.handleTool === "function") { out = mod.handleTool(env.ctx.name, env.ctx.args, env.host); }`);
  }
  if (hook === "__route") {
    return wrap(`let out;
if (typeof mod.handleRoute === "function") { out = mod.handleRoute(env.ctx, env.host); }`);
  }
  return wrap(`const fn = mod[${JSON.stringify(hook)}];
let out;
if (typeof fn === "function") { out = fn(env.ctx, env.host); }`);
}

port.on("message", async (msg) => {
  const { id, source, hook, ctx, storeSnapshot = {}, llmResults = {}, netResults = {}, netAllowed = false, maxStoreBytes = 1024 * 1024, storeAllowed = true, llmAllowed = true, fsAllowed = false, fsRoot = null, zipAllowed = false, zipBase64 = null, siblingToolDefs = null, embedResults = {} } = msg;
  const logs = [];
  const llmRequests = [];
  const netRequests = [];
  const embedRequests = [];
  const store = { ...storeSnapshot };
  let storeBytes = JSON.stringify(store).length;

  try {
    const runSandboxed = await getRun();
    const host = {
      log: (...args) => logs.push(args.map(String).join(" ").slice(0, 500)),
      store: storeAllowed
        ? {
            get: (k) => store[k] ?? null,
            put: (k, v) => {
              store[k] = v === undefined ? null : v;
              storeBytes = JSON.stringify(store).length;
              if (storeBytes > maxStoreBytes) throw new Error(`plugin store exceeded ${maxStoreBytes} bytes`);
            },
            delete: (k) => { delete store[k]; },
            keys: () => Object.keys(store),
          }
        : {
            get: () => { throw new Error("permission \"store\" not granted — approve via /v1/plugins/:id/approve"); },
            put: () => { throw new Error("permission \"store\" not granted"); },
            delete: () => { throw new Error("permission \"store\" not granted"); },
            keys: () => { throw new Error("permission \"store\" not granted"); },
          },
      llm: llmAllowed
        ? {
            request: (key, req) => {
              if (typeof key !== "string" || !req) throw new Error("llm.request(key, req)");
              if (llmRequests.length >= 16) throw new Error("too many llm requests in one pass");
              llmRequests.push({ key, req });
            },
            results: llmResults,
            // two-phase embeddings: request(key, {texts, model?}) on pass A,
            // read embedResults[key] = number[][] | null on the next pass
            embed: (key, req) => {
              if (typeof key !== "string" || !req || !Array.isArray(req.texts)) throw new Error("llm.embed(key, {texts, model?})");
              if (embedRequests.length >= 8) throw new Error("too many embed requests in one pass");
              embedRequests.push({ key, req });
            },
            embedResults,
          }
        : {
            request: () => { throw new Error("permission \"llm\" not granted — approve via /v1/plugins/:id/approve"); },
            results: {},
          },
      net: netAllowed
        ? {
            // two-phase like llm: request(key, fetchOptions) on pass A; read
            // results[key] = {ok, status, statusText, headers, url, json?|text?|base64?}
            // on the next pass. Host-side execution — no creds are attached.
            request: (key, req) => {
              if (typeof key !== "string" || !req || typeof req.url !== "string") throw new Error("net.request(key, {url, method?, headers?, body?, form?, timeoutMs?, maxBytes?, followRedirects?, json?, binary?})");
              if (netRequests.length >= 32) throw new Error("too many net requests in one pass");
              netRequests.push({ key, req });
            },
            results: netResults,
          }
        : {
            request: () => { throw new Error("permission \"network\" not granted (add \"network\" to manifest permissions)"); },
            results: {},
          },
    };
    // NOTE: we do NOT pass fetchAdapter — but the package may still inject a
    // fetch symbol; neutralize it explicitly inside the guest. It rides as its
    // own module so the harness can import it BEFORE plugin.js: statements
    // prepended to a module body would run after the imports it hoists above
    // them, i.e. after the plugin's own top-level code had already seen fetch.
    const guard = `
try { Object.defineProperty(globalThis, 'fetch', { value: undefined, writable: false, configurable: false }); } catch (e) {}
`;
    // Zip service (SPEC-v2 §3, import path): decode base64 zip → entries map
    // { "path": "text content" } for TEXT entries (binary entries listed as
    // { "__binary__": true }). Size/count capped. Sandboxed plugin then maps
    // entries to app data — the kernel never interprets app formats.
    const zipSvc = (() => {
      const denied = () => { throw new Error("permission \"zip\" not granted (add \"zip\" to manifest permissions)"); };
      if (!zipAllowed) return { entries: denied, list: denied };
      return {
        list: () => Object.keys(zipEntries()).length,
        entries: () => zipEntries(),
      };
      function zipEntries() {
        if (!zipBase64 || typeof zipBase64 !== "string") throw new Error("no zip payload provided");
        if (zipBase64.length > 200 * 1024 * 1024 / 0.75) throw new Error("zip payload too large (200MB cap)");
        const bytes = Buffer.from(zipBase64, "base64");
        // ZIP-BOMB GUARD: fflate's filter runs from the central directory
        // BEFORE any decompression — reject oversized archives without ever
        // inflating them, and skip entries we would not return anyway.
        const MAX_FILES = 5000;
        const MAX_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024; // 256MB across all entries
        let count = 0;
        let total = 0;
        const files = unzipSync(bytes, {
          filter: (f) => {
            if (f.name.endsWith("/")) return false;
            if (f.name.startsWith("/") || f.name.split("/").includes("..")) return false; // zip-slip
            count++;
            total += f.originalSize;
            if (count > MAX_FILES) throw new Error(`zip has too many entries (> ${MAX_FILES})`);
            if (total > MAX_TOTAL_UNCOMPRESSED) throw new Error(`zip expands beyond ${MAX_TOTAL_UNCOMPRESSED} bytes uncompressed — rejecting (zip bomb guard)`);
            return true;
          },
        });
        const names = Object.keys(files);
        const out = {};
        for (const name of names) {
          const data = files[name];
          const isText = /\.(json|jsonl|txt|md|js|css|html|yml|yaml|csv)$/i.test(name) || name === "settings.json";
          if (isText && data.length < 2 * 1024 * 1024) {
            out[name] = utf8.decode(data);
          } else if (data.length <= 16 * 1024 * 1024) {
            // binaries ride as base64 (16MB/entry) — importers need embedded
            // cards (PNG tEXt) out of foreign backup zips; still zip-bomb capped
            out[name] = { __b64__: true, base64: Buffer.from(data).toString("base64"), size: data.length };
          } else {
            out[name] = { __binary__: true, size: data.length };
          }
        }
        return out;
      }
    })();

    // Scoped fs service (SPEC-v2 §3): bundled plugins may read/write their
    // app's data/ dir. Path-safe: resolve within root, block escapes.
    const fsSvc = (() => {
      if (!fsAllowed || !fsRoot) {
        const denied = () => { throw new Error("plugin manifest.json is missing the \"fs\" permission (add it to permissions array) or the grant was not approved for imported plugins"); };
        return { read: denied, write: denied, list: denied, remove: denied, root: null };
      }
      // Lexical containment PLUS a realpath pass: a symlink planted inside
      // data/ (e.g. by a workspace shell) would otherwise let read/write/
      // remove follow it outside the app's world — credentials included.
      // Every existing path is resolved to its real location and re-checked;
      // writes create their parent dirs and then verify the REAL dir chain.
      const realRoot = (() => { try { return fs.realpathSync(fsRoot); } catch { return fsRoot; } })();
      const isSymlink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
      const within = (rel) => {
        const full = path.resolve(fsRoot, String(rel));
        if (full !== fsRoot && !full.startsWith(fsRoot + path.sep)) {
          throw new Error(`path escapes app data dir: ${rel}`);
        }
        let real = full;
        try {
          real = fs.realpathSync(full);
        } catch {
          // realpath throws for not-yet-existing paths AND for dangling
          // symlinks. A dangling link must never pass: a write would follow
          // it and CREATE the target outside the jail (the classic
          // authorized_keys trick), so distinguish by lstat.
          if (isSymlink(full)) throw new Error(`path is a dangling symlink: ${rel}`);
          return full; // genuinely missing — the caller's op decides what that means
        }
        if (real === full) return full;
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          throw new Error(`path resolves outside app data dir (symlink?): ${rel}`);
        }
        return full;
      };
      const withinNewFile = (rel) => {
        const full = within(rel);
        if (full === fsRoot) throw new Error("refusing to write the data dir itself");
        // even a symlink whose target resolves inside the jail is refused for
        // writes — the target could be swapped after this check
        if (isSymlink(full)) throw new Error(`refusing to write through a symlink: ${rel}`);
        // for not-yet-existing targets, resolve the nearest existing ancestor
        let dir = path.dirname(full);
        for (;;) {
          let realDir;
          try {
            realDir = fs.realpathSync(dir);
          } catch {
            const parent = path.dirname(dir);
            if (parent === dir) throw new Error(`cannot resolve parent dir for: ${rel}`);
            dir = parent;
            continue;
          }
          if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
            throw new Error(`path resolves outside app data dir (symlink?): ${rel}`);
          }
          return full;
        }
      };
      // fs errors must not leak absolute host paths (ENOENT messages carry
      // the full on-disk location) — re-raise with the app-relative path
      const scrub = (e, rel) => {
        const msg = String(e?.message ?? e).split(fsRoot).join("[app-data]");
        throw new Error(`${msg} (${rel})`);
      };
      return {
        read: (rel) => { try { return fs.readFileSync(within(rel), "utf8"); } catch (e) { scrub(e, rel); } },
        readBase64: (rel) => { try { return fs.readFileSync(within(rel)).toString("base64"); } catch (e) { scrub(e, rel); } },
        write: (rel, content) => {
          if (typeof content !== "string") throw new Error("fs.write(rel, string)");
          const full = withinNewFile(rel);
          if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error("fs.write content too large (4MB)");
          try {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content, "utf8");
          } catch (e) { scrub(e, rel); }
        },
        list: (rel = ".") => { try { return fs.readdirSync(within(rel)).sort(); } catch (e) { scrub(e, rel); } },
        remove: (rel) => {
          const full = within(rel);
          if (full === fsRoot) throw new Error("refusing to remove the data dir itself");
          try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) { scrub(e, rel); }
        },
      };
    })();
    host.fs = fsSvc;
    host.zip = zipSvc;
    if (siblingToolDefs) host.siblingTools = siblingToolDefs;

    // guest console.* joins the capped `logs` collection (host.log's 500-char
    // + count caps apply) instead of the library default: raw engine stdout
    const cappedConsole = (level) => (...args) => {
      if (logs.length >= 200) return;
      const text = args
        .map((a) => {
          if (typeof a === "string") return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        })
        .join(" ")
        .slice(0, 500);
      logs.push(`[console.${level}] ${text}`);
    };
    const result = await runSandboxed(
      async ({ evalCode }) => evalCode(harnessCode(hook), "harness.mjs"),
      {
        executionTimeout: 10_000,
        memoryLimit: 64 * 1024 * 1024,
        maxStackSize: 1024 * 1024,
        env: { ctx, host },
        nodeModules: { "plugin.js": source, "guard.js": guard },
        console: {
          log: cappedConsole("log"),
          error: cappedConsole("error"),
          warn: cappedConsole("warn"),
          info: cappedConsole("info"),
          debug: cappedConsole("debug"),
          trace: cappedConsole("trace"),
        },
      },
    );
    if (!result.ok) {
      reply({ id, ok: false, error: result.error.message, logs, storeWrites: store, llmRequests, netRequests, embedRequests });
      return;
    }
    // The guest reports its own failures in the envelope rather than rejecting:
    // a rejected promise crossing the boundary aborts the wasm runtime on
    // teardown (same JS_FreeRuntime assertion), which would turn every ordinary
    // plugin bug into a poisoned worker.
    let envelope;
    try {
      envelope = JSON.parse(result.data ?? "null");
    } catch {
      reply({ id, ok: false, error: "hook returned non-serializable result", logs, storeWrites: store, llmRequests, netRequests, embedRequests });
      return;
    }
    if (!envelope || envelope.ok !== true) {
      const error = envelope && typeof envelope.error === "string" ? envelope.error : "hook returned non-serializable result";
      reply({ id, ok: false, error, logs, storeWrites: store, llmRequests, netRequests, embedRequests });
      return;
    }
    reply({ id, ok: true, out: envelope.value ?? null, storeWrites: store, llmRequests, netRequests, embedRequests, logs });
  } catch (e) {
    // wasm abort / load failure — host will terminate+respawn this worker
    try {
      reply({ id, ok: false, error: `sandbox aborted: ${String(e?.message ?? e).slice(0, 200)}`, logs, storeWrites: store, llmRequests, netRequests, embedRequests });
    } catch {
      /* port dead — host timeout handles it */
    }
  }
});
