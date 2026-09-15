// Engine HTTP client. Cookie-authenticated (same-origin); errors surface as
// readable messages, never "[object Object]".

export interface EngineSession {
  sessionId: string
  runs: number
  lastAt: number | null
  title?: string | null
  archived?: boolean
}

export interface EngineTool {
  name: string
  ok: boolean
  summary?: string
  /** the result beyond the summary, when there is more of it */
  output?: string
  diff?: string
  args?: Record<string, unknown>
}

export interface EngineTurn {
  thinking?: string
  thinkingMs?: number
  text?: string
  tools: EngineTool[]
}

export interface EngineUsage {
  input: number
  output: number
  cacheRead: number
}

export interface EngineRun {
  type: "run" | "compact" | "rename"
  at: number
  user?: string
  assistant?: string
  /** Attached images as asset URLs (kept on the run so history shows them). */
  images?: string[]
  tools?: EngineTool[]
  turns?: EngineTurn[]
  thinking?: string
  thinkingMs?: number
  usage?: EngineUsage
  title?: string
  summary?: string
}

export interface AgentResponse {
  sessionId: string
  finalText: string
  turns: EngineTurn[]
  toolTrace: EngineTool[]
  thinking?: string
  thinkingMs?: number
  usage?: EngineUsage
  autoCompacted?: boolean
  stopped?: boolean
  error?: string
}

export interface EngineModel {
  provider: string
  modelId: string
  label: string
  connectionName: string | null
  reasoning: boolean
  reasoningLevels: string[]
  contextWindow: number | null
}

export interface McpServer {
  id: string
  type: string
  connected: boolean
  enabled: boolean
  tools?: number
  error?: string
}

export async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(p, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error("Connection lost. Is the engine running?")
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    const errBody = (json as { error?: unknown } | null)?.error
    // an error carrying no message must still say something: an empty string
    // reaches the UI as a banner with nothing in it
    const msg =
      (typeof errBody === "string" ? errBody : (errBody as { message?: string } | undefined)?.message) ||
      `HTTP ${res.status}`
    throw new Error(msg)
  }
  return json as T
}

export const sessionsApi = {
  list: () => api<{ sessions: EngineSession[] }>("GET", "/v1/agent/sessions").then((r) => r.sessions ?? []),
  get: (id: string) => api<{ runs: EngineRun[] }>("GET", `/v1/agent/sessions/${encodeURIComponent(id)}`),
  remove: (id: string) => api("DELETE", `/v1/agent/sessions/${encodeURIComponent(id)}`),
  rename: (id: string, title: string) =>
    api<{ ok: boolean }>("POST", `/v1/agent/sessions/${encodeURIComponent(id)}/rename`, { title }),
  archive: (id: string, archived: boolean) =>
    api<{ ok: boolean }>("POST", `/v1/agent/sessions/${encodeURIComponent(id)}/archive`, { archived }),
  truncate: (id: string, at: number) =>
    api<{ runs: number }>("POST", `/v1/agent/sessions/${encodeURIComponent(id)}/truncate`, { at }),
  compact: (id: string) =>
    api<{ sessionId: string; summary: string; runsBefore: number }>(
      "POST",
      `/v1/agent/sessions/${encodeURIComponent(id)}/compact`,
    ),
}

export interface SendInput {
  message: string
  sessionId?: string
  mode?: "normal" | "plan" | "accept"
  model?: string
  reasoning?: string
  images?: Array<{ data: string; mimeType: string }>
}

export function sendAgent(input: SendInput): Promise<AgentResponse> {
  return api("POST", "/v1/agent", input)
}

export function steerAgent(sessionId: string, message: string): Promise<void> {
  return api("POST", "/v1/agent/steer", { sessionId, message })
}

export function stopAgent(sessionId: string): Promise<{ ok: boolean }> {
  return api("POST", "/v1/agent/stop", { sessionId })
}

export function answerAgent(sessionId: string, id: string, answer: string): Promise<{ ok: boolean }> {
  return api("POST", "/v1/agent/answer", { sessionId, id, answer })
}

export function listModels(): Promise<EngineModel[]> {
  return api<{ models: EngineModel[] }>("GET", "/v1/models").then((r) => r.models ?? [])
}

export function getSettings(): Promise<{ model: string | null; reasoning: string | null }> {
  return api("GET", "/v1/settings")
}

export function listMcp(): Promise<McpServer[]> {
  return api<{ servers: McpServer[] }>("GET", "/v1/mcp").then((r) => r.servers ?? [])
}

/** Workspace files for the composer's "@" picker. The engine does the walking
 *  and the matching; `q` is a plain substring over the relative path. */
export async function agentFiles(q: string): Promise<string[]> {
  const r = await api<{ files?: string[] }>("GET", `/v1/agent/files?q=${encodeURIComponent(q)}`)
  return r.files ?? []
}

export interface UserCommand {
  name: string
  description: string
  body: string
}

/** The user's own prompts from commands/, shown in the composer as /<name>. */
export async function agentCommands(): Promise<UserCommand[]> {
  const r = await api<{ commands?: UserCommand[] }>("GET", "/v1/agent/commands")
  return r.commands ?? []
}
