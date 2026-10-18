/**
 * Plugin sandbox worker — owns the QuickJS wasm runtime OFF the main thread.
 * A hung/aborting plugin poisons only this worker; the host terminates and
 * respawns it (SPEC-v2 §S1: no sandbox failure may take down the server).
 *
 * Protocol (all plain JSON-serializable objects):
 *   → { id, source, modules, hook, ctx, storeSnapshot, maxStoreBytes }
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
 *   host.net.request(key, req)          → collected for two-phase execution;
 *                                         results in host.net.results next pass
 *   host.fs, host.zip                   → the app's data folder and uploaded
 *                                         zips, when permitted; fs.append
 *                                         adds to a file, zip.image stores an
 *                                         image entry as media, zip.read
 *                                         hands a large text entry over in
 *                                         line-aligned slices
 *   host.regex.matches(source, flags, text)
 *                                       → every match of a pattern, found by
 *                                         the host's own regex engine:
 *                                         [{ index, match, groups, named }]
 *   fetch                               → undefined: web requests go through
 *                                         host.net, which the engine runs
 */
import { parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { inflateSync } from "node:zlib";

/** PNG text fields that hold base64 (card data is base64 JSON), decoded:
 *  the guest would otherwise decode them itself, tens of milliseconds a card. */
function pngText(metadata) {
  const text = Object.create(null);
  for (const [key, value] of Object.entries(metadata)) {
    const trimmed = value.trim();
    if (trimmed && trimmed.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) text[key] = Buffer.from(trimmed, "base64").toString("utf8");
  }
  return text;
}
function pngMetadata(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("invalid PNG");
  const metadata = Object.create(null);
  let at = 8, total = 0;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at), end = at + length + 12;
    if (end > bytes.length) throw new Error("invalid PNG chunk length");
    const type = bytes.toString("ascii", at + 4, at + 8);
    if (["tEXt", "iTXt", "zTXt"].includes(type)) {
      const data = bytes.subarray(at + 8, end - 4), nul = data.indexOf(0);
      if (nul > 0) {
        const key = data.toString("latin1", 0, nul);
        let payload = data.subarray(nul + 1);
        if (type === "iTXt") {
          const compressed = payload[0];
          if (payload[1] !== 0) throw new Error("unsupported PNG text compression");
          const languageEnd = payload.indexOf(0, 2), translatedEnd = payload.indexOf(0, languageEnd + 1);
          if (languageEnd < 0 || translatedEnd < 0) throw new Error("invalid PNG text fields");
          payload = payload.subarray(translatedEnd + 1);
          if (compressed) payload = inflateSync(payload, { maxOutputLength: 32 * 1024 * 1024 });
        } else if (type === "zTXt") {
          if (payload[0] !== 0) throw new Error("unsupported PNG text compression");
          payload = inflateSync(payload.subarray(1), { maxOutputLength: 32 * 1024 * 1024 });
        }
        total += payload.length;
        if (total > 32 * 1024 * 1024) throw new Error("PNG metadata exceeds 32 MB");
        metadata[key] = payload.toString(type === "iTXt" ? "utf8" : "latin1");
      }
    }
    at = end;
  }
  return metadata;
}

const utf8 = new TextDecoder("utf-8");
const IMAGE_NAME = /\.(png|jpe?g|webp|gif)$/i;
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
// the wasm travels with the code: a compiled engine has no node_modules for
// the emscripten loader to find it in
import wasmFile from "@jitl/quickjs-ng-wasmfile-release-sync/wasm" with { type: "file" };
import { newVariant, Scope, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import { expose, loadQuickJs } from "@sebastianwessel/quickjs";

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
  if (retire) return Number.MAX_SAFE_INTEGER;
  return quickJs?.module?.module?.HEAPU8?.buffer?.byteLength ?? 0;
}

/** A kept-loaded context that could not free itself leaves this worker's
 *  wasm state unfit for more calls; the next reply asks the host to end it. */
let retire = false;

function reply(msg) {
  port.postMessage({ ...msg, heapBytes: heapBytes() });
}

/** The guest's interpreter walks a backtracking pattern step by step, tens of
 *  times slower than the host's compiled regex engine; a pattern that rescans
 *  long text from every position cost seconds per page of text there. The
 *  host runs the match and hands back plain results; the guest builds its
 *  own replacement. A runaway pattern holds this worker until the call's
 *  timeout ends it, as a runaway guest loop does. */
const REGEX_MAX_TEXT = 4 * 1024 * 1024;
const REGEX_MAX_MATCHES = 100_000;
const regexSvc = {
  matches: (source, flags = "", text = "") => {
    const input = String(text);
    if (input.length > REGEX_MAX_TEXT) throw new Error(`regex.matches text exceeds ${REGEX_MAX_TEXT} characters`);
    const re = new RegExp(String(source), String(flags));
    const found = re.global ? input.matchAll(re) : [re.exec(input)].filter(Boolean);
    const out = [];
    for (const m of found) {
      out.push({
        index: m.index,
        match: m[0],
        groups: m.slice(1).map((g) => (g === undefined ? null : g)),
        named: m.groups ? Object.fromEntries(Object.entries(m.groups).map(([k, v]) => [k, v === undefined ? null : v])) : null,
      });
      if (out.length >= REGEX_MAX_MATCHES) break;
    }
    return out;
  },
};

/** The plugin folder as the guest sees it: plugin.js plus the modules beside
 *  it, nested by path so `import "./src/x.js"` resolves from the importer. */
function pluginTree(source, modules) {
  // null prototypes: a path segment is a key, and "__proto__" must stay one
  const root = Object.assign(Object.create(null), { "plugin.js": source });
  for (const [rel, text] of Object.entries(modules ?? {})) {
    const parts = rel.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (typeof dir[part] !== "object") dir[part] = Object.create(null);
      dir = dir[part];
    }
    dir[parts[parts.length - 1]] = text;
  }
  return root;
}

// NOTE: we do NOT pass fetchAdapter — but the package may still inject a
// fetch symbol; neutralize it explicitly inside the guest. It rides as its
// own module so the harness can import it BEFORE plugin.js: statements
// prepended to a module body would run after the imports it hoists above
// them, i.e. after the plugin's own top-level code had already seen fetch.
// It also notes whether the plugin read the clock or drew a random number:
// such a result can differ on the same data, so no host may answer the
// same request again from a remembered copy. A kept-loaded plugin's calls
// reset that note each time.
const GUARD = `
try { Object.defineProperty(globalThis, 'fetch', { value: undefined, writable: false, configurable: false }); } catch (e) {}
let touched = false;
export const varied = () => touched;
export const resetVaried = () => { touched = false; };
const mark = () => { touched = true; };
const RealDate = Date;
const now = () => { mark(); return RealDate.now(); };
globalThis.Date = new Proxy(RealDate, {
  apply(target, self, args) { mark(); return Reflect.apply(target, self, args); },
  construct(target, args, newTarget) { if (args.length === 0) mark(); return Reflect.construct(target, args, newTarget); },
  get(target, key) { return key === "now" ? now : Reflect.get(target, key, target); },
});
const random = Math.random;
Math.random = () => { mark(); return random(); };
if (globalThis.performance && typeof globalThis.performance.now === "function") {
  const perf = globalThis.performance.now.bind(globalThis.performance);
  try { globalThis.performance.now = () => { mark(); return perf(); }; } catch (e) {}
}
if (globalThis.crypto) {
  for (const name of ["getRandomValues", "randomUUID"]) {
    const fn = globalThis.crypto[name];
    if (typeof fn === "function") { try { globalThis.crypto[name] = (...args) => { mark(); return fn.apply(globalThis.crypto, args); }; } catch (e) {} }
  }
}
`;

/** A route's own heap. App data is read whole into it, so a library's worth
 *  of JSON plus the serialized reply must fit. */
const DEFAULT_MEMORY_LIMIT = 256 * 1024 * 1024;

/** How a file stood when read. A rename-into-place write changes the inode,
 *  an in-place one the times or the size. "-" is a file that was missing. */
function fileSignature(full) {
  try {
    const s = fs.statSync(full);
    return `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`;
  } catch {
    return "-";
  }
}

/** A folder listing by its names, not its times: some filesystems keep folder
 *  times to the second or coarser. */
function dirSignature(full) {
  try {
    return createHash("sha1").update(fs.readdirSync(full).sort().join("\0")).digest("hex");
  } catch {
    return "-";
  }
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
  const preamble = `import { varied } from "guard.js";\nimport * as mod from "plugin/plugin.js";
${HOST_COPY}`;
  return `${preamble}export default ${callBody(hook)};
`;
}

/** What the guest runs for one call, as an expression: an async function's
 *  promise for the JSON envelope. `mod`, `varied` and `env` are in scope. */
function callBody(hook) {
  const wrap = (body) => `(async () => {
try {
${body}
if (out && typeof out.then === "function") out = await out;
const json = JSON.stringify({ ok: true, value: out === undefined ? null : out, varied: varied() });
out = null;
return json;
} catch (e) {
return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
}
})()`;
  // pseudo-hooks for kernel services (SPEC-v2 §3)
  if (hook.startsWith("__export:")) {
    const name = JSON.stringify(hook.slice("__export:".length));
    return wrap(`let out = mod[${name}] ?? null;`);
  }
  if (hook === "__tool") {
    return wrap(`let out;
if (typeof mod.handleTool === "function") { out = mod.handleTool(ctx.name, ctx.args, host); }`);
  }
  if (hook === "__route") {
    return wrap(`let out;
if (typeof mod.handleRoute === "function") { out = mod.handleRoute(ctx, host); }`);
  }
  return wrap(`const fn = mod[${JSON.stringify(hook)}];
let out;
if (typeof fn === "function") { out = fn(ctx, host); }`);
}

// ---------- plugins kept loaded between calls ----------
//
// A plugin whose manifest sets keepLoaded is evaluated once per worker and
// key (a user's copy of one plugin), and each call runs as a short script in
// the same context: compiling a large plugin cost more than most calls. Its
// module state may outlive a call, so the manifest flag is the plugin saying
// it does not depend on starting fresh. A context leaves when its code
// changes, when a call runs out of time or memory, or when more are kept
// than WARM_MAX (least recently used first).

const WARM_MAX = 4;
const warmSessions = new Map();
/** The console of the call running now; a context outlives its first call. */
let warmConsole = null;

function openWarm(version, tree, memoryLimitBytes, executionTimeoutMs) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let loaded, failed;
  const ready = new Promise((resolve, reject) => { loaded = resolve; failed = reject; });
  ready.catch(() => {});
  const sink = (level) => (...args) => warmConsole?.(level, ...args);
  const done = getRun().then((runSandboxed) => runSandboxed(async ({ ctx, evalCode }) => {
    ctx.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + executionTimeoutMs));
    const r = await evalCode(`import * as guard from "guard.js";
import * as mod from "plugin/plugin.js";
Object.defineProperty(globalThis, "__chrysalisWarm", { value: Object.freeze({ mod, guard }) });
export default true;
`, "warm.mjs");
    if (!r.ok) { failed(new Error(r.error.message)); return; }
    loaded(ctx);
    await released;
  }, {
    memoryLimit: memoryLimitBytes,
    maxStackSize: 1024 * 1024,
    nodeModules: { plugin: tree, "guard.js": GUARD },
    console: { log: sink("log"), error: sink("error"), warn: sink("warn"), info: sink("info"), debug: sink("debug"), trace: sink("trace") },
  }));
  done.catch((e) => failed(e));
  return {
    version,
    ready,
    close: async () => {
      release();
      try { await done; } catch { retire = true; }
    },
  };
}

/** The host for one kept-loaded call. A plugin that keeps `host` in module
 *  state would otherwise reach a finished call's store, journal and reads. */
function sealHost(value, live, depth = 0) {
  if (typeof value === "function") {
    return (...args) => {
      if (!live.on) throw new Error("host belongs to a call that has ended");
      return value(...args);
    };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || depth > 6) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = sealHost(v, live, depth + 1);
  return out;
}

const TIME_LIMIT = "The script execution has exceeded the maximum allowed time limit.";

/** One call in a kept-loaded context, answered like runSandboxed: {ok, data}
 *  or {ok: false, error}. `broken` means the context must not serve again. */
async function callWarm(ctx, hook, env, executionTimeoutMs, memoryLimitBytes) {
  const deadline = Date.now() + executionTimeoutMs;
  const scope = new Scope();
  let handle = null;
  const failure = (errorHandle) => {
    const e = ctx.dump(errorHandle);
    errorHandle.dispose();
    const message = String(e?.message ?? e);
    return { ok: false, error: { message: message === "interrupted" ? TIME_LIMIT : message }, broken: true };
  };
  try {
    ctx.runtime.setMemoryLimit(memoryLimitBytes);
    ctx.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    expose(ctx, scope, { env });
    const evaluated = ctx.evalCode(`(() => {
const { mod, guard } = globalThis.__chrysalisWarm;
guard.resetVaried();
const varied = guard.varied;
${HOST_COPY}return ${callBody(hook)};
})()`, "call.js", { type: "global", strict: true });
    if (evaluated.error) return failure(evaluated.error);
    handle = evaluated.value;
    // a sync export settles during the eval; anything else needs its jobs run
    let state = ctx.getPromiseState(handle);
    while (state.type === "pending") {
      if (Date.now() > deadline) return { ok: false, error: { message: TIME_LIMIT }, broken: true };
      const jobs = ctx.runtime.executePendingJobs();
      if (jobs.error) return failure(jobs.error);
      jobs.dispose();
      state = ctx.getPromiseState(handle);
      if (state.type === "pending") await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (state.type === "rejected") return failure(state.error);
    const data = ctx.dump(state.value);
    state.value.dispose();
    return { ok: true, data };
  } finally {
    handle?.dispose();
    try { expose(ctx, scope, { env: undefined }); } catch { /* context already unusable */ }
    scope.dispose();
  }
}

async function runWarm(key, source, modules, hook, env, executionTimeoutMs, memoryLimitBytes, sink) {
  const version = createHash("sha1").update(source).update("\0").update(JSON.stringify(modules ?? {})).digest("hex");
  let session = warmSessions.get(key);
  if (session && session.version !== version) {
    warmSessions.delete(key);
    await session.close();
    session = undefined;
  }
  if (session) warmSessions.delete(key);
  else session = openWarm(version, pluginTree(source, modules), memoryLimitBytes, executionTimeoutMs);
  warmSessions.set(key, session);
  for (const [oldKey, old] of warmSessions) {
    if (warmSessions.size <= WARM_MAX) break;
    warmSessions.delete(oldKey);
    await old.close();
  }
  const live = { on: true };
  warmConsole = sink;
  let result;
  try {
    const ctx = await session.ready;
    result = await callWarm(ctx, hook, { ctx: env.ctx, host: sealHost(env.host, live) }, executionTimeoutMs, memoryLimitBytes);
  } catch (e) {
    result = { ok: false, error: { message: String(e?.message ?? e) }, broken: true };
  } finally {
    live.on = false;
    warmConsole = null;
  }
  if (result.broken && warmSessions.get(key) === session) {
    warmSessions.delete(key);
    await session.close();
  }
  return result;
}

// env reaches the guest as host objects. A method call on one
// (host.fs.read(...)) carries its object along as `this`, which is
// serialized again on every call: about a millisecond each, so a route
// reading a thousand files spent a second on that alone. The guest gets its
// own copy, whose functions call the host's without a receiver.
const HOST_COPY = `const local = (v, depth) => {
  if (typeof v === "function") return (...args) => v(...args);
  if (v === null || typeof v !== "object" || depth > 6) return v;
  if (Array.isArray(v)) return v.map((x) => local(x, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) o[k] = local(v[k], depth + 1);
  return o;
};
const host = local(env.host, 0);
const ctx = local(env.ctx, 0);
`;

port.on("message", async (msg) => {
  const { id, source, modules = null, hook, ctx, storeSnapshot = {}, llmResults = {}, netResults = {}, netAllowed = false, maxStoreBytes = 1024 * 1024, storeAllowed = true, llmAllowed = true, fsAllowed = false, fsRoot = null, fsReadOnly = false, fsTransaction = null, zipAllowed = false, zipBase64 = null, zipEntries: providedEntries = null, siblingToolDefs = null, embedResults = {}, executionTimeoutMs = 10_000, memoryLimitBytes = DEFAULT_MEMORY_LIMIT, trackReads = false, warmKey = null } = msg;
  const logs = [];
  const fsWrites = new Set();
  const llmRequests = [];
  const netRequests = [];
  const embedRequests = [];
  const store = { ...storeSnapshot };
  let storeBytes = JSON.stringify(store).length;
  // only the keys this call touched go back: the host writes the store file
  // once per call that changed it, and a delete reaches the file too
  const storeTouched = new Set();
  const storeChanges = () => {
    const storeWrites = {};
    const storeDeletes = [];
    for (const k of storeTouched) {
      if (Object.hasOwn(store, k)) storeWrites[k] = store[k];
      else storeDeletes.push(k);
    }
    return { storeWrites, storeDeletes };
  };
  // what the result depends on, for a host that answers the same read again
  // without running it: each file and folder read, as it was when read
  const reads = trackReads ? new Map() : null;
  let sideEffects = false;
  const failed = () => ({ logs, ...storeChanges(), llmRequests, netRequests, embedRequests });

  try {
    const runSandboxed = await getRun();
    const host = {
      log: (...args) => logs.push(args.map(String).join(" ").slice(0, 500)),
      store: storeAllowed
        ? {
            get: (k) => store[k] ?? null,
            put: (k, v) => {
              store[k] = v === undefined ? null : v;
              storeTouched.add(String(k));
              storeBytes = JSON.stringify(store).length;
              if (storeBytes > maxStoreBytes) throw new Error(`plugin store exceeded ${maxStoreBytes} bytes`);
            },
            delete: (k) => { delete store[k]; storeTouched.add(String(k)); },
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
    // Zip service (SPEC-v2 §3, import path): decode base64 zip → entries map
    // { "path": "text content" } for TEXT entries (binary entries listed as
    // { "__binary__": true }). Size/count capped. Sandboxed plugin then maps
    // entries to app data — the kernel never interprets app formats.
    // the fs service's image writer, for images already in hand as bytes
    let storeImage = null;
    const zipSvc = (() => {
      const denied = () => { throw new Error("permission \"zip\" not granted (add \"zip\" to manifest permissions)"); };
      if (!zipAllowed) return { entries: denied, list: denied };
      return {
        list: () => Object.keys(zipEntries()).length,
        entries: () => {
          const entries = zipEntries();
          if (!providedEntries) return entries;
          const out = {};
          for (const [name, entry] of Object.entries(entries)) {
            out[name] = entry?.__large__ ? { __large__: true, size: entry.size }
              : IMAGE_NAME.test(name) && entry?.__b64__ ? { __image__: true, size: entry.size }
              : entry;
          }
          return out;
        },
        // an image entry stored as media; a PNG's text chunks come back too
        image: (name) => {
          const entry = zipEntries()[String(name)];
          const ext = IMAGE_NAME.exec(String(name))?.[1]?.toLowerCase();
          if (!entry?.__b64__ || typeof entry.base64 !== "string" || !ext) throw new Error("image entry not found");
          const bytes = Buffer.from(entry.base64, "base64");
          const type = ext === "jpg" ? "jpeg" : ext;
          if (type === "png" && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("invalid PNG");
          const metadata = type === "png" ? pngMetadata(bytes) : {};
          return { url: storeImage ? storeImage(type, bytes) : host.fs.media(`data:image/${type};base64,${entry.base64}`), metadata, text: pngText(metadata) };
        },
        // a large text entry, one slice at a time: whole lines from `offset`,
        // about `maxBytes` of them (more when one line is longer), and where
        // the next slice starts, or null at the end
        read: (name, offset = 0, maxBytes = 4 * 1024 * 1024) => {
          const entry = zipEntries()[String(name)];
          if (!entry?.__large__ || typeof entry.file !== "string") throw new Error("large entry not found");
          const from = Number(offset), want = Math.min(64 * 1024 * 1024, Math.max(64 * 1024, Number(maxBytes) || 0));
          if (!Number.isSafeInteger(from) || from < 0 || from > entry.size) throw new Error("invalid offset");
          const fd = fs.openSync(entry.file, "r");
          try {
            let buf = Buffer.alloc(0);
            for (;;) {
              const chunk = Buffer.alloc(Math.min(want, entry.size - from - buf.length));
              const got = chunk.length ? fs.readSync(fd, chunk, 0, chunk.length, from + buf.length) : 0;
              buf = Buffer.concat([buf, chunk.subarray(0, got)]);
              const end = from + buf.length >= entry.size || got === 0;
              if (end) return { text: utf8.decode(buf), next: null };
              const cut = buf.lastIndexOf(10);
              if (cut >= 0) return { text: utf8.decode(buf.subarray(0, cut + 1)), next: from + cut + 1 };
              if (buf.length >= 256 * 1024 * 1024) return { text: utf8.decode(buf), next: from + buf.length };
            }
          } finally { fs.closeSync(fd); }
        },
      };
      function zipEntries() {
        if (providedEntries) return providedEntries;
        if (!zipBase64 || typeof zipBase64 !== "string") throw new Error("no zip payload provided");
        if (zipBase64.length > 200 * 1024 * 1024 / 0.75) throw new Error("zip payload too large (200MB cap)");
        const bytes = Buffer.from(zipBase64, "base64");
        // ZIP-BOMB GUARD: fflate's filter runs from the central directory
        // BEFORE any decompression — reject oversized archives without ever
        // inflating them, and skip entries we would not return anyway.
        // Entry COUNT is a denial-of-service guard, not the size guard — the
        // uncompressed-bytes cap below is what bounds the work. 5000 was low
        // enough that an ordinary library (a card, a chat and a sidecar per
        // conversation adds up fast) was refused outright, with the whole
        // import lost to one error about entry count.
        const MAX_FILES = 60000;
        const MAX_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024; // 256MB across all entries
        let count = 0;
        let total = 0;
        const files = unzipSync(bytes, {
          filter: (f) => {
            if (f.name.endsWith("/")) return false;
            if (f.name.startsWith("/") || f.name.split("/").includes("..")) return false; // zip-slip
            count++;
            total += f.originalSize;
            if (count > MAX_FILES) throw new Error(`zip has too many entries (over ${MAX_FILES}) — import it in parts`);
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
      if (fsReadOnly) {
        let bytesRead = 0;
        const readVersioned = (rel) => {
          try {
            const full = within(rel);
            const size = fs.statSync(full).size;
            if (size > 1024 * 1024 || bytesRead + size > 16 * 1024 * 1024) throw new Error("Skill read limit exceeded");
            const text = fs.readFileSync(full, "utf8");
            bytesRead += Buffer.byteLength(text);
            if (bytesRead > 16 * 1024 * 1024) throw new Error("Skill read limit exceeded");
            return { text, revision: createHash("sha256").update(text).digest("hex") };
          } catch (e) { scrub(e, rel); }
        };
        return {
          read: (rel) => readVersioned(rel).text,
          readVersioned,
          list: (rel = ".") => {
            try {
              const names = fs.readdirSync(within(rel));
              if (names.length > 2000) throw new Error("Skill directory limit exceeded");
              return names.sort();
            } catch (e) { scrub(e, rel); }
          },
        };
      }
      const readFile = (rel) => {
        const full = within(rel);
        if (reads && !reads.has(`f:${full}`)) reads.set(`f:${full}`, fileSignature(full));
        return full;
      };
      const recorded = new Map();
      const beforeWrite = (full) => {
        if (!fsTransaction || recorded.has(full)) return;
        const rel = path.relative(fsRoot, full).split(path.sep).join("/");
        const backup = fs.existsSync(full) ? String(recorded.size) : null;
        if (backup) fs.copyFileSync(full, path.join(fsTransaction, backup), fs.constants.COPYFILE_FICLONE);
        recorded.set(full, { rel, backup });
        // one line per file, before the file is touched: rewriting the whole
        // list on each write made a batch of a thousand writes quadratic
        fs.appendFileSync(path.join(fsTransaction, "journal.jsonl"), JSON.stringify({ rel, backup }) + "\n");
      };
      // stored once per content hash; PNG text chunks are dropped
      storeImage = (ext, bytes) => {
        if (bytes.length > 64 * 1024 * 1024) throw new Error("image exceeds 64 MB");
        if (ext === "png" && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
          const chunks = [bytes.subarray(0, 8)];
          let at = 8;
          while (at < bytes.length) {
            if (at + 12 > bytes.length) throw new Error("invalid PNG chunk");
            const length = bytes.readUInt32BE(at), end = at + length + 12;
            if (end > bytes.length) throw new Error("invalid PNG chunk length");
            const type = bytes.toString("ascii", at + 4, at + 8);
            if (!["tEXt", "iTXt", "zTXt"].includes(type)) chunks.push(bytes.subarray(at, end));
            at = end;
          }
          bytes = Buffer.concat(chunks);
        }
        const name = createHash("sha256").update(bytes).digest("hex") + "." + ext;
        sideEffects = true;
        const full = withinNewFile("__media/" + name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (!fs.existsSync(full)) fs.writeFileSync(full, bytes, { flag: "wx" });
        return "/v1/apps/" + encodeURIComponent(path.basename(path.dirname(fsRoot))) + "/__media/" + name;
      };
      return {
        lookup: (collection, key, value) => {
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(collection))) throw new Error("invalid lookup collection");
          const name = createHash("sha256").update(String(key).toLowerCase()).digest("hex");
          const rel = "__lookup/" + collection + "/" + name + ".json";
          if (value === undefined) { try { return JSON.parse(fs.readFileSync(readFile(rel), "utf8")); } catch { return null; } }
          sideEffects = true;
          const full = withinNewFile(rel);
          const text = JSON.stringify(value);
          if (Buffer.byteLength(text) > 4096) throw new Error("lookup value too large");
          fs.mkdirSync(path.dirname(full), { recursive: true });
          beforeWrite(full);
          fs.writeFileSync(full, text);
          return value;
        },
        image: (uri) => {
          const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(uri));
          if (!match || match[2].length > 90 * 1024 * 1024) throw new Error("invalid image or image exceeds 64 MB");
          const bytes = Buffer.from(match[2], "base64");
          if (bytes.length > 64 * 1024 * 1024) throw new Error("image exceeds 64 MB");
          const metadata = match[1] === "png" ? pngMetadata(bytes) : {};
          return { url: storeImage(match[1], bytes), metadata, text: pngText(metadata) };
        },
        media: (uri) => {
          const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(uri));
          if (!match || match[2].length > 90 * 1024 * 1024) throw new Error("invalid image or image exceeds 64 MB");
          return storeImage(match[1], Buffer.from(match[2], "base64"));
        },
        read: (rel) => { try { return fs.readFileSync(readFile(rel), "utf8"); } catch (e) { scrub(e, rel); } },
        // many files in one call: a folder of thousands of small files paid
        // the crossing into the guest once per file. A file that cannot be
        // read comes back null.
        readMany: (rels) => {
          if (!Array.isArray(rels) || rels.length > 20000) throw new Error("fs.readMany(paths) takes up to 20000 paths");
          return rels.map((rel) => { try { return fs.readFileSync(readFile(String(rel)), "utf8"); } catch { return null; } });
        },
        readBase64: (rel) => { try { return fs.readFileSync(readFile(rel)).toString("base64"); } catch (e) { scrub(e, rel); } },
        write: (rel, content) => {
          if (typeof content !== "string") throw new Error("fs.write(rel, string)");
          const full = withinNewFile(rel);
          if (Buffer.byteLength(content) > 512 * 1024 * 1024) throw new Error("fs.write content too large (512MB)");
          try {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            beforeWrite(full);
            const temporary = full + "." + randomUUID() + ".tmp";
            try { fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" }); fs.renameSync(temporary, full); fsWrites.add(path.relative(fsRoot, full).split(path.sep).join("/")); }
            finally { fs.rmSync(temporary, { force: true }); }
          } catch (e) { scrub(e, rel); }
        },
        // the end of a file, which may grow past what one write can carry
        append: (rel, content) => {
          if (typeof content !== "string") throw new Error("fs.append(rel, string)");
          const full = withinNewFile(rel);
          if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error("fs.append content too large (64MB)");
          try {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            beforeWrite(full);
            fs.appendFileSync(full, content, "utf8");
            fsWrites.add(path.relative(fsRoot, full).split(path.sep).join("/"));
          } catch (e) { scrub(e, rel); }
        },
        list: (rel = ".") => {
          try {
            const full = within(rel);
            if (reads && !reads.has(`d:${full}`)) reads.set(`d:${full}`, dirSignature(full));
            return fs.readdirSync(full).sort();
          } catch (e) { scrub(e, rel); }
        },
        remove: (rel) => {
          const full = within(rel);
          if (full === fsRoot) throw new Error("refusing to remove the data dir itself");
          try {
            const remember = (file) => {
              if (fs.lstatSync(file).isDirectory()) {
                for (const name of fs.readdirSync(file)) remember(path.join(file, name));
              } else fsWrites.add(path.relative(fsRoot, file).split(path.sep).join("/"));
            };
            if (fs.existsSync(full)) remember(full);
            fs.rmSync(full, { recursive: true, force: true });
          } catch (e) { scrub(e, rel); }
        },
      };
    })();
    host.fs = fsSvc;
    host.zip = zipSvc;
    host.regex = regexSvc;
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
    const result = warmKey ? await runWarm(warmKey, source, modules, hook, { ctx, host }, executionTimeoutMs, memoryLimitBytes, (level, ...args) => cappedConsole(level)(...args)) : await runSandboxed(
      async ({ evalCode }) => evalCode(harnessCode(hook), "harness.mjs"),
      {
        executionTimeout: executionTimeoutMs,
        memoryLimit: memoryLimitBytes,
        maxStackSize: 1024 * 1024,
        env: { ctx, host },
        nodeModules: { plugin: pluginTree(source, modules), "guard.js": GUARD },
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
      reply({ id, ok: false, error: result.error.message, ...failed() });
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
      reply({ id, ok: false, error: "hook returned non-serializable result", ...failed() });
      return;
    }
    if (!envelope || envelope.ok !== true) {
      const error = envelope && typeof envelope.error === "string" ? envelope.error : "hook returned non-serializable result";
      reply({ id, ok: false, error, ...failed() });
      return;
    }
    const repeatable = reads && !envelope.varied && !sideEffects && fsWrites.size === 0 && storeTouched.size === 0;
    reply({
      id, ok: true, out: envelope.value ?? null, ...storeChanges(), llmRequests, netRequests, embedRequests, logs, fsWrites: [...fsWrites],
      ...(repeatable ? { reads: [...reads], outBytes: (result.data ?? "").length } : {}),
    });
  } catch (e) {
    // wasm abort / load failure — host will terminate+respawn this worker
    try {
      reply({ id, ok: false, error: `sandbox aborted: ${String(e?.message ?? e).slice(0, 200)}`, ...failed() });
    } catch {
      /* port dead — host timeout handles it */
    }
  }
});
