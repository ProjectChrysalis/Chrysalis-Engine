/**
 * Plugin runtime (SPEC §5.4): QuickJS-WASM sandboxed plugins from the user's
 * plugins/ directory. NO custom scripting DSL by design — plugins are real
 * (sandboxed) JS modules; heavier integrations go through MCP.
 *
 * Engine note: the SYNC QuickJS build is used deliberately. The asyncify
 * builds crash (refcount/memory bugs in quickjs-ng + classic under Node 24 —
 * verified), so async host calls are modeled as a two-phase exchange:
 *
 *   export function handleRoute(req, host) {
 *     const drafted = host.llm.results.draft;         // pass 2+
 *     if (drafted) return { json: { text: drafted.text } };
 *     host.llm.request("draft", { messages: [...] }); // pass 1: request
 *     return { __llmPending: true };
 *   }
 *
 * The engine runs the export, executes requested llm calls host-side (keys
 * never enter the sandbox), then re-runs it with results. Max 3 passes.
 *
 * Plugin shape on disk:
 *   plugins/<id>/manifest.json  { name, version, origin, permissions,
 *                                 schedule?: { intervalMs } }
 *   plugins/<id>/plugin.js      ESM exporting sync functions:
 *     handleRoute(req, host)  → { status, json | text }   (permission: routes)
 *     TOOLS + handleTool(name, args, host)                (permission: tools)
 *     uiPanel(ctx, host)      → a declarative settings panel
 *     onTick(host)                                (when schedule is set)
 *     onAppUpdate({ from, to }, host) → the app's own data upgrades, run
 *                               once after its code moved between versions
 */
import fs from "node:fs";
import path from "node:path";
import { sandbox, type SandboxResponse } from "./sandbox.js";
import type { PluginStoreService } from "./store.js";
import type { UserModelService, GenerateRequest, GenerateResult } from "../models.js";
import { log } from "../logger.js";
import { assertPublicHost } from "../net-guard.js";

/** Exports the engine calls on its own (routes and tools are dispatched by
 *  request, not from here). Only these names fire — a plugin exporting
 *  anything else is never reached. */
export const PLUGIN_HOOKS = ["onTick", "uiPanel", "onAppUpdate", "appTools", "llmRequest"] as const;
export type PluginHook = (typeof PLUGIN_HOOKS)[number];

export type PluginPermissionCap = "llm" | "store" | "schedule" | "network" | "tools" | "routes" | "fs" | "zip" | "hooks";

function hasCapAny(plugin: LoadedPlugin, cap: PluginPermissionCap, deps: PluginRuntimeDeps): boolean {
  const alts: Record<string, string[]> = {
    tools: ["tools", "register:tools"],
    routes: ["routes", "register:routes"],
    fs: ["fs"],
    zip: ["zip"],
  };
  const names = alts[cap] ?? [cap];
  const has = plugin.manifest.permissions.some((p) => names.includes(p));
  if (!has) return false;
  if (plugin.manifest.origin !== "imported") return true;
  const grants = deps.grantsFor(plugin.id);
  return names.some((n) => grants.includes(n));
}

export interface LoadedPlugin {
  id: string;
  dir: string;
  manifest: PluginManifest;
  source: string;
  mtimeMs: number;
  /** App data dir fs scope for app-bundled plugins (null for top-level). */
  fsRoot?: string | null;
  /** The app a bundled plugin belongs to (absent for top-level). */
  appId?: string;
}

export interface LlmRequestHook {
  plugin: LoadedPlugin;
  priority: number;
}

export interface PluginRuntimeDeps {
  store: PluginStoreService;
  models: Pick<UserModelService, "generate" | "embed">;
  /** settings.json pluginGrants — required for imported plugins. */
  grantsFor: (pluginId: string) => string[];
  /** When set, plugin llm requests tagged with a `stream` descriptor get
   *  their text deltas surfaced live (the kernel generates with streaming
   *  either way — this only routes the deltas to an event sink). */
  onLlmDelta?: (tag: unknown, delta: string) => void;
  /** Same routing for reasoning-model thinking deltas (live "Thinking…" UI). */
  onLlmThinking?: (tag: unknown, delta: string) => void;
  /** Live tool-call progress for streamed requests (start/end with result). */
  onLlmTool?: (tag: unknown, ev: { phase: "start" | "end"; name: string; args: Record<string, unknown>; result?: { text: string; isError: boolean } }) => void;
  /** App plugins can contribute llm tools to sibling plugins' requests: a
   *  request marked wantsTools:true picks up every sibling's appTools() export
   *  with the executor bound to the owning plugin. Set by app-route dispatch. */
  siblingTools?: (self: LoadedPlugin) => Promise<PluginToolBridge | null>;
  /** App plugins whose llmRequest hook may patch this plugin's model
   *  requests (permissions: hooks + llm). Set by app-route dispatch. */
  llmHooks?: (self: LoadedPlugin) => Promise<LlmRequestHook[]>;
  /** Register an abort signal for a streamed llm request (keyed by its stream
   *  descriptor's chatId by the dispatch layer). Cancelling aborts the
   *  provider stream; the kernel salvages whatever partial text exists. */
  abortCtlFor?: (tag: unknown) => AbortSignal | null;
  /** One-shot: was this streamed generation cancelled? Consumed when read —
   *  a cancelled generation's result is DISCARDED (error result, no commit);
   *  the client owns what a cancelled reply keeps and writes it itself. */
  consumeCancel?: (tag: unknown) => boolean;
}


// ---------- discovery (mtime-cached → cheap hot reload) ----------

const discoveryCache = new Map<string, { plugins: LoadedPlugin[]; key: string }>();

export function discoverPlugins(pluginsDir: string): LoadedPlugin[] {
  let key = "";
  try {
    key = fs.statSync(pluginsDir).mtimeMs.toString();
    for (const id of fs.readdirSync(pluginsDir)) {
      try {
        // manifest mtime matters too — permissions/networkHosts edits must be
      // picked up, not just plugin.js changes
      key += `${id}:${fs.statSync(path.join(pluginsDir, id, "plugin.js")).mtimeMs}:${fs.statSync(path.join(pluginsDir, id, "manifest.json")).mtimeMs}`;
      } catch {
        /* incomplete plugin dir — skipped below */
      }
    }
  } catch {
    return [];
  }
  const cached = discoveryCache.get(pluginsDir);
  if (cached && cached.key === key) return cached.plugins;

  const plugins: LoadedPlugin[] = [];
  for (const id of fs.readdirSync(pluginsDir)) {
    const dir = path.join(pluginsDir, id);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as PluginManifest;
      if (!manifest?.name || !Array.isArray(manifest.permissions)) continue;
      const source = fs.readFileSync(path.join(dir, "plugin.js"), "utf8");
      plugins.push({ id, dir, manifest, source, mtimeMs: fs.statSync(path.join(dir, "plugin.js")).mtimeMs });
    } catch {
      log.warn(`plugin "${id}" skipped: invalid manifest or missing plugin.js`);
    }
  }
  discoveryCache.set(pluginsDir, { plugins, key });
  return plugins;
}

export function invalidatePluginCache(pluginsDir?: string): void {
  if (pluginsDir) discoveryCache.delete(pluginsDir);
  else discoveryCache.clear();
  // kill schedules whose plugin dir no longer exists (deleted apps/plugins) —
  // otherwise a removed scheduled plugin keeps ticking with frozen source
  for (const [dir, armed] of activeTimers) {
    if (!fs.existsSync(path.join(dir, "plugin.js"))) {
      clearInterval(armed.timer);
      activeTimers.delete(dir);
    }
  }
}

/**
 * App-bundled plugins (SPEC-v2 §3): apps/<app>/plugins/<id>/. Ids namespaced
 * `<app>__<pluginId>`; fs scope = the app's data/ dir (git-tracked).
 */
export function discoverAppPlugins(appsDir: string, appId: string): LoadedPlugin[] {
  const pluginsDir = path.join(appsDir, appId, "plugins");
  const dataDir = path.join(appsDir, appId, "data");
  return discoverPlugins(pluginsDir).map((pl) => ({
    ...pl,
    id: `${appId}__${pl.id}`,
    manifest: { ...pl.manifest, name: pl.manifest.name ?? pl.id },
    fsRoot: dataDir,
    appId,
  }));
}

/** Read a static export (e.g. TOOLS) from a plugin without running hooks. */
export async function readPluginExport(plugin: LoadedPlugin, exportName: string): Promise<unknown> {
  const r = await sandbox.eval({
    source: plugin.source,
    hook: `__export:${exportName}`,
    ctx: { exportName },
    storeSnapshot: {},
    storeAllowed: false,
    llmAllowed: false,
    retryOnPoison: true,
  });
  return r.ok ? r.out : null;
}

/** Execute a plugin tool call (plugin exports handleTool(name, args, host)).
 *  A tool that needs a model, the network or embeddings asks for them like a
 *  route would: the host runs the requests and re-runs the handler with the
 *  results, bounded passes. */
export async function runPluginTool(
  plugin: LoadedPlugin,
  toolName: string,
  args: Record<string, unknown>,
  deps: PluginRuntimeDeps,
): Promise<{ ok: boolean; text: string } | null> {
  if (!hasCapAny(plugin, "tools", deps)) return null;
  const caps = passCaps(plugin, deps);
  const MAX_TOOL_PASSES = 3;
  let results = noResults();
  for (let pass = 0; pass < MAX_TOOL_PASSES; pass++) {
    const r = await sandbox.eval({
      source: plugin.source,
      hook: "__tool",
      ctx: { name: toolName, args },
      storeSnapshot: snapshotOf(plugin, deps),
      storeAllowed: hasCapAny(plugin, "store", deps),
      llmAllowed: caps.llm,
      llmResults: results.llm,
      embedResults: results.embed,
      fsAllowed: hasCapAny(plugin, "fs", deps) && !!plugin.fsRoot,
      fsRoot: plugin.fsRoot ?? null,
      netAllowed: caps.net,
      netResults: results.net,
    });
    printLogs(plugin, r);
    applyStoreWrites(plugin, r, deps);
    if (!r.ok) {
      log.warn(`[plugin:${plugin.id}] tool ${toolName} failed: ${r.error}`);
      return null;
    }
    const out = r.out as { text?: unknown; isError?: unknown } | null;
    if (!out || typeof out !== "object") return null;
    if (!passWants(r, caps) || pass === MAX_TOOL_PASSES - 1) {
      return { ok: out.isError !== true, text: String(out.text ?? "") };
    }
    results = await runPassRequests(plugin, r, deps, caps, "tool");
  }
  return null;
}

export interface PluginToolBridge {
  tools: GenerateRequest["tools"];
  executeTool: GenerateRequest["executeTool"];
}

/** Merge two tool bridges (own + sibling): tools concatenate (capped at 16,
 *  the kernel's def limit), execution routes to whichever bridge declared the
 *  tool name. */
export function mergeToolBridges(a: PluginToolBridge | null, b: PluginToolBridge | null): PluginToolBridge | null {
  if (!a) return b;
  if (!b) return a;
  const aNames = new Set((a.tools ?? []).map((t) => t.name));
  return {
    tools: [...(a.tools ?? []), ...(b.tools ?? []).filter((t) => !aNames.has(t.name))].slice(0, 16),
    executeTool: async (name, args) => {
      if (aNames.has(name) && a.executeTool) return a.executeTool(name, args);
      if (b.executeTool) return b.executeTool(name, args);
      return { text: "tool unavailable", isError: true };
    },
  };
}

/** Plugin-requested tool calling: tool DEFINITIONS ride the llm request as
 * plain data (the sandbox cannot export functions); the host bridges them to
 * the kernel tool loop by executing the plugin's handleTool(name, args, host)
 * in a fresh sandbox pass. Requires the "tools" permission. */
export function pluginToolBridge(
  plugin: LoadedPlugin,
  gen: { tools?: unknown },
  deps: PluginRuntimeDeps,
): PluginToolBridge | null {
  const defs = pluginToolsOf(gen.tools);
  if (!defs) return null;
  if (!hasCapAny(plugin, "tools", deps)) {
    log.warn(`[plugin:${plugin.id}] llm tools requested without the "tools" permission — ignored`);
    return null;
  }
  return {
    tools: defs as unknown as GenerateRequest["tools"],
    executeTool: async (name, args) => {
      const r = await runPluginTool(plugin, name, args, deps);
      return r ? { text: r.text, isError: !r.ok } : { text: "tool unavailable", isError: true };
    },
  };
}

/** Tools contributed by a plugin's SIBLINGS in the same app: each sibling
 *  with the "tools" permission exports appTools(host) returning
 *  { tools: [defs] }; execution binds to the owning plugin's handleTool.
 *  This is how a dedicated tools plugin injects agentic tools into another
 *  plugin's chat generations (requests marked wantsTools: true). */
export async function collectSiblingTools(
  appPlugins: LoadedPlugin[],
  self: LoadedPlugin,
  deps: PluginRuntimeDeps,
): Promise<PluginToolBridge | null> {
  const tools: { name: string; description: string; parameters: Record<string, unknown> }[] = [];
  const owners = new Map<string, LoadedPlugin>();
  for (const sibling of appPlugins) {
    if (sibling.id === self.id) continue;
    if (!hasCapAny(sibling, "tools", deps)) continue;
    const res = await runPluginHook(sibling, "appTools", {}, deps);
    const defs = pluginToolsOf((res as { tools?: unknown } | null)?.tools);
    if (!defs) continue;
    for (const d of defs) {
      if (owners.has(d.name)) continue; // first contributor wins on clashes
      owners.set(d.name, sibling);
      tools.push(d);
      if (tools.length >= 16) break;
    }
    if (tools.length >= 16) break;
  }
  if (!tools.length) return null;
  return {
    tools: tools as unknown as GenerateRequest["tools"],
    executeTool: async (name, args) => {
      const owner = owners.get(name);
      if (!owner) return { text: `tool not available: ${name}`, isError: true };
      const r = await runPluginTool(owner, name, args, deps);
      return r ? { text: r.text, isError: !r.ok } : { text: "tool unavailable", isError: true };
    },
  };
}

/** Request fields an llmRequest hook may patch. Everything else is host-only
 *  (tools, executeTool, signal, trace source, stream routing) and can never be
 *  set from a hook: the allowlist is the boundary, so a patch cannot take over
 *  execution, cancel a generation, or spoof the trace. */
const LLM_PATCH_FIELDS = [
  "messages", "systemPrompt", "model", "sessionId", "reasoning", "thinkingBudget",
  "reasoningTags", "assistantPrefill", "promptFormat", "presetParams", "schema",
] as const;

/** Sibling plugins that can patch this plugin's llm requests: llmRequest
 *  hooks, gated on BOTH "hooks" and "llm" (an imported plugin needs both
 *  grants — seeing another plugin's prompts is only for plugins the user has
 *  already trusted with model access). Manifest priority orders them: lower
 *  runs first, higher runs later so its patch wins on conflicts; ties break
 *  by plugin id for determinism. */
export async function collectSiblingLlmHooks(
  appPlugins: LoadedPlugin[],
  self: LoadedPlugin,
  deps: PluginRuntimeDeps,
): Promise<LlmRequestHook[]> {
  const hooks: LlmRequestHook[] = [];
  for (const sibling of appPlugins) {
    if (sibling.id === self.id) continue;
    if (!hasCapAny(sibling, "hooks", deps) || !hasCapAny(sibling, "llm", deps)) continue;
    // cheap pre-check before paying for a sandbox eval: no name, no export
    if (!sibling.source.includes("llmRequest")) continue;
    hooks.push({
      plugin: sibling,
      priority: typeof sibling.manifest.priority === "number" ? sibling.manifest.priority : 0,
    });
  }
  hooks.sort((a, b) => a.priority - b.priority || (a.plugin.id < b.plugin.id ? -1 : 1));
  return hooks;
}

/** Run the sibling llmRequest pipeline over one model request. Each hook sees
 *  a JSON snapshot of the request as patched so far and returns a patch;
 *  only LLM_PATCH_FIELDS survive. Crash-isolated like every hook: a failed
 *  hook is skipped and the request proceeds. Requests made BY a hook never
 *  re-enter the pipeline (runPluginHook's own loop does not apply hooks), so
 *  a hook cannot recurse into itself. */
export async function applyLlmRequestHooks(
  self: LoadedPlugin,
  key: string,
  req: GenerateRequest,
  deps: PluginRuntimeDeps,
): Promise<GenerateRequest> {
  if (!deps.llmHooks) return req;
  const hooks = await deps.llmHooks(self).catch(() => [] as LlmRequestHook[]);
  if (!hooks.length) return req;
  let out = req;
  for (const { plugin } of hooks) {
    const snapshot = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    let patch: Record<string, unknown> | null = null;
    try {
      patch = await runPluginHook(plugin, "llmRequest", { request: snapshot, plugin: self.id, key }, deps);
    } catch (e) {
      // a patch hook must never be able to break a generation it patches
      log.warn(`[plugin:${plugin.id}] llmRequest hook crashed: ${(e as Error).message}`);
      continue;
    }
    if (!patch || typeof patch !== "object") continue;
    const applied: Record<string, unknown> = {};
    for (const field of LLM_PATCH_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) applied[field] = patch[field];
    }
    if (!Object.keys(applied).length) continue;
    log.info(`[plugin:${self.id}] llm "${key}" patched by ${plugin.id}`);
    out = { ...out, ...applied } as GenerateRequest;
  }
  return out;
}

function pluginToolsOf(raw: unknown): { name: string; description: string; parameters: Record<string, unknown> }[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: { name: string; description: string; parameters: Record<string, unknown> }[] = [];
  for (const t of raw.slice(0, 16)) {
    const d = t as { name?: unknown; description?: unknown; parameters?: unknown };
    if (typeof d?.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(d.name)) continue;
    if (typeof d?.description !== "string") continue;
    if (d.parameters !== undefined && (typeof d.parameters !== "object" || d.parameters === null)) continue;
    out.push({
      name: d.name,
      description: d.description.slice(0, 2048),
      parameters: (d.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
    });
  }
  return out.length ? out : null;
}

/** Dispatch an HTTP route to a plugin (exports handleRoute(req, host)). */
export interface PluginRouteRequest {
  method: string;
  path: string; // relative to the app namespace, e.g. "/chats/abc/messages"
  query: Record<string, string>;
  body: unknown;
  /** Base64 zip payload for importers (permission "zip"; 200MB cap enforced in the worker). */
  zipBase64?: string;
}
export interface PluginRouteResponse {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
}
// ---------- network service (permission "network", SPEC-v2 §3) ----------
// Two-phase like llm: the sandbox registers requests, the HOST executes them
// (no Chrysalis credentials are ever attached), results land in host.net.results.
// Request shape is fetch-class:
//   { url, method?, headers?, body?, form?, timeoutMs?, maxBytes?,
//     followRedirects?, json?, binary? }
// Result: { ok, status, statusText, headers, contentType?, text?, json?,
//           base64?, url }
const NET_DEFAULT_TIMEOUT_MS = 15_000;
const NET_MAX_TIMEOUT_MS = 60_000;
const NET_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const NET_HARD_MAX_BYTES = 20 * 1024 * 1024;

interface NetRequestSpec {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
  form?: unknown;
  timeoutMs?: unknown;
  maxBytes?: unknown;
  followRedirects?: unknown;
  json?: unknown;
  binary?: unknown;
}

/** Drop payload headers when a redirect turned a POST into a GET. */
function stripBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower !== "content-type" && lower !== "content-length") out[k] = v;
  }
  return out;
}

async function executeNetRequest(plugin: LoadedPlugin, spec: NetRequestSpec): Promise<Record<string, unknown>> {
  try {
    // Egress is allowlist-ONLY: a plugin without networkHosts gets no network
    // at all (default-deny). Every redirect hop is re-validated too, so an
    // allowlisted host can't 30x a plugin onto something internal.
    const allow = plugin.manifest.networkHosts;
    const hostAllowed = (hostname: string): boolean =>
      Array.isArray(allow) &&
      allow.some((a) => hostname === a || (a.startsWith("*.") && hostname.endsWith(a.slice(1))));
    const checkUrl = (u: URL): void => {
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) urls");
      if (!hostAllowed(u.hostname)) {
        throw new Error(`host not in this plugin's networkHosts allowlist: ${u.hostname}`);
      }
    };
    const url = new URL(String(spec.url));
    checkUrl(url);
    await assertPublicHost(url.hostname);
    const method = spec.method === undefined ? "GET" : String(spec.method).toUpperCase();
    if (!/^[A-Z][A-Z0-9-]{0,15}$/.test(method)) throw new Error(`invalid method: ${method}`);

    const headers: Record<string, string> = {};
    if (spec.headers && typeof spec.headers === "object") {
      for (const [k, v] of Object.entries(spec.headers as Record<string, unknown>)) headers[k] = String(v);
    }
    // body: string as-is; object → JSON (content-type set unless provided);
    // form: object → urlencoded
    let body: string | undefined;
    if (spec.body !== undefined && method !== "GET" && method !== "HEAD") {
      if (typeof spec.body === "string") {
        body = spec.body;
      } else {
        body = JSON.stringify(spec.body);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
      }
    } else if (spec.form && typeof spec.form === "object" && method !== "GET" && method !== "HEAD") {
      body = new URLSearchParams(Object.entries(spec.form as Record<string, unknown>).map(([k, v]) => [k, String(v)] as [string, string])).toString();
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/x-www-form-urlencoded";
    }

    const timeoutMs = Math.min(NET_MAX_TIMEOUT_MS, Math.max(500, Number(spec.timeoutMs) || NET_DEFAULT_TIMEOUT_MS));
    const maxBytes = Math.min(NET_HARD_MAX_BYTES, Math.max(1024, Number(spec.maxBytes) || NET_DEFAULT_MAX_BYTES));

    // always-manual redirects, re-checking the allowlist per hop (≤5)
    let current = url;
    let res = await fetch(current, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; hop++) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const nextUrl = new URL(loc, current);
      checkUrl(nextUrl);
      await assertPublicHost(nextUrl.hostname);
      current = nextUrl;
      res = await fetch(current, {
        method: res.status === 303 || (res.status === 301 && method === "POST") || (res.status === 302 && method === "POST") ? "GET" : method,
        headers: res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST") ? stripBodyHeaders(headers) : headers,
        ...(res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST") ? {} : body !== undefined ? { body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    // precheck declared size, then stream-read with a hard ceiling — a
    // multi-GB body must never be buffered in full before the cap fires
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error(`response too large (${declared} > ${maxBytes}; raise maxBytes up to ${NET_HARD_MAX_BYTES})`);
    let buf: Buffer;
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* already closed */ }
          throw new Error(`response too large (${total} > ${maxBytes}; raise maxBytes up to ${NET_HARD_MAX_BYTES})`);
        }
        chunks.push(value);
      }
      buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    } else {
      buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) throw new Error(`response too large (${buf.byteLength} > ${maxBytes}; raise maxBytes up to ${NET_HARD_MAX_BYTES})`);
    }

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });

    const out: Record<string, unknown> = {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
      url: res.url,
    };
    const ct = res.headers.get("content-type");
    if (ct) out.contentType = ct;
    const wantsJson = spec.json === true || (spec.json !== false && ct?.includes("json"));
    const wantsBinary = spec.binary === true;
    if (wantsBinary) {
      out.base64 = buf.toString("base64");
    } else if (wantsJson) {
      try { out.json = JSON.parse(buf.toString("utf8")); } catch { out.text = buf.toString("utf8"); }
    } else {
      out.text = buf.toString("utf8");
    }
    return out;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Console-trace source for plugin llm calls: "app:<app>/<plugin>". */
function llmSourceOf(plugin: LoadedPlugin): string {
  const m = /apps\/([^/]+)\/plugins\//.exec(plugin.dir.replace(/\\/g, "/"));
  return `app:${m ? m[1] + "/" : ""}${plugin.id}`;
}

/** What a plugin may ask the host for between passes. */
interface PassCaps {
  llm: boolean;
  net: boolean;
}

function passCaps(plugin: LoadedPlugin, deps: PluginRuntimeDeps): PassCaps {
  return { llm: hasCapAny(plugin, "llm", deps), net: hasCapAny(plugin, "network", deps) };
}

/** Answers handed to the next pass, by the key the plugin asked under. */
interface PassResults {
  llm: Record<string, unknown>;
  net: Record<string, unknown>;
  embed: Record<string, unknown>;
}

const noResults = (): PassResults => ({ llm: {}, net: {}, embed: {} });

/** Did this pass ask for anything it is allowed to get? */
function passWants(r: SandboxResponse, caps: PassCaps): boolean {
  return (
    (caps.llm && ((r.llmRequests?.length ?? 0) > 0 || (r.embedRequests?.length ?? 0) > 0)) ||
    (caps.net && (r.netRequests?.length ?? 0) > 0)
  );
}

function printLogs(plugin: LoadedPlugin, r: SandboxResponse): void {
  for (const line of r.logs ?? []) log.info(`[plugin:${plugin.id}] ${line}`);
}

/** The stand-in result for a model call that produced nothing usable. */
function emptyGeneration(error?: string): GenerateResult {
  return { text: "", model: "error", ...(error ? { error } : {}), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0, priced: false } };
}

/**
 * Run what one pass asked for, host-side (keys never enter the sandbox and
 * web requests carry no Chrysalis credentials), one request after another.
 * Model requests get more the closer they are to an app route:
 *   route  sibling tools, other plugins' llmRequest hooks, live streaming
 *          and cancelling
 *   hook   sibling tools; never the hook pipeline, so a hook's own model
 *          call cannot recurse into it
 *   tool   the plain request: a tool runs inside a tool loop already, and
 *          tools of its own could nest that loop without end
 */
async function runPassRequests(
  plugin: LoadedPlugin,
  r: SandboxResponse,
  deps: PluginRuntimeDeps,
  caps: PassCaps,
  mode: "route" | "hook" | "tool",
): Promise<PassResults> {
  const results = noResults();
  if (caps.llm) {
    for (const { key, req } of r.embedRequests ?? []) {
      const texts = Array.isArray(req.texts) ? req.texts.map(String) : [];
      try {
        results.embed[key] = texts.length ? await deps.models.embed(texts, typeof req.model === "string" ? req.model : undefined) : null;
      } catch (e) {
        log.warn(`[plugin:${plugin.id}] embed "${key}" failed: ${(e as Error).message}`);
        results.embed[key] = null;
      }
    }
  }
  if (caps.net) {
    for (const { key, req } of r.netRequests ?? []) {
      results.net[key] = await executeNetRequest(plugin, req as { url?: unknown });
    }
  }
  if (!caps.llm) return results;
  for (const { key, req } of r.llmRequests ?? []) {
    // `stream` is an app-level routing descriptor, not a GenerateRequest
    // field — strip it and use it to route live deltas when a sink exists.
    // `wantsTools` likewise: a marker asking for sibling-contributed tools.
    const { stream, wantsTools, ...clean } = req as GenerateRequest & { stream?: unknown; wantsTools?: unknown; tools?: unknown };
    let toolBridge: PluginToolBridge | null = null;
    if (mode !== "tool") {
      toolBridge = pluginToolBridge(plugin, clean, deps);
      if (wantsTools === true && deps.siblingTools) toolBridge = mergeToolBridges(toolBridge, await deps.siblingTools(plugin));
    }
    delete clean.tools;
    const streamTag = mode === "route" ? stream : undefined;
    const request = mode === "route" ? await applyLlmRequestHooks(plugin, key, clean, deps) : clean;
    const onDelta = streamTag && deps.onLlmDelta ? (d: string) => deps.onLlmDelta!(streamTag, d) : undefined;
    const onThinking = streamTag && deps.onLlmThinking ? (d: string) => deps.onLlmThinking!(streamTag, d) : undefined;
    const onToolEvent = streamTag && deps.onLlmTool ? (ev: Parameters<NonNullable<PluginRuntimeDeps["onLlmTool"]>>[1]) => deps.onLlmTool!(streamTag, ev) : undefined;
    const abortSignal = streamTag && deps.abortCtlFor ? deps.abortCtlFor(streamTag) : null;
    try {
      const out = await deps.models.generate({ ...request, ...toolBridge, ...(onToolEvent ? { onToolEvent } : {}), ...(abortSignal ? { signal: abortSignal } : {}), source: llmSourceOf(plugin) }, onDelta, onThinking);
      // cancelled generations never commit: the client owns what a cancel
      // keeps (it froze the exact on-screen bytes) and writes them itself
      results.llm[key] = streamTag && deps.consumeCancel?.(streamTag) ? emptyGeneration() : out;
    } catch (e) {
      const msg = (e as Error).message;
      log.warn(`[plugin:${plugin.id}] llm "${key}" failed: ${msg}`);
      results.llm[key] = emptyGeneration(msg);
    }
  }
  return results;
}

export async function runPluginRoute(
  plugin: LoadedPlugin,
  req: PluginRouteRequest,
  deps: PluginRuntimeDeps,
): Promise<PluginRouteResponse | null> {
  if (!hasCapAny(plugin, "routes", deps)) return null;
  const MAX_ROUTE_PASSES = 3;
  const caps = passCaps(plugin, deps);
  let results = noResults();
  // pass-A carry-all: the sandbox module is re-evaluated fresh EVERY pass, so
  // plugin module state cannot survive — routes return {__llmPending, stash}
  // and the stash rides into the next pass's ctx verbatim
  let stash: Record<string, unknown> | undefined;
  const zipOk = hasCapAny(plugin, "zip", deps) && !!req.zipBase64;
  // ?siblingtools=1: expose the tool DEFINITIONS a wantsTools:true llm request
  // from this plugin would carry (defs only — execution stays host-side), so a
  // route can show its callers exactly what the model would receive
  let siblingToolDefs: GenerateRequest["tools"] | null = null;
  if (req.query.siblingtools === "1" && deps.siblingTools) {
    const bridge = await deps.siblingTools(plugin);
    siblingToolDefs = bridge ? [...(bridge.tools ?? [])] : [];
  }
  for (let pass = 0; pass < MAX_ROUTE_PASSES; pass++) {
    const r = await sandbox.eval({
      source: plugin.source,
      hook: "__route",
      // zipBase64 already rides the message for the host-side zip service —
      // keep the multi-MB string OUT of the guest's ctx (64MB heap)
      ctx: { ...req, zipBase64: undefined, ...(stash ? { stash } : {}) } as unknown as Record<string, unknown>,
      storeSnapshot: snapshotOf(plugin, deps),
      storeAllowed: hasCapAny(plugin, "store", deps),
      llmAllowed: caps.llm,
      fsAllowed: hasCapAny(plugin, "fs", deps) && !!plugin.fsRoot,
      fsRoot: plugin.fsRoot ?? null,
      zipAllowed: zipOk,
      ...(zipOk ? { zipBase64: req.zipBase64! } : {}),
      llmResults: results.llm,
      netAllowed: caps.net,
      netResults: results.net,
      embedResults: results.embed,
      ...(siblingToolDefs ? { siblingToolDefs } : {}),
      retryOnPoison: req.method === "GET" || req.method === "HEAD",
    });
    printLogs(plugin, r);
    applyStoreWrites(plugin, r, deps);
    if (!r.ok) {
      log.warn(`[plugin:${plugin.id}] route ${req.method} ${req.path} failed: ${r.error}`);
      // the plugin id belongs in the response too: the app page (and the
      // agent reading its console) must know WHICH plugin failed to parse,
      // not just that one did
      return { status: 500, json: { error: `plugin ${plugin.id} route failed: ${r.error}` } };
    }
    const out = r.out as Record<string, unknown> | null;
    if (out?.__llmPending === true && out.stash && typeof out.stash === "object") {
      stash = out.stash as Record<string, unknown>;
    }
    const pending = out?.__llmPending === true || passWants(r, caps);
    if (!pending || pass === MAX_ROUTE_PASSES - 1) {
      if (!out || typeof out !== "object" || (out.json === undefined && out.text === undefined && out.status === undefined)) {
        return null; // no route matched
      }
      return {
        status: typeof out.status === "number" ? out.status : 200,
        ...(out.json !== undefined ? { json: out.json } : {}),
        ...(out.text !== undefined ? { text: String(out.text) } : {}),
        ...(typeof out.contentType === "string" ? { contentType: out.contentType } : {}),
      };
    }
    results = await runPassRequests(plugin, r, deps, caps, "route");
  }
  return null;
}

function snapshotOf(plugin: LoadedPlugin, deps: PluginRuntimeDeps): Record<string, unknown> {
  if (!hasCapAny(plugin, "store", deps)) return {};
  const ns = deps.store.namespace(plugin.id);
  const snap: Record<string, unknown> = {};
  for (const k of ns.keys()) snap[k] = ns.get(k);
  return snap;
}

function applyStoreWrites(plugin: LoadedPlugin, r: { storeWrites?: Record<string, unknown> }, deps: PluginRuntimeDeps): void {
  if (!r.storeWrites || !hasCapAny(plugin, "store", deps)) return;
  const ns = deps.store.namespace(plugin.id);
  for (const [k, v] of Object.entries(r.storeWrites)) ns.put(k, v);
}


// ---------- manifest types (SPEC-v2 §3) ----------

export type PluginPermission =
  | "hooks"
  | "llm"
  | "store"
  | "schedule"
  | "network"
  | `fs:${string}`
  | "fs"
  | "register:tools"
  | "tools"
  | "register:routes"
  | "routes";

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  /** "local" (self/agent-authored, trusted) or "imported" (grants required). */
  origin?: "local" | "imported";
  permissions: PluginPermission[];
  hooks?: string[];
  /** Interval scheduler: calls the plugin's onTick(host) hook. */
  schedule?: { intervalMs: number };
  /** Cross-plugin hook order (llmRequest): lower runs first, higher runs
   *  later so its patch wins on conflicts. Default 0; ties break by id. */
  priority?: number;
  /** Optional host allowlist for the "network" permission: exact hostnames or
   *  "*.example.com" suffixes. Absent/empty = no network at all; egress is
   *  default-deny for every plugin, trusted or imported. */
  networkHosts?: string[];
}

// ---------- hook execution (two-phase llm exchange, worker-isolated) ----------

const MAX_PASSES = 3;

export async function runPluginHook(
  plugin: LoadedPlugin,
  hook: PluginHook | string,
  ctx: Record<string, unknown>,
  deps: PluginRuntimeDeps,
): Promise<Record<string, unknown> | null> {
  const storeOk = hasCapAny(plugin, "store", deps);
  const caps = passCaps(plugin, deps);
  const storeSnapshot = snapshotOf(plugin, deps);

  let results = noResults();
  let current: Record<string, unknown> = ctx;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const r = await sandbox.eval({
      source: plugin.source,
      hook,
      ctx: current as unknown,
      storeSnapshot,
      storeAllowed: storeOk,
      llmAllowed: caps.llm,
      llmResults: results.llm,
      embedResults: results.embed,
      netAllowed: caps.net,
      netResults: results.net,
      fsAllowed: hasCapAny(plugin, "fs", deps) && !!plugin.fsRoot,
      fsRoot: plugin.fsRoot ?? null,
    });

    applyStoreWrites(plugin, r, deps);
    printLogs(plugin, r);

    if (!r.ok) {
      if (!storeOk && r.storeWrites && Object.keys(r.storeWrites).length > 0) {
        log.warn(`[plugin:${plugin.id}] store writes attempted without permission — discarded`);
      }
      log.warn(`[plugin:${plugin.id}] ${hook} failed: ${r.error}`);
      return null; // crash-isolated: pass original ctx through
    }

    if (!passWants(r, caps)) return (r.out as Record<string, unknown> | null) ?? null;
    if (pass === MAX_PASSES - 1) {
      log.warn(`[plugin:${plugin.id}] ${hook}: exceeded ${MAX_PASSES} passes; using last good ctx`);
      return (r.out as Record<string, unknown> | null) ?? null;
    }
    results = await runPassRequests(plugin, r, deps, caps, "hook");
    current = (r.out as Record<string, unknown>) ?? current;
  }
  return null;
}


// ---------- scheduler (SPEC §5.4: schedule service, interval flavor) ----------

const MIN_INTERVAL_MS = 5_000;

interface ArmedTimer {
  /** Whose plugin this is (one workspace root per account). */
  owner: string;
  intervalMs: number;
  timer: NodeJS.Timeout;
}

/** Armed timers by plugin dir. */
const activeTimers = new Map<string, ArmedTimer>();

function intervalOf(plugin: LoadedPlugin): number | null {
  const ms = plugin.manifest.schedule?.intervalMs;
  return typeof ms === "number" && ms > 0 ? Math.max(MIN_INTERVAL_MS, ms) : null;
}

/**
 * Make one owner's timers match `list()`, the plugins they may come from:
 * every plugin with a schedule and the schedule permission ticks, and a timer
 * whose plugin is gone, disabled, lost the permission or changed its interval
 * stops (and re-arms at the new interval). A tick looks its plugin up again,
 * so it runs the code on disk now, and never starts while the previous tick of
 * the same plugin is still running.
 */
export function syncSchedules(
  owner: string,
  list: () => LoadedPlugin[],
  deps: PluginRuntimeDeps,
  onEvent: (plugin: LoadedPlugin, payload: unknown) => void,
): void {
  const wanted = new Map<string, LoadedPlugin>();
  for (const plugin of list()) {
    if (intervalOf(plugin) !== null && hasCapAny(plugin, "schedule", deps)) wanted.set(plugin.dir, plugin);
  }
  for (const [dir, armed] of activeTimers) {
    if (armed.owner !== owner) continue;
    const plugin = wanted.get(dir);
    if (plugin && intervalOf(plugin) === armed.intervalMs) continue;
    clearInterval(armed.timer);
    activeTimers.delete(dir);
  }
  for (const [dir, plugin] of wanted) {
    if (activeTimers.has(dir)) continue;
    const intervalMs = intervalOf(plugin)!;
    if (plugin.manifest.schedule!.intervalMs < MIN_INTERVAL_MS) log.warn(`[plugin:${plugin.id}] schedule.intervalMs < ${MIN_INTERVAL_MS}, clamped to ${MIN_INTERVAL_MS}`);
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      const current = list().find((p) => p.dir === dir);
      if (!current || intervalOf(current) === null || !hasCapAny(current, "schedule", deps)) return;
      running = true;
      try {
        const result = await runPluginHook(current, "onTick", { pluginId: current.id }, deps);
        if (result) onEvent(current, result);
      } finally {
        running = false;
      }
    }, intervalMs);
    timer.unref();
    activeTimers.set(dir, { owner, intervalMs, timer });
  }
}

/** Stop one owner's timers, or every timer when no owner is given. */
export function stopSchedules(owner?: string): void {
  for (const [dir, armed] of activeTimers) {
    if (owner !== undefined && armed.owner !== owner) continue;
    clearInterval(armed.timer);
    activeTimers.delete(dir);
  }
}
