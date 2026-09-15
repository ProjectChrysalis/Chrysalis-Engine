import { useEffect, useState } from "react"
import { Broom, Plus, TextAa } from "@phosphor-icons/react"
import { ComposerPrimitive, unstable_useComposerInput, unstable_useSlashCommandAdapter } from "@assistant-ui/react"
import type { ReactNode } from "react"
import { agentCommands, type UserCommand } from "./api"
import { useAgent } from "./store"

/** Icon shown next to a command in the "/" menu. */
function commandIcon(id: string): ReactNode {
  if (id === "new") return <Plus size={15} />
  if (id === "compact") return <Broom size={15} />
  return <TextAa size={15} />
}

/**
 * Slash commands for the composer. Typing "/" opens a menu of actions that run
 * against the thread itself instead of being sent to the model. The popover,
 * keyboard navigation (arrows / enter / escape) and search come from the
 * assistant-ui trigger primitives; the command list is ours.
 *
 * The list is the two built-ins plus whatever is in the user's commands/
 * folder — a workflow is mostly the prompts someone types again and again, so
 * theirs sit beside ours. Picking one puts its text in the box rather than
 * sending it, because most are a starting point with a detail to add.
 */
export function SlashCommands(): ReactNode {
  const [mine, setMine] = useState<UserCommand[]>([])
  useEffect(() => {
    void agentCommands().then(setMine).catch(() => undefined)
  }, [])
  // the supported bridge to the composer's text — a command fills the box, it
  // does not send, so the usual "…and check X too" can be added first
  const input = unstable_useComposerInput()
  const slash = unstable_useSlashCommandAdapter({
    // the typed command text is consumed by selecting the item, never sent
    removeOnExecute: true,
    commands: [
      {
        id: "new",
        label: "/new",
        description: "Start a new chat",
        execute: () => useAgent.getState().newChat(),
      },
      {
        id: "compact",
        label: "/compact",
        description: "Summarize this chat and continue from the summary",
        execute: () => {
          const s = useAgent.getState()
          if (!s.sessionId) {
            s.setBanner({ kind: "info", text: "Nothing to compact yet" })
            return
          }
          if (s.running) {
            s.setBanner({ kind: "info", text: "Stop the run, then compact" })
            return
          }
          void s.compact()
        },
      },
      ...mine.map((c) => ({
        id: `user:${c.name}`,
        label: `/${c.name}`,
        description: c.description || "From commands/",
        execute: () => input.setText(c.body),
      })),
    ],
  })
  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      adapter={slash.adapter}
      aria-label="Commands"
      className="aui-trigger-popover bg-popover text-popover-foreground border-border absolute inset-x-2 bottom-full z-50 mb-2 overflow-hidden rounded-xl border p-1 shadow-lg"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) =>
          items.length ? (
            items.map((item, i) => (
              <ComposerPrimitive.Unstable_TriggerPopoverItem
                key={item.id}
                item={item}
                index={i}
                className="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none"
              >
                <span className="text-muted-foreground shrink-0">{commandIcon(item.id)}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{item.label}</span>
                  {item.description ? <span className="text-muted-foreground truncate text-xs">{item.description}</span> : null}
                </span>
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            ))
          ) : (
            <div className="text-muted-foreground px-2.5 py-2 text-xs">No matching commands</div>
          )
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  )
}
