import { ExportedMessageRepository, type ThreadMessageLike } from "@assistant-ui/react"
import type { ReadonlyJSONObject } from "assistant-stream/utils"
import { visibleParts, type Msg } from "./runs"

function toThreadMessage(m: Msg): ThreadMessageLike {
  if (m.role === "user") {
    const content: ThreadMessageLike["content"] = [
      ...(m.images ?? []).map((image) => ({ type: "image" as const, image })),
      ...m.parts.map((p) => ({ type: "text" as const, text: p.kind === "text" ? p.text : "" })),
    ]
    return { id: m.id, role: "user", content }
  }
  return {
    id: m.id,
    role: "assistant",
    ...(m.streaming ? { status: { type: "running" as const } } : {}),
    content: visibleParts(m).map((p) => {
      if (p.kind === "think") return { type: "reasoning" as const, text: p.text }
      if (p.kind === "text") return { type: "text" as const, text: p.text }
      // a presented plan is read as part of the reply, not folded away with the steps
      if (p.name === "present_plan" && typeof p.args.plan === "string" && p.args.plan) return { type: "text" as const, text: p.args.plan }
      // engine tool args arrive from JSON.parse — display-only cast at this boundary
      return {
        type: "tool-call" as const,
        toolCallId: p.callId,
        toolName: p.name,
        args: p.args as ReadonlyJSONObject,
        isError: p.state === "error",
        ...(p.state === "running"
          ? {}
          : { result: { ok: p.state === "ok", summary: p.summary, output: p.output, diff: p.diff } }),
      }
    }),
  }
}

// Saved history replaces streamed messages; removed IDs must leave the UI too.
export const threadMessageRepository = (messages: Msg[]) =>
  ExportedMessageRepository.fromArray(messages.map(toThreadMessage))
