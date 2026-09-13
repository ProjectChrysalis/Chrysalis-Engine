// Engine run/turn records → the flat part list the UI renders. Both the
// session history loader and the final POST response go through here, so a
// stream and its authoritative record land on the same shapes.
import type { AgentResponse, EngineRun, EngineTool, EngineTurn } from "./api.js"
import type { StreamEvent } from "./streaming.js"

export type ToolState = "running" | "ok" | "error"

export interface ToolPartData {
  kind: "tool"
  callId: string
  name: string
  args: Record<string, unknown>
  state: ToolState
  summary?: string
  output?: string
  diff?: string
}

export interface ThinkPartData {
  kind: "think"
  text: string
  ms?: number
  done: boolean
}

export interface TextPartData {
  kind: "text"
  text: string
}

export type PartData = ToolPartData | ThinkPartData | TextPartData

export interface Msg {
  id: string
  role: "user" | "assistant"
  parts: PartData[]
  images?: string[]
  /** Engine run this message belongs to (its `at`); ids embed it so
   *  edit/regenerate can target the engine run to truncate from. */
  runAt?: number
  /** Set on the live in-flight assistant message; drives part statuses so
   *  the reasoning disclosure auto-opens while it streams. */
  streaming?: boolean
}

let seq = 0
export const uid = (p: string): string => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`

function toolPart(t: EngineTool): ToolPartData {
  return {
    kind: "tool",
    callId: uid("call"),
    name: t.name,
    args: t.args ?? {},
    state: t.ok ? "ok" : "error",
    summary: t.summary,
    output: t.output,
    diff: t.diff,
  }
}

/** Some providers emit stray thinking fragments ("." or whitespace) around
 *  tool turns; an empty block is not reasoning. */
export const hasReasoning = (s: string | undefined): s is string => !!s && s.trim().length > 0

/** The parts a message shows. A blank thinking fragment is dropped here, for
 *  the live stream and the loaded history alike, so both lay out the same
 *  steps and the part indices the thread renders map back onto this list. */
export const visibleParts = (m: Msg): PartData[] =>
  m.parts.filter((p) => p.kind !== "think" || hasReasoning(p.text))

/** Each model turn in the order it streamed: its reasoning, the text it wrote,
 *  then the tool calls it made. A thinking phase after a tool call stays after
 *  that call, where it happened. */
export function partsFromTurns(turns: EngineTurn[]): PartData[] {
  const out: PartData[] = []
  for (const turn of turns) {
    if (hasReasoning(turn.thinking)) {
      out.push({ kind: "think", text: turn.thinking, ...(turn.thinkingMs ? { ms: turn.thinkingMs } : {}), done: true })
    }
    if (turn.text) out.push({ kind: "text", text: turn.text })
    for (const t of turn.tools) out.push(toolPart(t))
  }
  return out
}

/** Legacy single-turn runs (no turns[]): thinking, then tools, then text. */
function partsLegacy(t: { thinking?: string; thinkingMs?: number; tools?: EngineTool[]; text?: string }): PartData[] {
  const out: PartData[] = []
  if (hasReasoning(t.thinking)) out.push({ kind: "think", text: t.thinking, ms: t.thinkingMs, done: true })
  for (const tool of t.tools ?? []) out.push(toolPart(tool))
  if (t.text) out.push({ kind: "text", text: t.text })
  return out
}

export function partsFromResponse(res: AgentResponse): PartData[] {
  const turns = res.turns ?? []
  const fromTurns = partsFromTurns(turns)
  if (fromTurns.length) {
    // Turn text carries the reply. A final turn that produced no text is
    // either an empty model response or a provider failure: the engine says
    // so in finalText/error, and turns never carry that, so add it here.
    const lastText = turns.at(-1)?.text
    const fallback = res.finalText || res.error
    if (!lastText && fallback) fromTurns.push({ kind: "text", text: fallback })
    return fromTurns
  }
  return partsLegacy({ thinking: res.thinking, thinkingMs: res.thinkingMs, tools: res.toolTrace, text: res.finalText || res.error })
}

export function msgsFromRuns(runs: EngineRun[]): Msg[] {
  const msgs: Msg[] = []
  for (const run of runs) {
    if (run.type === "compact") {
      msgs.push({
        id: uid("m"),
        role: "assistant",
        parts: [{ kind: "text", text: run.summary ? `_Compacted: ${run.summary}_` : "_Context compacted_" }],
      })
      continue
    }
    if (run.type !== "run") continue
    if (run.user !== undefined)
      msgs.push({
        id: `u${run.at}`,
        runAt: run.at,
        role: "user",
        parts: [{ kind: "text", text: run.user }],
        ...(run.images?.length ? { images: run.images } : {}),
      })
    const turns = run.turns ?? []
    const parts = turns.length
      ? partsFromTurns(turns)
      : partsLegacy({ thinking: run.thinking, thinkingMs: run.thinkingMs, tools: run.tools, text: run.assistant })
    if (parts.length) msgs.push({ id: `a${run.at}`, runAt: run.at, role: "assistant", parts })
  }
  return msgs
}

/** Fold a streamed delta/event into the live message's parts. */
export function applyStreamEvent(parts: PartData[], ev: StreamEvent): PartData[] {
  const out = [...parts]
  const last = out[out.length - 1]
  if (ev.type === "text") {
    if (last?.kind === "text") out[out.length - 1] = { ...last, text: last.text + (ev.delta ?? "") }
    else out.push({ kind: "text", text: ev.delta ?? "" })
    return out
  }
  if (ev.type === "thinking") {
    // a thinking phase continues only the block it is streaming into; one
    // that starts after a tool call or text is a new step, placed there
    if (last?.kind === "think" && !last.done) out[out.length - 1] = { ...last, text: last.text + (ev.delta ?? "") }
    else out.push({ kind: "think", text: ev.delta ?? "", done: false })
    return out
  }
  if (ev.type === "thinking_end") {
    if (last?.kind === "think") out[out.length - 1] = { ...last, done: true, ms: ev.ms }
    return out
  }
  if (ev.type === "tool_start") {
    // the same call is announced as the model starts writing it, again with
    // its finished arguments, and once more as it executes
    const i = ev.id ? out.findIndex((p) => p.kind === "tool" && p.callId === ev.id) : -1
    const known = i >= 0 ? out[i] : undefined
    if (known?.kind === "tool") {
      if (ev.args && Object.keys(ev.args).length) out[i] = { ...known, args: ev.args }
    } else {
      out.push({ kind: "tool", callId: ev.id ?? uid("call"), name: ev.name ?? "tool", args: ev.args ?? {}, state: "running" })
    }
    return out
  }
  if (ev.type === "tool_end") {
    const i = out.findIndex((p) => p.kind === "tool" && p.callId === ev.id)
    const p = out[i]
    if (p?.kind === "tool") out[i] = { ...p, state: ev.ok ? "ok" : "error", summary: ev.summary, output: ev.output, diff: ev.diff }
    return out
  }
  return out
}
