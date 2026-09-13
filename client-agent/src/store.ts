// Client state: sessions, the open thread, the live run, and the WS feed.
// The stream updates a live assistant message in place; when POST /v1/agent
// resolves it is replaced by the authoritative turn record.
import { create } from "zustand"
import {
  answerAgent,
  getSettings,
  listMcp,
  listModels,
  sendAgent,
  sessionsApi,
  steerAgent,
  stopAgent,
  type AgentResponse,
  type EngineModel,
  type EngineSession,
  type EngineUsage,
  type McpServer,
} from "./api"
import { applyStreamEvent, msgsFromRuns, partsFromResponse, uid, type Msg, type PartData } from "./runs"
import { createStreamDeltaBatcher, type StreamEvent } from "./streaming"

export interface PendingAsk {
  sessionId: string
  id: string
  question: string
  options?: string[]
  detail?: string
}

export interface Banner {
  kind: "error" | "info"
  text: string
}

export interface AgentState {
  sessions: EngineSession[]
  sessionId: string | null
  msgs: Msg[]
  running: boolean
  banner: Banner | null
  ask: PendingAsk | null
  models: EngineModel[]
  model: string | null
  reasoning: string
  mode: "normal" | "plan" | "accept"
  wsDown: boolean
  usage: EngineUsage | null
  mcp: McpServer[]
  sidebarOpen: boolean
  /** desktop sidebar visibility — the user's pick, persisted; mobile keeps
   *  the transient drawer (sidebarOpen) */
  sidebarPinned: boolean
  setSidebarPinned: (pinned: boolean) => void
  init: () => Promise<void>
  refreshSessions: () => Promise<void>
  refreshMcp: () => Promise<void>
  open: (id: string) => Promise<void>
  reloadCurrent: () => Promise<void>
  editAt: (at: number, text: string) => Promise<void>
  newChat: () => void
  send: (text: string, images?: Array<{ data: string; mimeType: string }>, urls?: string[]) => Promise<void>
  stop: () => Promise<void>
  answer: (text: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  archive: (id: string, archived: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
  compact: () => Promise<void>
  setModel: (m: string) => void
  setReasoning: (r: string) => void
  setMode: (m: AgentState["mode"]) => void
  setSidebar: (open: boolean) => void
  setBanner: (b: Banner | null) => void
}

function patchLive(msgs: Msg[], liveId: string, fn: (parts: PartData[]) => PartData[]): Msg[] {
  return msgs.map((m) => (m.id === liveId ? { ...m, parts: fn(m.parts) } : m))
}

/** Persisted UI preferences. Reading or writing localStorage THROWS where a
 *  browser blocks site data (private windows, "block all cookies", an
 *  embedded frame), and these run while the store is being created — an
 *  unguarded read there takes the whole UI down before it renders. */
const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      // preference is session-only; nothing here is worth failing an action for
    }
  },
}

const MODES: AgentState["mode"][] = ["normal", "plan", "accept"]
const storedMode = (): AgentState["mode"] => {
  const v = prefs.get("agent-ui-mode")
  return MODES.find((m) => m === v) ?? "normal"
}

/** The open thread is remembered so a reload — the rebuild reload the app does
 *  to itself included — lands back in the conversation instead of a blank new
 *  chat, taking the composer draft keyed to that thread with it. */
const rememberSession = (id: string | null): void => prefs.set("agent-ui-session", id ?? "")

let liveId: string | null = null

export const useAgent = create<AgentState>()((set, get) => {
  return {
    sessions: [],
    sessionId: null,
    msgs: [],
    running: false,
    banner: null,
    ask: null,
    models: [],
    model: prefs.get("agent-ui-model"),
    reasoning: prefs.get("agent-ui-reasoning") ?? "",
    mode: storedMode(),
    wsDown: false,
    usage: null,
    mcp: [],
    sidebarOpen: false,
    sidebarPinned: prefs.get("agent-ui-sidebar") !== "closed",

    init: async () => {
      try {
        const [settings, models] = await Promise.all([getSettings(), listModels()])
        set({
          models,
          model: get().model ?? settings.model ?? null,
          reasoning: get().reasoning || settings.reasoning || "",
        })
      } catch (e) {
        set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
      }
      await Promise.all([get().refreshSessions(), get().refreshMcp()])
      const last = prefs.get("agent-ui-session")
      if (last && !get().sessionId && get().sessions.some((x) => x.sessionId === last)) await get().open(last)
    },

    refreshSessions: async () => {
      try {
        set({ sessions: await sessionsApi.list() })
      } catch {
        // an unauthed or down engine keeps the list it had; the banner says why
      }
    },

    refreshMcp: async () => {
      try {
        set({ mcp: await listMcp() })
      } catch {
        // MCP status is decoration; never block the chat on it
      }
    },

    open: async (id) => {
      if (get().running) await get().stop()
      streamDeltaBatcher.reset()
      rememberSession(id)
      set({ sessionId: id, msgs: [], banner: null, ask: null, sidebarOpen: false })
      try {
        const r = await sessionsApi.get(id)
        if (get().sessionId === id) set({ msgs: msgsFromRuns(r.runs ?? []) })
      } catch (e) {
        set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
      }
    },

    /** Refetch the open session so message ids match the engine's run records. */
    reloadCurrent: async () => {
      const sid = get().sessionId
      if (!sid) return
      try {
        const r = await sessionsApi.get(sid)
        if (get().sessionId === sid) set({ msgs: msgsFromRuns(r.runs ?? []) })
      } catch {
        // keep the local view; the stream already showed the run
      }
    },

    /** Edit/regenerate: drop the run at `at` and resend `text` as a new run. */
    editAt: async (at, text) => {
      const s = get()
      if (!s.sessionId || s.running || !text.trim()) return
      try {
        await sessionsApi.truncate(s.sessionId, at)
      } catch (e) {
        set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
        return
      }
      await get().reloadCurrent()
      await get().send(text)
    },

    newChat: () => {
      if (get().running) void get().stop()
      streamDeltaBatcher.reset()
      rememberSession(null)
      set({ sessionId: null, msgs: [], banner: null, ask: null, sidebarOpen: false })
    },

    send: async (text, images, urls) => {
      const s = get()
      if (s.running && s.sessionId) {
        const live = uid("live")
        liveId = live
        set({
          msgs: [...s.msgs, { id: uid("m"), role: "user", parts: [{ kind: "text", text }] }, { id: live, role: "assistant", parts: [], streaming: true }],
        })
        try {
          await steerAgent(s.sessionId, text)
        } catch (e) {
          set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
        }
        return
      }
      streamDeltaBatcher.reset()
      const userMsg: Msg = {
        id: uid("m"),
        role: "user",
        parts: [{ kind: "text", text }],
        images: urls?.length ? urls : undefined,
      }
      const id = uid("live")
      liveId = id
      set({
        msgs: [...s.msgs, userMsg, { id, role: "assistant", parts: [], streaming: true }],
        running: true,
        banner: null,
        usage: null,
      })
      try {
        const res: AgentResponse = await sendAgent({
          message: text,
          sessionId: s.sessionId ?? undefined,
          model: s.model ?? undefined,
          reasoning: s.reasoning || undefined,
          mode: s.mode,
          images: images?.length ? images : undefined,
        })
        streamDeltaBatcher.reset()
        rememberSession(res.sessionId)
        const finalParts = partsFromResponse(res)
        set((st) => ({
          msgs: st.msgs.map((m) => (m.id === id ? { ...m, parts: finalParts, streaming: false } : m)),
          running: false,
          sessionId: res.sessionId,
          usage: res.usage ?? null,
          banner: res.error
            ? { kind: "error", text: res.error }
            : res.autoCompacted
              ? { kind: "info", text: "Context auto-compacted" }
              : st.banner,
        }))
        liveId = null
        void get().refreshSessions()
        void get().reloadCurrent()
      } catch (e) {
        streamDeltaBatcher.flush()
        const msg = e instanceof Error ? e.message : String(e)
        set((st) => ({
          msgs: patchLive(st.msgs, id, () => {
            const partial = st.msgs.find((m) => m.id === id)?.parts ?? []
            return [...partial, { kind: "text", text: `\n\n**Failed:** ${msg}` } satisfies PartData]
          }),
          running: false,
          banner: { kind: "error", text: msg },
        }))
        liveId = null
      }
    },

    stop: async () => {
      const sid = get().sessionId
      if (!sid) return
      try {
        await stopAgent(sid)
      } catch {
        // the run POST resolves with stopped:true either way
      }
    },

    answer: async (text) => {
      const a = get().ask
      if (!a) return
      set({ ask: null })
      try {
        await answerAgent(a.sessionId, a.id, text)
      } catch (e) {
        set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
      }
    },

    rename: async (id, title) => {
      try {
        await sessionsApi.rename(id, title)
        set({ sessions: get().sessions.map((x) => (x.sessionId === id ? { ...x, title } : x)) })
      } catch (e) {
        set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
      }
    },

    archive: async (id, archived) => {
      try {
        await sessionsApi.archive(id, archived)
        set({ sessions: get().sessions.map((x) => (x.sessionId === id ? { ...x, archived } : x)) })
      } catch (e) {
        set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
      }
    },

    remove: async (id) => {
      try {
        await sessionsApi.remove(id)
        const rest = get().sessions.filter((x) => x.sessionId !== id)
        set({ sessions: rest })
        if (get().sessionId === id) {
          rememberSession(null)
          set({ sessionId: null, msgs: [] })
        }
      } catch (e) {
        set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
      }
    },

    compact: async () => {
      const sid = get().sessionId
      if (!sid || get().running) return
      try {
        const r = await sessionsApi.compact(sid)
        await get().refreshSessions()
        await get().open(r.sessionId)
        set({ banner: { kind: "info", text: `Compacted ${r.runsBefore} runs` } })
      } catch (e) {
        set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
      }
    },

    setModel: (m) => {
      prefs.set("agent-ui-model", m)
      set({ model: m })
      const mdl = get().models.find((x) => `${x.provider}/${x.modelId}` === m)
      if (mdl && !mdl.reasoningLevels.includes(get().reasoning)) {
        const def = mdl.reasoningLevels[0] ?? ""
        prefs.set("agent-ui-reasoning", def)
        set({ reasoning: def })
      }
    },

    setReasoning: (r) => {
      prefs.set("agent-ui-reasoning", r)
      set({ reasoning: r })
    },

    setMode: (m) => {
      prefs.set("agent-ui-mode", m)
      set({ mode: m })
    },

    setSidebar: (open) => set({ sidebarOpen: open }),
    setSidebarPinned: (pinned) => {
      prefs.set("agent-ui-sidebar", pinned ? "open" : "closed")
      set({ sidebarPinned: pinned })
    },
    setBanner: (b) => set({ banner: b }),
  }
})

// ---- WS feed: text deltas + lifecycle events for the live run ----

let retry = 0

export function connectWs(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:"
  let seenBuild: number | null = null
  let reloadPending = false
  const ws = new WebSocket(`${proto}//${location.host}/v1/ws`)
  ws.onopen = () => {
    retry = 0
    useAgent.setState({ wsDown: false })
  }
  ws.onclose = () => {
    useAgent.setState({ wsDown: true })
    const wait = Math.min(15000, 1000 * 2 ** retry++)
    setTimeout(connectWs, wait)
  }
  ws.onmessage = (ev) => {
    let msg: { type?: string; build?: number; payload?: { sessionId?: string; delta?: string; ev?: StreamEvent } }
    try {
      msg = JSON.parse(ev.data as string)
    } catch {
      return
    }
    if (msg.type === "hello") {
      if (typeof msg.build === "number") {
        if (seenBuild === null) seenBuild = msg.build
        else if (msg.build !== seenBuild) {
          reloadPending = true
          if (document.visibilityState === "visible") location.reload()
          else
            document.addEventListener(
              "visibilitychange",
              () => {
                if (document.visibilityState === "visible" && reloadPending) location.reload()
              },
              { once: true },
            )
        }
      }
      return
    }
    if (msg.type === "connections_changed") {
      // engine-side connection change (added key, new endpoint): the model
      // catalog is stale. The engine emits after discovery finished, so the
      // re-pull lands the fresh list immediately.
      listModels()
        .then((models) => useAgent.setState({ models }))
        .catch(() => undefined)
      return
    }
    const st = useAgent.getState()
    const payload = msg.payload
    if (!payload) return
    if (payload.sessionId !== st.sessionId) {
      // First message of a new thread: the engine assigns the session id only
      // when POST /v1/agent resolves, but deltas stream long before that.
      // Adopt the id from the run's first delta or every token would be
      // dropped and the reply would land all at once at the end.
      if (st.sessionId === null && st.running) {
        rememberSession(payload.sessionId ?? null)
        useAgent.setState({ sessionId: payload.sessionId })
        // the thread now exists engine-side — pull it into the sidebar now
        // rather than at the end of the run, which for a long agent turn is
        // minutes of the list looking like nothing was created
        void useAgent.getState().refreshSessions()
      } else return
    }
    if (msg.type === "agent_delta" && payload.delta) {
      streamDeltaBatcher.enqueue({ type: "text", delta: payload.delta })
    } else if (msg.type === "agent_event" && payload.ev) {
      const e = payload.ev
      if (e.type === "thinking") {
        streamDeltaBatcher.enqueue({ type: "thinking", delta: e.delta })
      } else {
        streamDeltaBatcher.flush()
      }
      if (e.type === "thinking_end" || e.type === "tool_start" || e.type === "tool_end" || e.type === "ask_user" || e.type === "ask_user_done") {
        foldStream(e)
      }
    }
  }
}

const streamDeltaBatcher = createStreamDeltaBatcher(
  (events) => foldStreamBatch(events),
  {
    schedule: (callback) => window.setTimeout(callback, 40),
    cancel: (handle) => window.clearTimeout(handle),
  },
)

function foldStreamBatch(events: StreamEvent[]): void {
  if (!events.length) return
  if (!liveId) liveId = uid("live")
  const target = liveId
  useAgent.setState((st) => {
    const exists = st.msgs.some((m) => m.id === target)
    const msgs = exists ? st.msgs : [...st.msgs, { id: target, role: "assistant" as const, parts: [], streaming: true }]
    return {
      msgs: patchLive(msgs, target, (parts) => events.reduce((next, event) => applyStreamEvent(next, event), parts)),
    }
  })
}

function foldStream(ev: StreamEvent): void {
  const store = useAgent.getState()
  if (ev.type === "ask_user") {
    if (store.sessionId)
      useAgent.setState({
        ask: {
          sessionId: store.sessionId,
          id: ev.id ?? uid("ask"),
          question: ev.question ?? "",
          options: ev.options,
          detail: ev.detail,
        },
      })
    return
  }
  if (ev.type === "ask_user_done") {
    useAgent.setState({ ask: null })
    return
  }
  foldStreamBatch([ev])
}
