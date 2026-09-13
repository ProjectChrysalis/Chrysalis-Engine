import {
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { Thread } from "@/components/assistant-ui/elements/thread.aui"
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui"
import { useEffect, useMemo, type ReactNode } from "react"
import type { ReadonlyJSONObject } from "assistant-stream/utils"
import { Dialog } from "@base-ui/react/dialog"
import { X } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Header } from "./Header"
import { useAgent } from "./store"
import { AgentToolFallback, toolConfig } from "./tools"
import { visibleParts, type Msg } from "./runs"

const imageAttachments = new SimpleImageAttachmentAdapter()

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

interface SendImage {
  data: string
  mimeType: string
  url: string
}

function extractSend(message: AppendMessage): { text: string; images?: SendImage[] } {
  let text = ""
  for (const c of message.content) if (c.type === "text") text += c.text
  const images: SendImage[] = []
  for (const a of message.attachments ?? [])
    for (const c of a.content)
      if (c.type === "image" && typeof c.image === "string" && c.image.startsWith("data:")) {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(c.image)
        if (m?.[1] && m[2]) images.push({ mimeType: m[1], data: m[2], url: c.image })
      }
  return { text, images: images.length ? images : undefined }
}

/** message ids embed their run's `at` (u<at> / a<at>) — the engine truncate target */
function runAtFromId(id: string | null | undefined): number | null {
  if (!id || id[0] !== "u") return null
  const at = Number(id.slice(1))
  return Number.isFinite(at) ? at : null
}

export default function App(): ReactNode {
  const msgs = useAgent((s) => s.msgs)
  const running = useAgent((s) => s.running)
  const banner = useAgent((s) => s.banner)
  const setBanner = useAgent((s) => s.setBanner)
  const sessionId = useAgent((s) => s.sessionId)
  const sessions = useAgent((s) => s.sessions)
  const sidebarOpen = useAgent((s) => s.sidebarOpen)
  const setSidebar = useAgent((s) => s.setSidebar)
  const sidebarPinned = useAgent((s) => s.sidebarPinned)

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)")
    const closeDrawer = () => { if (media.matches) setSidebar(false) }
    media.addEventListener("change", closeDrawer)
    return () => media.removeEventListener("change", closeDrawer)
  }, [setSidebar])

  const messages = useMemo(() => msgs.map(toThreadMessage), [msgs])
  const threads = useMemo(
    () => sessions.filter((s) => !s.archived).map((s) => ({ status: "regular" as const, id: s.sessionId, title: s.title?.trim() || "Untitled" })),
    [sessions],
  )
  const archivedThreads = useMemo(
    () => sessions.filter((s) => s.archived).map((s) => ({ status: "archived" as const, id: s.sessionId, title: s.title?.trim() || "Untitled" })),
    [sessions],
  )
  const runtime = useExternalStoreRuntime({
    isRunning: running,
    messages,
    convertMessage: (m) => m,
    adapters: {
      attachments: imageAttachments,
      threadList: {
        threadId: sessionId ?? undefined,
        threads,
        archivedThreads,
        onSwitchToNewThread: () => useAgent.getState().newChat(),
        onSwitchToThread: (id: string) => useAgent.getState().open(id),
        onRename: (id: string, title: string) => useAgent.getState().rename(id, title),
        onArchive: (id: string) => useAgent.getState().archive(id, true),
        onUnarchive: (id: string) => useAgent.getState().archive(id, false),
        onDelete: (id: string) => useAgent.getState().remove(id),
      },
    },
    onNew: async (message) => {
      const { text, images } = extractSend(message)
      if (!text) return
      await useAgent.getState().send(
        text,
        images?.map(({ data, mimeType }) => ({ data, mimeType })),
        images?.map(({ url }) => url),
      )
    },
    onCancel: async () => {
      await useAgent.getState().stop()
    },
    onEdit: async (message) => {
      const { text } = extractSend(message)
      const source = (message as { sourceId?: string }).sourceId
      const at = runAtFromId(source) ?? runAtFromId(message.parentId)
      if (at !== null) await useAgent.getState().editAt(at, text)
    },
    onReload: async (parentId) => {
      const at = runAtFromId(parentId)
      if (at === null) return
      const original = useAgent.getState().msgs.find((m) => m.id === `u${at}`)
      const text = original?.parts.find((p) => p.kind === "text")
      if (text && text.kind === "text") await useAgent.getState().editAt(at, text.text)
    },
  })

  return (
    <AssistantRuntimeProvider runtime={runtime} config={toolConfig}>
      <div className="bg-background text-foreground flex h-dvh overflow-hidden">
        <aside aria-label="Conversations" className={`bg-sidebar text-sidebar-foreground w-64 shrink-0 flex-col border-r ${sidebarPinned ? "hidden md:flex" : "hidden"}`}>
          <div className="flex h-12 shrink-0 items-center px-4 text-sm font-semibold">Chrysalis</div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2"><ThreadList /></div>
        </aside>
        <Dialog.Root open={sidebarOpen} onOpenChange={setSidebar}>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
            <Dialog.Popup finalFocus={() => document.getElementById("agent-sidebar-toggle")} className="bg-sidebar text-sidebar-foreground fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r outline-none">
              <div className="flex h-14 shrink-0 items-center justify-between px-4">
                <Dialog.Title className="text-sm font-semibold">Conversations</Dialog.Title>
                <Dialog.Close render={<Button variant="ghost" size="icon" aria-label="Close sidebar" />}><X size={18} /></Dialog.Close>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2"><ThreadList /></div>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
        <main className="flex min-h-0 min-w-0 flex-grow flex-col overflow-hidden">
          <Header />
          {banner ? (
            <div
              className={`flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs ${
                banner.kind === "error"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-secondary text-secondary-foreground"
              }`}
            >
              <span>{banner.text}</span>
              <button className="underline" onClick={() => setBanner(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          <Thread components={{ ToolFallback: AgentToolFallback }} />
        </main>
      </div>
    </AssistantRuntimeProvider>
  )
}
