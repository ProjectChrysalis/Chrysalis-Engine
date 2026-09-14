/**
 * Hono app + routes (SPEC §6). Thin handlers over services.
 */
import { Hono, type Context, type Next } from "hono";
import { compress } from "hono/compress";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { PluginStoreService } from "../plugins/store.js";
import { discoverPlugins, discoverAppPlugins, runPluginHook, runPluginHookOutcome, runPluginRoute, runPluginTool, readPluginExport, syncSchedules, stopSchedules, invalidatePluginCache, collectSiblingTools, collectSiblingLlmHooks, mergeToolBridges, type LoadedPlugin, type PluginRuntimeDeps, type PluginToolBridge } from "../plugins/runtime.js";
import { McpRegistry, WEB_SEARCH_PRESET, readStdioApprovals, stdioFingerprint, writeStdioApproval, type CredentialMap, type McpServerConfig } from "../mcp/registry.js";
import { listApps, readApp, createAppSkeleton, renameAppDir, appTree, validateAppManifest, hashAppTree, type AppInfo } from "../apps/manager.js";
import { UPDATE_STRATEGIES, applyWrites, restoreWrites, forgetInstall, mergeTrees, moveInstall, readBaseline, readCodeTree, readInstallSource, readPendingUpgrade, recoverBaseline, satisfiesRange, seedDataTemplates, writeBaseline, writeInstallSource, writePendingUpgrade, type InstallSource } from "../apps/update.js";
import { OFFICIAL_SOURCES, createCatalog, isOfficialSource, normalizeGitUrl } from "../apps/store.js";
import { gitClone, gitRemoteHead, isValidGitRef, isValidGitUrl, remoteManifest, stripVcs } from "../apps/git.js";
import { BACKUP_MAX_BYTES, BACKUP_META_DIR, BackupError, buildBackup, extractBackup, locateBackup, type BackupMeta } from "../apps/backup.js";
import { bootstrapUserDir } from "../paths.js";
import type { UserService, UserRecord } from "../users.js";
import type { SessionService } from "../sessions.js";
import type { InstanceConfig } from "../config.js";
import { ENGINE_REPOSITORY, ENGINE_VERSION, resourcesDir } from "../install.js";
import type { ServerSettings } from "./settings.js";
import { latestRelease } from "../updates.js";
import { SELF_UPDATE, startUpdate, updateState } from "../self-update.js";
import { userPaths, safeResolve, type UserPaths } from "../paths.js";
import * as git from "../git.js";
import { UserModelService, ModelNotConfiguredError, type ModelPricing } from "../models.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import type { AuthPrompt, Credential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { curatedProviders, loadCustomProviders, reservedProviderIds } from "../providers/custom.js";
import { UserAgent, listSessions, renameSession, archiveSession, sessionDir, isReasoningLevel, type ReasoningLevel } from "../agent/agent.js";
import { listConnections, createConnection, updateConnection, deleteConnection, validateConnectionInput, validatePromptFormatInput, readConnections, connectionKeyUsable, type ConnectionInfo } from "../connections.js";
import { PROMPT_FORMATS, type PromptFormat } from "../providers/prompt-formats.js";
import {
  EDGE_FORMATS, EDGE_VOICES, createSpeechEndpoint, deleteSpeechEndpoint, edgeSpeakFmt,
  endpointSpeak, listSpeechEndpoints, speechEndpointKey, updateSpeechEndpoint, validateSpeechEndpointInput,
} from "../speech.js";
import type { EdgeFormat } from "../speech.js";
import * as assets from "../assets/store.js";
import { createSandbox, type SandboxRunner } from "../sandbox/index.js";
import { sandboxConfigOf } from "../config.js";
import { BrowserSandbox } from "../sandbox/browser.js";
import { sandboxAsset, sandboxFrameCsp, sandboxVersion, wasmshAsset } from "../sandbox/assets.js";
import { workspaceFs, type FsOp as WorkspaceFsOp } from "../sandbox/workspace.js";
import { initNetTokens, issueNetToken, netTokenUser, proxySandboxRequest, readSandboxEpoch, readSandboxSettings, writeSandboxSettings } from "../sandbox/network.js";
import { log } from "../logger.js";
import type { EventBus } from "./ws.js";
import { ensureLookWatcher } from "./look-watch.js";
import { assertPublicHost } from "../net-guard.js";
import { installApp, hasPackages, packagesBusy } from "../apps/packages.js";
import { appFsOps, checkOutput, leaseHolder, MAX_BATCH_OPS, readBuildStatus, readDevMeta, sourceRev, takeLease, writeClientErrors, writeClientLogs, writeOutput } from "../builder/server.js";
import { builderAsset, builderFrameCsp, builderVersion } from "../builder/assets.js";
import type { FsOp } from "../builder/fs.js";

export interface AppEnv {
  /** peerAddress: the connecting peer, injected by the server entry. Proxied
   *  requests (a tunnel or reverse proxy on this machine) connect from
   *  loopback, which is what rate-limit bucketing keys off. */
  Bindings: { peerAddress?: string };
  /** bridgeApp: set when the shell's app bridge relayed the request for an
   *  app frame (see appBridgeAllows). */
  Variables: { user: UserRecord; paths: UserPaths; models: UserModelService; bridgeApp: { id: string; trusted: boolean } };
}

export interface AppDeps {
  users: UserService;
  sessions: SessionService;
  config: InstanceConfig;
  dataDir: string;
  bus: EventBus;
  /** Agent shell sandbox (constructed from config when absent). */
  sandbox?: SandboxRunner;
  /** Random id for this run, echoed by /v1/health so a lock file can be
   *  matched to the engine that wrote it. */
  instance?: string;
  /** First run: the token that lets one visitor create the admin account.
   *  null once any account exists. */
  setupToken?: string | null;
  /** Reading and changing server settings (Settings > Server). */
  settings?: ServerSettings;
  /** Repository owners whose apps are official (tests point this at a
   *  local server). */
  officialSources?: readonly string[];
  /** How the Store list is fetched (tests substitute a stub). */
  storeFetch?: typeof fetch;
  /** Stop serving and run the newly installed program in this one's place. */
  restart?: () => Promise<void>;
}

const SESSION_COOKIE = "chrysalis_session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

/** CSP connect-src for pages that only ever need this engine: self, plus the
 *  same host's websocket endpoints (look_changed, live updates). A bare `ws:`
 *  would let any script on the page open a socket to any host. */
export function pageConnectSrc(host: string | undefined): string {
  const safe = host && (/^[A-Za-z0-9.-]+(:\d+)?$/.test(host) || /^\[[0-9a-fA-F:]+\](:\d+)?$/.test(host)) ? host : null;
  return safe ? `'self' ws://${safe} wss://${safe}` : "'self'";
}

/** Blocks WebRTC in a sandboxed frame. WebRTC does not go through fetch, so
 *  connect-src cannot cover it, and the CSP `webrtc` directive that would
 *  is implemented nowhere. Chromium's Connection-Allowlist blocks WebRTC by
 *  default once the header is present (enforced from Chrome 152).
 *  `response-origin` is the only connection the frame needs: its engine API
 *  calls ride the bridge, not the network. */
const FRAME_CONNECTION_ALLOWLIST = "(response-origin); webrtc=block";

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function sha256(s: string): string {
  return nodeCrypto.createHash("sha256").update(s).digest("hex");
}

/** Route-scoped error with an HTTP status (compact helper throws these). */
class HttpError extends Error {
  constructor(readonly status: 400 | 404 | 500 | 503, message: string) {
    super(message);
  }
}

/** Arm the per-user look watcher for an apps dir. Called wherever an app
 *  page is served. A change to what a build reads becomes build_needed: the
 *  shell's builder (src/builder, in the browser) picks it up and the open
 *  app updates in place. The engine itself never builds. */
export const armLookWatch = (username: string, appsDir: string, bus: EventBus): void => {
  ensureLookWatcher(username, appsDir, bus, {
    onBuild: (appId, paths) => bus.emit(username, "build_needed", { app: appId, paths }),
  });
};

/** Engine routes under /v1/apps/<id>/ that manage the app rather than
 *  being its API. */
const APP_MANAGEMENT_HEADS = new Set(["tree", "plugins", "rev", "updates", "update", "install", "dev", "build", "activate", "rename", "export", "exports"]);

/** Providers whose sign-in asks more than a single key (project/location/ADC
 *  file, AWS profile, Cloudflare account ids); the settings panel runs the
 *  whole guided flow. Providers that only need a key stay in the plain list. */
const GUIDED_SIGNINS = new Set(["google-vertex", "amazon-bedrock", "cloudflare-workers-ai", "cloudflare-ai-gateway"]);

/** Content-named build output (esbuild/asset hashes, dev snapshots): the bytes
 *  behind one of these names never change, so it caches forever. */
const IMMUTABLE_NAME = /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/;

/** What a request relayed for an app frame may reach — the engine's copy of
 *  the bridge's allowedRequest (test/malicious-plugin.test.ts keeps the two
 *  in step). `path` is the router's decoded path. */
export function appBridgeAllows(appId: string, method: string, path: string, trusted: boolean): boolean {
  const own = `/v1/apps/${appId}/`;
  if (path.startsWith(own)) {
    const segments = path.slice(own.length).split("/").filter(Boolean);
    const head = segments[0] ?? "";
    // Management is blocked by its exact shape, plus the two whole subtrees
    // (plugins/, build/). An app route that merely shares a first segment —
    // /export/backup — is the app's own API, not the engine's.
    const subtree = head === "plugins" || head === "build";
    if (APP_MANAGEMENT_HEADS.has(head) && (subtree || segments.length === 1)) return false;
    if (head === "mcp" && method !== "GET" && !trusted) return false;
    return true;
  }
  if (method === "GET") {
    if (path === "/v1/models" || path.startsWith("/v1/models/")) return true;
    if (["/v1/images/models", "/v1/embeddings/config", "/v1/audio/voices", "/v1/audio/speech/endpoints", "/v1/settings/connections", "/v1/settings/providers", "/v1/plugins"].includes(path)) return true;
    if (path === "/v1/assets" || path.startsWith("/v1/assets/")) return true;
  }
  // Paid generation (images, speech) is open to every app and deliberately
  // unmetered per app: the user installed the app and the call rides their
  // own provider connection, so there is no engine-side budget to enforce.
  if (method === "POST" && (path === "/v1/images" || path === "/v1/audio/speech")) return true;
  if (method === "PUT" && (path === "/v1/assets" || path.startsWith("/v1/assets/"))) return true;
  if (trusted) {
    if (method === "PUT" && (path === "/v1/models/context" || path === "/v1/models/pricing" || path === "/v1/embeddings/config")) return true;
    if (method === "POST" && path === "/v1/embeddings/probe") return true;
  }
  return false;
}

export function buildApp(deps: AppDeps): Hono<AppEnv> {
  const { users, sessions, config, dataDir, bus } = deps;
  initNetTokens(dataDir);
  const sandbox = deps.sandbox ?? createSandbox(sandboxConfigOf(config), bus);
  const officialSources = deps.officialSources ?? OFFICIAL_SOURCES;
  /** Official = this engine installed the app from a maintainers' repository.
   *  Read from the install record outside the workspace: a manifest can say
   *  anything, since the agent, the app and a non-admin shell can all write it. */
  const officialApp = (p: UserPaths, app: AppInfo): boolean => {
    const source = readInstallSource(p.appUpstream, app.id);
    return !!source && !source.restored && isOfficialSource(source.git, officialSources);
  };
  let setupToken = deps.setupToken ?? null;
  const app = new Hono<AppEnv>();

  // ---------- request guards: host + origin ----------
  // Rebinding protection: a public domain re-resolved to 127.0.0.1 (or a LAN
  // address) would let a remote page drive the engine on the user's session
  // cookie. Rebinding always arrives with the attacker's domain as the Host,
  // so only host NAMES are checked: localhost, this machine's hostname, and
  // the names the admin allowed in config.yaml (read live, so a change in
  // Settings applies at once). An IP address as the Host cannot come from
  // rebinding and always passes, which is what a phone on the LAN, a
  // container's published port or a VPN address needs.
  const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)$/i;
  const machineName = (() => {
    try {
      return os.hostname().toLowerCase();
    } catch {
      return "";
    }
  })();
  const hostAllowed = (hostName: string): boolean =>
    hostName === "" || hostName === "localhost" || hostName === machineName || IP_LITERAL.test(hostName) || config.allowedHosts.includes(hostName);
  // CSRF guard for cookie sessions: browsers always send Origin on
  // cross-origin writes; same-origin pages match the request Host, and
  // non-browser bearer clients send no Origin at all — anything else is a
  // cross-site attempt to spend the session cookie.
  const requestGuard = async (c: Context, next: Next) => {
    let host = (c.req.header("host") ?? "").trim().toLowerCase();
    if (!host) {
      // some test/transports hide the Host header — the request URL carries it
      try { host = new URL(c.req.url).host.toLowerCase(); } catch { /* leave empty: allowed */ }
    }
    const hostName = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!hostAllowed(hostName)) {
      return c.json({ error: `the name ${hostName} is not allowed. Add it to allowedHosts in config.yaml.` }, 403);
    }
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const origin = c.req.header("origin");
      if (origin && origin !== "null") {
        try {
          const originHost = new URL(origin).host.toLowerCase();
          if (originHost && originHost !== host) return c.json({ error: "cross-origin write refused" }, 403);
        } catch { /* malformed origin: the auth layer sorts it out */ }
      }
    }
    return next();
  };
  app.use("*", requestGuard);
  // The socket accepts a body as large as an app backup. Everywhere else the
  // limit stays where it was, so a request no route needs that much for
  // (sign-in included) cannot make the engine hold one. A declared length is
  // refused up front; a chunked body is counted as it is read, never buffered
  // here, so a request that is refused later costs nothing.
  const EVERYDAY_BODY_BYTES = 128 * 1024 * 1024;
  app.use("*", async (c, next) => {
    const body = c.req.raw.body;
    if (!body || (c.req.method === "POST" && c.req.path === "/v1/apps/import")) return next();
    const declared = c.req.header("content-length");
    if (declared !== undefined && !c.req.header("transfer-encoding")) {
      return Number(declared) > EVERYDAY_BODY_BYTES ? c.json({ error: "request body too large" }, 413) : next();
    }
    let read = 0;
    const counted = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          read += chunk.byteLength;
          if (read > EVERYDAY_BODY_BYTES) controller.error(new Error("request body too large"));
          else controller.enqueue(chunk);
        },
      }),
    );
    c.req.raw = new Request(c.req.raw, { body: counted, duplex: "half" } as RequestInit);
    return next();
  });
  // Every response was going out uncompressed: the roleplay app's boot payload
  // alone is over a megabyte of JSON, and the built bundles are megabytes more
  // — all of it re-fetched over the LAN by every phone that opens the app.
  // The middleware skips anything already compressed (images, zips, audio) by
  // content type, and small bodies by size.
  app.use("*", compress());


  const modelServices = new Map<string, UserModelService>();
  const getModels = (u: UserRecord): UserModelService => {
    let svc = modelServices.get(u.username);
    if (!svc) {
      svc = new UserModelService(u.username, userPaths(dataDir, u.username), config);
      modelServices.set(u.username, svc);
    }
    return svc;
  };

  /** Plugin tools from the ACTIVE app (SPEC-v2 §3) for llm calls. */
  const collectAppTools = async (u: UserRecord): Promise<{ tools: import("@earendil-works/pi-ai").Tool[]; byName: Map<string, { plugin: ReturnType<typeof discoverAppPlugins>[number]; deps: PluginRuntimeDeps }> }> => {
    const p = userPaths(dataDir, u.username);
    const appId = readActiveApp(p);
    const byName = new Map();
    const tools: import("@earendil-works/pi-ai").Tool[] = [];
    if (!appId) return { tools, byName };
    const deps = getPluginDeps(u);
    for (const plugin of enabledAppPlugins(p.apps, appId, p.settings)) {
      const exported = await readPluginExport(plugin, "TOOLS");
      if (!Array.isArray(exported)) continue;
      for (const t of exported as { name?: unknown; description?: unknown; parameters?: unknown }[]) {
        if (typeof t?.name !== "string" || !t.name) continue;
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          parameters: (isValidToolSchema(t.parameters) ? t.parameters : { type: "object", properties: {} }) as never,
        });
        byName.set(t.name, { plugin, deps });
      }
    }
    return { tools, byName };
  };
  function isValidToolSchema(s: unknown): boolean {
    return !!s && typeof s === "object" && (s as { type?: unknown }).type === "object";
  }

  // ---------- MCP registries per user ----------
  const mcpRegistries = new Map<string, McpRegistry>();
  /** Stdio approvals live beside the user's credentials, outside the
   *  workspace (see stdioFingerprint). */
  const stdioApprovalsFile = (p: UserPaths): string => path.join(path.dirname(p.auth), "mcp-approved.json");

  /** A new account's workspace: directory shape and git. Apps come from the
   *  welcome screen or the Store. */
  const provisionAccount = async (username: string): Promise<UserPaths> => {
    const p = bootstrapUserDir(dataDir, username);
    // a fresh account starts with no approved stdio servers (and so never
    // takes part in the one-time boot adoption of existing ones)
    writeStdioApproval(stdioApprovalsFile(p), "", null);
    await git.initRepo(p.root);
    return p;
  };
  const getMcp = (u: UserRecord): McpRegistry => {
    let r = mcpRegistries.get(u.username);
    if (!r) {
      const p = userPaths(dataDir, u.username);
      // @credential:<id> env refs resolve against the user's credential store,
      // so mcp.json holds no secrets even though it now sits beside them
      const credGet = (): CredentialMap => readAuth(p);
      r = new McpRegistry(p.mcp, credGet, (id, connected) => {
        // agent tools snapshot at agent creation — a server connecting LATER
        // (npx spawns are slow) must refresh that snapshot or the agent keeps
        // running without tools it now has
        log.info(`[mcp:${id}] ${connected ? "connected" : "dropped"} — refreshing agent tools`);
        evictAgents(u.username);
      }, (id, cfg) => {
        // role is read live: an account demoted from admin stops spawning
        const role = users.get(u.username)?.role;
        return role === "admin" && readStdioApprovals(stdioApprovalsFile(p))[id] === stdioFingerprint(cfg);
      });
      mcpRegistries.set(u.username, r);
      // connections are lazy; warm them so status is accurate right after boot
      void r.listTools().catch(() => undefined);
    }
    return r;
  };

  // ---------- plugin services per user (store + runtime deps + schedules) ----------
  const pluginStores = new Map<string, PluginStoreService>();
  const getPluginDeps = (u: UserRecord): PluginRuntimeDeps => {
    let store = pluginStores.get(u.username);
    if (!store) {
      store = new PluginStoreService(userPaths(dataDir, u.username).store);
      pluginStores.set(u.username, store);
    }
    const p = userPaths(dataDir, u.username);
    const grantsFor = (pluginId: string): string[] => {
      try {
        const s = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { pluginGrants?: Record<string, string[]> };
        return s.pluginGrants?.[pluginId] ?? [];
      } catch {
        return [];
      }
    };
    return { store, models: getModels(u), grantsFor };
  };
  /** App-route deps with a live-delta sink: plugin llm requests tagged with
   *  `stream:{chatId, name}` stream their text deltas to the user's sockets
   *  as `app_stream` events — the app UI renders a growing bubble. */
  /** Abort controllers for in-flight app llm generations, keyed
   *  username|appId|chatId. The stream descriptor riding each plugin llm
   *  request identifies the chat; cancelling aborts the provider stream and
   *  the kernel salvages whatever partial text exists. A finished entry
   *  lingers harmlessly; the next generation on the chat replaces it (an
   *  already-aborted controller must never leak into a fresh generation). */
  const genAborts = new Map<string, AbortController>();
  /** Chats whose in-flight generation was cancelled: the completion (salvaged
   *  or not) is discarded — the client owns what a cancelled reply keeps and
   *  commits it itself through the cancelled route. */
  const cancelledGens = new Set<string>();

  const getAppDeps = (u: UserRecord, appId: string): PluginRuntimeDeps => {
    const base = getPluginDeps(u);
    const abortKey = (tag: unknown): string | null => {
      const t = tag as { chatId?: string };
      return t && typeof t === "object" && t.chatId ? `${u.username}|${appId}|${t.chatId}` : null;
    };
    return {
      ...base,
      abortCtlFor: (tag) => {
        const key = abortKey(tag);
        if (!key) return null;
        // a fresh generation on this chat invalidates any stale cancel flag
        cancelledGens.delete(key);
        let ctl = genAborts.get(key);
        if (!ctl || ctl.signal.aborted) {
          ctl = new AbortController();
          genAborts.set(key, ctl);
        }
        return ctl.signal;
      },
      consumeCancel: (tag) => {
        const key = abortKey(tag);
        return key ? cancelledGens.delete(key) : false;
      },
      onLlmDelta: (tag, delta) => {
        const t = tag as { chatId?: string; name?: string };
        if (!t || typeof t !== "object") return;
        bus.emit(u.username, "app_stream", { app: appId, chatId: t.chatId, name: t.name, delta });
      },
      onLlmThinking: (tag, delta) => {
        const t = tag as { chatId?: string; name?: string };
        if (!t || typeof t !== "object") return;
        bus.emit(u.username, "app_stream", { app: appId, chatId: t.chatId, name: t.name, thinking: delta });
      },
      // tool-call progress rides the same stream so the UI can interleave
      // activity rows between text segments while the reply is still streaming
      onLlmTool: (tag, ev) => {
        const t = tag as { chatId?: string; name?: string };
        if (!t || typeof t !== "object") return;
        bus.emit(u.username, "app_stream", { app: appId, chatId: t.chatId, name: t.name, tool: ev });
      },
      // sibling tool contribution: a plugin's llm request marked wantsTools
      // picks up every other app plugin's appTools() export (the dedicated
      // tools plugin pattern — remove that plugin and tool calling is gone)
      siblingTools: async (self) => mergeToolBridges(
        await collectSiblingTools(enabledAppPlugins(userPaths(dataDir, u.username).apps, appId, userPaths(dataDir, u.username).settings), self, base),
        await appMcpTools(u, appId),
      ),
      // sibling request patching: an app plugin's llmRequest hook may patch
      // this plugin's model requests (permissions: hooks + llm)
      llmHooks: (self) => collectSiblingLlmHooks(enabledAppPlugins(userPaths(dataDir, u.username).apps, appId, userPaths(dataDir, u.username).settings), self, base),
    };
  };
  /** The MCP tools one app's generations may call: the engine servers that
   *  app has switched on for itself. Only those tools can run, whatever name
   *  the model sends. */
  const appMcpTools = async (u: UserRecord, appId: string): Promise<PluginToolBridge | null> => {
    const mcp = getMcp(u);
    const opted = new Set(appMcpOptIns(u.username, appId));
    const servers = mcp.sharedServers().filter((id) => opted.has(id));
    if (!servers.length) return null;
    const tools = await mcp.toPiTools(servers).catch(() => []);
    if (!tools.length) return null;
    const names = new Set(tools.map((t) => t.name));
    return {
      tools,
      executeTool: async (name, args) => {
        if (!names.has(name)) return { text: `tool not available: ${name}`, isError: true };
        const r = await mcp.callTool(name, args, servers);
        return { text: r.text, isError: !r.ok };
      },
    };
  };
  /** Timers belong to the account's workspace root, which is unique across
   *  engines sharing a process (tests) and follows a rename. */
  const scheduleOwner = (username: string): string => userPaths(dataDir, username).root;
  /** Every plugin a user's timers may come from: their own plugins and the
   *  enabled plugins of every installed app, whichever app is on screen. */
  const schedulablePlugins = (username: string): LoadedPlugin[] => {
    const p = userPaths(dataDir, username);
    const disabled = disabledAppPlugins(p.settings);
    const bundled = listApps(p.apps).flatMap((a) => discoverAppPlugins(p.apps, a.id));
    return [...discoverPlugins(p.plugins), ...bundled].filter((pl) => !disabled.has(pl.id));
  };
  /** How often a signed-in request re-checks timers, so a plugin the agent
   *  writes, an app install or a changed interval starts ticking without a
   *  restart. Explicit changes (enable, disable, approve) sync at once. */
  const SCHEDULE_SYNC_MS = 10_000;
  const scheduleSyncedAt = new Map<string, number>();
  const syncUserSchedules = (u: UserRecord): void => {
    scheduleSyncedAt.set(u.username, Date.now());
    syncSchedules(scheduleOwner(u.username), () => schedulablePlugins(u.username), getPluginDeps(u), (plugin, payload) =>
      bus.emit(u.username, "plugin_event", { ...(plugin.appId ? { app: plugin.appId } : {}), plugin: plugin.id, payload }),
    );
  };
  const stopUserSchedules = (username: string): void => {
    scheduleSyncedAt.delete(username);
    stopSchedules(scheduleOwner(username));
  };

  /** Active app id (SPEC-v2 §3). */
  const readActiveApp = (p: ReturnType<typeof userPaths>): string | null => {
    try {
      const s = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { activeApp?: string | null };
      return s.activeApp ?? null;
    } catch {
      return null;
    }
  };
  const readSetting = <T>(username: string, key: string, fallback: T): T => {
    try {
      const s = JSON.parse(fs.readFileSync(userPaths(dataDir, username).settings, "utf8")) as Record<string, unknown>;
      return key in s ? (s[key] as T) : fallback;
    } catch {
      return fallback;
    }
  };

  /** App plugins the user switched OFF (namespaced ids, settings.json —
   *  engine-owned state, so app data and app updates never touch it). A
   *  disabled plugin is not executed at all: no routes, no tools, no hooks,
   *  no panels, no network-host contributions. */
  const disabledAppPlugins = (settingsPath: string): Set<string> => {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { disabledPlugins?: unknown };
      return new Set(Array.isArray(s.disabledPlugins) ? s.disabledPlugins.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  };
  /** User-approved permission grants per plugin id. Declaring a permission in
   *  an imported plugin's manifest is a request, not a grant; execution paths
   *  outside the sandbox (the image-host union) must read this too. */
  const pluginGrants = (settingsPath: string): Record<string, string[]> => {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { pluginGrants?: Record<string, unknown> };
      const out: Record<string, string[]> = {};
      for (const [id, caps] of Object.entries(s.pluginGrants ?? {})) {
        if (Array.isArray(caps)) out[id] = caps.filter((x): x is string => typeof x === "string");
      }
      return out;
    } catch {
      return {};
    }
  };
  /** Mirrors the plugin runtime's cap check: imported plugins need a grant. */
  const pluginGranted = (
    plugin: { id: string; manifest: { origin?: string; permissions: readonly string[] } },
    cap: string,
    grants: Record<string, string[]>,
  ): boolean => {
    if (!plugin.manifest.permissions.includes(cap)) return false;
    if (plugin.manifest.origin !== "imported") return true;
    return (grants[plugin.id] ?? []).includes(cap);
  };
  /** The ONLY plugin list execution paths may iterate (dispatch, sibling
   *  tools, agent tools, panels, image-host allowlists, schedules). */
  const enabledAppPlugins = (appsDir: string, appId: string, settingsPath: string) => {
    const disabled = disabledAppPlugins(settingsPath);
    return discoverAppPlugins(appsDir, appId).filter((pl) => !disabled.has(pl.id));
  };

  const agentInstances = new Map<string, UserAgent>();
  /** username:sessionId -> currently running agent (steering target). */
  const activeRuns = new Map<string, UserAgent>();
  const evictAgents = (username: string) => {
    for (const key of agentInstances.keys()) if (key.startsWith(`${username}:`)) agentInstances.delete(key);
  };
  const getAgent = async (
    u: UserRecord,
    sessionId?: string,
    model?: string,
    reasoning?: ReasoningLevel,
    mode: "normal" | "accept" | "plan" = "normal",
  ): Promise<UserAgent> => {
    const key = sessionId ? `${u.username}:${sessionId}:${model ?? ""}:${reasoning ?? ""}:${mode}` : undefined;
    let a = key ? agentInstances.get(key) : undefined;
    if (!a) {
      let resolvedSessionId = sessionId;
      a = await UserAgent.create(u.username, getModels(u), userPaths(dataDir, u.username), users, config, {
        ...(sessionId ? { sessionId } : {}),
        notify: (type, payload) => bus.emit(u.username, type, payload),
        mcp: getMcp(u),
        ...(deps.settings && u.role === "admin" ? { settings: deps.settings } : {}),
        ...(u.role === "admin" ? { provisionAccount } : {}),
        ...(sandbox.enabled ? { sandbox } : {}),
        ...(model ? { model } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(mode !== "normal" ? { mode } : {}),
        ask: (q) =>
          new Promise<string>((resolve) => {
            const id = nodeCrypto.randomUUID();
            const askSessionId = resolvedSessionId;
            if (!askSessionId) {
              resolve("(question could not be delivered)");
              return;
            }
            pendingQuestions.set(id, { resolve, sessionId: askSessionId, username: u.username });
            bus.emit(u.username, "agent_event", {
              sessionId: askSessionId,
              ev: { type: "ask_user", id, question: q.question, ...(q.options?.length ? { options: q.options } : {}), ...(q.detail ? { detail: q.detail } : {}) },
            });
            setTimeout(() => {
              if (pendingQuestions.delete(id)) resolve("(no answer — timed out)");
            }, 10 * 60_000).unref();
          }),
      });
      resolvedSessionId = a.sessionId;
      if (key) agentInstances.set(key, a);
    }
    return a;
  };

  // pending ask_user questions: id → resolver (answered via /v1/agent/answer)
  const pendingQuestions = new Map<string, { resolve: (answer: string) => void; sessionId: string; username: string }>();

  // ---------- health (no auth) ----------
  app.get("/v1/health", (c) => c.json({ ok: true, version: ENGINE_VERSION, ...(deps.instance ? { instance: deps.instance } : {}) }));

  // ---------- kernel chrome client (v2 shell, SPEC-v2 §12.7) ----------
  const clientDir = path.join(resourcesDir(), "client", "dist");
  const extMimes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".json": "application/json",
  };
  const serveClientFile = (rel: string, c: Context<AppEnv>) => {
    const full = path.resolve(clientDir, rel);
    if (full !== path.resolve(clientDir) && !full.startsWith(path.resolve(clientDir) + path.sep)) return c.body("bad path", 400);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return c.body("not found", 404);
    const mime = extMimes[path.extname(full)] ?? "application/octet-stream";
    c.header("content-security-policy", `default-src 'self'; connect-src ${pageConnectSrc(c.req.header("host"))}; img-src 'self' blob: data:; media-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; frame-ancestors 'none'`);
    // the bundle, its CSS and every font are content-named, so they cache
    // forever; index.html and the unhashed public/ files revalidate. Serving
    // the whole tree no-store re-downloaded the entire client on every load.
    c.header("cache-control", IMMUTABLE_NAME.test(full) ? "public, max-age=31536000, immutable" : "no-store");
    // binary-safe: utf8 decoding would corrupt pngs/woff2
    return c.body(new Uint8Array(fs.readFileSync(full)), 200, { "content-type": mime });
  };
  app.get("/", (c) => serveClientFile("index.html", c));
  // the in-browser builder's code (src/builder/browser), bundled on demand
  app.get("/client/builder/:file", async (c) => {
    const name = c.req.param("file");
    const asset = await builderAsset(name).catch((e: unknown) => {
      log.error(`[builder] bundling failed: ${(e as Error).message}`);
      return null;
    });
    if (!asset) return c.body("not found", 404);
    const versioned = c.req.query("v") === (await builderVersion());
    const headers: Record<string, string> = {
      "content-type": asset.type,
      "x-content-type-options": "nosniff",
      "cache-control": versioned ? "public, max-age=31536000, immutable" : "no-cache",
      vary: "accept-encoding",
    };
    if (name === "frame.html") {
      headers["content-security-policy"] = builderFrameCsp(frameOriginOf(c));
      headers["connection-allowlist"] = FRAME_CONNECTION_ALLOWLIST;
    }
    // runtime.js runs in cookieless app frames
    if (name === "runtime.js") headers["cross-origin-resource-policy"] = "cross-origin";
    if (asset.gz && /\bgzip\b/.test(c.req.header("accept-encoding") ?? "")) {
      headers["content-encoding"] = "gzip";
      return c.body(new Uint8Array(asset.gz), 200, headers);
    }
    return c.body(new Uint8Array(asset.body), 200, headers);
  });
  // the browser sandbox's code (src/sandbox/browser) and the wasmsh runtime
  // under a version-scoped path. The sandbox frame is opaque-origin, so its
  // fetches are cross-origin and credentialless: everything here answers with
  // CORS open, and serves only these files.
  app.get("/client/sandbox/wasmsh/*", async (c) => {
    const rest = c.req.path.slice("/client/sandbox/wasmsh/".length);
    const slash = rest.indexOf("/");
    const ver = slash === -1 ? rest : rest.slice(0, slash);
    if (ver !== (await sandboxVersion())) return c.body("not found", 404);
    const asset = wasmshAsset(slash === -1 ? "" : rest.slice(slash + 1));
    if (!asset) return c.body("not found", 404);
    return c.body(new Uint8Array(asset.body), 200, {
      "content-type": asset.type,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=604800, immutable",
    });
  });
  app.get("/client/sandbox/:file", async (c) => {
    const name = c.req.param("file");
    const asset = await sandboxAsset(name).catch((e: unknown) => {
      log.error(`[sandbox] bundling failed: ${(e as Error).message}`);
      return null;
    });
    if (!asset) return c.body("not found", 404);
    const headers: Record<string, string> = {
      "content-type": asset.type,
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
      "cache-control": c.req.query("v") === (await sandboxVersion()) ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (name === "frame.html") {
      headers["content-security-policy"] = sandboxFrameCsp(frameOriginOf(c));
      headers["connection-allowlist"] = FRAME_CONNECTION_ALLOWLIST;
      headers["cache-control"] = "no-store";
    }
    return c.body(new Uint8Array(asset.body), 200, headers);
  });
  app.get("/client/*", (c) => serveClientFile(c.req.path.slice("/client/".length), c));

  // ---------- agent chat UI (client-agent/dist, framed by the launcher tab) ----------
  // same serving rules as the client, except it MAY be framed by this origin
  // (the launcher embeds it as the Agent tab); frame-ancestors 'self'
  const agentDir = path.join(resourcesDir(), "client-agent", "dist");
  const serveAgentFile = (rel: string, c: Context<AppEnv>) => {
    const full = path.resolve(agentDir, rel);
    if (full !== path.resolve(agentDir) && !full.startsWith(path.resolve(agentDir) + path.sep)) return c.body("bad path", 400);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return c.body("not found", 404);
    const mime = extMimes[path.extname(full)] ?? "application/octet-stream";
    c.header("content-security-policy", `default-src 'self'; connect-src ${pageConnectSrc(c.req.header("host"))}; img-src 'self' blob: data:; media-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; frame-ancestors 'self'`);
    c.header("cache-control", "no-store");
    return c.body(new Uint8Array(fs.readFileSync(full)), 200, { "content-type": mime });
  };
  app.get("/agent", (c) => serveAgentFile("index.html", c));
  app.get("/agent/*", (c) => serveAgentFile(c.req.path.slice("/agent/".length) || "index.html", c));
  /** Stream-read a request body with a hard byte cap (checked BEFORE
   * buffering — a chunked 10GB body must never reach `await text()`).
   * Content-length is prechecked; chunked streams are cut off mid-flight. */
  const readCappedBody = async (c: { req: { header: (k: string) => string | undefined; raw: { body: ReadableStream<Uint8Array> | null } } }, capBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> => {
    const cl = c.req.header("content-length");
    const mb = `${Math.round(capBytes / 1024 / 1024)}MB`;
    if (cl && (Number(cl) > capBytes || !Number.isFinite(Number(cl)))) return { ok: false, error: `body too large (${mb} cap)` };
    const body = c.req.raw.body;
    if (!body) return { ok: true, bytes: new Uint8Array(0) };
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > capBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return { ok: false, error: `body too large (${mb} cap)` };
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const ch of chunks) { merged.set(ch, off); off += ch.byteLength; }
    return { ok: true, bytes: merged };
  };

  // ---------- agent sandbox internet (before auth: the frame has no session) ----------
  // The sandbox frame is opaque-origin and cookieless; it authenticates with
  // the capability token its host page fetched, and every request is made
  // engine-side behind the local network guard.
  app.options("/v1/sandbox/net", () =>
    new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "*",
        "access-control-max-age": "600",
      },
    }),
  );
  app.post("/v1/sandbox/net", async (c) => {
    const cors = { "access-control-allow-origin": "*" };
    const auth = netTokenUser(c.req.header("x-sandbox-token"));
    const user = auth ? users.get(auth.username) : undefined;
    // a token from before internet was switched off carries an older epoch
    if (!auth || !user || user.enabled === false || auth.epoch !== readSandboxEpoch(userPaths(dataDir, auth.username).sandbox)) {
      return c.body("sandbox network: not signed in\n", 401, cors);
    }
    if (!readSandboxSettings(userPaths(dataDir, auth.username).sandbox).internet) {
      return c.body("sandbox network: internet access is off (Settings, Agent)\n", 403, cors);
    }
    const capped = await readCappedBody(c, 16 * 1024 * 1024);
    if (!capped.ok) return c.body(`sandbox network: ${capped.error}\n`, 413, cors);
    let headers: [string, string][] = [];
    try {
      const raw = JSON.parse(decodeURIComponent(c.req.header("x-sandbox-headers") ?? "[]")) as unknown;
      if (Array.isArray(raw)) headers = raw.filter((h): h is [string, string] => Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string");
    } catch { /* no forwarded headers */ }
    return proxySandboxRequest({
      url: c.req.header("x-sandbox-url") ?? "",
      method: (c.req.header("x-sandbox-method") ?? "GET").toUpperCase(),
      headers,
      body: capped.bytes,
    });
  });

  // ---------- sign-in (user picker + optional password) ----------
  // These run BEFORE the auth middleware; everything else needs a session
  // cookie or a bearer token.
  const loginFails = new Map<string, { n: number; until: number }>();
  const loginIpFails = new Map<string, { n: number; until: number }>();
  const resetCodes = new Map<string, { hash: string; expiresAt: number; attempts: number }>();
  // reset-code requests are unauthenticated (that's their point) but must not
  // be spammable — each one prints a banner in the server terminal, so an
  // open tunnel would let a stranger flood the log. Cooldown per IP.
  const forgotCooldowns = new Map<string, { n: number; until: number }>();
  const FORGOT_LIMIT = 5;
  const FORGOT_WINDOW = 10 * 60_000;
  // ...and a global cap: proxy headers can be rotated to mint fresh "IPs", so
  // the terminal-log protection must hold no matter what the client sends
  let forgotGlobal = { n: 0, until: 0 };
  const FORGOT_GLOBAL_LIMIT = 30;
  /** shared fail-limiter: usernames lock at 5, IPs lock at 20 (spread attacks
   *  across many names still trip the IP bucket; both clear on success) */
  const bumpFails = (map: Map<string, { n: number; until: number }>, key: string, limit: number) => {
    const f = map.get(key) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= limit) {
      f.until = Date.now() + 30_000;
      f.n = 0;
    }
    map.set(key, f);
  };

  /** True when this request arrived over TLS — directly or via the user's
   *  tunnel/proxy (cloudflared terminates TLS and forwards plain http with
   *  X-Forwarded-Proto: https). Spoofing the header on a direct LAN
   *  connection only breaks the spoofer's own login (their browser drops the
   *  Secure cookie over plain http) — it can't touch anyone else's session. */
  const requestIsHttps = (c: Context): boolean => {
    try {
      if (new URL(c.req.url).protocol === "https:") return true;
    } catch { /* fall through to the proxy header */ }
    return c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  };
  const cookieFlags = (c: Context): string =>
    `Path=/; HttpOnly; SameSite=Lax${requestIsHttps(c) ? "; Secure" : ""}`;
  const sessionCookie = (c: Context, token: string) =>
    c.header("set-cookie", `${SESSION_COOKIE}=${token}; ${cookieFlags(c)}; Max-Age=${SESSION_MAX_AGE}`);
  /** End an account's sessions and live sockets; `keepCurrent` spares the
   *  session this request came in on. */
  const signOutEverywhere = (c: Context, username: string, keepCurrent: boolean) => {
    sessions.destroyUser(username, keepCurrent ? parseCookies(c.req.header("cookie") ?? "")[SESSION_COOKIE] : undefined);
    bus.dropUser(username);
  };

  /** Client IP for rate-limit buckets. cf-connecting-ip is single-valued and
   *  overwritten by the Cloudflare edge (the tunnel's proxy), so it can't be
   *  rotated the way a client-supplied X-Forwarded-For prefix can; XFF
   *  otherwise takes the LAST hop — proxies append the real client IP, so a
   *  forged "X-Forwarded-For: 1.2.3.4" doesn't move the key. */
  const clientIp = (c: Context): string => {
    // proxy headers only mean something when a proxy sent them: a tunnel or
    // reverse proxy on this machine connects from loopback. From any other
    // peer they are whatever the client typed, a fresh bucket per attempt.
    // env is absent when a caller drives app.fetch directly (tests, embedding)
    const peer = (c.env as { peerAddress?: string } | undefined)?.peerAddress;
    const viaLocalProxy = !peer || peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    if (!viaLocalProxy) return peer;
    return (
      c.req.header("cf-connecting-ip")?.trim() ||
      c.req.header("x-forwarded-for")?.split(",").pop()?.trim() ||
      c.req.header("x-real-ip")?.trim() ||
      "local"
    );
  };

  app.get("/v1/auth/users", (c) => c.json({ users: users.publicList(), setup: setupToken !== null && users.list().length === 0 }));

  // first run: whoever holds the setup link creates the admin account. The
  // token was printed where the engine started (and written to its log file),
  // so only the person who started Chrysalis has it.
  app.post("/v1/auth/setup", async (c) => {
    const ip = clientIp(c);
    const ipFail = loginIpFails.get(ip);
    if (ipFail && ipFail.until > Date.now()) return c.json({ error: "Too many attempts, try again shortly" }, 429);
    if (setupToken === null || users.list().length > 0) return c.json({ error: "Chrysalis is already set up. Sign in instead." }, 409);
    const body = await c.req.json<{ token?: string; username?: string; password?: string }>().catch(() => ({}) as { token?: string; username?: string; password?: string });
    const given = Buffer.from(typeof body.token === "string" ? body.token.trim() : "");
    const want = Buffer.from(setupToken);
    if (given.length !== want.length || !nodeCrypto.timingSafeEqual(given, want)) {
      bumpFails(loginIpFails, ip, 20);
      return c.json({ error: "This setup link is not valid. Use the link Chrysalis printed when it started." }, 403);
    }
    let created: UserRecord;
    try {
      created = users.create((body.username ?? "").trim(), "admin", { password: body.password ?? "" }).user;
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    setupToken = null;
    await provisionAccount(created.username);
    log.info(`[setup] created admin account ${created.username}`);
    sessionCookie(c, sessions.create(created.username));
    return c.json({ username: created.username, role: created.role });
  });

  app.post("/v1/auth/login", async (c) => {
    const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({}) as { username?: string; password?: string });
    const username = (body.username ?? "").trim();
    const ip = clientIp(c);
    const fail = loginFails.get(username);
    const ipFail = loginIpFails.get(ip);
    if ((fail && fail.until > Date.now()) || (ipFail && ipFail.until > Date.now())) {
      const wait = Math.max(fail?.until ?? 0, ipFail?.until ?? 0) - Date.now();
      return c.json({ error: `Too many attempts — try again in ${Math.ceil(wait / 1000)}s` }, 429);
    }
    const user = username ? users.get(username) : undefined;
    const bad = () => {
      bumpFails(loginFails, username, 5);
      bumpFails(loginIpFails, ip, 20);
      return c.json({ error: "Incorrect username or password" }, 403);
    };
    if (!user || user.enabled === false) return bad();
    // every account has a password (bootstrap/ensurePasswords mint one);
    // an account somehow left without one can never log in
    if (!users.hasPassword(username) || !users.checkPassword(username, body.password ?? "")) return bad();
    loginFails.delete(username);
    loginIpFails.delete(ip);
    sessionCookie(c, sessions.create(username));
    return c.json({ username: user.username, role: user.role });
  });

  // forgot password → one-time code printed in the SERVER TERMINAL (the
  // machine owner reads it; local recovery, no email)
  app.post("/v1/auth/forgot", async (c) => {
    const ip = clientIp(c);
    const cd = forgotCooldowns.get(ip);
    if ((cd && cd.until > Date.now()) || forgotGlobal.until > Date.now()) {
      const wait = Math.max(cd?.until ?? 0, forgotGlobal.until) - Date.now();
      return c.json({ error: `Too many reset requests — try again in ${Math.ceil(wait / 60_000)} min` }, 429);
    }
    const body = await c.req.json<{ username?: string }>().catch(() => ({}) as { username?: string });
    const username = (body.username ?? "").trim();
    if (username && users.get(username)) {
      const code = nodeCrypto.randomBytes(4).toString("hex");
      resetCodes.set(username, { hash: sha256(code), expiresAt: Date.now() + 10 * 60_000, attempts: 0 });
      log.info("==========================================================");
      log.info(`Password reset code for '${username}' (valid 10 min): ${code}`);
      log.info("==========================================================");
    }
    // count every request (existing user or not) toward BOTH cooldowns; the
    // response stays existence-silent either way
    const f = cd ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= FORGOT_LIMIT) f.until = Date.now() + FORGOT_WINDOW;
    forgotCooldowns.set(ip, f);
    forgotGlobal.n += 1;
    if (forgotGlobal.n >= FORGOT_GLOBAL_LIMIT) forgotGlobal.until = Date.now() + FORGOT_WINDOW;
    return c.json({ ok: true }); // never reveal whether the user exists
  });

  app.post("/v1/auth/reset", async (c) => {
    const body = await c.req.json<{ username?: string; code?: string; password?: string }>().catch(() => ({}) as { username?: string; code?: string; password?: string });
    const username = (body.username ?? "").trim();
    const entry = username ? resetCodes.get(username) : undefined;
    if (!entry) return c.json({ error: "Request a reset code first" }, 400);
    if (entry.expiresAt <= Date.now()) {
      resetCodes.delete(username);
      return c.json({ error: "Code expired — request a new one" }, 400);
    }
    if (++entry.attempts > 5) {
      resetCodes.delete(username);
      return c.json({ error: "Too many attempts — request a new code" }, 429);
    }
    if (typeof body.code !== "string" || sha256(body.code.trim()) !== entry.hash) {
      return c.json({ error: "Incorrect code" }, 403);
    }
    if (typeof body.password !== "string" || body.password.length < 4 || body.password.length > 128) {
      return c.json({ error: "New password must be 4-128 chars" }, 400);
    }
    const user = users.get(username);
    if (!user || user.enabled === false) return c.json({ error: "Account unavailable" }, 403);
    users.setPassword(username, body.password);
    resetCodes.delete(username);
    signOutEverywhere(c, username, false);
    sessionCookie(c, sessions.create(username));
    return c.json({ username, role: user.role });
  });

  // ---------- auth middleware ----------
  const PUBLIC_PATHS = new Set(["/v1/health", "/v1/ws", "/v1/auth/users", "/v1/auth/setup", "/v1/auth/login", "/v1/auth/forgot", "/v1/auth/reset"]);
  /** Sandboxed app frames (opaque origin) send no cookies. Their static
   *  files live under /app/<user>/<id>/ and are public; every byte of data
   *  they show comes back through the shell bridge. */
  const PUBLIC_APP_FRAME = /^\/app\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\//;
  const authMiddleware = async (c: Context<AppEnv>, next: Next) => {
    if (PUBLIC_PATHS.has(c.req.path) || PUBLIC_APP_FRAME.test(c.req.path)) return next();
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    // bucket the unknown-token bcrypt budget per caller, so one peer spraying
    // garbage tokens cannot lock out a genuine headless client
    let user = token ? users.verify(token, clientIp(c)) : null;
    if (!user) {
      const cookie = parseCookies(c.req.header("cookie") ?? "")[SESSION_COOKIE] ?? "";
      const sess = cookie ? sessions.verify(cookie) : null;
      const bySession = sess ? (users.get(sess.username) ?? null) : null;
      user = bySession && bySession.enabled !== false ? bySession : null;
    }
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    c.set("paths", userPaths(dataDir, user.username));
    c.set("models", getModels(user));
    if (Date.now() - (scheduleSyncedAt.get(user.username) ?? 0) > SCHEDULE_SYNC_MS) syncUserSchedules(user);
    await next();
  };
  // app pages + cached packages are user-scoped too (cookies flow in the
  // embedded iframe, the fullscreen tab, and installed-PWA contexts)
  app.use("/v1/*", authMiddleware);
  app.use("/app/*", authMiddleware);

  // ---------- app bridge: second lock ----------
  // The shell's bridge (client/public/app-bridge-host.js) stamps every request
  // it relays for an app frame with x-chrysalis-app; the frame can neither set
  // nor drop it. The same allowlist is enforced here, so a gap in the bridge's
  // copy (it once compared the raw %-encoded path) is not a way in.
  app.use("/v1/*", async (c, next) => {
    const appId = c.req.header("x-chrysalis-app");
    if (appId === undefined) return next();
    const p = c.get("paths") as UserPaths | undefined;
    const info = p ? readApp(p.apps, appId) : null;
    const trusted = !!info && !!p && officialApp(p, info);
    if (!info || !appBridgeAllows(appId, c.req.method.toUpperCase(), c.req.path, trusted)) {
      return c.json({ error: "blocked by the app sandbox" }, 403);
    }
    c.set("bridgeApp", { id: appId, trusted });
    return next();
  });

  const requireAdmin = (c: { get: (k: "user") => UserRecord }) => {
    if (c.get("user").role !== "admin") throw new Error("admin only");
  };

  // ---------- me / models ----------
  app.get("/v1/me", (c) => {
    const u = c.get("user");
    // hasAvatar lets the shell skip the avatar request entirely when there is
    // none — the 404 fallback works but logs a failed request every load
    return c.json({
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      hasPassword: users.hasPassword(u.username),
      hasAvatar: !!users.avatarPath(u.username),
    });
  });

  // change the logged-in user's own password (current one required; there is
  // no passwordless state to go back to, so removal isn't a thing)
  app.put("/v1/auth/password", async (c) => {
    const u = c.get("user");
    const body = await c.req.json<{ current?: string; next?: string }>().catch(() => null) ?? ({} as { current?: string; next?: string });
    if (typeof body.next !== "string" || body.next.length < 4 || body.next.length > 128) {
      return c.json({ error: "new password must be 4-128 chars" }, 400);
    }
    if (users.hasPassword(u.username) && !users.checkPassword(u.username, body.current ?? "")) {
      return c.json({ error: "Current password is incorrect" }, 403);
    }
    users.setPassword(u.username, body.next);
    // every other browser signed in with the old password is signed out
    signOutEverywhere(c, u.username, true);
    return c.json({ ok: true, hasPassword: true });
  });

  app.post("/v1/auth/logout", (c) => {
    const token = parseCookies(c.req.header("cookie") ?? "")[SESSION_COOKIE] ?? "";
    if (token) sessions.destroy(token);
    c.header("set-cookie", `${SESSION_COOKIE}=; ${cookieFlags(c)}; Max-Age=0`);
    return c.json({ ok: true });
  });

  // upload / replace the signed-in user's profile picture (base64 body)
  app.put("/v1/auth/avatar", async (c) => {
    const u = c.get("user");
    const body = await c.req.json<{ data?: string; mimeType?: string }>().catch(() => ({}) as { data?: string; mimeType?: string });
    const ext = typeof body.mimeType === "string" ? AVATAR_MIME[body.mimeType] : undefined;
    if (!ext || typeof body.data !== "string") return c.json({ error: "data (base64) + mimeType (png/jpeg/webp/gif) required" }, 400);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.data, "base64");
    } catch {
      return c.json({ error: "invalid base64" }, 400);
    }
    if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) return c.json({ error: "image must be 1B - 2MB" }, 400);
    users.writeAvatar(u.username, bytes, ext);
    return c.json({ ok: true, url: `/v1/auth/avatar/${encodeURIComponent(u.username)}?v=${Date.now()}` });
  });

  app.delete("/v1/auth/avatar", (c) => {
    users.deleteAvatar(c.get("user").username);
    return c.json({ ok: true });
  });

  // change the signed-in user's username (workspace moves with the account)
  app.post("/v1/auth/rename", async (c) => {
    const u = c.get("user");
    const oldName = u.username; // users.rename MUTATES the record — capture first
    const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null) ?? ({} as { username?: string; password?: string });
    const next = (body.username ?? "").trim();
    if (users.hasPassword(oldName) && !users.checkPassword(oldName, body.password ?? "")) {
      return c.json({ error: "Current password is incorrect" }, 403);
    }
    let record: UserRecord;
    try {
      record = users.rename(oldName, next);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    // move the workspace + every cache keyed by username
    evictAgents(oldName);
    modelServices.delete(oldName);
    mcpRegistries.delete(oldName);
    pluginStores.delete(oldName);
    stopUserSchedules(oldName);
    try {
      const oldDir = userPaths(dataDir, oldName).root;
      const newDir = userPaths(dataDir, record.username).root;
      if (fs.existsSync(oldDir) && oldDir !== newDir) fs.renameSync(oldDir, newDir);
    } catch (e) {
      // roll the account back so users.json matches the directory layout
      users.rename(record.username, oldName);
      return c.json({ error: `workspace move failed: ${(e as Error).message}` }, 500);
    }
    sessions.renameUser(oldName, record.username);
    // seed the new directory shape if anything expected is missing
    bootstrapUserDir(dataDir, record.username);
    log.info(`[users] renamed ${oldName} → ${record.username}`);
    return c.json({ username: record.username });
  });

  // ---------- profile pictures (public — the login screen shows them) ----------
  const AVATAR_MIME: Record<string, "png" | "jpg" | "jpeg" | "webp" | "gif"> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  app.get("/v1/auth/avatar/:username", (c) => {
    const username = c.req.param("username");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(username)) return c.json({ error: "invalid username" }, 400);
    // a face is personal: only the signed-in owner reads their own. The UI
    // never shows anyone else's, so nothing needs the wider read, and the
    // user list is public enough to enumerate names from.
    if (username !== c.get("user").username) return c.json({ error: "not found" }, 404);
    const file = users.avatarPath(username);
    if (!file) return c.json({ error: "no avatar" }, 404);
    const ext = path.extname(file).slice(1);
    const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
    c.header("cache-control", "no-cache");
    return c.body(new Uint8Array(fs.readFileSync(file)), 200, { "content-type": mime });
  });

  // ---------- composer shell mode ("!"): run a command in the user's
  // workspace root and hand the output back to the prompt. Commands run in
  // the same browser sandbox as the agent's bash tool — never on the host.
  app.post("/v1/shell", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const body = await c.req.json<{ command?: string }>().catch(() => ({}) as { command?: string });
    const command = body.command ?? "";
    if (!command.trim()) return c.json({ error: "command required" }, 400);
    if (command.length > 2000) return c.json({ error: "command too long" }, 400);
    const res = await sandbox.run(u.username, p.root, { command, timeoutMs: 10_000 });
    if ("error" in res) return c.json({ error: res.error }, 400);
    return c.json({ output: res.stdout + (res.stderr ? (res.stdout ? "\n" : "") + res.stderr : ""), exitCode: res.exitCode ?? -1, timedOut: res.timedOut });
  });

  app.get("/v1/models", async (c) => c.json({ models: await c.get("models").available() }));

  // the instruct formats a text completion connection can write a chat in
  app.get("/v1/models/prompt-formats", (c) => c.json({ formats: PROMPT_FORMATS }));

  // the format a text completion model would be sent in right now, and why;
  // format=auto asks what matching the model finds, whatever the connection says
  app.get("/v1/models/prompt-format", async (c) => {
    const ref = c.req.query("model") ?? "";
    const slash = ref.indexOf("/");
    if (slash <= 0) return c.json({ error: "model must be provider/model-id" }, 400);
    const resolved = await c.get("models").resolvePromptFormat(ref.slice(0, slash), ref.slice(slash + 1), c.req.query("format") === "auto" ? "auto" : undefined);
    if (!resolved) return c.json({ error: "not a text completion model" }, 404);
    return c.json({ id: resolved.id, name: resolved.name, source: resolved.source });
  });

  // per-model context window override: the user's number wins over the
  // catalog's official value (proxies serve ids the catalog guesses wrong or
  // not at all); null clears back to the catalog number
  app.put("/v1/models/context", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const body = await c.req.json<{ ref?: unknown; contextWindow?: unknown }>().catch(() => ({}) as { ref?: unknown; contextWindow?: unknown });
    if (typeof body.ref !== "string" || !body.ref.includes("/") || body.ref.length > 400) {
      return c.json({ error: 'ref must be "<provider>/<model>"' }, 400);
    }
    if (body.contextWindow != null && (typeof body.contextWindow !== "number" || !Number.isInteger(body.contextWindow) || body.contextWindow <= 0 || body.contextWindow > 1e9)) {
      return c.json({ error: "contextWindow must be a positive integer or null to clear" }, 400);
    }
    const overrides = c.get("models").setContextOverride(body.ref, body.contextWindow ?? null);
    await git.commitAll(p.root, u.username, `models: context ${body.ref} = ${body.contextWindow ?? "catalog"}`).catch(() => undefined);
    // overrides are part of every model list line; push so open clients re-pull
    bus.emit(u.username, "connections_changed", { id: body.ref });
    return c.json({ ok: true, overrides });
  });

  // per-model prices (USD per million tokens). Custom endpoints and proxies
  // are in no price catalog, so without this their spend is unknown and the
  // apps say so instead of reporting a zero; null clears back to the catalog
  app.put("/v1/models/pricing", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const body = await c.req.json<{ ref?: unknown; pricing?: unknown }>().catch(() => ({}) as { ref?: unknown; pricing?: unknown });
    if (typeof body.ref !== "string" || !body.ref.includes("/") || body.ref.length > 400) {
      return c.json({ error: 'ref must be "<provider>/<model>"' }, 400);
    }
    let pricing: ModelPricing | null = null;
    if (body.pricing != null) {
      if (typeof body.pricing !== "object") return c.json({ error: "pricing must be an object or null to clear" }, 400);
      const raw = body.pricing as Record<string, unknown>;
      const rates: Record<string, number> = {};
      for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
        const v = raw[k];
        if (v == null) { rates[k] = 0; continue; }
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e6) {
          return c.json({ error: `${k} must be a non-negative number (USD per million tokens)` }, 400);
        }
        rates[k] = v;
      }
      if (!Object.values(rates).some((v) => v > 0)) {
        return c.json({ error: "at least one rate must be above zero — send null to clear instead" }, 400);
      }
      pricing = { input: rates.input!, output: rates.output!, cacheRead: rates.cacheRead!, cacheWrite: rates.cacheWrite! };
    }
    const table = c.get("models").setPricingOverride(body.ref, pricing);
    await git.commitAll(p.root, u.username, `models: pricing ${body.ref} = ${pricing ? "set" : "catalog"}`).catch(() => undefined);
    bus.emit(u.username, "connections_changed", { id: body.ref });
    return c.json({ ok: true, pricing: table });
  });

  // embeddings model config: the name sent to whatever connection serves
  // /embeddings (default text-embedding-3-small; other providers differ)
  app.get("/v1/embeddings/config", (c) => {
    const p = c.get("paths");
    let model = "text-embedding-3-small";
    try {
      const st = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { embedModel?: unknown };
      if (typeof st.embedModel === "string" && st.embedModel.trim()) model = st.embedModel.trim();
    } catch { /* default */ }
    return c.json({ model });
  });
  app.put("/v1/embeddings/config", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const body = await c.req.json<{ model?: unknown }>().catch(() => ({}) as { model?: unknown });
    if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 200) {
      return c.json({ error: "model must be a non-empty string" }, 400);
    }
    const settings = fs.existsSync(p.settings)
      ? (JSON.parse(fs.readFileSync(p.settings, "utf8")) as { embedModel?: string })
      : {};
    settings.embedModel = body.model.trim();
    fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
    await git.commitAll(p.root, u.username, "settings: embeddings model set").catch(() => undefined);
    return c.json({ ok: true, model: settings.embedModel });
  });

  // live embeddings capability probe — one tiny call through the user's
  // connections, so the memory UI can say honestly whether semantic recall
  // works or is falling back to keyword matching
  app.post("/v1/embeddings/probe", async (c) => {
    try {
      const r = await c.get("models").embedProbe();
      return c.json(r);
    } catch (e) {
      return c.json({ ok: false, via: null, error: (e as Error).message }, 200);
    }
  });

  // ---------- agent shell sandbox ----------
  app.get("/v1/sandbox", async (c) => c.json({ ...(await sandbox.status()), internet: readSandboxSettings(c.get("paths").sandbox).internet }));

  app.get("/v1/settings/sandbox", (c) => c.json(readSandboxSettings(c.get("paths").sandbox)));
  app.put("/v1/settings/sandbox", async (c) => {
    const body = await c.req.json<{ internet?: unknown }>().catch(() => ({}) as { internet?: unknown });
    if (typeof body.internet !== "boolean") return c.json({ error: "internet (boolean) required" }, 400);
    const u = c.get("user");
    // switching off bumps the token epoch, so old tokens stop verifying
    writeSandboxSettings(c.get("paths").sandbox, { internet: body.internet });
    bus.emit(u.username, "sandbox_config_changed", { internet: body.internet });
    evictAgents(u.username);
    return c.json({ internet: body.internet });
  });

  // what the user's sandbox frame boots with
  app.get("/v1/sandbox/config", (c) => {
    const u = c.get("user");
    const file = c.get("paths").sandbox;
    const { internet } = readSandboxSettings(file);
    return c.json({ internet, token: internet ? issueNetToken(u.username, readSandboxEpoch(file)) : null });
  });

  // Browser sandbox host bridge: heartbeat (registration + liveness), run
  // results, and the workspace file ops the host mounts/syncs through. With
  // another provider there is no browser host, and these answer plainly.
  app.post("/v1/sandbox/host", async (c) => {
    if (!(sandbox instanceof BrowserSandbox)) return c.json({ error: "this instance does not use the browser sandbox" }, 409);
    const body = await c.req.json<{ host?: unknown; ready?: unknown }>().catch(() => ({}) as { host?: unknown; ready?: unknown });
    if (typeof body.host !== "string" || !/^[a-z0-9]{8,64}$/.test(body.host)) return c.json({ error: "host required" }, 400);
    sandbox.hello(c.get("user").username, body.host, body.ready === true);
    return c.json({ ok: true });
  });

  app.post("/v1/sandbox/result", async (c) => {
    if (!(sandbox instanceof BrowserSandbox)) return c.json({ error: "this instance does not use the browser sandbox" }, 409);
    const body = await c.req
      .json<{ id?: unknown; exitCode?: unknown; stdout?: unknown; stderr?: unknown; timedOut?: unknown; truncated?: unknown }>()
      .catch(() => ({}) as Record<string, unknown>);
    const accepted = sandbox.resolve(c.get("user").username, body.id, {
      exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
      stdout: typeof body.stdout === "string" ? body.stdout : "",
      stderr: typeof body.stderr === "string" ? body.stderr : "",
      timedOut: body.timedOut === true,
      truncated: body.truncated === true,
    });
    return accepted ? c.json({ ok: true }) : c.json({ error: "that run is no longer waiting" }, 409);
  });

  const sandboxFsHandler = async (c: Context<AppEnv>) => {
    const capped = await readCappedBody(c, 24 * 1024 * 1024);
    if (!capped.ok) return c.json({ error: capped.error }, 413);
    let op: unknown;
    try {
      op = JSON.parse(new TextDecoder().decode(capped.bytes));
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    try {
      return c.json(workspaceFs(c.get("paths").root, op as WorkspaceFsOp));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  };
  app.post("/v1/sandbox/fs", sandboxFsHandler);
  app.put("/v1/sandbox/fs", sandboxFsHandler);

  // ---------- image generation (pi-ai images API; creds never leave) ----------
  app.get("/v1/images/models", async (c) => {
    try {
      return c.json({ models: await c.get("models").imageModels() });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });
  // the picture lands in the asset store and travels as a same-origin URL:
  // chats and cards that keep it stay small, and app pages (CSP img-src
  // 'self') can show it directly
  app.post("/v1/images", async (c) => {
    const body = await c.req.json<{ prompt?: unknown; model?: unknown }>().catch(() => ({}) as { prompt?: unknown; model?: unknown });
    if (typeof body.prompt !== "string" || !body.prompt.trim()) return c.json({ error: "prompt required" }, 400);
    try {
      const out = await c.get("models").generateImage({
        prompt: body.prompt.slice(0, 4000),
        ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
      });
      const ext = out.mimeType.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "png";
      const rec = assets.putAsset(c.get("paths"), out.data, out.mimeType, `image.${ext}`, c.get("bridgeApp")?.id ?? null);
      return c.json({ url: `/v1/assets/${rec.id}`, mimeType: out.mimeType, model: out.model });
    } catch (e) {
      const status = e instanceof ModelNotConfiguredError ? 503 : 500;
      return c.json({ error: (e as Error).message }, status);
    }
  });

  // ---------- speech synthesis ----------
  // Providers, in resolution order when the request doesn't pin one:
  //   1. the user's speech endpoints (speech.json + key in auth.json)
  //   2. Edge voices — Microsoft's keyless read-aloud service
  //   3. any keyed OpenAI-compatible engine connection (legacy fallback)
  // Credentials never leave the engine.
  app.get("/v1/audio/speech/endpoints", (c) => {
    return c.json({ endpoints: listSpeechEndpoints(c.get("paths")) });
  });
  app.post("/v1/audio/speech/endpoints", async (c) => {
    const body = await c.req.json<Parameters<typeof validateSpeechEndpointInput>[0]>().catch(() => ({}) as Parameters<typeof validateSpeechEndpointInput>[0]);
    const v = validateSpeechEndpointInput(body);
    if (!v.ok) return c.json({ error: v.error }, 400);
    return c.json({ endpoint: createSpeechEndpoint(c.get("paths"), v.value) }, 201);
  });
  app.patch("/v1/audio/speech/endpoints/:id", async (c) => {
    const body = await c.req
      .json<{ name?: unknown; baseUrl?: unknown; model?: unknown; voice?: unknown; key?: unknown }>()
      .catch(() => ({}) as { name?: unknown; baseUrl?: unknown; model?: unknown; voice?: unknown; key?: unknown });
    const patch: { name?: string; baseUrl?: string; model?: string; voice?: string; key?: string } = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.baseUrl === "string") patch.baseUrl = body.baseUrl;
    if (typeof body.model === "string") patch.model = body.model;
    if (typeof body.voice === "string") patch.voice = body.voice;
    if (typeof body.key === "string") patch.key = body.key;
    const out = updateSpeechEndpoint(c.get("paths"), c.req.param("id"), patch);
    if (!out) return c.json({ error: "no such speech endpoint" }, 404);
    return c.json({ endpoint: out });
  });
  app.delete("/v1/audio/speech/endpoints/:id", (c) => {
    return deleteSpeechEndpoint(c.get("paths"), c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ error: "no such speech endpoint" }, 404);
  });
  app.get("/v1/audio/voices", (c) => {
    return c.json({ edge: EDGE_VOICES });
  });

  app.post("/v1/audio/speech", async (c) => {
    const body = await c.req
      .json<{ text?: unknown; model?: unknown; voice?: unknown; speed?: unknown; connection?: unknown; provider?: unknown; endpointId?: unknown; format?: unknown }>()
      .catch(() => null) ?? ({} as { text?: unknown; model?: unknown; voice?: unknown; speed?: unknown; connection?: unknown; provider?: unknown; endpointId?: unknown; format?: unknown });
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text required" }, 400);
    const speed = Math.min(4, Math.max(0.25, Number(body.speed) || 1));
    const provider = body.provider === "edge" || body.provider === "endpoint" ? body.provider : undefined;
    const endpoints = listSpeechEndpoints(c.get("paths"));

    // explicit edge, or implicit when nothing else is configured
    if (provider === "edge" || (!provider && endpoints.length === 0 && body.endpointId === undefined && body.connection === undefined)) {
      const voice = typeof body.voice === "string" && body.voice ? body.voice : "en-US-AriaNeural";
      // webm/opus exists for clients whose build lacks the proprietary mp3 decoder
      const format: EdgeFormat = body.format === "webm" ? "webm" : "mp3";
      try {
        const clip = await edgeSpeakFmt({ text, voice, speed, format });
        return c.json({ dataUrl: `data:${EDGE_FORMATS[format].mime};base64,${clip.toString("base64")}`, provider: "edge", voice });
      } catch (e) {
        return c.json({ error: (e as Error).message }, 502);
      }
    }
    if (provider === "endpoint" && endpoints.length === 0) {
      return c.json({ error: "no speech endpoints configured — add one in the engine client: Settings → Speech" }, 503);
    }

    // endpoint route: explicit id, else the first configured endpoint
    const ep = (typeof body.endpointId === "string" ? endpoints.find((x) => x.id === body.endpointId) : undefined) ?? endpoints[0];
    if (ep) {
      const model = typeof body.model === "string" && body.model ? body.model : ep.model;
      const voice = typeof body.voice === "string" && body.voice ? body.voice : ep.voice ?? "alloy";
      try {
        const mp3 = await endpointSpeak({
          baseUrl: ep.baseUrl,
          key: speechEndpointKey(c.get("paths"), ep.id),
          model,
          voice,
          speed,
          text,
        });
        return c.json({ dataUrl: `data:audio/mpeg;base64,${mp3.toString("base64")}`, provider: "endpoint", endpoint: ep.name });
      } catch (e) {
        return c.json({ error: (e as Error).message }, 502);
      }
    }

    // legacy fallback: an explicit engine connection id, else any keyed
    // OpenAI-compatible custom connection, else the keyed openai builtin
    const model = typeof body.model === "string" && body.model ? body.model : "tts-1";
    const voice = typeof body.voice === "string" && body.voice ? body.voice : "alloy";
    const conns = listConnections(c.get("paths"));
    const auth = readAuth(c.get("paths"));
    // A stored key only travels to the endpoint it was saved for. Custom
    // endpoints stay user-editable (providers.json is a workspace file), so an
    // edited baseUrl must not carry the key to a new host: the same rule the
    // model path applies (see connectionKeyUsable).
    const usableKey = (k: ConnectionInfo): string | undefined => {
      const cred = auth[k.effectiveProviderId] as { key?: unknown } | undefined;
      if (!cred || typeof cred.key !== "string") return undefined;
      return connectionKeyUsable(k, k.id, cred) ? cred.key : undefined;
    };
    const byId = new Map(conns.map((k) => [k.id, k]));
    const conn =
      (typeof body.connection === "string" ? byId.get(body.connection) : undefined) ||
      conns.find((k) => k.api === "openai-completions" && usableKey(k)) ||
      conns.find((k) => k.effectiveProviderId === "openai" && usableKey(k));
    let baseUrl: string | null = null;
    let key: string | undefined;
    if (conn) {
      if (conn.api === "anthropic-messages") return c.json({ error: `"${conn.name}" is not an OpenAI-compatible endpoint` }, 400);
      if (conn.baseUrl) baseUrl = conn.baseUrl.replace(/\/+$/, "");
      else {
        const builtin = builtinProviders().find((p) => p.id === conn.effectiveProviderId);
        if (builtin?.baseUrl) baseUrl = builtin.baseUrl.replace(/\/+$/, "");
      }
      key = usableKey(conn);
      // a key that exists but is bound elsewhere means the endpoint was moved
      // under it: say so instead of quietly calling the new host
      if (key === undefined && conn.hasKey) {
        return c.json({ error: `"${conn.name}" has a key saved for a different endpoint. Re-enter it in Settings.` }, 400);
      }
    }
    if (!baseUrl) {
      return c.json(
        { error: "no speech provider — configure one in the engine client: Settings → Speech (Edge voices need no key)" },
        503,
      );
    }
    try {
      const mp3 = await endpointSpeak({ baseUrl, key, model, voice, speed, text });
      return c.json({ dataUrl: `data:audio/mpeg;base64,${mp3.toString("base64")}`, provider: "connection", endpoint: conn!.name });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // ---------- launch + settings (home-flow contract, SPEC-v2 §12.5) ----------
  // The v2 client's boot moment: what apps exist, that the agent tab exists,
  // and what to auto-enter. A single app goes straight in; with more, or
  // none yet, the picker shows. settings.launchDefault pins a choice.
  // engine identity for the launcher footer (version + repo link)
  const ENGINE_INFO = { version: ENGINE_VERSION, repository: ENGINE_REPOSITORY };

  app.get("/v1/launch", (c) => {
    const p = c.get("paths");
    const apps = listApps(p.apps);
    let pinned: string | null = null;
    try {
      const settings = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { launchDefault?: unknown };
      if (typeof settings.launchDefault === "string") pinned = settings.launchDefault;
    } catch { /* no settings file yet */ }
    const def = pinned && apps.some((a) => a.id === pinned) ? pinned : apps.length === 1 ? apps[0]!.id : null;
    return c.json({
      apps: apps.map((a) => ({
        id: a.id, name: a.manifest.name, kind: a.manifest.kind,
        author: a.manifest.author ?? null,
        official: officialApp(p, a),
        repository: installSourceOf(p, a)?.git ?? null,
      })),
      engine: { ...ENGINE_INFO, admin: c.get("user").role === "admin" },
      agent: true, // the agent tab is always available (kernel-level)
      default: def,
    });
  });

  // ---------- store ----------
  // The Store list, and per entry whether it is official and which of this
  // account's apps came from it. Installing is the git import, preview first.
  let catalog: { url: string; list: ReturnType<typeof createCatalog> } | null = null;
  app.get("/v1/store", async (c) => {
    const p = c.get("paths");
    const url = config.apps.store;
    if (!url) return c.json({ enabled: false, apps: [], fetchedAt: null });
    if (catalog?.url !== url) {
      catalog = {
        url,
        list: createCatalog({ url, cacheFile: path.join(dataDir, "store-catalog.json"), fetcher: deps.storeFetch, userAgent: `Chrysalis/${ENGINE_VERSION}` }),
      };
    }
    const result = await catalog.list.get({ fresh: c.req.query("fresh") === "1" });
    const installed = new Map<string, string>();
    for (const a of listApps(p.apps)) {
      const source = installSourceOf(p, a);
      if (source) installed.set(normalizeGitUrl(source.git), a.id);
    }
    const apps = result.apps
      .map((e) => ({ ...e, official: isOfficialSource(e.repository, officialSources), installed: installed.get(normalizeGitUrl(e.repository)) ?? null }))
      .sort((a, b) => Number(b.official) - Number(a.official) || b.added.localeCompare(a.added) || a.name.localeCompare(b.name));
    return c.json({ enabled: true, apps, fetchedAt: result.fetchedAt, ...(result.error ? { error: result.error } : {}) });
  });

  app.get("/v1/settings", (c) => {
    const p = c.get("paths");
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(fs.readFileSync(p.settings, "utf8")); } catch { /* defaults */ }
    return c.json({
      launchDefault: typeof settings.launchDefault === "string" ? settings.launchDefault : null,
      storeSeen: typeof settings.storeSeen === "string" ? settings.storeSeen : null,
      model: typeof settings.model === "string" ? settings.model : null,
      reasoning: isReasoningLevel(settings.reasoning) ? settings.reasoning : null,
      autoCompact:
        settings.autoCompact === true || settings.autoCompact === false || settings.autoCompact === null
          ? settings.autoCompact
          : typeof settings.autoCompact === "number"
            ? settings.autoCompact
            : true,
    });
  });

  app.put("/v1/settings", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const body = await c.req.json<{ launchDefault?: string | null; storeSeen?: string; model?: string | null; reasoning?: string | null; autoCompact?: boolean | number | null }>().catch(() => null) ?? {};
    if (!("launchDefault" in body) && !("storeSeen" in body) && !("model" in body) && !("reasoning" in body) && !("autoCompact" in body)) {
      return c.json({ error: "launchDefault, storeSeen, model, reasoning or autoCompact required" }, 400);
    }
    if (body.storeSeen !== undefined && !(typeof body.storeSeen === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.storeSeen))) {
      return c.json({ error: "storeSeen must be a date (YYYY-MM-DD)" }, 400);
    }
    if (body.launchDefault !== undefined && body.launchDefault !== null && typeof body.launchDefault !== "string") {
      return c.json({ error: "launchDefault must be a string app id or null" }, 400);
    }
    if (body.launchDefault !== undefined && typeof body.launchDefault === "string" && !readApp(p.apps, body.launchDefault)) {
      return c.json({ error: "unknown app" }, 404);
    }
    if (body.model !== undefined && body.model !== null && (typeof body.model !== "string" || !body.model.trim() || body.model.length > 200)) {
      return c.json({ error: "model must be a non-empty string or null" }, 400);
    }
    if (body.reasoning !== undefined && body.reasoning !== null && !isReasoningLevel(body.reasoning)) {
      return c.json({ error: "reasoning must be one of off|minimal|low|medium|high|xhigh|max or null" }, 400);
    }
    if (
      body.autoCompact !== undefined && body.autoCompact !== null && body.autoCompact !== true && body.autoCompact !== false &&
      !(typeof body.autoCompact === "number" && Number.isFinite(body.autoCompact) && body.autoCompact >= 1000 && body.autoCompact <= 10_000_000)
    ) {
      return c.json({ error: "autoCompact must be true, false, null, or a token threshold (1000-10000000)" }, 400);
    }
    const settings = fs.existsSync(p.settings)
      ? (JSON.parse(fs.readFileSync(p.settings, "utf8")) as Record<string, unknown>)
      : {};
    if (body.launchDefault !== undefined) settings.launchDefault = body.launchDefault;
    if (body.storeSeen !== undefined) settings.storeSeen = body.storeSeen;
    if (body.model !== undefined) settings.model = body.model;
    if (body.reasoning !== undefined) settings.reasoning = body.reasoning;
    if (body.autoCompact !== undefined) settings.autoCompact = body.autoCompact;
    fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n");
    const changes: string[] = [];
    if (body.launchDefault !== undefined) changes.push("launch default");
    if (body.storeSeen !== undefined) changes.push("store seen");
    if (body.model !== undefined) changes.push("default model");
    if (body.reasoning !== undefined) changes.push("thinking level");
    if (body.autoCompact !== undefined) changes.push("auto-compact");
    await git.commitAll(p.root, u.username, `settings: ${changes.join(", ")}`).catch(() => undefined);
    evictAgents(u.username); // agents snapshot model + reasoning at creation
    return c.json({ ok: true });
  });

  // Provider credentials for the standard settings panel. Keys are WRITE-ONLY:
  // responses never contain key material (SPEC §7 — credentials stay server-side).
  const readAuth = (p: UserPaths): Record<string, unknown> => {
    try { return JSON.parse(fs.readFileSync(p.auth, "utf8")) as Record<string, unknown>; } catch { return {}; }
  };
  const writeAuth = (p: UserPaths, data: Record<string, unknown>): void => {
    fs.mkdirSync(path.dirname(p.auth), { recursive: true });
    fs.writeFileSync(p.auth, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  };

  app.get("/v1/settings/providers", (c) => {
    const p = c.get("paths");
    const auth = readAuth(p);
    const curated = new Set(curatedProviders().map((x) => x.id));
    const byId = new Map<string, { id: string; label: string; kind: string; baseUrl: string | null; apiKeyAuth: boolean; oauth: boolean; oauthLabel: string | null; signIn: boolean; signInLabel: string | null }>();
    for (const provider of [...builtinProviders(), ...curatedProviders(), ...loadCustomProviders(p.root + "/providers.json")]) {
      // radius OAuth needs gateway options we don't expose yet
      const oauth = provider.auth?.oauth && provider.id !== "radius" ? provider.auth.oauth : undefined;
      // Guided credential setup (Vertex ADC, AWS profile, Cloudflare ids):
      // an api-key sign-in that a single key field cannot express.
      const apiKeyAuth = provider.auth?.apiKey;
      const guided = !oauth && !!apiKeyAuth?.login && GUIDED_SIGNINS.has(provider.id);
      // Pickable whenever the provider has a sign-in path. A missing top-level
      // baseUrl only means the endpoint lives on each model (opencode), or the
      // provider resolves it from the credential/env at request time — both
      // stay connectable. Radius is the lone no-endpoint kind: it needs a
      // gateway URL and has its own OAuth entry.
      const connectable = provider.id !== "radius" && (!!provider.auth?.apiKey || !!provider.auth?.oauth);
      byId.set(provider.id, {
        id: provider.id,
        label: provider.name ?? provider.id,
        kind: curated.has(provider.id) ? "curated" : connectable ? "builtin" : "needs-setup",
        baseUrl: provider.baseUrl ?? null,
        apiKeyAuth: !!provider.auth?.apiKey,
        oauth: !!oauth,
        oauthLabel: oauth?.loginLabel ?? oauth?.name ?? null,
        signIn: !!oauth || guided,
        signInLabel: oauth ? (oauth.loginLabel ?? oauth.name) : guided ? (apiKeyAuth?.name ?? null) : null,
      });
    }
    return c.json({
      providers: [...byId.values()].map((x) => ({ ...x, hasKey: !!auth[x.id] })),
    });
  });

  // ---------- Sign-in flows (OAuth subscriptions + guided credential setups) ----------
  // A flow runs server-side: pi-ai either spins its own local callback server
  // and hands us an auth_url / device code to show in the browser, or walks a
  // guided prompt sequence (project ids, account ids, file paths). The
  // resulting credential lands in auth.json under the provider id — same
  // store the model layer reads. State is polled by the client via /status.
  interface OAuthFlowState {
    providerId: string;
    status: "pending" | "connected" | "error";
    url?: string;
    userCode?: string;
    verificationUri?: string;
    message?: string;
    error?: string;
    /** guided flows only: the step waiting for the user's answer */
    prompt?: {
      id: number;
      type: "text" | "secret" | "select" | "manual_code";
      message: string;
      placeholder?: string;
      options?: Array<{ id: string; label: string; description?: string }>;
    };
  }
  const oauthFlows = new Map<string, OAuthFlowState>();
  /** Abort handle for the active flow, so walking away can free the slot. */
  const oauthCancels = new Map<string, () => void>();
  /** The pending guided-flow answer, keyed like oauthFlows (username). */
  const pendingAnswers = new Map<string, { id: number; reply: (value: string) => void }>();
  let promptSeq = 0;

  /** The sign-in method behind a provider id, or null when the panel has
   *  none. Radius resolves separately: its flow needs the user's gateway. */
  const signInFor = (providerId: string): { login: (interaction: ProviderAuthInteraction) => Promise<Credential>; guided: boolean } | null => {
    const provider = builtinProviders().find((b) => b.id === providerId);
    const oauth = provider?.auth?.oauth;
    if (oauth) return { login: (i) => oauth.login(i), guided: false };
    const apiKeyLogin = provider?.auth?.apiKey?.login;
    if (apiKeyLogin && GUIDED_SIGNINS.has(providerId)) return { login: (i) => apiKeyLogin(i), guided: true };
    return null;
  };

  const oauthProviders = () => [
    ...builtinProviders()
      .filter((pr) => pr.id !== "radius" && (pr.auth?.oauth || (pr.auth?.apiKey?.login && GUIDED_SIGNINS.has(pr.id))))
      .map((pr) => {
        const oauth = pr.auth?.oauth;
        return {
          id: pr.id,
          name: pr.name ?? pr.id,
          label: oauth ? (oauth.loginLabel ?? oauth.name) : (pr.auth?.apiKey?.name ?? pr.name ?? pr.id),
          subscription: oauth?.isSubscription === true,
        };
      }),
    // radius needs a user-supplied gateway; its flow is loaded directly
    { id: "radius", name: "Radius", label: "Radius gateway", subscription: false },
  ];

  app.get("/v1/settings/oauth", (c) => {
    const p = c.get("paths");
    const auth = readAuth(p);
    return c.json({
      providers: oauthProviders().map((x) => ({ ...x, configured: !!auth[x.id] })),
      flow: oauthFlows.get(c.get("user").username) ?? null,
    });
  });

  app.post("/v1/settings/oauth/:providerId/start", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const providerId = c.req.param("providerId");
    // radius: pull the gateway from the user's Radius connection, then use its flow directly
    let radiusGateway: string | null = null;
    if (providerId === "radius") {
      radiusGateway =
        (Object.values(readConnections(p).connections) as import("../connections.js").ConnectionDef[])
          .find((x) => x.oauthProvider === "radius")?.gateway ?? null;
      if (!radiusGateway) return c.json({ error: "create a Radius connection (with its gateway URL) first" }, 400);
    }
    let method: { login: (interaction: ProviderAuthInteraction) => Promise<Credential>; guided: boolean } | null = null;
    if (providerId === "radius") {
      const oauth = radiusGateway ? radiusProvider({ name: "Radius", gateway: radiusGateway }).auth.oauth : undefined;
      if (oauth) method = { login: (i) => oauth.login(i), guided: false };
    } else {
      method = signInFor(providerId);
    }
    if (!method) return c.json({ error: "unknown sign-in provider" }, 404);
    if (oauthFlows.get(u.username)?.status === "pending") {
      return c.json({ error: "a sign-in is already in progress" }, 409);
    }
    const auth = readAuth(p);
    if (auth[providerId]) return c.json({ error: "already signed in — remove the credential first" }, 409);

    const flow: OAuthFlowState = { providerId, status: "pending" };
    oauthFlows.set(u.username, flow);
    const controller = new AbortController();
    oauthCancels.set(u.username, () => controller.abort(new Error("cancelled")));
    const timeout = setTimeout(() => controller.abort(new Error("sign-in timed out after 5 minutes")), 5 * 60_000);

    /** Park a guided flow on a prompt; the client answers via /answer. */
    const askUser = (step: AuthPrompt): Promise<string> => {
      const id = ++promptSeq;
      const pending: NonNullable<OAuthFlowState["prompt"]> = { id, type: step.type, message: step.message };
      if (step.type === "select") {
        pending.options = step.options.map((o) => ({ id: o.id, label: o.label, description: o.description }));
      } else if (step.placeholder !== undefined) {
        pending.placeholder = step.placeholder;
      }
      flow.prompt = pending;
      return new Promise<string>((resolve, reject) => {
        const onAbort = () => {
          pendingAnswers.delete(u.username);
          reject(new Error("cancelled"));
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        step.signal?.addEventListener("abort", onAbort, { once: true });
        pendingAnswers.set(u.username, {
          id,
          reply: (value) => {
            controller.signal.removeEventListener("abort", onAbort);
            step.signal?.removeEventListener("abort", onAbort);
            pendingAnswers.delete(u.username);
            resolve(value);
          },
        });
      });
    };

    void (async () => {
      try {
        const credential = await method.login({
          signal: controller.signal,
          notify: (event) => {
            if (event.type === "auth_url") {
              flow.url = event.url;
              flow.message = event.instructions ?? "Complete the sign-in in your browser.";
            } else if (event.type === "device_code") {
              flow.userCode = event.userCode;
              flow.verificationUri = event.verificationUri;
            } else if (event.type === "info" || event.type === "progress") {
              flow.message = event.message;
            }
          },
          prompt: (prompt) => {
            if (method.guided) return askUser(prompt);
            // subscription flows drive their happy path: first option for
            // selects (browser login), defaults for text (e.g. github.com);
            // manual code entry waits for the callback to win the race
            if (prompt.type === "select") return Promise.resolve(prompt.options[0]?.id ?? "");
            if (prompt.type === "text" || prompt.type === "secret") return Promise.resolve("");
            return new Promise<never>((_, reject) => {
              const onAbort = () => reject(new Error("cancelled"));
              controller.signal.addEventListener("abort", onAbort, { once: true });
              prompt.signal?.addEventListener("abort", onAbort, { once: true });
            });
          },
        });
        // the user walked away mid-flow: drop the result, save nothing
        if (oauthFlows.get(u.username) !== flow) return;
        const all = readAuth(p);
        // Radius tokens are bound to the gateway they were issued for: the
        // gateway URL lives in the user's connection definition, so a later
        // edit of that URL must not take the token along
        all[providerId] = { ...(credential as unknown as { type: string }), ...(radiusGateway ? { boundBaseUrl: radiusGateway } : {}) };
        writeAuth(p, all);
        flow.status = "connected";
        modelServices.delete(u.username);
        evictAgents(u.username);
        bus.emit(u.username, "oauth_event", { provider: providerId, status: "connected" });
      } catch (e) {
        // a canceled flow already left the map: nothing to report
        if (oauthFlows.get(u.username) === flow) {
          flow.status = "error";
          flow.error = (e as Error).message || "sign-in failed";
          bus.emit(u.username, "oauth_event", { provider: providerId, status: "error", error: flow.error });
        }
      } finally {
        flow.prompt = undefined;
        pendingAnswers.delete(u.username);
        oauthCancels.delete(u.username);
        clearTimeout(timeout);
        setTimeout(() => {
          const f = oauthFlows.get(u.username);
          if (f && f.status !== "pending") oauthFlows.delete(u.username);
        }, 120_000).unref();
      }
    })();
    return c.json({ started: true });
  });

  /** One guided sign-in step: the flow has the prompt parked, this answers it. */
  app.post("/v1/settings/oauth/:providerId/answer", async (c) => {
    const u = c.get("user");
    const providerId = c.req.param("providerId");
    const flow = oauthFlows.get(u.username);
    const prompt = flow?.status === "pending" && flow.providerId === providerId ? flow.prompt : undefined;
    const pending = prompt ? pendingAnswers.get(u.username) : undefined;
    if (!flow || !prompt || !pending || pending.id !== prompt.id) {
      return c.json({ error: "no prompt is waiting for an answer" }, 409);
    }
    const body = (await c.req.json<{ id?: unknown; value?: unknown }>().catch(() => null)) ?? {};
    if (body.id !== prompt.id) return c.json({ error: "that step expired" }, 409);
    if (typeof body.value !== "string" || body.value.length > 4096) {
      return c.json({ error: "value must be a string" }, 400);
    }
    const value = body.value.trim();
    if (prompt.type === "select") {
      if (!prompt.options?.some((o) => o.id === value)) return c.json({ error: "pick one of the listed options" }, 400);
    } else if (!value) {
      return c.json({ error: "enter a value" }, 400);
    }
    flow.prompt = undefined;
    pending.reply(value);
    return c.json({ ok: true });
  });

  /** Walk away from a pending sign-in: abort it and free the slot, so the
   *  next provider can start without "already in progress". Idempotent. */
  app.post("/v1/settings/oauth/:providerId/cancel", (c) => {
    const u = c.get("user");
    const providerId = c.req.param("providerId");
    const flow = oauthFlows.get(u.username);
    if (flow?.providerId === providerId) oauthFlows.delete(u.username);
    oauthCancels.get(u.username)?.();
    oauthCancels.delete(u.username);
    pendingAnswers.delete(u.username);
    return c.json({ ok: true });
  });

  app.delete("/v1/settings/oauth/:providerId", (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const providerId = c.req.param("providerId");
    const auth = readAuth(p);
    if (!auth[providerId]) {
      return c.json({ error: "no stored credential for this provider" }, 404);
    }
    delete auth[providerId];
    writeAuth(p, auth);
    modelServices.delete(u.username);
    evictAgents(u.username);
    return c.json({ ok: true });
  });

  app.put("/v1/settings/providers/:id/key", async (c) => {
    const p = c.get("paths");
    const id = c.req.param("id");
    const known = [...builtinProviders(), ...curatedProviders(), ...loadCustomProviders(p.root + "/providers.json")].some((x) => x.id === id);
    if (!known) return c.json({ error: "unknown provider (add it to providers.json first for custom endpoints)" }, 404);
    const body = await c.req.json<{ key?: unknown }>().catch(() => null) ?? {};
    const key = body?.key;
    if (typeof key !== "string" || !key.trim() || key.length > 4096) return c.json({ error: "key must be a non-empty string" }, 400);
    const auth = readAuth(p);
    // a providers.json endpoint gets its key bound to the URL it has now;
    // built-in and curated endpoints are defined in code
    const custom = reservedProviderIds().has(id) ? undefined : loadCustomProviders(p.root + "/providers.json").find((x) => x.id === id);
    auth[id] = { type: "api_key", key: key.trim(), ...(custom?.baseUrl ? { boundBaseUrl: custom.baseUrl } : {}) };
    writeAuth(p, auth);
    return c.json({ ok: true, id });
  });

  app.delete("/v1/settings/providers/:id/key", (c) => {
    const p = c.get("paths");
    const id = c.req.param("id");
    const auth = readAuth(p);
    if (!(id in auth)) return c.json({ error: "no credential for provider" }, 404);
    delete auth[id];
    writeAuth(p, auth);
    return c.json({ ok: true, id });
  });


  // ---------- llm bridge (keys stay server-side) ----------
  app.post("/v1/llm", async (c) => {
    const u = c.get("user");
    const body = await c.req.json<{
      messages: { role: "user" | "assistant"; content: string }[];
      systemPrompt?: string;
      model?: string | null;
      reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
      /** Inject tools exported by the active app's plugins (dice, choices, ...). */
      useAppTools?: boolean;
    }>().catch(() => null);
    // garbage bodies are 400s, not generate() 500s
    if (
      !body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.messages) ||
      body.messages.some((m) => !m || typeof m.content !== "string" || (m.role !== "user" && m.role !== "assistant"))
    ) {
      return c.json({ error: "messages: array of {role: user|assistant, content: string} required" }, 400);
    }
    try {
      let tools: Parameters<UserModelService["generate"]>[0]["tools"];
      let executeTool: Parameters<UserModelService["generate"]>[0]["executeTool"];
      if (body.useAppTools) {
        const collected = await collectAppTools(u);
        if (collected.tools.length > 0) {
          tools = collected.tools;
          executeTool = async (name, args) => {
            const entry = collected.byName.get(name);
            if (!entry) return { text: `tool "${name}" not found`, isError: true };
            const r = await runPluginTool(entry.plugin, name, args, entry.deps);
            return r ?? { text: `tool "${name}" failed`, isError: true };
          };
        }
      }
      const result = await getModels(u).generate({ ...body, source: "api:/v1/chat/completions", ...(tools?.length ? { tools, executeTool } : {}) }, (d) => bus.emit(u.username, "llm_delta", { delta: d }));
      return c.json(result);
    } catch (e) {
      if (e instanceof ModelNotConfiguredError) return c.json({ error: e.message }, 503);
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ---------- git ----------
  app.get("/v1/git/log", async (c) => c.json({ commits: await git.log(c.get("paths").root, 50) }));
  app.post("/v1/git/commit", async (c) => {
    const u = c.get("user");
    const body = await c.req.json<{ message: string }>().catch(() => null);
    if (!body?.message) return c.json({ error: "message required" }, 400);
    const oid = await git.commitAll(c.get("paths").root, u.username, body.message);
    return c.json({ oid });
  });
  app.post("/v1/git/restore", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const body = await c.req.json<{ path: string; commit: string }>().catch(() => null);
    if (!body?.path || !body?.commit) return c.json({ error: "path and commit required" }, 400);
    const commits = await git.log(p.root, 500).catch(() => [] as git.CommitInfo[]);
    const target = commits.find((cm) => cm.oid.startsWith(body.commit ?? ""));
    if (!target) return c.json({ error: "commit not found" }, 404);
    try {
      await git.restoreFile(p.root, body.path, target.oid, u.username);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // path rejections are client errors, not server faults
      if (/^(invalid restore path|refusing to restore|path escapes)/.test(msg)) return c.json({ error: msg }, 400);
      throw e;
    }
    return c.json({ ok: true });
  });

  // ---------- agent ----------
  // ---------- agent (SPEC-v2 §6) ----------
  // file search for the agent composer's @-mention context (bounded walk)
  app.get("/v1/agent/files", (c) => {
    const p = c.get("paths");
    const q = (c.req.query("q") ?? "").toLowerCase();
    const SKIP_DIRS = new Set([".git", "node_modules", "assets-store", "agent", ".cache"]);
    const TEXT_EXT = /\.(json|jsonl|md|txt|ts|tsx|js|jsx|mjs|css|html|yaml|yml|toml|csv|py|rs|go|sh|lua|gm)$/i;
    const results: string[] = [];
    const walk = (rel: string, depth: number) => {
      if (results.length >= 30 || depth > 6) return;
      const abs = safeResolve(p.root, rel || ".");
      let entries: import("node:fs").Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (results.length >= 30) return;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
          walk(childRel, depth + 1);
        } else if (TEXT_EXT.test(e.name) && childRel.toLowerCase().includes(q)) {
          results.push(childRel);
        }
      }
    };
    walk("", 0);
    return c.json({ files: results });
  });

  app.get("/v1/agent/sessions", (c) => {
    const p = c.get("paths");
    return c.json({ sessions: listSessions(p) });
  });

  // session history for client replay (runs: user/assistant/tools per turn)
  app.get("/v1/agent/sessions/:id", (c) => {
    const id = c.req.param("id");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.json({ error: "invalid session id" }, 400);
    const file = path.join(sessionDir(c.get("paths")), `${id}.jsonl`);
    if (!fs.existsSync(file)) return c.json({ error: "session not found" }, 404);
    // run + compact records — the client renders compact markers as dividers
    const runs = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.type === "run" || r.type === "compact");
    return c.json({ sessionId: id, runs });
  });

  app.post("/v1/agent", async (c) => {
    const u = c.get("user");
    const body = (await c.req.json<{
      message: string;
      sessionId?: string;
      model?: string;
      reasoning?: string;
      mode?: string;
      images?: Array<{ data: string; mimeType: string }>;
    }>().catch(() => null));
    // null/array/scalar bodies AND non-string message values are 400s, not 500s
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.message !== "string" || !body.message.trim()) {
      return c.json({ error: "message required" }, 400);
    }
    if (body.sessionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(body.sessionId)) {
      return c.json({ error: "invalid sessionId (allowed: letters, digits, - _; max 64)" }, 400);
    }
    const images = (body.images ?? [])
      .filter((img) => img && typeof img.data === "string" && /^image\/(png|jpeg|gif|webp)$/.test(img.mimeType))
      .slice(0, 8);
    // the run record keeps images as asset URLs; the bytes the model gets are
    // the base64 above. A storage failure (oversize, quota) must not fail the
    // run: the model already sees the image, only history loses the preview.
    const paths = c.get("paths");
    const imageUrls: string[] = [];
    for (const img of images) {
      try {
        imageUrls.push(`/v1/assets/${assets.putAsset(paths, Buffer.from(img.data, "base64"), img.mimeType, null, null).id}`);
      } catch (e) {
        log.warn(`[agent] attached image not stored: ${(e as Error).message}`);
      }
    }
    let agent: UserAgent;
    try {
      agent = await getAgent(
        u,
        body.sessionId,
        typeof body.model === "string" ? body.model.slice(0, 200) : undefined,
        isReasoningLevel(body.reasoning) ? body.reasoning : undefined,
        body.mode === "plan" ? "plan" : body.mode === "accept" ? "accept" : "normal",
      );
    } catch (e) {
      if (/no models configured/i.test((e as Error).message)) {
        return c.json({ error: (e as Error).message }, 503);
      }
      throw e;
    }
    bus.emit(u.username, "agent_session", { sessionId: agent.sessionId });
    const runKey = `${u.username}:${agent.sessionId}`;
    activeRuns.set(runKey, agent);
    try {
      const result = await agent.run(body.message, {
        onDelta: (d) => bus.emit(u.username, "agent_delta", { sessionId: agent.sessionId, delta: d }),
        onEvent: (ev) => bus.emit(u.username, "agent_event", { sessionId: agent.sessionId, ev }),
        images,
        ...(imageUrls.length ? { imageUrls } : {}),
      });
      // auto-compact: when the next call's context is over the limit, fold
      // the session into a summary (marker keeps history for the UI). The
      // automatic limit needs the model's real window; a model whose size is
      // unknown only compacts at a threshold the user set.
      let autoCompacted = false;
      const autoCompact = readSetting(u.username, "autoCompact", true);
      const limit =
        autoCompact === true && result.contextWindow
          ? Math.floor(result.contextWindow * 0.8)
          : typeof autoCompact === "number" && autoCompact >= 1000
            ? autoCompact
            : 0;
      // count cached tokens too — they're part of the context the model re-reads
      const nextContext = result.usage ? result.usage.input + result.usage.cacheRead + result.usage.output : 0;
      if (limit > 0 && nextContext >= limit && !result.error) {
        try {
          await compactSession(u, agent.sessionId, { auto: true });
          autoCompacted = true;
          bus.emit(u.username, "agent_event", { sessionId: agent.sessionId, ev: { type: "autocompact" } });
        } catch (e) {
          log.warn(`[agent] auto-compact failed for ${u.username}/${agent.sessionId}: ${(e as Error).message}`);
        }
      }
      return c.json({ sessionId: agent.sessionId, ...result, ...(autoCompacted ? { autoCompacted: true } : {}) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    } finally {
      activeRuns.delete(runKey);
    }
  });

  // Queue a user message into a RUNNING agent (steering): injected after the
  // current tool batch, before the next model call.
  app.post("/v1/agent/steer", async (c) => {
    const u = c.get("user");
    const body = await c.req.json<{ sessionId?: string; message?: string }>().catch(() => null) ?? {};
    if (!body.sessionId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(body.sessionId)) {
      return c.json({ error: "valid sessionId required" }, 400);
    }
    if (!body.message?.trim()) return c.json({ error: "message required" }, 400);
    const agent = activeRuns.get(`${u.username}:${body.sessionId}`);
    if (!agent) return c.json({ error: "no active run for this session" }, 409);
    agent.steer(body.message.slice(0, 8000));
    bus.emit(u.username, "agent_event", { sessionId: body.sessionId, ev: { type: "steer", text: body.message } });
    return c.json({ ok: true });
  });

  // abort the active run for a session (partial output is kept)
  app.post("/v1/agent/stop", async (c) => {
    const u = c.get("user");
    const body = await c.req.json<{ sessionId?: string }>().catch(() => null);
    if (!body || !body.sessionId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(body.sessionId)) {
      return c.json({ error: "valid sessionId required" }, 400);
    }
    const agent = activeRuns.get(`${u.username}:${body.sessionId}`);
    if (!agent) return c.json({ error: "no active run for this session" }, 409);
    // unblock any pending ask_user from this run so the abort can settle
    for (const [askId, pending] of pendingQuestions) {
      if (pending.sessionId === body.sessionId && pending.username === u.username) {
        pendingQuestions.delete(askId);
        pending.resolve("(stopped)");
      }
    }
    agent.stop();
    return c.json({ ok: true });
  });

  // answer a pending ask_user question (resolves the blocked tool call)
  app.post("/v1/agent/answer", async (c) => {
    const u = c.get("user");
    const body = await c.req.json<{ sessionId?: string; id?: string; answer?: string }>().catch(() => null) ?? ({} as { sessionId?: string; id?: string; answer?: string });
    const pending = body.id ? pendingQuestions.get(body.id) : undefined;
    if (!pending || pending.username !== u.username) return c.json({ error: "no pending question" }, 404);
    pendingQuestions.delete(body.id!);
    const answer = (body.answer ?? "").slice(0, 8000);
    pending.resolve(answer);
    bus.emit(u.username, "agent_event", { sessionId: pending.sessionId, ev: { type: "ask_user_done", id: body.id } });
    return c.json({ ok: true });
  });

  // ---------- agent session operations (go back / fork / delete) ----------
  const readRuns = (p: UserPaths, id: string): Record<string, unknown>[] | null => {
    const file = path.join(sessionDir(p), `${id}.jsonl`);
    if (!fs.existsSync(file)) return null;
    try {
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  };
  const writeRuns = (p: UserPaths, id: string, runs: Record<string, unknown>[]): void => {
    const file = path.join(sessionDir(p), `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, runs.map((r) => JSON.stringify(r)).join("\n") + (runs.length ? "\n" : ""), "utf8");
  };

  app.delete("/v1/agent/sessions/:id", (c) => {
    const p = c.get("paths");
    const id = c.req.param("id");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.json({ error: "invalid session id" }, 400);
    const file = path.join(sessionDir(p), `${id}.jsonl`);
    if (!fs.existsSync(file)) return c.json({ error: "session not found" }, 404);
    fs.rmSync(file);
    evictAgents(c.get("user").username);
    return c.json({ ok: true });
  });

  // drop runs at/after `at` — "go back" / edit-and-resend
  app.post("/v1/agent/sessions/:id/truncate", async (c) => {
    const p = c.get("paths");
    const id = c.req.param("id");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.json({ error: "invalid session id" }, 400);
    const body = await c.req.json<{ at?: number }>().catch(() => null) ?? {};
    if (typeof body.at !== "number") return c.json({ error: "at (run timestamp) required" }, 400);
    const cutoff = body.at;
    const runs = readRuns(p, id);
    if (runs === null) return c.json({ error: "session not found" }, 404);
    // renames, archive state and the run-opened marker are session metadata, not dialogue:
    // they survive truncation so the thread keeps its name and its place in
    // the sidebar even when every run is cut
    const keep = runs.filter((r) => r.type === "rename" || r.type === "start" || r.type === "archive" || (r.type === "run" && typeof r.at === "number" && (r.at as number) < cutoff));
    writeRuns(p, id, keep);
    evictAgents(c.get("user").username);
    return c.json({ ok: true, runs: keep.length });
  });

  // copy runs before `at` into a new session
  app.post("/v1/agent/sessions/:id/fork", async (c) => {
    const p = c.get("paths");
    const id = c.req.param("id");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.json({ error: "invalid session id" }, 400);
    const body = await c.req.json<{ at?: number }>().catch(() => null) ?? {};
    const runs = readRuns(p, id);
    if (runs === null) return c.json({ error: "session not found" }, 404);
    const keep = runs.filter((r) => r.type === "rename" || r.type === "start" || (r.type === "run" && (body.at === undefined || (typeof r.at === "number" && (r.at as number) < body.at))));
    let newId = `fork-${Math.random().toString(36).slice(2, 10)}`;
    while (fs.existsSync(path.join(sessionDir(p), `${newId}.jsonl`))) {
      newId = `fork-${Math.random().toString(36).slice(2, 10)}`;
    }
    writeRuns(p, newId, keep);
    return c.json({ sessionId: newId, runs: keep.length });
  });

  // rename a session (sidebar title — metadata, never enters the model context)
  app.post("/v1/agent/sessions/:id/rename", async (c) => {
    const p = c.get("paths");
    const body = await c.req.json<{ title?: unknown }>().catch(() => ({}) as { title?: unknown });
    if (typeof body.title !== "string") return c.json({ error: "title (string) required" }, 400);
    try {
      const title = renameSession(p, c.req.param("id"), body.title);
      return c.json({ ok: true, title });
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg === "session not found" ? 404 : 400);
    }
  });

  app.post("/v1/agent/sessions/:id/archive", async (c) => {
    const body = await c.req.json<{ archived?: unknown }>().catch(() => ({}) as { archived?: unknown });
    if (typeof body.archived !== "boolean") return c.json({ error: "archived (boolean) required" }, 400);
    try {
      archiveSession(c.get("paths"), c.req.param("id"), body.archived);
      return c.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg === "session not found" ? 404 : 400);
    }
  });

  // ---------- compact: summarize the session, APPEND a compact marker ----------
  // History stays in the file (the UI keeps it scrollable behind a divider);
  // the model's context restarts from the summary (loadSessionDialogue drops
  // everything before the marker).
  const compactSession = async (u: UserRecord, id: string, opts: { auto?: boolean } = {}): Promise<{ summary: string; runsBefore: number }> => {
    const p = userPaths(dataDir, u.username);
    const file = path.join(sessionDir(p), `${id}.jsonl`);
    if (!fs.existsSync(file)) throw new HttpError(404, "session not found");
    const pre = fs.readFileSync(file, "utf8");
    const runs = (readRuns(p, id) ?? []).filter((r) => r.type === "run");
    const lines: string[] = [];
    for (const r of runs) {
      if (typeof r.user === "string" && r.user.trim()) lines.push(`User: ${r.user}`);
      if (typeof r.assistant === "string" && r.assistant.trim()) lines.push(`Assistant: ${r.assistant}`);
    }
    const transcript = lines.join("\n\n").slice(0, 100_000);
    if (!transcript.trim()) throw new HttpError(400, "nothing to compact");

    let agent: UserAgent;
    try {
      agent = await getAgent(u, id);
    } catch (e) {
      if (/no models configured/i.test((e as Error).message)) throw new HttpError(503, (e as Error).message);
      throw e;
    }
    const runKey = `${u.username}:${agent.sessionId}`;
    activeRuns.set(runKey, agent);
    try {
      const result = await agent.run(
        `Summarize the conversation below into a compact session memory. Preserve: what the user wants, decisions made, every file path created or edited, plugin/app/MCP state, and open threads / next steps. Write it as a self-contained briefing a coding agent can continue from, in plain text with short sections. No preamble, no commentary about summarizing.\n\n<conversation>\n${transcript}\n</conversation>`,
        {
          onDelta: (d) => bus.emit(u.username, "agent_delta", { sessionId: agent.sessionId, delta: d }),
          onEvent: (ev) => bus.emit(u.username, "agent_event", { sessionId: agent.sessionId, ev }),
        },
      );
      if (result.error) throw new HttpError(500, result.error);
      const summary = result.finalText.trim();
      if (!summary) throw new HttpError(500, "compaction produced no summary (check that a model is configured)");
      // keep prior history, append the marker; the summarization run that
      // agent.run persisted is dropped (it would duplicate the summary)
      const rec: { type: "compact"; at: number; summary: string; auto?: boolean } = {
        type: "compact",
        at: Date.now(),
        summary,
        ...(opts.auto ? { auto: true } : {}),
      };
      fs.writeFileSync(file, pre + JSON.stringify(rec) + "\n", "utf8");
      return { summary, runsBefore: runs.length };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, (e as Error).message);
    } finally {
      activeRuns.delete(runKey);
      evictAgents(u.username); // the session file changed under any cached agent
    }
  };

  app.post("/v1/agent/sessions/:id/compact", async (c) => {
    const u = c.get("user");
    const id = c.req.param("id");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) return c.json({ error: "invalid sessionId" }, 400);
    try {
      const r = await compactSession(u, id);
      return c.json({ sessionId: id, ...r });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return c.json({ error: (e as Error).message }, status as 400 | 404 | 500 | 503);
    }
  });

  // ---------- named API connections (SPEC: keys never leave the server) ----------
  /** Connection mutations rebuild the user's model service. Warm the rebuilt
   *  catalog first (auto-discovery runs here, not on the next list request),
   *  then tell the user's open clients to re-pull their model lists. */
  const connectionsMutated = (u: UserRecord, id?: string): void => {
    modelServices.delete(u.username);
    evictAgents(u.username);
    void getModels(u)
      .available()
      .catch(() => undefined)
      .then(() => bus.emit(u.username, "connections_changed", { id }));
  };

  app.get("/v1/settings/connections", (c) => {
    return c.json({ connections: listConnections(c.get("paths")) });
  });

  // personal agent instructions (persona.md, git-tracked)
  app.get("/v1/settings/persona", (c) => {
    const p = c.get("paths");
    try {
      return c.json({ persona: fs.readFileSync(p.persona, "utf8") });
    } catch {
      return c.json({ persona: "" });
    }
  });

  app.put("/v1/settings/persona", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const body = await c.req.json<{ persona?: unknown }>().catch(() => null) ?? {};
    if (typeof body.persona !== "string" || body.persona.length > 32_000) {
      return c.json({ error: "persona must be a string (max 32k chars)" }, 400);
    }
    fs.mkdirSync(path.dirname(p.persona), { recursive: true });
    fs.writeFileSync(p.persona, body.persona, "utf8");
    await git.commitAll(p.root, u.username, "settings: agent instructions").catch(() => undefined);
    evictAgents(u.username); // system prompt snapshots at agent creation
    return c.json({ ok: true });
  });

  app.post("/v1/settings/connections", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const body = await c.req.json<Record<string, unknown>>().catch(() => null) ?? {};
    const parsed = validateConnectionInput(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const created = createConnection(p, parsed.value);
    connectionsMutated(u, created.id);
    return c.json({ connection: created }, 201);
  });

  app.patch("/v1/settings/connections/:id", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const body = await c.req.json<{ name?: string; baseUrl?: string; key?: string; models?: unknown; promptFormat?: unknown; promptFormatCustom?: unknown }>().catch(() => null) ?? {};
    let models: import("../connections.js").ConnectionDef["models"] | undefined;
    if (body.models !== undefined) {
      const check = validateConnectionInput({ name: "x", api: "openai-completions", baseUrl: "http://x.example", models: body.models });
      if (!check.ok) return c.json({ error: check.error }, 400);
      models = check.value.models;
    }
    let format: { promptFormat: string; promptFormatCustom?: PromptFormat } | undefined;
    if (body.promptFormat !== undefined) {
      const check = validatePromptFormatInput(body.promptFormat, body.promptFormatCustom);
      if (!check.ok) return c.json({ error: check.error }, 400);
      format = check.value;
    }
    const updated = updateConnection(p, c.req.param("id"), {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body.key === "string" ? { key: body.key } : {}),
      ...(models !== undefined ? { models } : {}),
      ...format,
    });
    if (!updated) return c.json({ error: "connection not found" }, 404);
    connectionsMutated(u, updated.id);
    return c.json({ connection: updated });
  });

  app.delete("/v1/settings/connections/:id", (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    if (!deleteConnection(p, c.req.param("id"))) return c.json({ error: "connection not found" }, 404);
    connectionsMutated(u, c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---------- MCP (per-user mcp.json registry; SPEC §5.5) ----------
  /** Engine servers an app has switched on for itself (settings.json appMcp:
   *  engine-owned, so app data and app updates never touch it). */
  const appMcpOptIns = (username: string, appId: string): string[] => {
    const all = readSetting<Record<string, unknown>>(username, "appMcp", {});
    const v = all && typeof all === "object" ? all[appId] : undefined;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  };
  /** Body → server config, shared by the engine and app routes; an error
   *  carries the status the route should send back. */
  const parseMcpConfig = (raw: unknown, role: string): { cfg: McpServerConfig } | { error: string; status: 400 | 403 } => {
    const b = raw as { type?: unknown; command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown; enabled?: unknown } | null;
    if (!b || typeof b !== "object" || (b.type !== "stdio" && b.type !== "http" && b.type !== "sse")) {
      return { error: "type must be stdio|http|sse", status: 400 };
    }
    if (b.type === "stdio" && role !== "admin") {
      // stdio servers spawn a process on the HOST, outside the bash-tool
      // sandbox — that power belongs to the machine owner. Non-admin
      // accounts can still register http/sse servers (outbound HTTP only).
      return { error: "stdio MCP servers are admin-only (they run a command on the host)", status: 403 };
    }
    if (b.type === "stdio" && typeof b.command !== "string") return { error: "stdio requires command", status: 400 };
    if (b.type !== "stdio" && typeof b.url !== "string") return { error: `${b.type} requires url`, status: 400 };
    return {
      cfg: {
        type: b.type,
        ...(typeof b.command === "string" ? { command: b.command } : {}),
        ...(Array.isArray(b.args) ? { args: b.args.filter((x): x is string => typeof x === "string") } : {}),
        ...(b.env && typeof b.env === "object" ? { env: b.env as Record<string, string> } : {}),
        ...(typeof b.url === "string" ? { url: b.url } : {}),
        ...(b.headers && typeof b.headers === "object" ? { headers: b.headers as Record<string, string> } : {}),
        ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
      },
    };
  };

  app.get("/v1/mcp", async (c) => {
    const registry = getMcp(c.get("user"));
    // connections are lazy; give them a bounded head start so a fresh boot
    // doesn't report "not connected" until something happens to warm them
    await Promise.race([
      registry.listTools().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
    return c.json({ servers: registry.status() });
  });
  app.put("/v1/mcp/:id", async (c) => {
    const u = c.get("user");
    const parsed = parseMcpConfig(await c.req.json<unknown>().catch(() => null), u.role);
    if ("error" in parsed) return c.json({ error: parsed.error }, parsed.status);
    // stdio only reaches here for admins (parseMcpConfig): this save IS the
    // approval, and anything else becomes unapproved
    writeStdioApproval(stdioApprovalsFile(c.get("paths")), c.req.param("id"), parsed.cfg.type === "stdio" ? parsed.cfg : null);
    getMcp(u).upsertServer(c.req.param("id"), parsed.cfg);
    evictAgents(u.username); // agent toolsets snapshot MCP tools at creation
    await git.commitAll(c.get("paths").root, u.username, `mcp(${c.req.param("id")}): registered via API`);
    return c.json({ ok: true });
  });
  app.delete("/v1/mcp/:id", async (c) => {
    const u = c.get("user");
    if (!getMcp(u).deleteServer(c.req.param("id"))) return c.json({ error: "no such engine MCP server" }, 404);
    writeStdioApproval(stdioApprovalsFile(c.get("paths")), c.req.param("id"), null);
    evictAgents(u.username);
    await git.commitAll(c.get("paths").root, u.username, `mcp(${c.req.param("id")}): removed via API`);
    return c.json({ ok: true });
  });
  app.get("/v1/mcp/tools", async (c) => c.json({ tools: await getMcp(c.get("user")).listTools() }));
  app.patch("/v1/mcp/:id", async (c) => {
    const u = c.get("user");
    const body = await c.req.json<{ enabled?: unknown; share?: unknown }>().catch(() => ({}) as { enabled?: unknown; share?: unknown });
    const access: { enabled?: boolean; share?: "all" | "agent" } = {};
    if (typeof body.enabled === "boolean") access.enabled = body.enabled;
    if (body.share === "all" || body.share === "agent") access.share = body.share;
    if (!Object.keys(access).length) return c.json({ error: "send enabled and/or share (all | agent)" }, 400);
    if (!getMcp(u).setAccess(c.req.param("id"), access)) return c.json({ error: "no such engine MCP server" }, 404);
    evictAgents(u.username); // agent toolsets snapshot MCP tools at creation
    await git.commitAll(c.get("paths").root, u.username, `mcp(${c.req.param("id")}): ${access.enabled === false ? "off" : access.share ?? "on"}`).catch(() => undefined);
    return c.json({ ok: true });
  });
  app.post("/v1/mcp/:id/reconnect", async (c) => {
    const u = c.get("user");
    const ok = await getMcp(u).reconnect(c.req.param("id"));
    if (ok) evictAgents(u.username); // re-attach refreshed toolset
    return c.json({ ok }, ok ? 200 : 404);
  });
  app.post("/v1/mcp/tools/:name/call", async (c) => {
    const body = await c.req.json<{ args?: Record<string, unknown> }>().catch(() => ({ args: {} }));
    const r = await getMcp(c.get("user")).callTool(c.req.param("name"), body.args ?? {});
    return c.json(r);
  });

  // What an app gets: engine servers shared with every app; each app opts in
  // per server with the PATCH below. Servers are added and shared in the
  // engine's MCP settings — apps never register egress of their own.
  app.get("/v1/apps/:id/mcp", async (c) => {
    const u = c.get("user");
    const appId = c.req.param("id");
    const registry = getMcp(u);
    const shared = registry.sharedServers();
    const opted = new Set(appMcpOptIns(u.username, appId));
    await Promise.race([registry.warm(shared), new Promise((resolve) => setTimeout(resolve, 2500))]);
    const servers = registry.status()
      .filter((srv) => shared.includes(srv.id))
      .map((srv) => ({ ...srv, use: opted.has(srv.id) }));
    return c.json({ servers });
  });
  app.patch("/v1/apps/:id/mcp/:serverId", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const appId = c.req.param("id");
    const serverId = c.req.param("serverId");
    if (!readApp(p.apps, appId)) return c.json({ error: "app not found" }, 404);
    const body = await c.req.json<{ use?: unknown }>().catch(() => ({}) as { use?: unknown });
    if (typeof body.use !== "boolean") return c.json({ error: "use must be true or false" }, 400);
    const cfg = getMcp(u).readConfig().servers[serverId];
    if (!cfg || (cfg.share ?? "all") !== "all") {
      return c.json({ error: "not a server shared with apps" }, 404);
    }
    const settings = fs.existsSync(p.settings) ? (JSON.parse(fs.readFileSync(p.settings, "utf8")) as { appMcp?: Record<string, string[]> }) : {};
    const list = new Set(appMcpOptIns(u.username, appId));
    if (body.use) list.add(serverId);
    else list.delete(serverId);
    settings.appMcp = { ...settings.appMcp, [appId]: [...list] };
    if (!settings.appMcp[appId]?.length) delete settings.appMcp[appId];
    if (!Object.keys(settings.appMcp).length) delete settings.appMcp;
    fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
    await git.commitAll(p.root, u.username, `mcp(${serverId}): ${body.use ? "on" : "off"} for ${appId}`).catch(() => undefined);
    return c.json({ ok: true, use: body.use });
  });

  // ---------- plugins (sandboxed; files created via agent/HTTP file writes) ----------
  app.get("/v1/plugins", (c) => {
    const p = c.get("paths");
    const deps = getPluginDeps(c.get("user"));
    const granted = deps.grantsFor;
    // an app page lists its own plugins; the shell lists the app on screen
    const activeApp = c.get("bridgeApp")?.id ?? readActiveApp(p);
    const mapper = (source: string) => (pl: ReturnType<typeof discoverPlugins>[number]) => ({
      id: pl.id,
      source,
      manifest: pl.manifest,
      needsApproval: pl.manifest.origin === "imported",
      grantedCapabilities: granted(pl.id),
      pendingCapabilities: (pl.manifest.permissions ?? []).filter(
        (cap) => cap !== "hooks" && !granted(pl.id).includes(cap),
      ),
      disabled: disabledAppPlugins(p.settings).has(pl.id),
    });
    const items = discoverPlugins(p.plugins).map(mapper("user"));
    if (activeApp) {
      for (const pl of discoverAppPlugins(p.apps, activeApp)) {
        items.push(mapper(`app:${activeApp}`)(pl));
      }
    }
    return c.json({ plugins: items, activeApp });
  });

  app.post("/v1/plugins/:id/approve", async (c) => {
    const p = c.get("paths");
    const id = c.req.param("id");
    const body = await c.req.json<{ capabilities?: string[] }>().catch(() => ({ capabilities: undefined }));
    const plugin = [
      ...discoverPlugins(p.plugins),
      ...listApps(p.apps).flatMap((a) => discoverAppPlugins(p.apps, a.id)),
    ].find((pl) => pl.id === id);
    if (!plugin) return c.json({ error: "plugin not found" }, 404);
    const caps = body.capabilities ?? (plugin.manifest.permissions ?? []).filter((x) => x !== "hooks");
    const settings = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { pluginGrants?: Record<string, string[]> };
    settings.pluginGrants ??= {};
    settings.pluginGrants[id] = [...new Set([...(settings.pluginGrants[id] ?? []), ...caps])];
    fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
    // a newly granted schedule permission starts ticking now
    syncUserSchedules(c.get("user"));
    return c.json({ ok: true, granted: settings.pluginGrants[id] });
  });

  // ---------- shareable plugins (git import, scoped to ONE app) ----------
  // A plugin repo = manifest.json + plugin.js at the root (exactly how
  // bundled app plugins look on disk). Two-phase like app import: preview
  // shows the manifest + permissions + network hosts with the community-risk
  // copy; confirm installs into THIS app's plugins/ with the just-reviewed
  // capabilities pre-granted, and the engine hot-loads it while the app is
  // active. A git-source app update replaces it (that's the "modified"
  // warning on the app's update banner).
  const stagePlugin = async (gitUrl: string, staging: string): Promise<{ head: string; manifest: Record<string, unknown> } | { error: string; status: number }> => {
    fs.rmSync(staging, { recursive: true, force: true });
    let head: string;
    try {
      head = await gitClone(gitUrl, staging); // head BEFORE stripVcs drops .git
      stripVcs(staging);
      // sidecar so the confirm phase knows the head without a .git to ask
      // (rev-parse here would silently resolve to the PARENT workspace repo)
      fs.writeFileSync(path.join(staging, ".staged-head"), head + "\n", "utf8");
    } catch (e) {
      return { error: `clone failed: ${(e as Error).message}`, status: 502 };
    }
    const manifestFile = path.join(staging, "manifest.json");
    const pluginFile = path.join(staging, "plugin.js");
    if (!fs.existsSync(manifestFile) || !fs.existsSync(pluginFile)) {
      return { error: "not a plugin repository — manifest.json and plugin.js must be at the repo root (multi-plugin bundles are apps: import them as one)", status: 422 };
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
      if (typeof manifest.name !== "string" || !manifest.name.trim()) return { error: "plugin manifest has no name", status: 422 };
      return { head, manifest };
    } catch {
      return { error: "invalid manifest.json", status: 422 };
    }
  };

  app.post("/v1/apps/:id/plugins/import", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const appId = c.req.param("id");
    const appDir = safeResolve(p.apps, appId);
    if (!fs.existsSync(path.join(appDir, "manifest.json"))) return c.json({ error: "no such app" }, 404);
    const body = await c.req.json<{ gitUrl?: string; confirm?: boolean; head?: string }>().catch(() => ({}) as never);
    const gitUrl = typeof body.gitUrl === "string" ? body.gitUrl.trim() : "";
    // the commit the preview showed: confirm installs THAT tree or nothing
    const reviewedHead = typeof body.head === "string" ? body.head.trim() : "";
    if (!isValidGitUrl(gitUrl)) return c.json({ error: "give a git repository URL (https://… or git@…)" }, 400);
    const slug = (gitUrl.split(/[/:]/).pop() ?? "plugin").replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9-]/g, "") || "plugin";
    const staging = path.join(p.apps, ".staging", `plugin-${slug}`);

    const stagedHeadFile = path.join(staging, ".staged-head");
    let staged = fs.existsSync(stagedHeadFile) && fs.existsSync(path.join(staging, "plugin.js"))
      ? await (async () => {
          try {
            const head = fs.readFileSync(stagedHeadFile, "utf8").trim();
            return { head, manifest: JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf8")) as Record<string, unknown> };
          } catch { return null; }
        })()
      : null;
    if (!staged) {
      const r = await stagePlugin(gitUrl, staging);
      if ("error" in r) { fs.rmSync(staging, { recursive: true, force: true }); return c.json({ error: r.error }, r.status as 422); }
      // fresh clone (the preview's staging was gone): it must be the commit the
      // user reviewed, or the permissions they approved describe different code
      if (reviewedHead && r.head !== reviewedHead) {
        fs.rmSync(staging, { recursive: true, force: true });
        return c.json({ error: "the repository moved since the preview — run the import again to review what changed" }, 409);
      }
      staged = r;
    }

    const manifest = staged.manifest as { name?: string; version?: string; author?: string; description?: string; permissions?: string[]; networkHosts?: string[]; origin?: string; source?: Record<string, unknown> };
    // the same repository imported again is an update of that plugin, in place
    const pluginsDir = path.join(appDir, "plugins");
    const installed = (() => {
      try {
        for (const pid of fs.readdirSync(pluginsDir)) {
          try {
            const m = JSON.parse(fs.readFileSync(path.join(pluginsDir, pid, "manifest.json"), "utf8")) as { version?: unknown; source?: { git?: unknown } };
            if (typeof m.source?.git === "string" && normalizeGitUrl(m.source.git) === normalizeGitUrl(gitUrl)) {
              return { id: pid, version: typeof m.version === "string" ? m.version : null };
            }
          } catch { /* not a plugin */ }
        }
      } catch { /* no plugins yet */ }
      return null;
    })();
    if (!body.confirm) {
      return c.json({
        staged: true, slug, head: staged.head,
        manifest: { name: manifest.name ?? slug, version: manifest.version ?? null, author: manifest.author ?? null, description: manifest.description ?? null },
        permissions: declaredPermissions(manifest),
        networkHosts: Array.isArray(manifest.networkHosts) ? manifest.networkHosts.filter((h): h is string => typeof h === "string") : [],
        installed,
      });
    }

    // install: the plugin's own folder when updating, else a unique one
    // under THIS app's plugins/
    let id = installed?.id ?? "";
    if (!installed) {
      const baseId = (manifest.name ?? slug).toLowerCase().replace(/[^a-z0-9-]/g, "") || slug;
      id = baseId;
      let n = 2;
      while (fs.existsSync(path.join(pluginsDir, id))) id = `${baseId}-${n++}`;
    }
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.rmSync(stagedHeadFile, { force: true });
    if (installed) fs.rmSync(path.join(pluginsDir, id), { recursive: true, force: true });
    fs.renameSync(staging, path.join(pluginsDir, id));
    // provenance + pre-grant exactly what the user just reviewed (app plugin
    // ids are namespaced <app>__<plugin> — grants key on the namespaced id)
    manifest.origin = "imported";
    manifest.source = { git: gitUrl, head: staged.head };
    fs.writeFileSync(path.join(pluginsDir, id, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    try {
      const settings = fs.existsSync(p.settings)
        ? (JSON.parse(fs.readFileSync(p.settings, "utf8")) as { pluginGrants?: Record<string, string[]> })
        : {};
      settings.pluginGrants ??= {};
      settings.pluginGrants[`${appId}__${id}`] = declaredPermissions(manifest);
      fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
    } catch { /* grants best-effort — the approve flow still works */ }
    invalidatePluginCache();
    await git.commitAll(p.root, u.username, `app(${appId}): plugin ${id} ${installed ? "updated" : "imported"} from ${gitUrl}`);
    bus.emit(u.username, "app_changed", { app: appId });
    return c.json({ ok: true, id, name: manifest.name ?? id, updated: !!installed });
  });



  // ---------- apps (SPEC-v2 §3) ----------
  app.get("/v1/apps", (c) => {
    const p = c.get("paths");
    const apps = listApps(p.apps).map((x) => ({ ...x, manifest: x.manifest }));
    return c.json({ apps, activeApp: readActiveApp(p) });
  });

  app.post("/v1/apps", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const body = await c.req.json<{ id: string; name: string; kind?: "skin" | "app" | "web" | "vite"; description?: string; author?: string }>().catch(() => null) ?? ({ id: "", name: "" });
    if (!body?.id || !body?.name) return c.json({ error: "id and name required" }, 400);
    if (body.author !== undefined && (typeof body.author !== "string" || body.author.length > 100)) {
      return c.json({ error: "author must be a string (max 100 chars)" }, 400);
    }
    try {
      const app = createAppSkeleton(p.apps, body);
      await git.commitAll(p.root, u.username, `app(${body.id}): created via API`);
      return c.json({ ok: true, ...app });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // delete an app folder outright (the picker's delete — irreversible, so the
  // client confirms first). active-app/launch-default settings pointing at it
  // are cleared; the deletion is git-committed like every other workspace change.
  app.delete("/v1/apps/:id", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const id = c.req.param("id");
    if (!readApp(p.apps, id)) return c.json({ error: "app not found" }, 404);
    const appDir = safeResolve(p.apps, id);
    fs.rmSync(appDir, { recursive: true, force: true });
    forgetInstall(p.appUpstream, id);
    invalidatePluginCache();
    try {
      const settings = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { activeApp?: string | null; launchDefault?: string | null; pluginGrants?: Record<string, string[]>; disabledPlugins?: string[]; appMcp?: Record<string, string[]> };
      let touched = false;
      if (settings.activeApp === id) { settings.activeApp = null; touched = true; }
      if (settings.launchDefault === id) { settings.launchDefault = null; touched = true; }
      // the app is gone: its MCP opt-ins mean nothing now
      if (settings.appMcp?.[id]) { delete settings.appMcp[id]; touched = true; }
      // the app's plugins die with it — their namespaced grants and disabled
      // flags must not linger in settings.json forever
      const prefix = `${id}__`;
      const grants = settings.pluginGrants ?? {};
      for (const key of Object.keys(grants)) {
        if (key.startsWith(prefix)) { delete grants[key]; touched = true; }
      }
      if (Array.isArray(settings.disabledPlugins) && settings.disabledPlugins.some((x) => x.startsWith(prefix))) {
        settings.disabledPlugins = settings.disabledPlugins.filter((x) => !x.startsWith(prefix));
        touched = true;
      }
      if (touched) fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
    } catch { /* no settings file */ }
    await git.commitAll(p.root, u.username, `app(${id}): deleted via API`);
    bus.emit(u.username, "app_changed", { app: id, deleted: true });
    return c.json({ ok: true });
  });

  app.post("/v1/apps/:id/activate", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const id = c.req.param("id");
    const app = readApp(p.apps, id);
    if (!app) return c.json({ error: "app not found (invalid manifest?)" }, 404);
    const settings = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { activeApp?: string | null };
    settings.activeApp = id;
    fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
    await git.commitAll(p.root, u.username, `app(${id}): activated`);
    bus.emit(u.username, "app_changed", { app: id });
    return c.json({ ok: true, activeApp: id });
  });

  // rename an app: moves its directory; active-app settings follow
  app.post("/v1/apps/:id/rename", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const oldId = c.req.param("id");
    const body = await c.req.json<{ id?: unknown }>().catch(() => ({}) as { id?: unknown });
    const newId = typeof body.id === "string" ? body.id.trim() : "";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(newId)) {
      return c.json({ error: "invalid app id (letters, digits, _, -; max 64)" }, 400);
    }
    if (!readApp(p.apps, oldId)) return c.json({ error: "app not found" }, 404);
    if (oldId !== newId && !renameAppDir(p.apps, oldId, newId)) {
      return c.json({ error: `rename failed (does "${newId}" already exist?)` }, 409);
    }
    if (oldId !== newId) moveInstall(p.appUpstream, oldId, newId);
    const settings = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { activeApp?: string | null };
    if (settings.activeApp === oldId) {
      settings.activeApp = newId;
      fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
    }
    if (oldId !== newId) await git.commitAll(p.root, u.username, `app(${newId}): renamed from ${oldId}`);
    invalidatePluginCache();
    evictAgents(u.username);
    bus.emit(u.username, "app_changed", { app: newId });
    return c.json({ ok: true, app: newId });
  });

  // read-only hierarchy of an app's source (no file contents) — the launch
  // picker's "what's inside" pane. Derived dirs (node_modules/dist/.git) are
  // skipped; depth/entry caps live in appTree().
  app.get("/v1/apps/:id/tree", (c) => {
    const p = c.get("paths");
    const id = c.req.param("id");
    const info = readApp(p.apps, id);
    if (!info) return c.json({ error: "app not found" }, 404);
    const tree = appTree(p.apps, id);
    if (!tree) return c.json({ error: "app not found" }, 404);
    return c.json({ app: id, tree, manifest: info.manifest });
  });

  // Export an app as a zip: every file and its live data, minus the derived
  // dirs, plus where it updates from (see apps/backup.ts). Built from the
  // engine's own copy.
  app.get("/v1/apps/:id/export", async (c) => {
    const p = c.get("paths");
    const id = c.req.param("id");
    const info = readApp(p.apps, id);
    if (!info) return c.json({ error: "app not found" }, 404);
    const source = readInstallSource(p.appUpstream, id);
    const baseline = source ? readBaseline(p.appUpstream, id) : null;
    const meta: BackupMeta = {
      format: 1,
      id,
      exportedAt: new Date().toISOString(),
      engine: ENGINE_VERSION,
      ...(source && baseline
        ? { source: { git: source.git, ref: source.ref, baselineVersion: baseline.version, ...(info.manifest.source?.head ? { head: info.manifest.source.head } : {}) } }
        : {}),
    };
    let zip: Uint8Array;
    try {
      zip = await buildBackup(info.dir, meta, baseline?.files ?? null);
    } catch (e) {
      if (e instanceof BackupError) return c.json({ error: e.message }, e.status);
      return c.json({ error: `could not export the app: ${(e as Error).message}` }, 500);
    }
    const day = new Date().toISOString().slice(0, 10);
    c.header("content-type", "application/zip");
    c.header("content-disposition", `attachment; filename="${id}-backup-${day}.zip"`);
    c.header("x-content-type-options", "nosniff");
    return c.body(new Uint8Array(zip));
  });

  // ---------- git app distribution ----------
  // Import community apps from a git URL. Two phases on one route: without
  // `confirm` the repo is cloned to a hidden staging dir and PREVIEWED (name,
  // version, bundled plugins + their permissions — the client shows the risk
  // picture before anything is installed); with `confirm` the staged copy
  // moves into apps/ and records its source for later update checks.
  const readStaged = (staging: string) => {
    const raw = JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf8"));
    const manifest = validateAppManifest(raw);
    if (!manifest) return null;
    const pluginsDir = path.join(staging, "plugins");
    const plugins = fs.existsSync(pluginsDir)
      ? fs.readdirSync(pluginsDir).filter((d) => {
          try {
            return fs.statSync(path.join(pluginsDir, d)).isDirectory() && fs.existsSync(path.join(pluginsDir, d, "plugin.js"));
          } catch { return false; }
        })
      : [];
    return { manifest, plugins };
  };

  /** Plugins bundled in a git-imported app are third-party code — they must
   *  enter the SAME grant system as directly-imported plugins: stamp origin
   *  "imported" (ungranted capabilities then need /v1/plugins/:id/approve)
   *  and pre-grant exactly what the import preview showed, because the
   *  confirm click IS the approval. Without this, a repo's bundled plugins
   *  arrive with origin undefined = fully trusted, zero approval flow. */
  const stampBundledPlugins = (p: UserPaths, appId: string, dest: string, gitUrl: string, head: string) => {
    stampPluginSources(dest, gitUrl, head);
    grantBundledPlugins(p, appId, dest, gitUrl);
  };

  /** Mark each bundled plugin as the repository's code. A plugin the user
   *  imported into the app on their own keeps its own trail. */
  const stampPluginSources = (dest: string, gitUrl: string, head: string) => {
    const pluginsDir = path.join(dest, "plugins");
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(pluginsDir); } catch { return; }
    for (const pid of dirs) {
      const mf = path.join(pluginsDir, pid, "manifest.json");
      if (!fs.existsSync(mf)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(mf, "utf8")) as { origin?: string; source?: { git?: unknown } };
        if (m.origin === "imported" && m.source?.git !== gitUrl) continue;
        m.origin = "imported";
        m.source = { git: gitUrl, head } as never;
        fs.writeFileSync(mf, JSON.stringify(m, null, 2) + "\n", "utf8");
      } catch { /* malformed manifest — grant flow will catch it */ }
    }
  };

  /** Pre-grant the permissions the repository's plugins declare, the grant
   *  the user gave by importing the app. */
  const grantBundledPlugins = (p: UserPaths, appId: string, dest: string, gitUrl: string) => {
    grantPlugins(p, appId, dest, (m) => m.source?.git === gitUrl);
  };

  /** Add each chosen plugin's declared permissions to the app's grants. */
  const grantPlugins = (p: UserPaths, appId: string, dest: string, chosen: (manifest: { source?: { git?: unknown } }) => boolean) => {
    const pluginsDir = path.join(dest, "plugins");
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(pluginsDir); } catch { return; }
    let grants: Record<string, string[]> = {};
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(p.settings, "utf8")) as Record<string, unknown>;
      grants = (settings.pluginGrants as Record<string, string[]> | undefined) ?? {};
    } catch { /* fresh settings */ }
    let touched = false;
    for (const pid of dirs) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(pluginsDir, pid, "manifest.json"), "utf8")) as { permissions?: unknown; source?: { git?: unknown } };
        if (!chosen(m)) continue;
        const key = `${appId}__${pid}`;
        grants[key] = [...new Set([...(grants[key] ?? []), ...declaredPermissions(m)])];
        touched = true;
      } catch { /* not a plugin dir */ }
    }
    if (touched) {
      settings.pluginGrants = grants;
      fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
      log.info(`[apps] granted ${appId}'s bundled plugins the permissions they declare`);
    }
  };

  /** The capabilities a plugin manifest asks for ("hooks" needs no grant). */
  const declaredPermissions = (m: { permissions?: unknown }): string[] =>
    Array.isArray(m.permissions) ? m.permissions.filter((x): x is string => typeof x === "string" && x !== "hooks") : [];

  /** What the import preview shows for each bundled plugin. */
  const previewPlugins = (dir: string, plugins: string[]) =>
    plugins.map((pid) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, "plugins", pid, "manifest.json"), "utf8")) as {
          name?: unknown; version?: unknown; description?: unknown; permissions?: unknown; networkHosts?: unknown;
        };
        return {
          id: pid,
          name: typeof m.name === "string" ? m.name : pid,
          version: typeof m.version === "string" ? m.version : null,
          description: typeof m.description === "string" ? m.description : null,
          permissions: declaredPermissions(m),
          networkHosts: Array.isArray(m.networkHosts) ? m.networkHosts.filter((h): h is string => typeof h === "string") : [],
        };
      } catch {
        return { id: pid, name: pid, version: null, description: null, permissions: [], networkHosts: [] };
      }
    });

  // Import an app from a backup zip (see apps/backup.ts), two phases like a
  // git import: the upload is unpacked into a staging folder named by a
  // random token and previewed; the confirm names that token. A file's code
  // is nobody's official release, so the install is never official, and its
  // plugins get exactly the permissions the preview listed. A backup that
  // recorded where the app updates from keeps updating from there.
  const FILE_TOKEN = /^[0-9a-f]{32}$/;
  const fileStaging = (p: UserPaths, token: string) => path.join(p.apps, ".staging", `file-${token}`);

  const fileImportId = (p: UserPaths, meta: BackupMeta | null, name: string): string => {
    const fromName = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "").slice(0, 48);
    const base = meta && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(meta.id) ? meta.id : fromName || "app";
    let id = base;
    let n = 2;
    while (fs.existsSync(path.join(p.apps, id))) id = `${base}-${n++}`;
    return id;
  };

  const readStagedSafe = (dir: string) => {
    try { return readStaged(dir); } catch { return null; }
  };

  const previewFileImport = async (c: Context<AppEnv>) => {
    const p = c.get("paths");
    if (Number(c.req.header("content-length") ?? "0") > BACKUP_MAX_BYTES) return c.json({ error: "the file is too large (over 512 MB)" }, 413);
    // previews nobody confirmed go once they are an hour old
    const stagingRoot = path.join(p.apps, ".staging");
    try {
      for (const entry of fs.readdirSync(stagingRoot)) {
        const full = path.join(stagingRoot, entry);
        if (entry.startsWith("file-") && Date.now() - fs.statSync(full).mtimeMs > 60 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true });
      }
    } catch { /* nothing staged yet */ }
    const token = nodeCrypto.randomBytes(16).toString("hex");
    const dest = fileStaging(p, token);
    let unpacked: ReturnType<typeof extractBackup>;
    try {
      unpacked = extractBackup(new Uint8Array(await c.req.arrayBuffer()), dest);
    } catch (e) {
      fs.rmSync(dest, { recursive: true, force: true });
      if (e instanceof BackupError) return c.json({ error: e.message }, e.status);
      return c.json({ error: `could not read the file: ${(e as Error).message}` }, 400);
    }
    const staged = readStagedSafe(unpacked.root);
    if (!staged) {
      fs.rmSync(dest, { recursive: true, force: true });
      return c.json({ error: "not a Chrysalis app (missing or invalid manifest.json)" }, 422);
    }
    return c.json({
      staged: true,
      file: token,
      id: fileImportId(p, unpacked.meta, staged.manifest.name),
      manifest: { name: staged.manifest.name, version: staged.manifest.version, author: staged.manifest.author ?? null },
      plugins: previewPlugins(unpacked.root, staged.plugins),
      data: fs.existsSync(path.join(unpacked.root, "data")),
      updatesFrom: unpacked.meta?.source && isValidGitUrl(unpacked.meta.source.git) ? unpacked.meta.source.git : null,
    });
  };

  const confirmFileImport = async (c: Context<AppEnv>, token: string, name: string) => {
    const u = c.get("user");
    const p = c.get("paths");
    if (!FILE_TOKEN.test(token)) return c.json({ error: "unknown upload: import the file again" }, 400);
    const dest = fileStaging(p, token);
    if (!fs.existsSync(dest)) return c.json({ error: "the upload expired: import the file again" }, 409);
    let unpacked: ReturnType<typeof locateBackup>;
    try {
      unpacked = locateBackup(dest);
    } catch (e) {
      fs.rmSync(dest, { recursive: true, force: true });
      return c.json({ error: (e as Error).message }, 422);
    }
    const { root, meta } = unpacked;
    const staged = readStagedSafe(root);
    if (!staged) {
      fs.rmSync(dest, { recursive: true, force: true });
      return c.json({ error: "not a Chrysalis app (missing or invalid manifest.json)" }, 422);
    }
    const source = meta?.source && isValidGitUrl(meta.source.git) ? meta.source : null;
    const baselineDir = path.join(root, BACKUP_META_DIR, "baseline");
    const baseline = source && fs.existsSync(baselineDir) ? readCodeTree(baselineDir) : null;
    for (const entry of fs.readdirSync(root)) {
      if (entry.startsWith(".__")) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }

    const id = fileImportId(p, meta, staged.manifest.name);
    const appDir = path.join(p.apps, id);
    fs.renameSync(root, appDir);
    fs.rmSync(dest, { recursive: true, force: true });

    const manifest = staged.manifest;
    manifest.origin = "imported";
    delete manifest.source;
    if (source && baseline) manifest.source = { git: source.git, ref: source.ref, ...(source.head ? { head: source.head } : {}) };
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    // every bundled plugin is the file's code; one the user once imported from
    // its own repository keeps that trail
    const label = name.replace(/[^\w.@ -]+/g, "_").slice(0, 120) || "backup.zip";
    try {
      for (const pid of fs.readdirSync(path.join(appDir, "plugins"))) {
        const mf = path.join(appDir, "plugins", pid, "manifest.json");
        try {
          const m = JSON.parse(fs.readFileSync(mf, "utf8")) as { origin?: string; source?: { git?: unknown } };
          if (m.origin === "imported" && typeof m.source?.git === "string" && isValidGitUrl(m.source.git)) continue;
          m.origin = "imported";
          m.source = { file: label } as never;
          fs.writeFileSync(mf, JSON.stringify(m, null, 2) + "\n", "utf8");
        } catch { /* no manifest: not a plugin the runtime loads */ }
      }
    } catch { /* no plugins */ }
    grantPlugins(p, id, appDir, () => true);
    forgetInstall(p.appUpstream, id);
    if (source && baseline) {
      writeBaseline(p.appUpstream, id, source.baselineVersion, baseline);
      writeInstallSource(p.appUpstream, id, { git: source.git, ref: source.ref, restored: true });
    }
    invalidatePluginCache();
    await git.commitAll(p.root, u.username, `app(${id}): imported from ${label}`);
    bus.emit(u.username, "app_changed", { app: id });
    return c.json({ ok: true, id });
  };

  app.post("/v1/apps/import", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    if (c.req.header("content-type")?.split(";")[0]?.trim() === "application/zip") return previewFileImport(c);
    const body = await c.req.json<{ gitUrl?: string; ref?: string; confirm?: string; head?: string; id?: string; file?: string; name?: string }>().catch(() => null) ?? ({} as never);
    if (typeof body.file === "string") return confirmFileImport(c, body.file, typeof body.name === "string" ? body.name : "");
    const gitUrl = typeof body.gitUrl === "string" ? body.gitUrl.trim() : "";
    const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : "HEAD";
    // the commit the preview showed: confirm installs THAT tree or nothing
    const reviewedHead = typeof body.head === "string" ? body.head.trim() : "";
    if (!isValidGitUrl(gitUrl)) return c.json({ error: "give a git repository URL (https://… or git@…)" }, 400);
    if (!isValidGitRef(ref)) return c.json({ error: "ref must be a branch or tag name" }, 400);
    // the Store names the install folder; without it the repository's name is used
    const requestedId = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
    if (requestedId && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(requestedId)) {
      return c.json({ error: "id must be lowercase letters, digits, - or _ (at most 64)" }, 400);
    }
    // an installed app gets new versions through its update, which merges
    // them with the user's edits and upgrades its data; importing over it
    // would do neither
    const installedFrom = listApps(p.apps).find((a) => {
      const from = installSourceOf(p, a)?.git;
      return !!from && normalizeGitUrl(from) === normalizeGitUrl(gitUrl);
    });
    if (installedFrom) {
      return c.json({ error: `${installedFrom.manifest.name} is already installed from this repository. Update it from the launcher to get its newest version.`, installed: installedFrom.id }, 409);
    }
    const slug = requestedId || (gitUrl.split(/[/:]/).pop() ?? "app").replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9-]/g, "") || "app";
    const staging = path.join(p.apps, ".staging", slug);

    if (!body.confirm) {
      fs.rmSync(staging, { recursive: true, force: true });
      try {
        const head = await gitClone(gitUrl, staging, ref);
        stripVcs(staging);
        // sidecar so the confirm phase knows the head without a .git to ask
        fs.writeFileSync(path.join(staging, ".staged-head"), head + "\n", "utf8");
        const staged = readStaged(staging);
        if (!staged) return c.json({ error: "not a Chrysalis app (missing or invalid manifest.json)" }, 422);
        return c.json({
          staged: true, slug, head,
          manifest: { name: staged.manifest.name, version: staged.manifest.version, author: staged.manifest.author ?? null },
          plugins: previewPlugins(staging, staged.plugins),
        });
      } catch (e) {
        fs.rmSync(staging, { recursive: true, force: true });
        return c.json({ error: `clone failed: ${(e as Error).message}` }, 502);
      }
    }

    // confirm: install the staged copy (or re-stage if the preview expired)
    let staged = fs.existsSync(staging) ? readStaged(staging) : null;
    let head: string | null = null;
    if (!staged) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
        head = await gitClone(gitUrl, staging, ref);
        stripVcs(staging);
        fs.writeFileSync(path.join(staging, ".staged-head"), head + "\n", "utf8");
        staged = readStaged(staging);
      } catch (e) {
        return c.json({ error: `clone failed: ${(e as Error).message}` }, 502);
      }
      if (!staged) return c.json({ error: "not a Chrysalis app (missing or invalid manifest.json)" }, 422);
      // the preview's staging was gone, so this is a FRESH clone: it must be
      // the same commit the user reviewed. Otherwise the permissions shown at
      // preview and the code installed here are two different things, and the
      // confirm click would pre-grant capabilities nobody ever saw.
      if (reviewedHead && head !== reviewedHead) {
        fs.rmSync(staging, { recursive: true, force: true });
        return c.json({ error: "the repository moved since the preview — run the import again to review what changed" }, 409);
      }
    }
    if (!head) {
      // staged-from-preview confirm: the sidecar holds the head (rev-parse
      // on the stripped tree would answer for the PARENT workspace repo)
      try {
        head = fs.readFileSync(path.join(staging, ".staged-head"), "utf8").trim();
      } catch {
        return c.json({ error: "staging expired — run the import preview again" }, 409);
      }
      // another preview of the same repository can replace the staged copy
      if (reviewedHead && head !== reviewedHead) {
        return c.json({ error: "the repository moved since the preview — run the import again to review what changed" }, 409);
      }
    }

    // another app (from elsewhere) already has this folder name: install beside it
    let id = slug;
    if (fs.existsSync(path.join(p.apps, id))) {
      let n = 2;
      while (fs.existsSync(path.join(p.apps, `${slug}-${n}`))) n++;
      id = `${slug}-${n}`;
    }
    const dest = path.join(p.apps, id);
    fs.rmSync(path.join(staging, ".staged-head"), { force: true });
    fs.renameSync(staging, dest);
    // stamp provenance so update checks know where this copy came from;
    // contentHash records the pristine code state — a mismatch later means
    // "modified since install" and the update UI warns before resetting
    const manifestPath = path.join(dest, "manifest.json");
    const manifest = staged.manifest;
    manifest.origin = "imported";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    // stamp bundled plugins BEFORE hashing — the stamp rewrites their manifests,
    // and hashing first would mark the app "modified since install" forever
    stampBundledPlugins(p, id, dest, gitUrl, head);
    manifest.source = { git: gitUrl, ref, head, contentHash: hashAppTree(dest) ?? undefined };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    // the version the next update merges against, and where it comes from
    writeBaseline(p.appUpstream, id, manifest.version, readCodeTree(dest));
    writeInstallSource(p.appUpstream, id, { git: gitUrl, ref });
    invalidatePluginCache();
    await git.commitAll(p.root, u.username, `app(${id}): imported from ${gitUrl}`);
    bus.emit(u.username, "app_changed", { app: id });
    return c.json({ ok: true, id, head });
  });

  /** Where an app's next version comes from: the repository this engine
   *  installed it from, or for an older import without that record, the
   *  source its manifest names. */
  const installSourceOf = (p: UserPaths, info: AppInfo): InstallSource | null => {
    const recorded = readInstallSource(p.appUpstream, info.id);
    if (recorded) return recorded;
    const src = info.manifest.source;
    return src?.git ? { git: src.git, ref: src.ref ?? "HEAD" } : null;
  };

  const sameTree = (a: Map<string, Buffer>, b: Map<string, Buffer>): boolean => {
    if (a.size !== b.size) return false;
    for (const [rel, body] of a) if (!b.get(rel)?.equals(body)) return false;
    return true;
  };

  /** Has the app's code changed since the version it was installed from?
   *  null when that version is not on record. */
  const codeModified = (p: UserPaths, info: AppInfo): boolean | null => {
    const base = readBaseline(p.appUpstream, info.id);
    if (!base) return info.manifest.source?.contentHash ? hashAppTree(info.dir) !== info.manifest.source.contentHash : null;
    const ours = readCodeTree(info.dir);
    if (ours.size !== base.files.size) return true;
    for (const [rel, body] of ours) if (!base.files.get(rel)?.equals(body)) return true;
    return false;
  };

  // Update check for the launcher: one ls-remote per app, in parallel, for
  // the badge on every row. Results are reused for a minute so reopening the
  // launcher does not repeat the round trips; `fresh=1` after an update.
  const updateChecks = new Map<string, { at: number; signature: string; apps: { id: string; available: boolean; remoteHead?: string | null; error?: string }[] }>();
  app.get("/v1/apps/updates", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const entries = listApps(p.apps)
      .map((app) => ({ app, source: installSourceOf(p, app) }))
      .filter((e): e is { app: AppInfo; source: InstallSource } => e.source !== null);
    const signature = entries.map((e) => `${e.app.id}:${e.source.git}:${e.source.ref}:${e.app.manifest.source?.head ?? ""}`).join("|");
    const cached = updateChecks.get(u.username);
    if (c.req.query("fresh") !== "1" && cached?.signature === signature && Date.now() - cached.at < 60_000) {
      return c.json({ apps: cached.apps });
    }
    const slow = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the repository did not answer in time")), ms));
    const apps = await Promise.all(entries.map(async ({ app, source }) => {
      const localHead = app.manifest.source?.head ?? null;
      try {
        const remoteHead = await Promise.race([gitRemoteHead(source.git, source.ref), slow(15_000)]);
        return { id: app.id, available: !!remoteHead && remoteHead !== localHead, remoteHead };
      } catch (e) {
        return { id: app.id, available: false, error: (e as Error).message };
      }
    }));
    updateChecks.set(u.username, { at: Date.now(), signature, apps });
    return c.json({ apps });
  });

  // Update check: asks the app's repository for its head (ls-remote only).
  // Nothing local moves.
  app.get("/v1/apps/:id/updates", async (c) => {
    const p = c.get("paths");
    const info = readApp(p.apps, c.req.param("id"));
    if (!info) return c.json({ error: "app not found" }, 404);
    const source = installSourceOf(p, info);
    if (!source) return c.json({ supported: false });
    const modified = codeModified(p, info);
    const localHead = info.manifest.source?.head ?? null;
    try {
      const remoteHead = await gitRemoteHead(source.git, source.ref);
      const upToDate = !remoteHead || remoteHead === localHead;
      // what the new version is and whether this engine can run it, named
      // before the Update button rather than after it fails
      const incoming = !upToDate && remoteHead ? await remoteManifest(source.git, remoteHead) : null;
      return c.json({
        supported: true,
        repository: source.git,
        version: info.manifest.version,
        localHead,
        remoteHead,
        upToDate,
        modified,
        available: incoming?.version ?? null,
        engine: incoming?.engine ?? null,
        engineOk: incoming?.engine ? satisfiesRange(incoming.engine, ENGINE_VERSION) : true,
        engineVersion: ENGINE_VERSION,
      });
    } catch (e) {
      return c.json({ supported: true, repository: source.git, error: (e as Error).message }, 200);
    }
  });

  /** The agent's brief for conflicts an update left in the files. */
  const mergeBrief = (info: AppInfo, from: string, to: string, conflicts: { path: string; reason: string }[], before: string | null, link: string | null): string => {
    const marked = conflicts.filter((x) => x.reason === "both edited" || x.reason === "no baseline");
    const kept = conflicts.filter((x) => !marked.includes(x));
    return [
      `The ${info.manifest.name} app (apps/${info.id}/) was updated from v${from} to v${to}, and some of my own edits overlapped with the update. Merge them.`,
      ...(marked.length
        ? ["", `These files now contain conflict markers: <<<<<<< your version, then ======= and the v${to} side, closed by >>>>>>> v${to}. Keep what both sides meant, remove every marker, and make sure the file still parses:`, ...marked.map((x) => `- apps/${info.id}/${x.path}`)]
        : []),
      ...(kept.length
        ? ["", "These kept my version because no text merge was possible. Check whether they need the update's change:", ...kept.map((x) => `- apps/${info.id}/${x.path} (${x.reason})`)]
        : []),
      "",
      ...(before ? [`My version from before the update is commit ${before.slice(0, 10)} in the workspace history.`] : []),
      ...(link ? [`Where the update comes from: ${link}`] : []),
      "When the files are merged, rebuild the app and check it loads.",
    ].join("\n");
  };

  /** A data upgrade may walk every chat an app has: it gets minutes and room
   *  a request never does, on a sandbox of its own. */
  const UPGRADE_LIMITS = { executionTimeoutMs: 5 * 60_000, memoryLimitBytes: 512 * 1024 * 1024 };

  /** Run the app plugins' onAppUpdate for the code now on disk. A plugin whose
   *  earlier upgrade failed upgrades from the version its data still has. What
   *  fails is recorded and retried, and returned so the person updating sees
   *  it. */
  const runAppUpdateHooks = async (u: UserRecord, p: UserPaths, appId: string, from: string | null, to: string): Promise<{ plugin: string; error: string }[]> => {
    const deps = getAppDeps(u, appId);
    const pending = readPendingUpgrade(p.appUpstream, appId)?.plugins ?? {};
    const stillPending: Record<string, string> = {};
    const failed: { plugin: string; error: string }[] = [];
    for (const plugin of enabledAppPlugins(p.apps, appId, p.settings)) {
      const since = pending[plugin.id] ?? from;
      if (since === null || !plugin.source.includes("onAppUpdate")) continue;
      const outcome = await runPluginHookOutcome(plugin, "onAppUpdate", { from: since, to }, deps, UPGRADE_LIMITS);
      if (outcome.ok) continue;
      stillPending[plugin.id] = since;
      failed.push({ plugin: plugin.manifest.name, error: outcome.error });
    }
    writePendingUpgrade(p.appUpstream, appId, stillPending);
    return failed;
  };

  /** Data upgrades left unfinished by an update, retried once per start before
   *  the app's first request, which waits for them. */
  const upgradeRetries = new Map<string, Promise<void>>();
  const retryPendingUpgrade = (u: UserRecord, p: UserPaths, appId: string): Promise<void> => {
    const key = `${u.username}/${appId}`;
    let retry = upgradeRetries.get(key);
    if (!retry) {
      retry = (async () => {
        if (!readPendingUpgrade(p.appUpstream, appId)) return;
        const failed = await runAppUpdateHooks(u, p, appId, null, readApp(p.apps, appId)?.manifest.version ?? "0.0.0");
        if (failed.length) log.warn(`[apps] ${u.username}/${appId}: data upgrade still failing: ${failed.map((f) => `${f.plugin}: ${f.error}`).join("; ")}`);
        else log.info(`[apps] ${u.username}/${appId}: finished its data upgrade`);
      })().catch((e) => log.warn(`[apps] ${u.username}/${appId}: data upgrade retry failed: ${(e as Error).message}`));
      upgradeRetries.set(key, retry);
    }
    return retry;
  };

  /** Apps an update is being applied to. One at a time per app: two would
   *  clone into the same staging folder and write the same files. */
  const updatingApps = new Set<string>();

  // Update an app as a merge: the files you changed keep your changes, the
  // ones you did not take the new version, and overlapping edits come back
  // as conflicts with nothing written until a strategy is picked. Your
  // workspace is committed first, so every outcome can be walked back.
  app.post("/v1/apps/:id/update", async (c) => {
    const id = c.req.param("id");
    const key = `${c.get("user").username}/${id}`;
    if (updatingApps.has(key)) return c.json({ error: "this app is already being updated" }, 409);
    updatingApps.add(key);
    try {
      return await updateApp(c, id);
    } finally {
      updatingApps.delete(key);
    }
  });
  const updateApp = async (c: Context<AppEnv>, id: string) => {
    const u = c.get("user");
    const p = c.get("paths");
    const info = readApp(p.apps, id);
    if (!info) return c.json({ error: "app not found" }, 404);
    const source = installSourceOf(p, info);
    if (!source) return c.json({ error: "this app has no update source: it was not installed from a repository" }, 400);
    const official = !source.restored && isOfficialSource(source.git, officialSources);
    const body = (await c.req.json().catch(() => ({}))) as { confirmDeps?: boolean; strategy?: unknown; head?: unknown };
    const strategy = UPDATE_STRATEGIES.find((x) => x === body.strategy) ?? "merge";

    const staging = path.join(p.apps, ".staging", `${id}-update`);
    let head: string;
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      head = await gitClone(source.git, staging, source.ref);
      stripVcs(staging);
      stampPluginSources(staging, source.git, head);
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      return c.json({ error: `clone failed: ${(e as Error).message}` }, 502);
    }
    const incoming = staging;
    const dropStaging = () => fs.rmSync(staging, { recursive: true, force: true });
    const incomingManifest = readStaged(incoming)?.manifest;
    if (!incomingManifest) {
      dropStaging();
      return c.json({ error: "the new version has no valid manifest.json" }, 422);
    }
    const from = info.manifest.version;
    const to = incomingManifest.version;
    if (incomingManifest.engine && !satisfiesRange(incomingManifest.engine, ENGINE_INFO.version)) {
      dropStaging();
      return c.json({ error: `v${to} needs Chrysalis engine ${incomingManifest.engine}, and this engine is v${ENGINE_INFO.version}. Update the engine first.` }, 409);
    }

    // What a third-party update would newly be able to do is reviewed before
    // anything changes: changed packages (supply-chain weight) and permissions
    // its plugins ask for that were never granted. The confirm must name the
    // commit that review showed. Official apps come from the maintainers, who
    // own that choice.
    const depFingerprint = (dir: string): string =>
      ["package.json", "package-lock.json", "bun.lock", "bun.lockb"].map((f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } }).join("\u0000");
    const depsChanged = hasPackages(incoming) && depFingerprint(info.dir) !== depFingerprint(incoming);
    const reviewedHead = typeof body.head === "string" ? body.head : null;
    if (body.confirmDeps === true && reviewedHead && reviewedHead !== head) {
      dropStaging();
      return c.json({ error: "the repository moved since you reviewed this update: check for updates again" }, 409);
    }
    const settingsNow = (() => {
      try { return JSON.parse(fs.readFileSync(p.settings, "utf8")) as { pluginGrants?: Record<string, string[]> }; } catch { return {}; }
    })();
    const permissions: { id: string; name: string; added: string[] }[] = [];
    try {
      for (const pid of fs.readdirSync(path.join(incoming, "plugins"))) {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(incoming, "plugins", pid, "manifest.json"), "utf8")) as { name?: unknown; permissions?: unknown };
          const granted = settingsNow.pluginGrants?.[`${id}__${pid}`] ?? [];
          const added = declaredPermissions(m).filter((x) => !granted.includes(x));
          if (added.length) permissions.push({ id: pid, name: typeof m.name === "string" ? m.name : pid, added });
        } catch { /* not a plugin */ }
      }
    } catch { /* no plugins */ }
    const reviewDeps = depsChanged && config.apps.packageDownloads;
    if (!official && (reviewDeps || permissions.length) && body.confirmDeps !== true) {
      if (!reviewDeps) {
        dropStaging();
        return c.json({ needsDepConfirm: true, head, deps: { added: [], changed: [], removed: [], nonRegistry: [] }, permissions });
      }
      const readDeps = (dir: string): Record<string, string> => {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
          const merged: Record<string, string> = {};
          for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
            for (const [name, spec] of Object.entries(pkg[key] ?? {})) merged[name] = spec;
          }
          return merged;
        } catch { return {}; }
      };
      const oldDeps = readDeps(info.dir);
      const newDeps = readDeps(incoming);
      const added = Object.entries(newDeps).filter(([n]) => !(n in oldDeps)).map(([name, spec]) => ({ name, spec }));
      const changed = Object.entries(newDeps).filter(([n, s]) => n in oldDeps && oldDeps[n] !== s).map(([name, spec]) => ({ name, spec, was: oldDeps[name] }));
      const removed = Object.keys(oldDeps).filter((n) => !(n in newDeps));
      // anything not resolving to the public registry is worth naming
      const nonRegistry: string[] = [];
      try {
        const lock = JSON.parse(fs.readFileSync(path.join(incoming, "package-lock.json"), "utf8")) as { packages?: Record<string, { resolved?: string }> };
        for (const [p2, entry] of Object.entries(lock.packages ?? {})) {
          if (p2 === "" || !entry?.resolved) continue;
          if (!/^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\//.test(entry.resolved)) {
            const name = p2.replace(/^node_modules\//, "").split(/\/node_modules\//).pop() ?? p2;
            nonRegistry.push(`${name} (${entry.resolved})`);
          }
        }
      } catch { /* no lock — spec strings still shown */ }
      // The text lockfile is one package per line: `"name": ["name@resolution", …]`.
      // A registry version is a bare version; anything else (git, file, a plain
      // URL) is named the same way. Binary lockfiles cannot be read this way.
      try {
        const text = fs.readFileSync(path.join(incoming, "bun.lock"), "utf8");
        for (const line of text.split("\n")) {
          const m = /^\s*"([^"]+)":\s*\[\s*"([^"]*)"(?:\s*,\s*"([^"]*)")?/.exec(line);
          if (!m) continue;
          const [, name = "", spec = "", repeated = ""] = m;
          const resolution = repeated || spec.slice(spec.lastIndexOf("@") + 1);
          if (!resolution || /^[\d^~]/.test(resolution) || resolution.startsWith("sha512-")) continue;
          if (/^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\//.test(resolution)) continue;
          nonRegistry.push(`${name} (${resolution})`);
        }
      } catch { /* no bun lock */ }
      dropStaging();
      return c.json({ needsDepConfirm: true, head, deps: { added, changed, removed, nonRegistry }, permissions });
    }

    const before = (await git.commitAll(p.root, u.username, `app(${id}): your version before the update to v${to}`)) ?? (await git.log(p.root, 1))[0]?.oid ?? null;
    let base = readBaseline(p.appUpstream, id)?.files ?? null;
    if (!base) {
      base = await recoverBaseline(p.root, id, from).catch(() => null);
      if (base) writeBaseline(p.appUpstream, id, from, base);
    }
    const theirs = readCodeTree(incoming);
    const ours = readCodeTree(info.dir);
    let result: Awaited<ReturnType<typeof mergeTrees>>;
    try {
      result = await mergeTrees(base, ours, theirs, strategy, { base: `v${from}`, theirs: `v${to}` });
    } catch (e) {
      dropStaging();
      return c.json({ error: `merge failed: ${(e as Error).message}` }, 500);
    }
    if (strategy === "merge" && result.conflicts.length) {
      dropStaging();
      return c.json({ status: "conflicts", from, to, merged: result.merged, conflicts: result.conflicts });
    }

    // all or nothing: a write that fails (a full disk, a file another program
    // holds) puts every file this update touched back the way it was
    const manifestPath = path.join(info.dir, "manifest.json");
    const manifestBefore = fs.readFileSync(manifestPath);
    try {
      applyWrites(info.dir, result.writes);
      // the incoming manifest wins for content fields; provenance stays ours
      const next = { ...incomingManifest, origin: "imported" as const, source: { git: source.git, ref: source.ref, head } };
      fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n", "utf8");
      writeBaseline(p.appUpstream, id, to, theirs);
    } catch (e) {
      let restored = true;
      try {
        restoreWrites(info.dir, result.writes.keys(), ours);
        fs.writeFileSync(manifestPath, manifestBefore);
      } catch {
        restored = false;
      }
      dropStaging();
      const why = (e as Error).message;
      log.warn(`[apps] ${u.username}/${id}: update to v${to} could not be written: ${why}`);
      return c.json({
        error: restored
          ? `The update could not be written (${why}), so nothing changed.`
          : `The update could not be written (${why}) and the app could not be put back by itself. Your version is in the workspace history${before ? ` as commit ${before.slice(0, 10)}` : ""}: ask the agent to restore apps/${id} from it.`,
      }, 500);
    }
    seedDataTemplates(incoming, info.dir);
    dropStaging();
    fs.rmSync(path.join(info.dir, "dist"), { recursive: true, force: true });
    const warnings: string[] = [];
    // installed over the old packages: if the install fails, the app keeps
    // the ones it had instead of none
    if (depsChanged && config.apps.packageDownloads) {
      const installed = await installApp(info.dir);
      if (!installed.ok) warnings.push(`Its packages did not install (${installed.log.split("\n").filter(Boolean).slice(-2).join(" ")}). Open the app to try again.`);
    }
    grantBundledPlugins(p, id, info.dir, source.git);
    if (source.restored && sameTree(readCodeTree(info.dir), theirs)) writeInstallSource(p.appUpstream, id, { git: source.git, ref: source.ref });
    invalidatePluginCache();
    evictAgents(u.username);
    const upgradeFailed = await runAppUpdateHooks(u, p, id, from, to);
    // what failed now is retried before the app's next request
    upgradeRetries.delete(`${u.username}/${id}`);
    const note = !result.conflicts.length ? "" : strategy === "agent" ? `, ${result.conflicts.length} conflicts left for the agent` : strategy === "mine" ? `, your side kept in ${result.conflicts.length} conflicts` : "";
    await git.commitAll(p.root, u.username, `app(${id}): updated v${from} → v${to}${strategy === "theirs" ? ", your edits replaced" : ""}${note}`);
    bus.emit(u.username, "app_changed", { app: id, updated: true });
    const link = `${source.git} (commit ${head.slice(0, 10)})`;
    return c.json({
      status: "applied",
      from,
      to,
      strategy,
      merged: result.merged,
      conflicts: result.conflicts,
      ...(upgradeFailed.length ? { upgradeFailed } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(strategy === "agent" && result.conflicts.length ? { agentPrompt: mergeBrief(info, from, to, result.conflicts, before, link) } : {}),
    });
  };

  // ---------- app plugin management ----------
  app.get("/v1/apps/:id/plugins", (c) => {    const p = c.get("paths");
    const id = c.req.param("id");
    const appDir = safeResolve(p.apps, id);
    if (!fs.existsSync(path.join(appDir, "manifest.json"))) return c.json({ error: "no such app" }, 404);
    const disabled = disabledAppPlugins(p.settings);
    const info = readApp(p.apps, id);
    const appSource = info ? installSourceOf(p, info)?.git : undefined;
    const plugins = discoverAppPlugins(p.apps, id).map((pl) => {
      // a plugin imported into the app on its own updates from its repository;
      // the app's bundled ones update with the app
      const git = (pl.manifest as { source?: { git?: unknown } }).source?.git;
      const repository = typeof git === "string" && isValidGitUrl(git) && (!appSource || normalizeGitUrl(git) !== normalizeGitUrl(appSource)) ? git : null;
      return {
        id: pl.id.replace(/^.*__/, ""),
        name: pl.manifest.name ?? pl.id,
        version: pl.manifest.version ?? null,
        description: pl.manifest.description ?? null,
        permissions: pl.manifest.permissions ?? [],
        networkHosts: pl.manifest.networkHosts ?? [],
        disabled: disabled.has(pl.id),
        repository,
      };
    });
    return c.json({ plugins });
  });

  // switch a plugin off without uninstalling: it stops executing entirely
  // (routes, tools, hooks, panels, host allowlists) until switched back on
  const setPluginEnabled = async (
    u: UserRecord,
    p: UserPaths,
    id: string,
    pid: string,
    enabled: boolean,
  ): Promise<{ status: 200 | 400 | 404; body: Record<string, unknown> }> => {
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(pid)) return { status: 400, body: { error: "bad plugin id" } };
    const appDir = safeResolve(p.apps, id);
    const pluginDir = path.join(appDir, "plugins", pid);
    if (!fs.existsSync(path.join(pluginDir, "manifest.json"))) return { status: 404, body: { error: "no such plugin" } };
    const key = `${id}__${pid}`;
    const settings = fs.existsSync(p.settings)
      ? (JSON.parse(fs.readFileSync(p.settings, "utf8")) as { disabledPlugins?: string[] })
      : {};
    const cur = new Set(Array.isArray(settings.disabledPlugins) ? settings.disabledPlugins : []);
    if (enabled) cur.delete(key);
    else cur.add(key);
    settings.disabledPlugins = [...cur];
    fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
    syncUserSchedules(u);
    return { status: 200, body: { ok: true, disabled: !enabled } };
  };
  app.post("/v1/apps/:id/plugins/:pid/disable", async (c) => {
    const r = await setPluginEnabled(c.get("user"), c.get("paths"), c.req.param("id"), c.req.param("pid"), false);
    return c.json(r.body, r.status);
  });
  app.post("/v1/apps/:id/plugins/:pid/enable", async (c) => {
    const r = await setPluginEnabled(c.get("user"), c.get("paths"), c.req.param("id"), c.req.param("pid"), true);
    return c.json(r.body, r.status);
  });

  app.delete("/v1/apps/:id/plugins/:pid", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const id = c.req.param("id");
    const pid = c.req.param("pid");
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(pid)) {
      return c.json({ error: "bad plugin id" }, 400);
    }
    const appDir = safeResolve(p.apps, id);
    const pluginDir = path.join(appDir, "plugins", pid);
    if (!fs.existsSync(pluginDir)) return c.json({ error: "no such plugin" }, 404);
    if (!pluginDir.startsWith(path.join(appDir, "plugins") + path.sep)) return c.json({ error: "bad path" }, 400);
    invalidatePluginCache();
    fs.rmSync(pluginDir, { recursive: true, force: true });
    // drop a stale grant if this was a git-imported plugin (keyed by namespaced id)
    try {
      const settings = fs.existsSync(p.settings)
        ? (JSON.parse(fs.readFileSync(p.settings, "utf8")) as { pluginGrants?: Record<string, string[]>; disabledPlugins?: string[] })
        : {};
      let touched = false;
      if (settings.pluginGrants?.[`${id}__${pid}`]) {
        delete settings.pluginGrants[`${id}__${pid}`];
        touched = true;
      }
      if (settings.disabledPlugins?.includes(`${id}__${pid}`)) {
        settings.disabledPlugins = settings.disabledPlugins.filter((x) => x !== `${id}__${pid}`);
        touched = true;
      }
      if (touched) fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
    } catch { /* best effort */ }
    await git.commitAll(p.root, u.username, `app(${id}): plugin ${pid} removed via API`);
    return c.json({ ok: true });
  });

  app.get("/v1/apps/active", (c) => {
    const p = c.get("paths");
    const id = readActiveApp(p);
    if (!id) return c.json({ app: null });
    const app = readApp(p.apps, id);
    return app ? c.json({ app: id, manifest: app.manifest }) : c.json({ app: null });
  });

  // ---------- app UI tier: built dist serving + install + dev overlay ----------
  const DIST_MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
    ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
    ".map": "application/json", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
  };
  // ---------- public app frames (sandboxed, cookieless) ----------
  // App pages load in a `sandbox="allow-scripts ..."` iframe, so they get an
  // opaque origin: no cookies are ever sent, module scripts are cross-origin,
  // and the CSP allows no network at all. Static files are therefore public
  // on a user-scoped path with CORS; every byte of data arrives through the
  // shell bridge (client/app-bridge.js <-> client/app-bridge-host.js).
  const frameOriginOf = (c: Context<AppEnv>): string => {
    const host = (c.req.header("host") ?? "localhost").replace(/[^A-Za-z0-9.:[\]-]/g, "");
    return `${requestIsHttps(c) ? "https" : "http"}://${host}`;
  };
  // `sandbox` applies to the response whether it is framed or navigated to
  // top-level (bookmark, PWA window, popup): the document gets an opaque
  // origin either way, so it can never read shell storage or spend the
  // session cookie on the engine's own routes. The embedding iframe's
  // sandbox attribute is not enough on its own; opening the URL directly
  // used to drop it.
  const frameCsp = (origin: string): string =>
    "sandbox allow-scripts allow-popups allow-downloads allow-forms; " +
    "default-src 'none'; " +
    `script-src ${origin} 'wasm-unsafe-eval'; ` +
    `style-src ${origin} 'unsafe-inline'; ` +
    `img-src ${origin} blob: data:; media-src ${origin} blob: data:; font-src ${origin} data:; ` +
    "connect-src 'none'; " +
    `frame-ancestors ${origin}; base-uri 'none'; form-action 'none'; ` +
    // honoured where implemented (Chromium ignores it; see app-bridge.js)
    "webrtc 'block'";
  const BRIDGE_TAG = '<script src="/client/app-bridge.js"></script>';
  const withBridge = (html: string): string => {
    const m = /<head[^>]*>/i.exec(html);
    if (!m || m.index < 0) return BRIDGE_TAG + html;
    const at = m.index + m[0].length;
    return html.slice(0, at) + BRIDGE_TAG + html.slice(at);
  };
  // Every frame file carries the sandbox CSP, not just .html: an .svg (or any
  // other document type) opened top-level would otherwise run script on the
  // engine origin with the session cookie. Subresource loads ignore it.
  const serveFrameFile = (c: Context<AppEnv>, full: string, p: UserPaths, id: string) => {
    const ext = path.extname(full).toLowerCase();
    const headers: Record<string, string> = {
      "content-type": DIST_MIME[ext] ?? "application/octet-stream",
      "cache-control": ext !== ".html" && IMMUTABLE_NAME.test(full) ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      "content-security-policy": frameCsp(frameOriginOf(c)),
      // a document policy: subresource responses don't need it (and building
      // it reads the app's plugin manifests)
      ...(ext === ".html" ? { "connection-allowlist": frameConnections(p, id) } : {}),
    };
    if (ext === ".html") return c.body(withBridge(fs.readFileSync(full, "utf8")), 200, headers);
    return c.body(new Uint8Array(fs.readFileSync(full)), 200, headers);
  };
  /** The network an app frame may still reach: this engine (its bridge answers
   *  every API call; no native connection is expected) plus hosts the app's
   *  granted plugins declare, so click-gated popups to a card's source page
   *  keep working. WebRTC is blocked either way; see
   *  FRAME_CONNECTION_ALLOWLIST. */
  const frameConnections = (p: UserPaths, id: string): string => {
    const grants = pluginGrants(p.settings);
    const hosts = new Set<string>();
    for (const plugin of enabledAppPlugins(p.apps, id, p.settings)) {
      if (!pluginGranted(plugin, "network", grants)) continue;
      for (const host of plugin.manifest.networkHosts ?? []) hosts.add(host);
    }
    if (!hosts.size) return FRAME_CONNECTION_ALLOWLIST;
    const extra = [...hosts].map((h) => ` "https://${h}"`).join("");
    return `(response-origin${extra}); webrtc=block`;
  };
  /** A frame file only if it is a regular file whose REAL location is inside
   *  the app's dist. The route is public, and a symlink in dist (shipped by an
   *  imported repo, or planted by a workspace shell) would otherwise hand any
   *  LAN visitor whatever it points at, the credentials store included. */
  const distFile = (appsDir: string, id: string, full: string): string | null => {
    try {
      // anchored on the real apps dir, NOT the real dist: a dist (or app dir)
      // that is itself a symlink must not move the root along with it
      const root = path.join(fs.realpathSync(appsDir), id, "dist");
      const real = fs.realpathSync(full);
      if (!real.startsWith(root + path.sep)) return null;
      return fs.statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  };
  const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  app.get("/app/:username/:id/*", (c) => {
    const username = c.req.param("username");
    const id = c.req.param("id");
    const p = userPaths(dataDir, username);
    const app = readApp(p.apps, id);
    if (!app) return c.json({ error: "app not found" }, 404);
    const prefix = `/app/${encodeURIComponent(username)}/${encodeURIComponent(id)}/`;
    if (!c.req.path.startsWith(prefix)) return c.json({ error: "not found" }, 404);
    const rel = c.req.path.slice(prefix.length);
    const dist = path.resolve(p.apps, id, "dist");
    if (rel === "manifest.webmanifest") {
      return c.json({
        name: app.manifest.name,
        short_name: app.manifest.name,
        start_url: prefix,
        display: "standalone",
        background_color: "#111217",
        theme_color: "#111217",
        icons: [{ src: "/client/chrysalis_logo.png", sizes: "512x512", type: "image/png" }],
      });
    }
    if (rel === "") {
      const index = distFile(p.apps, id, path.join(dist, "index.html"));
      if (!index) {
        c.header("content-security-policy", frameCsp(frameOriginOf(c)));
        c.header("connection-allowlist", frameConnections(p, id));
        c.header("cache-control", "no-store");
        c.header("access-control-allow-origin", "*");
        c.header("cross-origin-resource-policy", "cross-origin");
        armLookWatch(username, p.apps, bus);
        // the builder records a failed build here; show why, not just "missing"
        const status = readBuildStatus(path.join(p.apps, id));
        const why = status && !status.ok && status.errors.length
          ? `<div style="text-align:left;max-width:720px;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;color:#e8a0a0">${escapeHtml(status.errors.slice(0, 5).map((e) => `${e.file ?? ""}${e.line ? `:${e.line}` : ""}\n  ${e.text}`).join("\n\n"))}</div>`
          : `<div style="text-align:center;max-width:460px">This app has not been built yet. It builds when you open it in Chrysalis.</div>`;
        return c.html(withBridge(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(app.manifest.name ?? id)}</title><body style="font-family:system-ui;background:#111217;color:#888;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:16px;box-sizing:border-box">${why}</body>`));
      }
      armLookWatch(username, p.apps, bus);
      return serveFrameFile(c, index, p, id);
    }
    // dot-files in dist are the builder's bookkeeping, not the app
    if (rel.split("/").some((seg) => seg.startsWith("."))) return c.json({ error: "not found" }, 404);
    const full = path.resolve(dist, rel);
    if (full !== dist && !full.startsWith(dist + path.sep)) return c.json({ error: "bad path" }, 400);
    const file = distFile(p.apps, id, full);
    if (file) return serveFrameFile(c, file, p, id);
    return c.json({ error: "not found" }, 404);
  });

  // ---------- in-browser builds (src/builder) ----------
  // The engine never runs a build tool over app files. The shell's builder
  // (a sandboxed, cookieless, network-less iframe) reads ONE app's files
  // through /build/fs and hands back plain files that land in its dist/.
  // All of these are app management: the bridge refuses them to app frames.
  const buildKey = (u: UserRecord, id: string) => `${u.username}/${id}`;
  const buildableApp = (c: Context<AppEnv>): { id: string; dir: string } | null => {
    const id = c.req.param("id") ?? "";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) return null;
    const p = c.get("paths");
    if (!readApp(p.apps, id)) return null;
    return { id, dir: path.join(p.apps, id) };
  };

  // Runtime errors the app frame's dev runtime caught (uncaught throws,
  // unhandled rejections, console.error). The shell pane forwards them from
  // the frame; they land beside the build status, tagged with the source rev
  // they ran on, and app_check reads them back. Untrusted display data: caps,
  // never evaluation.
  //
  // Both report routes share this sanitizer: entries become bounded and
  // plausible (kind stays a short identifier, `at` outside a sane window
  // becomes now so a bogus timestamp cannot break formatting downstream,
  // text/stack are capped). An app can post these events itself, so nothing
  // here trusts their shape.
  const cleanClientEvents = (
    events: unknown,
    opts: { tail: boolean; defaultKind: string },
  ): Array<{ kind: string; text: string; stack?: string; at: number }> => {
    const list = Array.isArray(events) ? (opts.tail ? events.slice(-40) : events.slice(0, 20)) : [];
    const now = Date.now();
    return list.flatMap((raw) => {
      const e = raw as { kind?: unknown; text?: unknown; stack?: unknown; at?: unknown } | null;
      if (!e || typeof e.text !== "string" || !e.text.trim()) return [];
      const at = typeof e.at === "number" && Number.isInteger(e.at) && e.at > 0 && e.at < now + 86_400_000 ? e.at : now;
      return [{
        kind: typeof e.kind === "string" && /^[a-z0-9_-]{1,16}$/i.test(e.kind) ? e.kind.toLowerCase() : opts.defaultKind,
        text: e.text.trim().slice(0, 2000),
        ...(typeof e.stack === "string" && e.stack ? { stack: e.stack.slice(0, 4000) } : {}),
        at,
      }];
    });
  };

  app.post("/v1/apps/:id/client-errors", async (c) => {
    const a = buildableApp(c);
    if (!a) return c.json({ error: "app not found" }, 404);
    const capped = await readCappedBody(c, 256 * 1024);
    if (!capped.ok) {
      c.header("connection", "close");
      return c.json({ error: capped.error }, 413);
    }
    let body: { events?: unknown };
    try {
      body = JSON.parse(new TextDecoder().decode(capped.bytes)) as typeof body;
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    const rev = sourceRev(a.dir);
    const events = cleanClientEvents(body.events, { tail: false, defaultKind: "error" }).map((e) => ({ ...e, rev }));
    writeClientErrors(a.dir, events);
    return c.json({ ok: true, stored: events.length });
  });

  // Page prints the app frame captured (console.log/info/warn/debug). Same
  // route shape as client errors: the shell pane forwards them, and the
  // agent's app_console reads them back like a test log. Display data only.
  app.post("/v1/apps/:id/client-logs", async (c) => {
    const a = buildableApp(c);
    if (!a) return c.json({ error: "app not found" }, 404);
    const capped = await readCappedBody(c, 256 * 1024);
    if (!capped.ok) {
      c.header("connection", "close");
      return c.json({ error: capped.error }, 413);
    }
    let body: { events?: unknown };
    try {
      body = JSON.parse(new TextDecoder().decode(capped.bytes)) as typeof body;
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    const rev = sourceRev(a.dir);
    const events = cleanClientEvents(body.events, { tail: true, defaultKind: "log" }).map((e) => ({ ...e, rev }));
    writeClientLogs(a.dir, events);
    return c.json({ ok: true, stored: events.length });
  });

  app.get("/v1/apps/:id/build", async (c) => {
    const a = buildableApp(c);
    if (!a) return c.json({ error: "app not found" }, 404);
    // whoever asks is about to build or show it: source edits must reach them
    armLookWatch(c.get("user").username, c.get("paths").apps, bus);
    const buildable = fs.existsSync(path.join(a.dir, "index.html"));
    const rev = sourceRev(a.dir);
    const status = readBuildStatus(a.dir);
    const built = fs.existsSync(path.join(a.dir, "dist", "index.html"));
    const dev = status?.mode === "development" ? readDevMeta(a.dir) : null;
    // a dev dist whose snapshot/deps files are gone can never load; treat it
    // as unbuilt so a fresh full build replaces it instead of serving
    // references to files that are not there
    const lostDev = status?.mode === "development" && status.ok && !dev;
    // a failed build of the same sources is not retried until they change.
    // The builder stamp is NOT consulted here: an open page running an older
    // host would rebuild on every open and never re-stamp, looping forever.
    // app_check is the one that distrusts a stale stamp, explicitly.
    const needsBuild = buildable && (!status || status.rev !== rev || (status.ok && !built) || lostDev);
    // packages still landing: a build now fails on imports that are moments
    // away, so the builder holds off until the install ends
    const installing = packagesBusy(a.dir);
    return c.json(
      { rev, buildable, needsBuild, installing, status, dev },
      200,
      { "cache-control": "no-store" },
    );
  });

  app.post("/v1/apps/:id/build/lease", async (c) => {
    const a = buildableApp(c);
    if (!a) return c.json({ error: "app not found" }, 404);
    const body = await c.req.json<{ holder?: unknown; release?: unknown; force?: unknown; busy?: unknown }>().catch(() => ({}) as { holder?: unknown; release?: unknown; force?: unknown; busy?: unknown });
    if (typeof body.holder !== "string" || !/^[a-z0-9]{8,64}$/.test(body.holder)) return c.json({ error: "holder required" }, 400);
    return c.json({ granted: takeLease(buildKey(c.get("user"), a.id), body.holder, { release: body.release === true, force: body.force === true, busy: body.busy === true }) });
  });

  app.post("/v1/apps/:id/build/fs", async (c) => {
    const a = buildableApp(c);
    if (!a) return c.json({ error: "app not found" }, 404);
    const capped = await readCappedBody(c, 4 * 1024 * 1024);
    if (!capped.ok) return c.json({ error: capped.error }, 413);
    let ops: unknown;
    try {
      ops = (JSON.parse(new TextDecoder().decode(capped.bytes)) as { ops?: unknown }).ops;
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    if (!Array.isArray(ops) || ops.length > MAX_BATCH_OPS) return c.json({ error: `ops must be an array of at most ${MAX_BATCH_OPS}` }, 400);
    const clean = ops.filter((o): o is FsOp => !!o && typeof o === "object" && typeof (o as { op?: unknown }).op === "string");
    return c.json({ results: appFsOps(c.get("paths").apps, a.id, clean) });
  });

  app.put("/v1/apps/:id/build/output", async (c) => {
    const u = c.get("user");
    const a = buildableApp(c);
    if (!a) return c.json({ error: "app not found" }, 404);
    const capped = await readCappedBody(c, 384 * 1024 * 1024);
    if (!capped.ok) {
      c.header("connection", "close");
      return c.json({ error: capped.error }, 413);
    }
    let body: { holder?: unknown; rev?: unknown; builder?: unknown; output?: unknown };
    try {
      body = JSON.parse(new TextDecoder().decode(capped.bytes)) as typeof body;
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    // only the tab holding the lease writes, so two builders never interleave
    if (typeof body.holder !== "string" || leaseHolder(buildKey(u, a.id)) !== body.holder) return c.json({ error: "another tab is building this app" }, 409);
    const out = checkOutput(body.output);
    if (typeof out === "string") return c.json({ error: out }, 400);
    const rev = typeof body.rev === "string" && body.rev.length < 100 ? body.rev : sourceRev(a.dir);
    const builder = typeof body.builder === "string" && body.builder.length <= 100 ? body.builder : undefined;
    try {
      writeOutput(c.get("paths").apps, a.id, out, rev, builder);
    } catch (e) {
      return c.json({ error: `writing the build failed: ${(e as Error).message}` }, 500);
    }
    if (!out.ok) log.warn(`[build] ${u.username}/${a.id} failed: ${out.errors[0]?.text ?? "unknown error"}`);
    bus.emit(u.username, "app_built", {
      app: a.id,
      kind: out.hot ? "hot" : "full",
      mode: out.mode,
      ok: out.ok,
      holder: body.holder,
      ...(out.hot ? { seq: out.hot.seq } : {}),
      ...(out.errors.length ? { errors: out.errors.slice(0, 5) } : {}),
    });
    return c.json({ ok: true });
  });

  app.post("/v1/apps/:id/install", async (c) => {
    const p = c.get("paths");
    const id = c.req.param("id");
    if (!readApp(p.apps, id)) return c.json({ error: "app not found" }, 404);
    const dir = path.join(p.apps, id);
    if (!hasPackages(dir)) return c.json({ error: "this app has no package.json; nothing to install" }, 400);
    if (!config.apps.packageDownloads) return c.json({ error: "package downloads are off (apps.packageDownloads in config.yaml)" }, 403);
    const res = await installApp(dir);
    // node_modules changes are invisible to the app watcher; tell open pages
    // to rebuild so an unresolved-import error clears once the dep lands
    if (res.ok) bus.emit(c.get("user").username, "build_needed", { app: id, paths: ["package.json"] });
    return c.json(res, res.ok ? 200 : 500);
  });

  // /app/<id>/ — legacy path. The app page moved to the cookieless
  // /app/<user>/<id>/ frame surface; redirect old links so nothing serves a
  // same-origin (unsandboxed) app document any more.
  app.get("/app/:id/", (c) => {
    const p = c.get("paths");
    const id = c.req.param("id");
    if (!readApp(p.apps, id)) return c.json({ error: "app not found" }, 404);
    return c.redirect(`/app/${encodeURIComponent(c.get("user").username)}/${encodeURIComponent(id)}/`);
  })

  app.get("/app/:id/manifest.webmanifest", (c) => {
    const p = c.get("paths");
    const id = c.req.param("id");
    const app = readApp(p.apps, id);
    if (!app) return c.json({ error: "app not found" }, 404);
    return c.json({
      name: app.manifest.name,
      short_name: app.manifest.name,
      start_url: `/app/${encodeURIComponent(c.get("user").username)}/${encodeURIComponent(id)}/`,
      display: "standalone",
      background_color: "#111217",
      theme_color: "#111217",
      icons: [{ src: "/client/chrysalis_logo.png", sizes: "512x512", type: "image/png" }],
    });
  });

  // standalone app window (the shell's Fullscreen button): the host page for
  // one sandboxed app frame, with the same bridge the shell runs.
  app.get("/standalone", authMiddleware, (c) => {
    const u = c.get("user");
    const id = c.req.query("app") ?? "";
    const app = readApp(c.get("paths").apps, id);
    if (!app) return c.json({ error: "app not found" }, 404);
    const safeId = id.replace(/[^a-z0-9_-]/gi, "");
    const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, viewport-fit=cover, initial-scale=1, maximum-scale=1.0, user-scalable=no, interactive-widget=resizes-content" />
<title>${safeId}</title>
<script src="/client/app-bridge-host.js"></script>
<script src="/client/builder/host.js"></script>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#111217}iframe{border:0;width:100%;height:100vh;height:100dvh;display:block}
#boot{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:#111217;color:#8a8f98;font:13px system-ui;z-index:2}
#boot .spin{width:16px;height:16px;border:2px solid #2a2e36;border-top-color:#8a8f98;border-radius:50%;animation:sp 0.9s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
</style></head>
<body><iframe id="frame" title="${safeId}" sandbox="allow-scripts allow-popups allow-downloads allow-forms"></iframe>
<div id="boot"><div class="spin"></div><div id="bootmsg">Opening…</div></div>
<script>
  var frame = document.getElementById("frame");
  var appId = ${JSON.stringify(safeId)};
  var username = ${JSON.stringify(u.username)};
  var boot = document.getElementById("boot");
  var bootmsg = document.getElementById("bootmsg");
  var loaded = false;
  var hide = function () { if (!loaded) { loaded = true; boot.style.display = "none"; } };
  var fail = function () { bootmsg.textContent = "The build failed. This window shows the app's last good build."; };
  ChrysalisBridgeHost.serve(frame, appId, username, ${officialApp(c.get("paths"), app)});
  var load = function () { boot.style.display = "flex"; loaded = false; frame.src = ChrysalisBridgeHost.frameSrc(appId, username); };
  // the same signal the shell's app pane waits for, plus a load fallback
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.__chrysalisRuntime === 1 && d.t === "ready") hide();
  });
  frame.addEventListener("load", function () { setTimeout(hide, 250); });
  if (window.ChrysalisBuilder) {
    // the app is built in this browser before it first shows (same builder the
    // shell uses, lease and all); the overlay reports the build's progress
    var w = ChrysalisBuilder.watch(appId, function (s) {
      if (s.phase === "building") bootmsg.textContent = "Building the app…";
      else if (s.phase === "waiting") bootmsg.textContent = s.message || "Waiting for the build…";
      else if (s.phase === "error") fail();
      else bootmsg.textContent = "Opening…";
    }, load);
    w.ready.then(function () { if (!frame.getAttribute("src")) load(); }, function () { fail(); if (!frame.getAttribute("src")) load(); });
  } else { load(); }
</script>
</body></html>`;
    c.header("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    c.header("cache-control", "no-store");
    return c.html(html);
  });

  // paste an Exa API key → stored in the credential store (never git); the
  // default web-search MCP server is enabled and picks the key up via its
  // @credential:exa ref
  app.post("/v1/mcp/exa-key", async (c) => {
    const u = c.get("user");
    const p = c.get("paths");
    const body = await c.req.json<{ key?: unknown }>().catch(() => ({}) as { key?: unknown });
    if (typeof body.key !== "string" || !body.key.trim()) return c.json({ error: "key required" }, 400);
    const auth = readAuth(p);
    auth["exa"] = { type: "api_key", key: body.key.trim() };
    writeAuth(p, auth);
    // enable the preset in mcp.json (idempotent; keeps any other servers)
    const mcpFile = p.mcp;
    let cfg: { servers: Record<string, McpServerConfig> } = { servers: {} };
    try {
      cfg = JSON.parse(fs.readFileSync(mcpFile, "utf8")) as { servers: Record<string, McpServerConfig> };
    } catch { /* fresh */ }
    cfg.servers["web-search"] = { ...WEB_SEARCH_PRESET, enabled: true };
    fs.writeFileSync(mcpFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    mcpRegistries.delete(u.username); // fresh registry reconnects with the key
    void getMcp(u).listTools().catch(() => undefined);
    evictAgents(u.username);
    return c.json({ ok: true });
  });

  // Same-origin image proxy. App pages ship under a locked-down CSP
  // (img-src 'self'), so remote art — marketplace thumbnails and the like —
  // must come through the engine. The gate is the union of the app's plugins'
  // networkHosts allowlists: an app can only pull images from hosts its
  // plugins already declared, and every redirect hop is re-validated.
  app.get("/v1/apps/:appId/img", async (c) => {
    const u = c.get("user");
    const appId = c.req.param("appId");
    let url: URL;
    try {
      url = new URL(c.req.query("url") ?? "");
    } catch {
      return c.json({ error: "invalid url" }, 400);
    }
    if (url.protocol !== "https:") return c.json({ error: "https url required" }, 400);
    // image CDNs live on 443; explicit ports would turn allowlisted hostnames
    // into a port scanner against those hosts
    if (url.port) return c.json({ error: "port must be the https default" }, 400);
    const p = userPaths(dataDir, u.username);
    if (!readApp(p.apps, appId)) return c.json({ error: "app not found" }, 404);
    const hosts = new Set<string>();
    const suffixes: string[] = [];
    const grants = pluginGrants(p.settings);
    for (const plugin of enabledAppPlugins(p.apps, appId, p.settings)) {
      // a declared hostname only counts when the network permission is
      // actually granted; otherwise an imported plugin with no grants could
      // still make the engine fetch on its behalf (a data-carrying URL query
      // leaves even when the response is not an image)
      if (!pluginGranted(plugin, "network", grants)) continue;
      for (const host of plugin.manifest.networkHosts ?? []) {
        if (host.startsWith("*.")) suffixes.push(host.slice(1));
        else hosts.add(host);
      }
    }
    const hostAllowed = (hostname: string) => hosts.has(hostname) || suffixes.some((s) => hostname.endsWith(s));
    if (!hostAllowed(url.hostname)) {
      return c.json({ error: `host not allowlisted by any ${appId} plugin: ${url.hostname}` }, 403);
    }
    const CAP = 8 * 1024 * 1024;
    try {
      let current = url;
      for (let hop = 0; hop < 3; hop++) {
        await assertPublicHost(current.hostname);
        const res = await fetch(current, {
          headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36", accept: "image/*" },
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) return c.json({ error: "redirect without location" }, 502);
          const next = new URL(loc, current);
          if (next.protocol !== "https:" || next.port || !hostAllowed(next.hostname)) {
            return c.json({ error: `redirect to non-allowlisted host: ${next.hostname}` }, 403);
          }
          current = next;
          continue;
        }
        if (!res.ok) return c.json({ error: `upstream ${res.status}` }, 502);
        const type = res.headers.get("content-type") ?? "";
        if (!type.startsWith("image/")) return c.json({ error: `not an image (${type || "unknown type"})` }, 415);
        if (Number(res.headers.get("content-length") ?? 0) > CAP) return c.json({ error: "image too large" }, 413);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > CAP) return c.json({ error: "image too large" }, 413);
        c.header("cache-control", "private, max-age=86400");
        // an allowlisted host can still serve image/svg+xml: opened top-level
        // it would be a script page on the engine origin
        return c.body(buf, 200, { "content-type": type, "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" });
      }
      return c.json({ error: "too many redirects" }, 502);
    } catch (e) {
      return c.json({ error: `image fetch failed: ${(e as Error).message}` }, 502);
    }
  });

  // plugin-provided UI panels: an app plugin can export uiPanel(host)
  // returning a declarative panel (label, icon, items, fields, actions).
  // The client renders panels with one generic renderer — a plugin that ships
  // a panel owns its UI presence; remove the plugin and the panel is gone.
  // Reserved path so it can never collide with plugin routes.
  app.get("/v1/apps/:appId/__panels", async (c) => {
    const u = c.get("user");
    const appId = c.req.param("appId");
    const p = userPaths(dataDir, u.username);
    if (!readApp(p.apps, appId)) return c.json({ error: "app not found" }, 404);
    const deps = getAppDeps(u, appId);
    const panels: unknown[] = [];
    for (const plugin of enabledAppPlugins(p.apps, appId, p.settings)) {
      const res = await runPluginHook(plugin, "uiPanel", {}, deps);
      if (res && typeof res === "object" && typeof (res as { label?: unknown }).label === "string") {
        panels.push(res);
      }
    }
    return c.json({ panels });
  });

  // cancel the in-flight generation for a chat: aborts the provider stream;
  // whatever partial reply exists commits mid-sentence
  app.post("/v1/apps/:appId/__abort", async (c) => {
    const u = c.get("user");
    const appId = c.req.param("appId");
    const body = await c.req.json<{ chatId?: string }>().catch(() => ({ chatId: undefined }));
    if (!body.chatId) return c.json({ error: "chatId required" }, 400);
    const key = `${u.username}|${appId}|${body.chatId}`;
    cancelledGens.add(key);
    const ctl = genAborts.get(key);
    if (!ctl) return c.json({ ok: true, active: false });
    ctl.abort();
    return c.json({ ok: true, active: true });
  });

  // app route dispatch: /v1/apps/<activeAppId>/<rest...> → bundled plugins with
  // routes permission exporting handleRoute(req, host). First non-null wins.
  /** Shared app-route dispatch. */
  const dispatchAppRoute = async (
    u: UserRecord,
    appId: string,
    method: string,
    rel: string,
    query: Record<string, string>,
    body: unknown,
  ): Promise<{ status: number; payload: unknown; contentType?: string } | null> => {
    const p = userPaths(dataDir, u.username);
    if (appId === "active" || !readApp(p.apps, appId)) return { status: 404, payload: { error: "app not found" } };
    await retryPendingUpgrade(u, p, appId);
    const deps = getAppDeps(u, appId);
    // pending changes that predate this route (agent writes, shell edits) —
    // committed under their own label after the route so a sweep never
    // attributes out-of-band edits to whatever request happened to fire
    const dirtyBefore = await git.changedPaths(p.root).catch(() => [] as string[]);
    for (const plugin of enabledAppPlugins(p.apps, appId, p.settings)) {
      const payload = body && typeof body === "object" ? (body as { zipBase64?: string }).zipBase64 : undefined;
      const res = await runPluginRoute(plugin, { method, path: rel, query, body, ...(typeof payload === "string" ? { zipBase64: payload } : {}) }, deps);
      if (res) {
        // app data writes auto-commit (undo parity); failed routes (500) never
        // commit — a crashing plugin must not sweep unrelated changes in.
        if ((res.status ?? 200) < 400) {
          if (dirtyBefore.length > 0) {
            const preview = dirtyBefore.slice(0, 3).join(", ") + (dirtyBefore.length > 3 ? ` +${dirtyBefore.length - 3} more` : "");
            await git.commitPaths(p.root, u.username, `out-of-band: ${preview}`, dirtyBefore).catch(() => undefined);
          }
          await git.commitAll(p.root, u.username, `app(${appId}): ${method} ${rel}`).catch(() => undefined);
        }
        if (res.json !== undefined) return { status: res.status ?? 200, payload: res.json };
        return { status: res.status ?? 200, payload: res.text ?? "", ...(res.contentType ? { contentType: res.contentType } : {}) };
      }
    }
    return null;
  };

  app.all("/v1/apps/:appId/*", async (c) => {
    const u = c.get("user");
    const appId = c.req.param("appId");
    const rel = c.req.path.slice(`/v1/apps/${appId}`.length) || "/";
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.query())) query[k] = String(v);
    let body: unknown = undefined;
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const cap = rel.startsWith("/import/") ? 220 * 1024 * 1024 : 1024 * 1024;
      const capped = await readCappedBody(c, cap);
      // early response without consuming the body poisons the socket for
      // keep-alive reuse — tell the client (and node) to close it
      if (!capped.ok) { c.header("connection", "close"); return c.json({ error: capped.error }, 413); }
      const raw = new TextDecoder().decode(capped.bytes);
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
    }
    const got = await dispatchAppRoute(u, appId, c.req.method, rel, query, body);
    if (got === null) return c.json({ error: "no route" }, 404);
    if (typeof got.payload === "string") {
      const ct = got.contentType ?? "text/plain; charset=utf-8";
      // response-level sandbox on EVERY text response: even if the app (or
      // the user) navigates to this route, the document is opaque-origin and
      // scripts are off. Matching "active" types failed open: a leading space
      // or any +xml type still rendered as a live document.
      const headers: Record<string, string> = {
        "content-type": ct,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-security-policy": "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
      };
      return c.body(got.payload, got.status as 200, headers);
    }
    return c.json(got.payload, got.status as 200);
  });

  app.get("/v1/assets", (c) => {
    const viewer = c.get("bridgeApp") ?? null;
    return c.json({ assets: assets.listAssets(c.get("paths")).filter((r) => assets.assetVisibleTo(r, viewer)) });
  });
  app.put("/v1/assets", async (c) => {
    const p = c.get("paths");
    const mime = c.req.header("content-type") ?? "application/octet-stream";
    const name = c.req.query("name") ?? null;
    const capped = await readCappedBody(c, 64 * 1024 * 1024);
    if (!capped.ok) { c.header("connection", "close"); return c.json({ error: capped.error }, 413); }
    try {
      return c.json(assets.putAsset(p, Buffer.from(capped.bytes), mime, name, c.get("bridgeApp")?.id ?? null));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 413);
    }
  });
  app.get("/v1/assets/:id", (c) => {
    const got = assets.getAsset(c.get("paths"), c.req.param("id"));
    if (!got || !assets.assetVisibleTo(got.record, c.get("bridgeApp") ?? null)) return c.json({ error: "not found" }, 404);
    // SECURITY (SPEC-v2 §S4): no sniffing; dangerous mimes never render inline on
    // the API origin (stored-XSS guard for the future client).
    const mime = got.record.mime.toLowerCase();
    const dangerous = /(^|\/)(html|svg|xhtml|xml|javascript|ecmascript)(\+xml)?$|(^text\/)/.test(mime) && !/text\/plain/.test(mime);
    const inlineSafe = /^(image\/|audio\/|video\/|font\/|text\/plain)/.test(mime);
    const disposition = dangerous || !inlineSafe ? "attachment" : "inline";
    return c.body(new Uint8Array(got.bytes), 200, {
      "content-type": got.record.mime,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "content-disposition": `${disposition}; filename="${(got.record.name ?? got.record.id).replace(/["\\]/g, "")}"`,
    });
  });

  // ---------- admin ----------
  app.post("/v1/admin/users", async (c) => {
    try {
      requireAdmin(c);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 403);
    }
    const body = await c.req.json<{ username: string; role?: "user" | "admin"; password: string }>();
    if (!body.username) return c.json({ error: "username required" }, 400);
    try {
      const { user, token } = users.create(body.username, body.role ?? "user", { password: body.password });
      const p = await provisionAccount(user.username);
      return c.json({ username: user.username, role: user.role, token, note: "API token shown once — the user signs in from the login screen", dir: p.root });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.get("/v1/admin/users", (c) => {
    try {
      requireAdmin(c);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 403);
    }
    return c.json({ users: users.publicList() });
  });
  // set a user's password (accounts always keep one), enable/disable the account
  app.patch("/v1/admin/users/:username", async (c) => {
    try {
      requireAdmin(c);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 403);
    }
    const body = await c.req.json<{ password?: string; enabled?: boolean; current?: string }>();
    const username = c.req.param("username");
    if (!users.get(username)) return c.json({ error: "user not found" }, 404);
    try {
      if (body.password !== undefined) {
        if (typeof body.password !== "string" || body.password.length < 4 || body.password.length > 128) {
          return c.json({ error: "password must be 4-128 chars" }, 400);
        }
        // setting any password re-proves who is at the keyboard: the acting
        // admin's own current password, the same gate a self-service change
        // goes through
        if (!users.checkPassword(c.get("user").username, body.current ?? "")) {
          return c.json({ error: "Your current password is incorrect" }, 403);
        }
        users.setPassword(username, body.password);
        signOutEverywhere(c, username, true);
      }
      if (typeof body.enabled === "boolean") {
        if (!body.enabled && username === c.get("user").username) {
          return c.json({ error: "you cannot disable your own account" }, 400);
        }
        users.setEnabled(username, body.enabled);
        const target = users.get(username);
        if (!body.enabled) stopUserSchedules(username);
        else if (target) syncUserSchedules(target);
      }
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return c.json({ user: users.publicList().find((x) => x.username === username) });
  });
  app.delete("/v1/admin/users/:username", (c) => {
    try {
      requireAdmin(c);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 403);
    }
    const username = c.req.param("username");
    if (username === c.get("user").username) return c.json({ error: "you cannot delete your own account" }, 400);
    const admins = users.list().filter((x) => x.role === "admin");
    const target = users.get(username);
    if (!target) return c.json({ error: "user not found" }, 404);
    if (target.role === "admin" && admins.length <= 1) {
      return c.json({ error: "cannot delete the last admin" }, 400);
    }
    if (!users.delete(username)) return c.json({ error: "user not found" }, 404);
    signOutEverywhere(c, username, false);
    stopUserSchedules(username);
    // keep the user's files on disk (their workspace may be restored by
    // recreating the user); only the account is gone
    return c.json({ ok: true });
  });

  // ---------- server settings (config.yaml) ----------
  app.get("/v1/admin/server", (c) => {
    try {
      requireAdmin(c);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 403);
    }
    if (!deps.settings) return c.json({ error: "server settings are not available in this engine" }, 404);
    return c.json(deps.settings.describe());
  });
  app.get("/v1/admin/server/release", async (c) => {
    try {
      requireAdmin(c);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 403);
    }
    const release = await latestRelease();
    if (!release?.newer) return c.json({ release });
    // apps that say which engine they need and would not get it: named before
    // the update, not discovered after it
    const incompatibleApps: { name: string; needs: string }[] = [];
    for (const account of users.list()) {
      for (const info of listApps(userPaths(dataDir, account.username).apps)) {
        const needs = info.manifest.engine;
        if (!needs || satisfiesRange(needs, release.version)) continue;
        if (!incompatibleApps.some((a) => a.name === info.manifest.name && a.needs === needs)) incompatibleApps.push({ name: info.manifest.name, needs });
      }
    }
    return c.json({ release: { ...release, incompatibleApps } });
  });
  app.get("/v1/admin/server/update", (c) => {
    try {
      requireAdmin(c);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 403);
    }
    return c.json(updateState());
  });
  app.post("/v1/admin/server/update", async (c) => {
    try {
      requireAdmin(c);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 403);
    }
    if (!SELF_UPDATE || !deps.restart) return c.json({ error: "this copy of Chrysalis cannot update itself" }, 400);
    const release = await latestRelease();
    if (!release?.newer || !release.asset) return c.json({ error: "no update to install" }, 409);
    return c.json(startUpdate(release.version, release.asset, deps.restart));
  });
  app.put("/v1/admin/server", async (c) => {
    try {
      requireAdmin(c);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 403);
    }
    if (!deps.settings) return c.json({ error: "server settings are not available in this engine" }, 404);
    const body = await c.req.json<{ changes?: Record<string, unknown> }>().catch(() => null);
    if (!body?.changes || typeof body.changes !== "object" || Array.isArray(body.changes)) return c.json({ error: "changes required" }, 400);
    const r = deps.settings.update(body.changes);
    if ("error" in r) return c.json({ error: r.error }, 400);
    log.info(`[settings] ${c.get("user").username} changed ${Object.keys(body.changes).join(", ")}`);
    return c.json({ ...r.info, moved: r.moved });
  });

  app.onError((err, c) => {
    // full detail to the engine log; clients get a generic message (raw
    // err.message can leak paths and internals)
    console.error("[route error]", c.req.method, c.req.path, err);
    return c.json({ error: "internal error (see the engine log)" }, 500);
  });

  // plugin timers run from the start, not from the first signed-in request
  for (const u of users.list()) if (u.enabled !== false) syncUserSchedules(u);

  return app;
}
