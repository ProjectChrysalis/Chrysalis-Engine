
import { useEffect, useRef } from "react"
import { TerminalWindow, BracketsCurly } from '@phosphor-icons/react'
import type { QuickReplySet } from "@/lib/types"
import { cn } from "@/lib/utils"

export interface AcItem {
  key: string
  label: string
  insert: string
  hint: string
  kind: "slash" | "macro"
  /** slash commands that map to an app action rather than inserted text */
  action?: "continue" | "impersonate" | "regenerate" | "swipe" | "send" | "imagine" | "help" | "gallery"
  /**
   * Command accepts a trailing argument. Picking it from the list types the
   * command out and waits for the argument, rather than firing immediately on
   * an empty one.
   */
  takesArgs?: boolean
}

export const MACROS: { name: string; hint: string }[] = [
  { name: "char", hint: "Character's name" },
  { name: "user", hint: "Your persona's name" },
  { name: "persona", hint: "Your persona's description" },
  { name: "description", hint: "Character's description" },
  { name: "personality", hint: "Character's personality" },
  { name: "scenario", hint: "Chat scenario" },
  { name: "time", hint: "Current time" },
  { name: "date", hint: "Current date" },
  { name: "weekday", hint: "Current day of the week" },
  { name: "isotime", hint: "Current ISO time (24h)" },
  { name: "isodate", hint: "Current ISO date (YYYY-MM-DD)" },
  { name: "random:a,b,c", hint: "Random item from the list (re-rolls each use)" },
  { name: "pick:a,b,c", hint: "Random item, stable for this chat" },
  { name: "roll:d20", hint: "Dice roll, e.g. d6, 2d8, d20+3" },
  { name: "lastMessage", hint: "Text of the last message" },
  { name: "lastUserMessage", hint: "Text of your last message" },
  { name: "lastCharMessage", hint: "Text of the character's last message" },
  { name: "idle_duration", hint: "Time since the last user message" },
  { name: "setvar::name::value", hint: "Set a chat variable (persists on the chat)" },
  { name: "getvar::name", hint: "Read a chat variable" },
  { name: "addvar::name::2", hint: "Add a number to a chat variable" },
  { name: "incvar::name", hint: "Increment a chat variable" },
  { name: "decvar::name", hint: "Decrement a chat variable" },
  { name: "summary", hint: "The chat's running summary" },
  { name: "newline", hint: "Inserts a newline" },
  { name: "trim", hint: "Eats the newlines around it" },
]

const BUILTIN_SLASH: AcItem[] = [
  { key: "/continue", label: "/continue", insert: "", hint: "Continue the last reply", kind: "slash", action: "continue" },
  { key: "/impersonate", label: "/impersonate", insert: "", hint: "Draft a reply written as you", kind: "slash", action: "impersonate" },
  { key: "/regenerate", label: "/regenerate", insert: "", hint: "Regenerate the last reply", kind: "slash", action: "regenerate" },
  { key: "/swipe", label: "/swipe", insert: "", hint: "Generate an alternative reply (new swipe)", kind: "slash", action: "swipe" },
  { key: "/gallery", label: "/gallery", insert: "", hint: "Open this character's gallery", kind: "slash", action: "gallery" },
  { key: "/help", label: "/help", insert: "", hint: "Every command and macro", kind: "slash", action: "help" },
]

/** Listed only when the image-generation extension is switched on. */
const IMAGINE: AcItem = {
  key: "/imagine", label: "/imagine", insert: "", kind: "slash", action: "imagine",
  takesArgs: true,
  hint: "Draw the scene, or: you, face, me, background, or your own description",
}

/** Build the slash command list: built-ins plus quick replies (labeled). */
export function getSlashCommands(qrSets: QuickReplySet[], imageGenEnabled = false): AcItem[] {
  const fromQR: AcItem[] = qrSets
    .filter((s) => s.enabled)
    .flatMap((s) =>
      s.replies
        .filter((r) => !BUILTIN_SLASH.some((b) => b.key === r.message))
        .map((r) => ({
          key: `/qr-${r.id}`,
          label: `/${r.label.toLowerCase().replace(/\s+/g, "-")}`,
          insert: r.message,
          hint: `Shortcut (${s.name}): ${r.message.slice(0, 60)}`,
          kind: "slash" as const,
          action: r.mode === "send" ? ("send" as const) : undefined,
        })),
    )
  return [...BUILTIN_SLASH, ...(imageGenEnabled ? [IMAGINE] : []), ...fromQR]
}

/** Subsequence fuzzy match, returns score (lower is better) or null. */
export function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  let qi = 0
  let score = 0
  let last = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += last >= 0 ? ti - last - 1 : ti
      last = ti
      qi++
    }
  }
  return qi === q.length ? score : null
}

export interface Trigger {
  type: "slash" | "macro" | "mention"
  query: string
  start: number // index in value where the trigger token starts
}

/** Detect an active autocomplete trigger at the caret. */
export function detectTrigger(value: string, caret: number, allowMention = false): Trigger | null {
  const before = value.slice(0, caret)
  // slash: only at the very start of the message
  if (before.startsWith("/") && !/\s/.test(before)) {
    return { type: "slash", query: before.slice(1), start: 0 }
  }
  // macro: last "{{" with no closing "}}" after it, no newline inside
  const open = before.lastIndexOf("{{")
  if (open >= 0 && !before.slice(open).includes("}}") && !before.slice(open).includes("\n")) {
    return { type: "macro", query: before.slice(open + 2), start: open }
  }
  if (allowMention) {
    const at = before.lastIndexOf("@")
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1] ?? '')) && !/\s/.test(before.slice(at + 1))) {
      return { type: "mention", query: before.slice(at + 1), start: at }
    }
  }
  return null
}

export function AutocompletePopup({
  items,
  activeIndex,
  onSelect,
  onHover,
}: {
  items: AcItem[]
  activeIndex: number
  onSelect: (item: AcItem) => void
  onHover: (index: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  if (items.length === 0) return null

  return (
    <div
      className="absolute bottom-full left-0 z-30 mb-1 max-h-64 w-full max-w-md overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
      role="listbox"
      aria-label="Autocomplete suggestions"
    >
      <div ref={listRef} className="flex flex-col">
        {items.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onSelect(item) }}
            className={cn(
              "flex items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm",
              i === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground",
            )}
          >
            {item.kind === "slash"
              ? <TerminalWindow className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />
              : <BracketsCurly className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />}
            <span className="shrink-0 font-mono text-xs font-semibold">{item.label}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.hint}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
