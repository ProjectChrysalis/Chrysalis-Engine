import { ArrowElbowDownLeft } from "@phosphor-icons/react"
import { useState, type ReactNode } from "react"
import { useAgent } from "./store"

/** Pending ask_user: option buttons plus free text. Blocks the run until answered. */
export function AskBar(): ReactNode {
  const ask = useAgent((s) => s.ask)
  const answer = useAgent((s) => s.answer)
  const [draft, setDraft] = useState("")
  if (!ask) return null

  const submit = (text: string): void => {
    const t = text.trim()
    if (t) void answer(t)
    setDraft("")
  }

  return (
    <div className="border-ring/40 bg-card flex flex-col gap-2 rounded-xl border p-3">
      <div>
        <p className="text-sm font-medium">{ask.question}</p>
        {ask.detail ? (
          <p className="text-muted-foreground mt-1 text-xs whitespace-pre-wrap">{ask.detail}</p>
        ) : null}
      </div>
      {ask.options?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {ask.options.map((o) => (
            <button
              key={o}
              className="border-border hover:bg-accent rounded-full border px-3 py-1.5 text-xs"
              onClick={() => submit(o)}
            >
              {o}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          submit(draft)
        }}
      >
        <input
          value={draft}
          placeholder="Answer"
          onChange={(e) => setDraft(e.target.value)}
          className="border-input bg-background min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-sm outline-none"
        />
        <button
          type="submit"
          title="Send"
          className="bg-primary text-primary-foreground flex items-center rounded-lg px-2.5"
        >
          <ArrowElbowDownLeft size={14} />
        </button>
      </form>
    </div>
  )
}
