/**
 * Named API connections (user-facing "connection profiles").
 *
 * Two kinds:
 *  - builtin: a pi-ai provider (anthropic, deepseek, google, …) — the key is
 *    written to auth.json under the PROVIDER id; models come from pi-ai's
 *    catalog. One credential per provider (auth.json is keyed by provider).
 *  - custom: an OpenAI-compatible or Anthropic endpoint (baseUrl [+ models])
 *    registered as its own provider (id c_…).
 *
 * Definitions live in connections.json beside the credentials (name + endpoint
 * metadata, NEVER the key); keys go to auth.json in the same 0600 dir. Neither
 * file is in the workspace: the Settings UI is the only writer.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { UserPaths } from "./paths.js";
import { CURATED_PROVIDERS, keyBoundTo, reservedProviderIds } from "./providers/custom.js";
import { parsePromptFormat, promptFormatById, type PromptFormat } from "./providers/prompt-formats.js";

export interface ConnectionDef {
  name: string;
  /** builtin pi-ai provider id (mutually exclusive with api+baseUrl) */
  providerId?: string;
  /** Radius gateway sign-in (OAuth connection kind; needs `gateway`) */
  oauthProvider?: "radius";
  gateway?: string;
  api?: "openai-completions" | "anthropic-messages" | "openai-text";
  baseUrl?: string;
  /** set when this connection is a builtin provider routed through a reverse
   * proxy: custom-shaped def + display origin. The key is
   * bound to the proxy endpoint, never sent to the official one. */
  proxyOf?: string;
  /** custom only: explicit model list (per-model overrides), or "auto" to discover from GET {baseUrl}/models */
  models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }> | "auto";
  /** openai-text only: "auto" (match the loaded model), a format id, or
   *  "custom" with `promptFormatCustom`. */
  promptFormat?: string;
  promptFormatCustom?: PromptFormat;
}

/** A text completion connection's format choice from untrusted input. */
export function validatePromptFormatInput(
  promptFormat: unknown,
  custom: unknown,
): { ok: true; value: { promptFormat: string; promptFormatCustom?: PromptFormat } } | { ok: false; error: string } {
  const id = promptFormat === undefined ? "auto" : promptFormat;
  if (id === "auto" || (typeof id === "string" && promptFormatById(id))) return { ok: true, value: { promptFormat: id } };
  if (id !== "custom") return { ok: false, error: `unknown prompt format "${String(id)}"` };
  const parsed = parsePromptFormat(custom);
  if (!parsed) return { ok: false, error: "a custom prompt format needs a user or assistant prefix, and strings of at most 400 characters" };
  return { ok: true, value: { promptFormat: "custom", promptFormatCustom: parsed } };
}

export interface ConnectionsFile {
  connections: Record<string, ConnectionDef>;
}

export interface ConnectionInfo extends ConnectionDef {
  id: string;
  /** true when ANY credential is stored (API key or OAuth subscription) */
  hasKey: boolean;
  /** which kind of credential backs this connection */
  credentialType?: "api_key" | "oauth";
  /** effective provider id whose models this connection surfaces */
  effectiveProviderId: string;
}

const NAME_MAX = 60;

function connectionsPath(p: UserPaths): string {
  return p.connections;
}

export function readConnections(p: UserPaths): ConnectionsFile {
  try {
    const file = JSON.parse(fs.readFileSync(connectionsPath(p), "utf8")) as ConnectionsFile;
    return { connections: file.connections ?? {} };
  } catch {
    return { connections: {} };
  }
}

function writeConnections(p: UserPaths, file: ConnectionsFile): void {
  const full = connectionsPath(p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(file, null, 2) + "\n", "utf8");
}

/** auth.json credential map (api_key or oauth entries; outside git, 0600). */
export function readAuth(p: UserPaths): Record<string, { type: string; key?: string; [k: string]: unknown }> {
  try {
    return JSON.parse(fs.readFileSync(p.auth, "utf8")) as Record<string, { type: string; key?: string }>;
  } catch {
    return {};
  }
}

export function writeAuth(p: UserPaths, data: Record<string, { type: string; key?: string; [k: string]: unknown }>): void {
  fs.mkdirSync(path.dirname(p.auth), { recursive: true });
  fs.writeFileSync(p.auth, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

export function authTarget(def: ConnectionDef, id: string): string {
  return def.providerId ?? id;
}

/** The endpoint a connection's credential is bound to: its baseUrl for a
 *  custom endpoint, its gateway for Radius, none for a builtin provider (the
 *  endpoint is in code). */
export function connectionEndpoint(def: ConnectionDef): string | null {
  if (def.providerId) return null;
  if (def.oauthProvider === "radius") return def.gateway ?? null;
  return def.baseUrl ?? null;
}

/** May this connection's stored credential be used? A custom endpoint only
 *  with a credential saved for that exact endpoint (see keyBoundTo), and
 *  never under a builtin provider's id, whose credential is unbound. */
export function connectionKeyUsable(def: ConnectionDef, id: string, cred: unknown): boolean {
  const endpoint = connectionEndpoint(def);
  if (endpoint === null) return true;
  if (def.oauthProvider !== "radius" && reservedProviderIds().has(authTarget(def, id))) return false;
  return keyBoundTo(cred, endpoint);
}

/** One-time adoption for keys saved before endpoint binding: each custom
 *  connection's and providers.json endpoint's unbound key binds to the URL it
 *  points at now. Returns what was bound, for the boot log. */
export function bindLegacyKeys(p: UserPaths): string[] {
  const auth = readAuth(p);
  const reserved = reservedProviderIds();
  const bound: string[] = [];
  const bind = (target: string, url: string | null | undefined) => {
    const cred = auth[target];
    if (!url || !cred || typeof cred.boundBaseUrl === "string") return;
    auth[target] = { ...cred, boundBaseUrl: url };
    bound.push(`${target} -> ${url}`);
  };
  for (const [id, def] of Object.entries(readConnections(p).connections)) {
    // the Radius sign-in is stored under the provider id, bound to its gateway
    if (def.oauthProvider === "radius") bind("radius", def.gateway);
    else if (!reserved.has(authTarget(def, id))) bind(authTarget(def, id), connectionEndpoint(def));
  }
  try {
    const providers = (JSON.parse(fs.readFileSync(path.join(p.root, "providers.json"), "utf8")) as { providers?: Record<string, { baseUrl?: string }> }).providers ?? {};
    for (const [id, def] of Object.entries(providers)) if (!reserved.has(id)) bind(id, def?.baseUrl);
  } catch { /* no providers.json */ }
  if (bound.length) writeAuth(p, auth);
  return bound;
}

export function slugId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "conn";
  return `c_${slug}-${randomBytes(3).toString("hex")}`;
}

/** Providers a connection may name by id: the library's own plus the curated
 *  endpoints defined in code (keyed the same way in auth.json). */
const builtins: { id: string; name: string; auth?: { apiKey?: unknown; oauth?: unknown } }[] = [
  ...builtinProviders(),
  ...Object.entries(CURATED_PROVIDERS).map(([id, def]) => ({ id, name: def.name ?? id, auth: { apiKey: true } })),
];

export function validateConnectionInput(input: {
  name?: unknown;
  providerId?: unknown;
  oauthProvider?: unknown;
  gateway?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  proxyUrl?: unknown;
  models?: unknown;
  key?: unknown;
  promptFormat?: unknown;
  promptFormatCustom?: unknown;
}):
  | { ok: true; value: ConnectionInput }
  | { ok: false; error: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > NAME_MAX) return { ok: false, error: `name must be 1-${NAME_MAX} characters` };
  const key = typeof input.key === "string" ? input.key.trim() : undefined;
  if (key !== undefined && (!key || key.length > 4096)) return { ok: false, error: "key must be a non-empty string" };

  if (typeof input.providerId === "string" && input.providerId) {
    const builtin = builtins.find((b) => b.id === input.providerId);
    if (!builtin) return { ok: false, error: `unknown provider "${input.providerId}"` };
    // A provider without a top-level baseUrl still connects: its models carry
    // the endpoint (opencode), or pi-ai resolves it from the credential/env at
    // request time. Only radius is unconnectable without user-supplied config.
    if (builtin.id === "radius") {
      return { ok: false, error: `"${builtin.name}" needs its gateway sign-in. Use the Radius entry.` };
    }
    if (!builtin.auth?.apiKey && !builtin.auth?.oauth) {
      return { ok: false, error: `"${builtin.name}" has no API-key or OAuth sign-in here yet` };
    }
    // reverse proxy: route the provider through a custom endpoint.
    // Becomes a custom-shaped def — the key binds to the proxy, models can be
    // auto-discovered or listed manually.
    const proxyUrl = typeof input.proxyUrl === "string" ? input.proxyUrl.trim() : "";
    if (proxyUrl) {
      if (!/^https?:\/\/.{3,}/.test(proxyUrl)) return { ok: false, error: "reverse proxy must be an http(s) URL" };
      let models: ConnectionDef["models"] = "auto";
      if (Array.isArray(input.models)) {
        if (input.models.length === 0 || !input.models.every((m) => m && typeof (m as { id?: unknown }).id === "string")) {
          return { ok: false, error: "models must be a non-empty list of {id} objects or \"auto\"" };
        }
        models = input.models as ConnectionDef["models"];
      }
      const proxyApi: ConnectionDef["api"] = builtin.id === "anthropic" ? "anthropic-messages" : "openai-completions";
      return { ok: true, value: { name, api: proxyApi, baseUrl: proxyUrl, proxyOf: builtin.id, models, ...(key ? { key } : {}) } };
    }
    return { ok: true, value: { name, providerId: builtin.id, ...(key ? { key } : {}) } };
  }

  // Radius gateway: OAuth-only connection kind
  if (input.oauthProvider === "radius") {
    const gateway = typeof input.gateway === "string" ? input.gateway.trim() : "";
    if (!/^https?:\/\/.{3,}/.test(gateway)) return { ok: false, error: "radius needs a gateway http(s) URL" };
    return { ok: true, value: { name, oauthProvider: "radius", gateway } };
  }

  if (
    input.api !== "openai-completions" &&
    input.api !== "anthropic-messages" &&
    input.api !== "openai-responses" &&
    input.api !== "google-generative-ai" &&
    input.api !== "openai-text"
  ) {
    return { ok: false, error: "providerId, or api (openai-completions|anthropic-messages|openai-responses|google-generative-ai) + baseUrl, required" };
  }
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!/^https?:\/\/.{3,}/.test(baseUrl)) return { ok: false, error: "baseUrl must be an http(s) URL" };
  let models: ConnectionDef["models"] = "auto";
  if (Array.isArray(input.models)) {
    if (
      input.models.length === 0 ||
      !input.models.every(
        (m) =>
          m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" && (m as { id?: unknown }).id &&
          Object.entries(m as Record<string, unknown>).every(
            ([k, v]) =>
              (k === "id" && typeof v === "string") ||
              (k === "name" && typeof v === "string") ||
              (k === "contextWindow" && typeof v === "number" && v > 0) ||
              (k === "maxTokens" && typeof v === "number" && v > 0) ||
              (k === "reasoning" && typeof v === "boolean"),
          ),
      )
    ) {
      return { ok: false, error: "models must be a non-empty list of {id, name?, contextWindow?, maxTokens?, reasoning?} or \"auto\"" };
    }
    models = input.models as ConnectionDef["models"];
  } else if (input.models !== undefined && input.models !== "auto") {
    return { ok: false, error: "models must be a list or \"auto\"" };
  }
  if (input.api === "openai-text") {
    const format = validatePromptFormatInput(input.promptFormat, input.promptFormatCustom);
    if (!format.ok) return format;
    return { ok: true, value: { name, api: input.api, baseUrl, models, ...format.value, ...(key ? { key } : {}) } };
  }
  return { ok: true, value: { name, api: input.api as ConnectionDef["api"], baseUrl, models, ...(key ? { key } : {}) } };
}

export function listConnections(p: UserPaths): ConnectionInfo[] {
  const auth = readAuth(p);
  const { connections } = readConnections(p);
  return Object.entries(connections)
    .map(([id, def]) => {
      const target = authTarget(def, id);
      const cred = auth[target];
      return { id, ...def, hasKey: !!cred, ...(cred ? { credentialType: cred.type as "api_key" | "oauth" } : {}), effectiveProviderId: target };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

type ConnectionInput = Pick<ConnectionDef, "providerId" | "oauthProvider" | "gateway" | "api" | "baseUrl" | "proxyOf" | "models" | "promptFormat" | "promptFormatCustom"> & { name: string; key?: string };

export function createConnection(p: UserPaths, value: ConnectionInput): ConnectionInfo {
  const file = readConnections(p);
  let id = slugId(value.name);
  while (file.connections[id]) id = slugId(value.name);
  const def: ConnectionDef = value.oauthProvider
    ? { name: value.name, oauthProvider: value.oauthProvider, gateway: value.gateway! }
    : value.providerId
      ? { name: value.name, providerId: value.providerId }
      : {
          name: value.name,
          api: value.api!,
          baseUrl: value.baseUrl!,
          models: value.models ?? "auto",
          ...(value.proxyOf ? { proxyOf: value.proxyOf } : {}),
          ...(value.api === "openai-text" ? { promptFormat: value.promptFormat ?? "auto", ...(value.promptFormatCustom ? { promptFormatCustom: value.promptFormatCustom } : {}) } : {}),
        };
  file.connections[id] = def;
  writeConnections(p, file);
  if (value.key) {
    const auth = readAuth(p);
    const endpoint = connectionEndpoint(def);
    auth[authTarget(def, id)] = { type: "api_key", key: value.key, ...(endpoint ? { boundBaseUrl: endpoint } : {}) };
    writeAuth(p, auth);
  }
  const target = authTarget(def, id);
  return { id, ...def, hasKey: !!value.key, ...(value.key ? { credentialType: "api_key" as const } : {}), effectiveProviderId: target };
}

export function updateConnection(
  p: UserPaths,
  id: string,
  patch: { name?: string; baseUrl?: string; key?: string; models?: ConnectionDef["models"]; promptFormat?: string; promptFormatCustom?: PromptFormat },
): ConnectionInfo | null {
  const file = readConnections(p);
  const def = file.connections[id];
  if (!def) return null;
  if (patch.name !== undefined) def.name = patch.name.trim().slice(0, NAME_MAX) || def.name;
  const oldEndpoint = connectionEndpoint(def);
  if (patch.baseUrl !== undefined && !def.providerId && /^https?:\/\/.{3,}/.test(patch.baseUrl)) def.baseUrl = patch.baseUrl.trim();
  if (patch.models !== undefined && !def.providerId) {
    def.models = patch.models === "auto" || (Array.isArray(patch.models) && patch.models.length > 0) ? patch.models : def.models;
  }
  if (patch.promptFormat !== undefined && def.api === "openai-text") {
    def.promptFormat = patch.promptFormat;
    if (patch.promptFormat === "custom" && patch.promptFormatCustom) def.promptFormatCustom = patch.promptFormatCustom;
    else delete def.promptFormatCustom;
  }
  writeConnections(p, file);
  const endpoint = connectionEndpoint(def);
  if (patch.key !== undefined && patch.key.trim()) {
    const auth = readAuth(p);
    auth[authTarget(def, id)] = { type: "api_key", key: patch.key.trim(), ...(endpoint ? { boundBaseUrl: endpoint } : {}) };
    writeAuth(p, auth);
  } else if (endpoint !== oldEndpoint) {
    // a key never follows its endpoint to a new URL: moving the connection
    // drops it, and the user enters it again for the new host
    const auth = readAuth(p);
    if (auth[authTarget(def, id)]) {
      delete auth[authTarget(def, id)];
      writeAuth(p, auth);
    }
  }
  const auth = readAuth(p);
  const target = authTarget(def, id);
  const cred = auth[target];
  return { id, ...def, hasKey: !!cred, ...(cred ? { credentialType: cred.type as "api_key" | "oauth" } : {}), effectiveProviderId: target };
}

export function deleteConnection(p: UserPaths, id: string): boolean {
  const file = readConnections(p);
  const def = file.connections[id];
  if (!def) return false;
  delete file.connections[id];
  writeConnections(p, file);
  const auth = readAuth(p);
  delete auth[authTarget(def, id)];
  writeAuth(p, auth);
  return true;
}
