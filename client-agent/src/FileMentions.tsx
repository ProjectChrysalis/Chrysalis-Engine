import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { File as FileIcon } from "@phosphor-icons/react"
import { ComposerPrimitive } from "@assistant-ui/react"
import type { Unstable_TriggerAdapter } from "@assistant-ui/core"
import type { ReactNode } from "react"
import { agentFiles } from "./api"
import { filePathDirective, fileTriggerAdapter } from "./file-mentions"

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

/** The folder part, dimmed beside the name. "" for a file at the root. */
function dirOf(rel: string): string {
  const at = rel.lastIndexOf("/")
  return at < 0 ? "" : rel.slice(0, at)
}

/**
 * Keep the highlighted row inside the scroll box.
 *
 * Without this, holding the down arrow walks the highlight past the bottom of
 * the popover and out of sight: the list stays put while the selection keeps
 * going, and the page scrolls instead. The highlight is an attribute the
 * library toggles rather than anything React re-renders here, so a ref
 * callback never sees it — an observer does.
 */
function useScrollHighlightIntoView(): (el: HTMLDivElement | null) => void {
  const observer = useRef<MutationObserver | undefined>(undefined)
  return useCallback((box: HTMLDivElement | null) => {
    observer.current?.disconnect()
    if (!box) return
    const show = () => box.querySelector<HTMLElement>("[data-highlighted]")?.scrollIntoView({ block: "nearest" })
    observer.current = new MutationObserver(show)
    observer.current.observe(box, { subtree: true, attributes: true, attributeFilter: ["data-highlighted"], childList: true })
    show()
  }, [])
}

export function FileMentions(): ReactNode {
  const popoverRef = useScrollHighlightIntoView()
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

  const adapter = useMemo<Unstable_TriggerAdapter>(() => fileTriggerAdapter(files, fetchFor), [files, fetchFor])

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={adapter}
      isLoading={loading}
      ref={popoverRef}
      aria-label="Files"
      className="aui-trigger-popover bg-popover text-popover-foreground border-border absolute inset-x-2 bottom-full z-50 mb-2 max-h-72 min-h-11 overflow-y-auto overscroll-contain rounded-xl border p-1 shadow-lg"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={filePathDirective} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) =>
          items.length ? (
            items.map((item, i) => (
              <ComposerPrimitive.Unstable_TriggerPopoverItem
                key={item.id}
                item={item}
                index={i}
                className="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex w-full cursor-pointer items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none"
              >
                <FileIcon size={14} className="text-muted-foreground shrink-0 self-center" />
                {/* the name is what you are looking for; the folder is only
                    there to tell two files of the same name apart */}
                <span className="truncate font-medium">{item.label}</span>
                <span className="text-muted-foreground/70 min-w-0 flex-1 truncate text-right text-xs">
                  {dirOf(item.description ?? item.id)}
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
