import { tr } from "./i18n"
// Client state: sessions, the open thread, the live run, and the WS feed.
// The stream updates a live assistant message in place; when POST /v1/agent
// resolves it is replaced by the authoritative turn record.
import { create } from "zustand"
import {
  agentApps,
  setAgentTarget,
  answerAgent,
  agentState,
  cancelQueuedAgent,
  dismissAgent,
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

export interface QueuedMessage { id: string; sessionId: string; text: string; pending: boolean; accepted?: boolean }

export interface AgentState {
  queue: QueuedMessage[]
  cancelQueued: (id: string) => Promise<string | null>
  dismissAsk: () => Promise<void>
  sessions: EngineSession[]
  sessionId: string | null
  appId: string | null
  apps: { id: string; name: string }[]
  targetChanging: boolean
  setApp: (appId: string | null) => Promise<void>
  msgs: Msg[]
  running: boolean
  stopping: boolean
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

let runSequence = 0
let liveId: string | null = null

let targetChange: Promise<void> | null = null

export const useAgent = create<AgentState>()((set, get) => {
  return {
    queue: (() => { try { return (JSON.parse(prefs.get("agent-ui-queue") ?? "[]") as QueuedMessage[]).map((item) => ({ ...item, pending: false })) } catch { return [] } })(),
    sessions: [],
    sessionId: null,
    appId: null,
    apps: [],
    targetChanging: false,
    setApp: async (appId) => {
      const state = get();
      if (state.running || state.targetChanging) return;
      set({ targetChanging: true });
      const operation = (async () => {
        try {
          if (state.sessionId) await setAgentTarget(state.sessionId, appId);
          if (get().sessionId === state.sessionId) set({ appId });
        } catch (e) { set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } }); }
        finally { set({ targetChanging: false }); }
      })();
      targetChange = operation;
      await operation;
      if (targetChange === operation) targetChange = null;
    },
    msgs: [],
    running: false,
    stopping: false,
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
        const [settings, models, catalog] = await Promise.all([getSettings(), listModels(), agentApps()])
        set({
          models,
          apps: catalog.apps,
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
      runSequence += 1
      liveId = null
      rememberSession(id)
      set({ running: false, stopping: false, sessionId: id, msgs: [], banner: null, ask: null, sidebarOpen: false })
      try {
        const r = await sessionsApi.get(id)
        if (get().sessionId === id) {
          const delivered = new Set((r.runs ?? []).flatMap((run) => run.turns?.map((turn) => turn.userId).filter(Boolean) ?? []));
          set((state) => ({ appId: r.appId, msgs: msgsFromRuns(r.runs ?? [], tr), queue: state.queue.filter((item) => !delivered.has(item.id)) }));
          const live = await agentState(id);
          if (get().sessionId === id) set((state) => ({ running: live.running, ask: live.ask ?? null, queue: [...state.queue.filter((item) => item.sessionId !== id || !live.queue.some((queued) => queued.id === item.id)).map((item) => item.sessionId === id ? { ...item, accepted: false } : item), ...live.queue.map((item) => ({ ...item, sessionId: id, pending: false, accepted: true }))] }));
        }
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
        if (get().sessionId === sid) {
          const delivered = new Set((r.runs ?? []).flatMap((run) => run.turns?.map((turn) => turn.userId).filter(Boolean) ?? []));
          set((state) => ({ msgs: msgsFromRuns(r.runs ?? [], tr), queue: state.queue.filter((item) => !delivered.has(item.id)) }));
        }
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
      runSequence += 1
      if (get().running) void get().stop()
      streamDeltaBatcher.reset()
      rememberSession(null)
      set({ running: false, stopping: false, sessionId: null, appId: null, msgs: [], banner: null, ask: null, sidebarOpen: false })
    },

    send: async (text, images, urls) => {
      if (targetChange) await targetChange
      const s = get()
      if (s.stopping) return
      if (s.running && s.sessionId) {
        if (images?.length) {
          set({ banner: { kind: "error", text: tr("Send attachments after the run finishes") } })
          throw new Error(tr("Send attachments after the run finishes"))
        }
        const id = uid("queued")
        set({ queue: [...s.queue, { id, sessionId: s.sessionId, text, pending: true }] })
        try {
          const reply = await steerAgent(s.sessionId, text, id)
          if (reply.queued === false) set((state) => ({ queue: state.queue.filter((item) => item.id !== id) }))
          set((state) => ({ queue: state.queue.map((item) => item.id === id ? { ...item, accepted: true } : item) }))
        } catch (e) {
          set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
        } finally {
          set((state) => ({ queue: state.queue.map((item) => item.id === id ? { ...item, pending: false } : item) }))
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
      set((state) => ({ queue: state.queue.map((item) => item.sessionId === s.sessionId ? { ...item, accepted: false } : item) }))
      const id = uid("live")
      const sequence = ++runSequence
      liveId = id
      const sid = s.sessionId ?? uid("session")
      rememberSession(sid)
      set({
        msgs: [...s.msgs, userMsg, { id, role: "assistant", parts: [], streaming: true }],
        running: true,
        stopping: false,
        sessionId: sid,
        banner: null,
        usage: null,
      })
      try {
        const res: AgentResponse = await sendAgent({
          message: text,
          appId: s.appId,
          sessionId: sid,
          model: s.model ?? undefined,
          reasoning: s.reasoning || undefined,
          mode: s.mode,
          images: images?.length ? images : undefined,
        })
        if (runSequence !== sequence || get().sessionId !== sid) return
        streamDeltaBatcher.reset()
        rememberSession(res.sessionId)
        const finalParts = partsFromResponse(res)
        set((st) => ({
          msgs: st.msgs.map((m) => ({ ...m, ...(m.id === id && !res.turns.some((turn) => turn.user !== undefined) ? { parts: finalParts } : {}), streaming: false })),
          running: false,
          stopping: false,
          sessionId: res.sessionId,
          appId: res.appId === undefined ? st.appId : res.appId,
          usage: res.usage ?? null,
          banner: res.stopped
            ? { kind: "info", text: tr("Stopped") }
            : res.stopReason === "length"
              ? { kind: "info", text: tr("Response reached the output limit.") }
              : res.error
            ? { kind: "error", text: res.error }
            : res.autoCompacted
              ? { kind: "info", text: tr("Context auto-compacted") }
              : st.banner,
        }))
        liveId = null
        void get().refreshSessions()
        void get().reloadCurrent()
      } catch (e) {
        if (runSequence !== sequence || get().sessionId !== sid) return
        streamDeltaBatcher.flush()
        const msg = e instanceof Error ? e.message : String(e)
        set((st) => ({
          msgs: patchLive(st.msgs, id, () => {
            const partial = st.msgs.find((m) => m.id === id)?.parts ?? []
            return [...partial, { kind: "text", text: `\n\n**${tr("Failed")}:** ${msg}` } satisfies PartData]
          }),
          running: false,
          stopping: false,
          banner: { kind: "error", text: msg },
        }))
        liveId = null
      }
    },

    stop: async () => {
      const { sessionId: sid, running, stopping } = get()
      if (!sid || !running || stopping) return
      const target = liveId
      streamDeltaBatcher.flush()
      set({ stopping: true, ask: null, banner: { kind: "info", text: tr("Stopping…") } })
      try {
        while (get().running && get().sessionId === sid && liveId === target) {
          try { await stopAgent(sid); return }
          catch (e) {
            if (!(e instanceof Error) || !e.message.includes("no active run for this session")) throw e
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
      } catch (e) {
        if (get().sessionId === sid && liveId === target) set({ stopping: false, banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
      }
    },

    cancelQueued: async (id) => {
      const item = get().queue.find((item) => item.id === id)
      if (!item || item.pending) return null
      if (item.accepted && get().running && get().sessionId === item.sessionId) {
        try { await cancelQueuedAgent(item.sessionId, id) }
        catch (e) {
          set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
          return null
        }
      }
      set((state) => ({ queue: state.queue.filter((item) => item.id !== id) }))
      return item.text
    },

    dismissAsk: async () => {
      const ask = get().ask
      if (!ask) return
      try {
        await dismissAgent(ask.sessionId, ask.id)
        if (get().ask?.id === ask.id) set({ ask: null })
      } catch (e) {
        set({ banner: { kind: "error", text: e instanceof Error ? e.message : String(e) } })
      }
    },

    answer: async (text) => {
      const a = get().ask
      if (!a) return
      try {
        await answerAgent(a.sessionId, a.id, text)
        if (get().ask?.id === a.id) set({ ask: null })
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
        set({ banner: { kind: "info", text: tr("Compacted {count} runs", { count: r.runsBefore }) } })
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
    if (msg.type === "agent_target" && payload?.sessionId === st.sessionId) {
      useAgent.setState({ appId: (payload as { appId?: string | null }).appId ?? null });
      return;
    }
    if (msg.type === "agent_settled" && payload?.sessionId === st.sessionId) {
      streamDeltaBatcher.flush();
      useAgent.setState({ running: false, stopping: false, ask: null });
      void useAgent.getState().reloadCurrent();
      void useAgent.getState().refreshSessions();
      return;
    }
    if (!st.running || (st.stopping && payload?.ev?.type !== "queue_sent")) return
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
      if (e.type === "thinking_end" || e.type === "tool_start" || e.type === "tool_end" || e.type === "ask_user" || e.type === "ask_user_done" || e.type === "queue_added" || e.type === "queue_sent" || e.type === "queue_cancelled") {
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
  if (ev.type === "queue_added") {
    if (ev.id && ev.text && store.sessionId) {
      const exists = store.queue.some((item) => item.id === ev.id)
      useAgent.setState({ queue: exists ? store.queue.map((item) => item.id === ev.id ? { ...item, accepted: true } : item) : [...store.queue, { id: ev.id, text: ev.text, sessionId: store.sessionId, pending: false, accepted: true }] })
    }
    return
  }
  if (ev.type === "queue_sent") {
    useAgent.setState({ queue: store.queue.filter((item) => item.id !== ev.id) })
    if (ev.text) {
      const next = uid("live")
      liveId = next
      useAgent.setState({ msgs: [...store.msgs.map((m) => ({ ...m, streaming: false })), { id: ev.id ?? uid("m"), role: "user", parts: [{ kind: "text", text: ev.text }] }, { id: next, role: "assistant", parts: [], streaming: true }] })
    }
    return
  }
  if (ev.type === "queue_cancelled") return
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
    if (store.ask?.id === ev.id) useAgent.setState({ ask: null })
    return
  }
  foldStreamBatch([ev])
}

useAgent.subscribe((state, previous) => { if (state.queue !== previous.queue) prefs.set("agent-ui-queue", JSON.stringify(state.queue)) })
