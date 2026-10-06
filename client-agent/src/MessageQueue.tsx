import { useAui } from "@assistant-ui/react"
import { X } from "@phosphor-icons/react"
import { useAgent } from "./store"
import { tr } from "./i18n"

export function MessageQueue() {
  const aui = useAui()
  const sessionId = useAgent((s) => s.sessionId)
  const items = useAgent((s) => s.queue)
  const queue = items.filter((item) => item.sessionId === sessionId)
  const cancel = useAgent((s) => s.cancelQueued)
  if (!queue.length) return null
  return (
    <section aria-label={tr("Queued messages")} className="agent-message-queue">
      <p className="text-muted-foreground text-xs">{tr("Queued messages")}</p>
      {queue.map((item) => (
        <div key={item.id} className="agent-queue-item">
          <p>{item.text}</p>
          <button type="button" aria-label={tr("Restore queued message")} title={tr("Restore queued message")} disabled={item.pending} onClick={async () => {
            const text = await cancel(item.id)
            if (text === null) return
            const current = aui.composer.getState().text
            aui.composer.setText(current ? current + "\n\n" + text : text)
          }}><X size={16} aria-hidden="true" /></button>
        </div>
      ))}
    </section>
  )
}
