import { tr } from "@/i18n"
import { ArrowElbowDownLeft, X } from "@phosphor-icons/react"
import { useState, useEffect, type ReactNode } from "react"
import { useAgent } from "./store"

/** Pending ask_user: option buttons plus free text. Blocks the run until answered. */
export function AskBar(): ReactNode {
  const ask = useAgent((s) => s.ask)
  const dismiss = useAgent((s) => s.dismissAsk)
  const [pending, setPending] = useState(false)
  const answer = useAgent((s) => s.answer)
  const [draft, setDraft] = useState("")
  useEffect(() => { setDraft(""); setPending(false) }, [ask?.id])
  if (!ask) return null

  const submit = (text: string): void => {
    const t = text.trim()
    if (!t || pending) return
    setPending(true)
    void answer(t).finally(() => setPending(false))
  }

  return (
    <div className="agent-ask border-ring/40 bg-card rounded-xl border p-3">
      <div className="agent-ask-heading">
        <p className="text-sm font-medium">{ask.question}</p>
        <button type="button" disabled={pending} aria-label={tr("Dismiss question")} title={tr("Dismiss question")} onClick={() => { setPending(true); void dismiss().finally(() => setPending(false)) }}><X size={16} aria-hidden="true" /></button>
      </div>
      <div className="agent-ask-content">
        {ask.detail ? (
          <p className="text-muted-foreground mt-1 text-xs whitespace-pre-wrap">{ask.detail}</p>
        ) : null}
      {ask.options?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {ask.options.map((o) => (
            <button
              key={o}
              type="button"
              disabled={pending}
              className="border-border hover:bg-accent max-w-full rounded-lg border px-3 py-1.5 text-left text-xs whitespace-normal [overflow-wrap:anywhere]"
              onClick={() => submit(o)}
            >
              {o}
            </button>
          ))}
        </div>
      ) : null}
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          submit(draft)
        }}
      >
        <input
          value={draft}
          placeholder={tr("Answer")}
          onChange={(e) => setDraft(e.target.value)}
          className="border-input bg-background min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-sm outline-none"
        />
        <button
          type="submit"
          disabled={pending || !draft.trim()}
          aria-label={tr("Send")}
          title={tr("Send")}
          className="bg-primary text-primary-foreground flex items-center rounded-lg px-2.5"
        >
          <ArrowElbowDownLeft size={14} />
        </button>
      </form>
    </div>
  )
}
