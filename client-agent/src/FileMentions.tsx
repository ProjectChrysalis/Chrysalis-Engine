import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { File as FileIcon } from "@phosphor-icons/react"
import {
  ComposerPrimitive,
  unstable_defaultDirectiveFormatter,
  type Unstable_TriggerItem,
} from "@assistant-ui/react"
import type { Unstable_TriggerAdapter } from "@assistant-ui/core"
import type { ReactNode } from "react"
import { agentFiles } from "./api"

/**
 * "@" in the composer picks a file out of the workspace, so a request can name
 * one instead of describing it and hoping. The engine does the searching
 * (/v1/agent/files), which keeps a workspace of any size to one bounded walk.
 *
 * The trigger adapter is synchronous and the search is not, so `search` answers
 * from what was last fetched and starts the fetch for what was just typed;
 * results land a moment later and the popover re-renders. `isLoading` tells the
 * popover to say so in the meantime.
 */
export function FileMentions(): ReactNode {
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const lastQuery = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const fetchFor = useCallback((q: string) => {
    if (lastQuery.current === q) return
    lastQuery.current = q
    clearTimeout(timer.current)
    setLoading(true)
    timer.current = setTimeout(() => {
      void agentFiles(q)
        .then((names) => {
          // a slower earlier query must not overwrite a later one
          if (lastQuery.current === q) setFiles(names)
        })
        .catch(() => undefined)
        .finally(() => {
          if (lastQuery.current === q) setLoading(false)
        })
    }, 120)
  }, [])

  // the unfiltered head of the list, ready before the first keystroke
  useEffect(() => {
    fetchFor("")
    return () => clearTimeout(timer.current)
  }, [fetchFor])

  const adapter = useMemo<Unstable_TriggerAdapter>(() => {
    const items = (): Unstable_TriggerItem[] =>
      files.map((path) => ({
        id: path,
        type: "file",
        label: path.split("/").pop() ?? path,
        description: path,
      }))
    return {
      categories: () => [{ id: "files", label: "Files" }],
      categoryItems: () => items(),
      search: (query: string) => {
        fetchFor(query.toLowerCase())
        const q = query.toLowerCase()
        return items().filter((i) => i.id.toLowerCase().includes(q))
      },
    }
  }, [files, fetchFor])

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={adapter}
      isLoading={loading}
      aria-label="Files"
      className="aui-trigger-popover bg-popover text-popover-foreground border-border absolute inset-x-2 bottom-full z-50 mb-2 max-h-72 overflow-y-auto rounded-xl border p-1 shadow-lg"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={unstable_defaultDirectiveFormatter} />
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
                <FileIcon size={15} className="text-muted-foreground shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{item.label}</span>
                  <span className="text-muted-foreground truncate text-xs">{item.description}</span>
                </span>
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            ))
          ) : (
            <div className="text-muted-foreground px-2.5 py-2 text-xs">
              {loading ? "Searching…" : "No matching files"}
            </div>
          )
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  )
}
