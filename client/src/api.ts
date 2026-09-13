import { tr } from "./i18n/index"
import type { AppUpdate, StoreList } from "./types"
// Chrysalis engine HTTP client for the launcher shell (auth, settings,
// connections, apps). The agent chat lives in its own app (client-agent/).
export interface EngineConnection {
  id: string
  name: string
  providerId?: string
  oauthProvider?: "radius"
  gateway?: string
  api?: "openai-completions" | "anthropic-messages" | "openai-responses" | "google-generative-ai" | "openai-text"
  baseUrl?: string
  /** builtin provider this connection proxies (reverse proxy connections) */
  proxyOf?: string
  models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }> | "auto"
  /** text completion connections: "auto", a format id, or "custom" */
  promptFormat?: string
  promptFormatCustom?: PromptFormat
  hasKey: boolean
  credentialType?: "api_key" | "oauth"
  effectiveProviderId: string
}

export interface PromptFormat {
  systemPrefix: string
  systemSuffix: string
  userPrefix: string
  userSuffix: string
  assistantPrefix: string
  assistantSuffix: string
  systemAsUser: boolean
}

export interface NamedPromptFormat extends PromptFormat {
  id: string
  name: string
}

export const listPromptFormats = () =>
  api<{ formats: NamedPromptFormat[] }>("GET", "/v1/models/prompt-formats").then((r) => r.formats)

export interface EngineProvider {
  id: string
  label: string
  kind: "builtin" | "curated" | "needs-setup"
  baseUrl: string | null
  apiKeyAuth: boolean
  /** provider supports OAuth subscription sign-in (pi-ai flow) */
  oauth: boolean
  oauthLabel: string | null
  /** provider has a sign-in entry this panel can run (OAuth or guided credentials) */
  signIn: boolean
  signInLabel: string | null
  hasKey: boolean
}

/** One step of a guided sign-in flow (Vertex ADC, AWS profile, Cloudflare ids). */
export interface OAuthPrompt {
  id: number
  type: "text" | "secret" | "select" | "manual_code"
  message: string
  placeholder?: string
  options?: Array<{ id: string; label: string; description?: string }>
}

/** Live OAuth sign-in state (polled while a flow runs). */
export interface OAuthFlow {
  providerId: string
  status: "pending" | "connected" | "error"
  url?: string
  userCode?: string
  verificationUri?: string
  message?: string
  error?: string
  /** guided flows: the step waiting for the user's answer */
  prompt?: OAuthPrompt
}

export { prefs } from "./prefs"

export async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(p, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error(tr("Connection lost. Is the Chrysalis server running?"))
  }
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // non-JSON body (proxy error page, truncated response) — never let the
    // parse error's embedded snippet escape as an Error message
    json = null
  }
  // error bodies come in two shapes: plain strings and {message} objects —
  // stringifying an object directly would surface as "[object Object]"
  const errBody = json?.error
  const errMsg = typeof errBody === "string" ? errBody : (errBody?.message ?? (errBody ? JSON.stringify(errBody) : `HTTP ${res.status}`))
  if (!res.ok) throw new Error(errMsg)
  return json as T
}

export const oauthApi = {
  list: () =>
    api<{
      providers: Array<{ id: string; name: string; label: string; subscription: boolean; configured: boolean }>
      flow: OAuthFlow | null
    }>("GET", "/v1/settings/oauth"),
  start: (providerId: string) => api<{ started: boolean }>("POST", `/v1/settings/oauth/${encodeURIComponent(providerId)}/start`),
  cancel: (providerId: string) => api<{ ok: boolean }>("POST", `/v1/settings/oauth/${encodeURIComponent(providerId)}/cancel`),
  answer: (providerId: string, id: number, value: string) =>
    api<{ ok: boolean }>("POST", `/v1/settings/oauth/${encodeURIComponent(providerId)}/answer`, { id, value }),
  disconnect: (providerId: string) => api("DELETE", `/v1/settings/oauth/${encodeURIComponent(providerId)}`),
}

export const avatarApi = {
  upload: (data: string, mimeType: string) =>
    api<{ ok: boolean; url: string }>("PUT", "/v1/auth/avatar", { data, mimeType }),
  remove: () => api("DELETE", "/v1/auth/avatar"),
  rename: (username: string, password?: string) =>
    api<{ username: string }>("POST", "/v1/auth/rename", { username, ...(password ? { password } : {}) }),
}

export const connectionsApi = {
  list: () => api<{ connections: EngineConnection[] }>("GET", "/v1/settings/connections").then((r) => r.connections ?? []),
  create: (body: { name: string; providerId?: string; oauthProvider?: "radius"; gateway?: string; api?: EngineConnection["api"]; baseUrl?: string; proxyUrl?: string; models?: unknown; key?: string; promptFormat?: string; promptFormatCustom?: PromptFormat }) =>
    api<{ connection: EngineConnection }>("POST", "/v1/settings/connections", body),
  update: (id: string, body: { name?: string; baseUrl?: string; key?: string; models?: unknown; promptFormat?: string; promptFormatCustom?: PromptFormat }) =>
    api<{ connection: EngineConnection }>("PATCH", `/v1/settings/connections/${encodeURIComponent(id)}`, body),
  remove: (id: string) => api("DELETE", `/v1/settings/connections/${encodeURIComponent(id)}`),
}

export interface SpeechEndpoint {
  id: string
  name: string
  baseUrl: string
  model: string
  voice?: string
  hasKey: boolean
}

export const speechApi = {
  list: () => api<{ endpoints: SpeechEndpoint[] }>("GET", "/v1/audio/speech/endpoints").then((r) => r.endpoints ?? []),
  create: (body: { name: string; baseUrl: string; model: string; voice?: string; key?: string }) =>
    api<{ endpoint: SpeechEndpoint }>("POST", "/v1/audio/speech/endpoints", body),
  update: (id: string, body: { name?: string; baseUrl?: string; model?: string; voice?: string; key?: string }) =>
    api<{ endpoint: SpeechEndpoint }>("PATCH", `/v1/audio/speech/endpoints/${encodeURIComponent(id)}`, body),
  remove: (id: string) => api("DELETE", `/v1/audio/speech/endpoints/${encodeURIComponent(id)}`),
  voices: () => api<{ edge: string[] }>("GET", "/v1/audio/voices").then((r) => r.edge ?? []),
  /** Synthesize through the engine; resolves an audio data URL the caller plays. */
  speak: (body: { text: string; provider?: "edge" | "endpoint"; endpointId?: string; voice?: string; model?: string; speed?: number }) =>
    api<{ dataUrl: string }>("POST", "/v1/audio/speech", body),
}

export const appPluginsApi = {
  list: (appId: string) =>
    api<{ plugins: any[] }>("GET", `/v1/apps/${encodeURIComponent(appId)}/plugins`).then((r) => r.plugins ?? []),
  remove: (appId: string, pid: string) =>
    api("DELETE", `/v1/apps/${encodeURIComponent(appId)}/plugins/${encodeURIComponent(pid)}`),
  /** Switch a plugin off/on without uninstalling — a disabled plugin stops
   *  executing entirely (routes, tools, hooks, panels). */
  setEnabled: (appId: string, pid: string, enabled: boolean) =>
    api<{ ok: boolean; disabled: boolean }>(
      "POST",
      `/v1/apps/${encodeURIComponent(appId)}/plugins/${encodeURIComponent(pid)}/${enabled ? "enable" : "disable"}`,
    ),
  /** Phase 1: clone + inspect — nothing installed yet. */
  importPreview: (appId: string, gitUrl: string) =>
    api<{
      staged: boolean
      slug: string
      head: string
      manifest: { name: string; version: string | null; author: string | null; description: string | null }
      permissions: string[]
      networkHosts: string[]
    }>("POST", `/v1/apps/${encodeURIComponent(appId)}/plugins/import`, { gitUrl }),
  /** Phase 2: install the staged copy into this app's plugins/. `head` pins
   *  the install to the commit the preview reviewed. */
  importConfirm: (appId: string, gitUrl: string, head: string) =>
    api<{ ok: boolean; id: string; name: string }>("POST", `/v1/apps/${encodeURIComponent(appId)}/plugins/import`, {
      gitUrl,
      confirm: true,
      head,
    }),
}

export async function listProviders(): Promise<EngineProvider[]> {
  const r = await api<{ providers: EngineProvider[] }>("GET", "/v1/settings/providers")
  return r.providers ?? []
}

export const personaApi = {
  get: () => api<{ persona: string }>("GET", "/v1/settings/persona").then((r) => r.persona ?? ""),
  put: (persona: string) => api("PUT", "/v1/settings/persona", { persona }),
}

export const mcpApi = {
  list: () => api<{ servers: Array<{ id: string; type: string; connected: boolean; enabled: boolean; share: "all" | "agent"; tools?: number; error?: string }> }>("GET", "/v1/mcp").then((r) => r.servers ?? []),
  upsert: (id: string, cfg: Record<string, unknown>) => api("PUT", `/v1/mcp/${encodeURIComponent(id)}`, cfg),
  remove: (id: string) => api("DELETE", `/v1/mcp/${encodeURIComponent(id)}`),
  reconnect: (id: string) => api<{ ok: boolean }>("POST", `/v1/mcp/${encodeURIComponent(id)}/reconnect`),
  setAccess: (id: string, access: { enabled?: boolean; share?: "all" | "agent" }) => api("PATCH", `/v1/mcp/${encodeURIComponent(id)}`, access),
}

// ---- sign-in (user picker + optional password; cookies do the auth) ----

export interface AuthUser {
  username: string
  role: string
  hasPassword: boolean
  enabled: boolean
  createdAt: number
}

export const authApi = {
  users: () => api<{ users: AuthUser[]; setup?: boolean }>("GET", "/v1/auth/users").then((r) => ({ users: r.users ?? [], setup: r.setup === true })),
  setup: (token: string, username: string, password: string) =>
    api<{ username: string; role: string }>("POST", "/v1/auth/setup", { token, username, password }),
  login: (username: string, password?: string) =>
    api<{ username: string; role: string }>("POST", "/v1/auth/login", { username, ...(password ? { password } : {}) }),
  logout: () => api("POST", "/v1/auth/logout"),
  forgot: (username: string) => api<{ ok: boolean }>("POST", "/v1/auth/forgot", { username }),
  reset: (username: string, code: string, password: string) =>
    api<{ username: string; role: string }>("POST", "/v1/auth/reset", { username, code, password }),
  changePassword: (current: string | undefined, next: string) =>
    api<{ ok: boolean; hasPassword: boolean }>("PUT", "/v1/auth/password", { ...(current !== undefined ? { current } : {}), next }),
}

export const storeApi = {
  list: (fresh = false) => api<StoreList>("GET", `/v1/store${fresh ? "?fresh=1" : ""}`),
  seen: () => api<{ storeSeen: string | null }>("GET", "/v1/settings").then((r) => r.storeSeen ?? null),
  markSeen: (day: string) => api("PUT", "/v1/settings", { storeSeen: day }),
}

export const updatesApi = {
  /** Every app's upstream state; `fresh` skips the engine's one-minute cache. */
  list: (fresh = false) => api<{ apps: AppUpdate[] }>("GET", `/v1/apps/updates${fresh ? "?fresh=1" : ""}`),
}

/** Install an app from a git repository: the preview step, then the confirm
 *  pinned to the commit the preview saw, then its packages in the background.
 *  `id` names the install folder, as the Store entry does. */
export async function installFromGit(gitUrl: string, ref?: string, id?: string): Promise<string> {
  const target = { gitUrl, ...(ref ? { ref } : {}), ...(id ? { id } : {}) }
  const preview = await api<{ slug: string; head: string }>("POST", "/v1/apps/import", target)
  const done = await api<{ id: string }>("POST", "/v1/apps/import", { ...target, confirm: preview.slug, head: preview.head })
  void api("POST", `/v1/apps/${encodeURIComponent(done.id)}/install`).catch(() => undefined)
  return done.id
}

/** Download an app as a zip (its files and live data) through the browser. */
export async function exportApp(id: string): Promise<void> {
  const res = await fetch(`/v1/apps/${encodeURIComponent(id)}/export`)
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // not a JSON body; the status is all we know
    }
    throw new Error(message)
  }
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement("a")
  a.href = url
  a.download = `${id}-backup-${new Date().toISOString().slice(0, 10)}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Server settings (config.yaml) as the engine reports them. */
export interface ServerConfig {
  port: number
  lan: boolean
  listenAddress: string
  allowedHosts: string[]
  ssl: { enabled: boolean; certPath: string; keyPath: string }
  openBrowser: boolean
  apps: { packageDownloads: boolean; store: string | null }
  agent: { shell: boolean; shellTimeoutSeconds: number }
  defaultModel: string | null
  dataRoot: string
}

export interface ServerInfo {
  version: string
  installKind: "source" | "binary" | "npm" | "android"
  container: boolean
  portable: boolean
  configPath: string
  homeDir: string
  dataDir: string
  file: ServerConfig
  effective: ServerConfig
  /** setting → the environment variable or flag overriding it this run */
  locked: Record<string, string>
  urls: { local: string; lan: string[] }
}

export const serverApi = {
  get: () => api<ServerInfo>("GET", "/v1/admin/server"),
  release: () => api<{ release: { version: string; url: string; newer: boolean } | null }>("GET", "/v1/admin/server/release").then((r) => r.release),
  update: (changes: Record<string, unknown>) => api<ServerInfo & { moved: boolean }>("PUT", "/v1/admin/server", { changes }),
}

export const adminUsersApi = {
  list: () => api<{ users: AuthUser[] }>("GET", "/v1/admin/users").then((r) => r.users ?? []),
  create: (username: string, password: string, opts: { role?: string } = {}) =>
    api<{ username: string; token: string }>("POST", "/v1/admin/users", { username, password, ...opts }),
  update: (username: string, body: { password?: string; current?: string; enabled?: boolean }) =>
    api<{ user: AuthUser }>("PATCH", `/v1/admin/users/${encodeURIComponent(username)}`, body),
  remove: (username: string) => api("DELETE", `/v1/admin/users/${encodeURIComponent(username)}`),
}
