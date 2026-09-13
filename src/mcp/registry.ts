/**
 * Per-user MCP registry (SPEC §5.5): servers defined in the user's mcp.json,
 * which lives OUTSIDE the workspace beside their credentials. A stdio entry is
 * a command the engine runs on the host and an http entry is unrestricted
 * egress, so the user writes that file through Settings and nothing in the
 * workspace — agent, shell or imported app — can author one. Tools are
 * namespaced `mcp_<server>_<tool>` and only reach chats that opt into tool
 * calling (SPEC §5.3).
 *
 * mcp.json shape:
 * {
 *   "servers": {
 *     "dice": { "type": "stdio", "command": "node", "args": ["dice.mjs"] },
 *     "weather": { "type": "http", "url": "https://t.example/mcp", "headers": {...} }
 *   }
 * }
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { log } from "../logger.js";
import { assertMcpHost } from "../net-guard.js";
import { ENGINE_VERSION } from "../install.js";


export interface McpServerConfig {
  /** stdio = local process; http = streamable HTTP; sse = legacy HTTP+SSE
   * (all three are the standard coding-agent surface) */
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  /** who may call its tools: "all" (the agent and every app, the default) or
   *  "agent" (the engine's own agent only). enabled:false turns it off. */
  share?: "all" | "agent";
}

export type CredentialMap = Record<string, unknown>;

/**
 * Resolve env values for a stdio server: plain strings pass through; values of
 * the form "@credential:<id>" are replaced with the key stored in the user's
 * credential store (OUTSIDE the workspace/git) under that id. So mcp.json —
 * which is git-tracked — never contains secrets.
 */
export function resolveMcpEnv(
  env: Record<string, string> | undefined,
  credentials: () => CredentialMap,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && v.startsWith("@credential:")) {
      const id = v.slice("@credential:".length);
      out[k] = (credentials()[id] as { key?: string } | undefined)?.key ?? "";
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Hosts a stored credential may be sent to from an HTTP server's headers.
 *  A header can name a credential only where the key's own service lives:
 *  otherwise editing an entry's URL would carry a key to any server. */
const HEADER_CREDENTIAL_HOSTS: Record<string, readonly string[]> = {
  exa: ["mcp.exa.ai"],
};

/** Web search through Exa's hosted MCP server, keyed by the user's stored
 *  Exa key. Nothing runs on this computer. */
export const WEB_SEARCH_PRESET: McpServerConfig = {
  type: "http",
  url: "https://mcp.exa.ai/mcp",
  headers: { "x-api-key": "@credential:exa" },
};

/** The web-search preset as earlier engines wrote it: a local npx process. */
export function isLegacyWebSearchPreset(cfg: McpServerConfig | undefined): boolean {
  return cfg?.type === "stdio" && cfg.command === "npx" && JSON.stringify(cfg.args) === JSON.stringify(["-y", "exa-mcp-server"]);
}

/** Resolve "@credential:<id>" header values for an HTTP server at `url`. A
 *  credential named for another host resolves to nothing. */
export function resolveMcpHeaders(
  headers: Record<string, string> | undefined,
  url: string,
  credentials: () => CredentialMap,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch { /* no host: no credential goes anywhere */ }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string" && v.startsWith("@credential:")) {
      const id = v.slice("@credential:".length);
      if (!HEADER_CREDENTIAL_HOSTS[id]?.includes(host)) continue;
      const key = (credentials()[id] as { key?: string } | undefined)?.key;
      if (key) out[k] = key;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Stdio servers the machine owner approved. A stdio entry is a command the
 * ENGINE spawns on the host, outside the bash sandbox, with credentials
 * resolved into its env. mcp.json now sits outside the workspace, but this
 * second gate stays: it is admin-only where the file is merely user-owned, and
 * it survives anyone who reaches the file directly. The admin-only API records
 * a fingerprint of each stdio config beside it, and only a config that still
 * matches its fingerprint connects.
 */
export function stdioFingerprint(cfg: McpServerConfig): string {
  const env = cfg.env ? Object.fromEntries(Object.entries(cfg.env).sort(([a], [b]) => a.localeCompare(b))) : {};
  return createHash("sha256").update(JSON.stringify({ command: cfg.command ?? "", args: cfg.args ?? [], env })).digest("hex");
}

export function readStdioApprovals(file: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { servers?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(raw.servers ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

export function writeStdioApproval(file: string, id: string, cfg: McpServerConfig | null): void {
  const servers = readStdioApprovals(file);
  if (cfg && cfg.type === "stdio") servers[id] = stdioFingerprint(cfg);
  else delete servers[id];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ servers }, null, 2) + "\n", { mode: 0o600 });
}

export interface McpRegistryFile {
  servers: Record<string, McpServerConfig>;
}

interface ConnectedServer {
  client: Client;
  tools: { name: string; description?: string; inputSchema: unknown }[];
}

export interface McpToolInfo {
  name: string; // namespaced: mcp_<server>_<tool>
  server: string;
  rawName: string;
  description?: string;
  inputSchema: unknown;
}

const CONNECT_TIMEOUT_MS = 15_000;
const FAILURE_BACKOFF_MS = 30_000;
/** Failed servers retry on this schedule, then give up until a manual
 * reconnect, a config change, or the next server boot. */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 20_000];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class McpRegistry {
  private connected = new Map<string, ConnectedServer>();
  private connecting = new Map<string, Promise<ConnectedServer | null>>();
  private failedAt = new Map<string, number>();
  private retrying = new Set<string>();
  private lastError = new Map<string, string>();

  constructor(
    private mcpJsonPath: string,
    private credentials: () => CredentialMap = () => ({}),
    /** Fires on connect/drop — hosts use it to refresh agent tool snapshots. */
    private onStateChange: (id: string, connected: boolean) => void = () => {},
    /** May this stdio config spawn? (see stdioFingerprint). Refuses by default. */
    private stdioApproved: (id: string, cfg: McpServerConfig) => boolean = () => false,
  ) {}

  readConfig(): McpRegistryFile {
    try {
      return JSON.parse(fs.readFileSync(this.mcpJsonPath, "utf8")) as McpRegistryFile;
    } catch {
      return { servers: {} };
    }
  }

  writeConfig(cfg: McpRegistryFile): void {
    fs.mkdirSync(path.dirname(this.mcpJsonPath), { recursive: true });
    fs.writeFileSync(this.mcpJsonPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }

  upsertServer(id: string, cfg: McpServerConfig): void {
    const file = this.readConfig();
    file.servers[id] = cfg;
    this.writeConfig(file);
    this.failedAt.delete(id); // config changed: allow an immediate retry
    void this.disconnect(id); // config changed: drop stale connection
  }

  /** Change who may use a server without touching how it connects. Turning a
   *  server off drops its connection; turning it on reconnects on demand. */
  setAccess(id: string, access: { enabled?: boolean; share?: "all" | "agent" }): boolean {
    const file = this.readConfig();
    const cfg = file.servers[id];
    if (!cfg) return false;
    if (access.enabled !== undefined) cfg.enabled = access.enabled;
    if (access.share !== undefined) cfg.share = access.share;
    this.writeConfig(file);
    if (cfg.enabled === false) void this.disconnect(id);
    else this.failedAt.delete(id);
    return true;
  }

  /** Servers every app may offer; each app still opts in for itself. */
  sharedServers(): string[] {
    return Object.entries(this.readConfig().servers)
      .filter(([, cfg]) => cfg.enabled !== false && (cfg.share ?? "all") === "all")
      .map(([id]) => id);
  }

  deleteServer(id: string): boolean {
    const file = this.readConfig();
    if (!file.servers[id]) return false;
    delete file.servers[id];
    this.writeConfig(file);
    this.failedAt.delete(id);
    void this.disconnect(id);
    return true;
  }

  private async disconnect(id: string): Promise<void> {
    const c = this.connected.get(id);
    this.connected.delete(id);
    if (c) {
      this.onStateChange(id, false);
      await c.client.close().catch(() => undefined);
    }
  }

  /** Background retry ladder: try for a while, then give up (manual
   * reconnect / config change / boot clears it). */
  private scheduleRetries(id: string): void {
    if (this.retrying.has(id)) return;
    this.retrying.add(id);
    void (async () => {
      try {
        for (const delay of RETRY_DELAYS_MS) {
          await sleep(delay);
          const cfg = this.readConfig().servers[id];
          if (!cfg || cfg.enabled === false) return;
          if (this.connected.has(id)) return;
          const conn = await this.connect(id, cfg);
          if (conn) {
            this.failedAt.delete(id);
            this.connected.set(id, conn);
            this.onStateChange(id, true);
            log.info(`[mcp:${id}] connected (auto-retry)`);
            return;
          }
        }
        log.warn(`[mcp:${id}] giving up after ${RETRY_DELAYS_MS.length} retries (reconnect manually or edit config)`);
      } finally {
        this.retrying.delete(id);
      }
    })();
  }

  /** Drop the cached connection so the next call reconnects from scratch. */
  async reconnect(id: string): Promise<boolean> {
    const cfg = this.readConfig().servers[id];
    if (!cfg) return false;
    this.failedAt.delete(id); // manual retry always attempts a fresh connect
    await this.disconnect(id);
    const conn = await this.connect(id, cfg);
    if (!conn) return false;
    this.connected.set(id, conn);
    return true;
  }

  private async connect(id: string, cfg: McpServerConfig): Promise<ConnectedServer | null> {
    const client = new Client({ name: "chrysalis-engine", version: ENGINE_VERSION }, { capabilities: {} });
    try {
      if (cfg.type === "stdio") {
        if (!cfg.command) throw new Error("stdio server requires command");
        if (!this.stdioApproved(id, cfg)) {
          throw new Error("not approved: an admin must save this server in MCP settings");
        }
        // Windows can't exec .cmd shims (npx) directly — route through cmd /c
        const isWin = process.platform === "win32";
        const transport = new StdioClientTransport({
          command: isWin ? "cmd" : cfg.command,
          args: isWin ? ["/c", cfg.command, ...(cfg.args ?? [])] : (cfg.args ?? []),
          env: resolveMcpEnv(cfg.env, this.credentials) as Record<string, string> | undefined,
          stderr: "ignore",
        });
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${id}`);
      } else if (cfg.type === "sse") {
        if (!cfg.url) throw new Error("sse server requires url");
        await assertMcpHost(new URL(cfg.url).hostname);
        const transport = new SSEClientTransport(new URL(cfg.url), {
          requestInit: { headers: resolveMcpHeaders(cfg.headers, cfg.url, this.credentials) },
        });
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${id}`);
      } else {
        if (!cfg.url) throw new Error("http server requires url");
        await assertMcpHost(new URL(cfg.url).hostname);
        const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: { headers: resolveMcpHeaders(cfg.headers, cfg.url, this.credentials) },
        });
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${id}`);
      }
      const res = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listTools ${id}`);
      this.lastError.delete(id);
      return { client, tools: res.tools as ConnectedServer["tools"] };
    } catch (e) {
      await client.close().catch(() => undefined);
      this.lastError.set(id, (e as Error).message);
      log.warn(`[mcp:${id}] connect failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async ensure(id: string): Promise<ConnectedServer | null> {
    const cfg = this.readConfig().servers[id];
    if (!cfg || cfg.enabled === false) return null;
    const cached = this.connected.get(id);
    if (cached) return cached;
    const failed = this.failedAt.get(id);
    if (failed !== undefined && Date.now() - failed < FAILURE_BACKOFF_MS) return null;
    let p = this.connecting.get(id);
    if (!p) {
      p = this.connect(id, cfg).finally(() => this.connecting.delete(id));
      this.connecting.set(id, p);
    }
    const conn = await p;
    if (conn) {
      this.failedAt.delete(id);
      this.connected.set(id, conn);
      this.onStateChange(id, true);
    } else {
      this.failedAt.set(id, Date.now());
      this.scheduleRetries(id);
    }
    return conn;
  }

  /** List tools from all enabled servers (lazy-connects; failed servers are
   *  skipped). */
  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    for (const [id, cfg] of Object.entries(this.readConfig().servers)) {
      if (cfg.enabled === false) continue;
      const conn = await this.ensure(id);
      if (!conn) continue;
      for (const t of conn.tools) {
        out.push({
          name: namespaceTool(id, t.name),
          server: id,
          rawName: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        });
      }
    }
    return out;
  }

  /** Call a namespaced tool. `allow` narrows which server ids may be
   *  reached — the app bridge passes exactly what the model was offered. */
  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
    allow?: readonly string[],
  ): Promise<{ ok: boolean; text: string }> {
    // resolve the server by matching KNOWN ids (longest first) — a regex
    // split can't disambiguate: server ids may contain dashes while tool
    // names contain underscores (mcp_web-search_web_search_exa)
    const ids = Object.keys(this.readConfig().servers).sort((a, b) => b.length - a.length);
    let serverId = "";
    let rawName = "";
    for (const id of ids) {
      const prefix = `mcp_${id}_`;
      if (namespacedName.startsWith(prefix)) {
        serverId = id;
        rawName = namespacedName.slice(prefix.length);
        break;
      }
    }
    if (!serverId) return { ok: false, text: `unknown MCP tool: ${namespacedName}` };
    if (allow && !allow.includes(serverId)) return { ok: false, text: `tool not available: ${namespacedName}` };
    const conn = await this.ensure(serverId);
    if (!conn) return { ok: false, text: `MCP server "${serverId}" unavailable` };
    if (!conn.tools.some((t) => t.name === rawName)) {
      return { ok: false, text: `tool "${rawName}" not found on server "${serverId}"` };
    }
    try {
      const res = await conn.client.callTool({ name: rawName, arguments: args });
      const content = (res.content as { type: string; text?: string }[] | undefined) ?? [];
      const text = content.map((c) => c.text ?? `(${c.type})`).join("\n");
      return { ok: !res.isError, text };
    } catch (e) {
      return { ok: false, text: `MCP call failed: ${(e as Error).message}` };
    }
  }

  /** Tools as pi-ai Tool[] for model calls (chat opt-in, SPEC §5.3);
   *  `servers` narrows them to the listed server ids. */
  async toPiTools(servers?: readonly string[]): Promise<PiTool[]> {
    const infos = (await this.listTools()).filter((t) => !servers || servers.includes(t.server));
    return infos.map((t) => ({
      name: t.name,
      description: t.description ?? `(no description)`,
      parameters: (t.inputSchema && isValidObjectSchema(t.inputSchema) ? t.inputSchema : fallbackSchema()) as TSchema,
    }));
  }

  status(): { id: string; type: string; connected: boolean; enabled: boolean; share: "all" | "agent"; tools?: number; error?: string }[] {
    return Object.entries(this.readConfig().servers).map(([id, cfg]) => {
      const conn = this.connected.get(id);
      return {
        id,
        type: cfg.type,
        connected: this.connected.has(id),
        enabled: cfg.enabled !== false,
        share: cfg.share ?? "all",
        ...(conn ? { tools: conn.tools.length } : {}),
        ...(!conn && this.lastError.has(id) ? { error: this.lastError.get(id) } : {}),
      };
    });
  }

  /** Connect (or retry) the listed servers now so a UI can show live
   *  status; failures are the caller's to render, not to throw. */
  async warm(ids: readonly string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.ensure(id).catch(() => null)));
  }

  async dispose(): Promise<void> {
    for (const id of this.connected.keys()) await this.disconnect(id);
  }
}

export function namespaceTool(serverId: string, toolName: string): string {
  return `mcp_${serverId}_${toolName}`;
}

function isValidObjectSchema(s: unknown): s is Record<string, unknown> {
  return !!s && typeof s === "object" && (s as { type?: unknown }).type === "object";
}

function fallbackSchema(): unknown {
  return { type: "object", properties: {} };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}
