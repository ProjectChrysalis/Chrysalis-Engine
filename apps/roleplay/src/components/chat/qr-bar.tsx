
import { GearSix, X } from '@phosphor-icons/react'
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { useApp } from "@/lib/store"
import type { QuickReply } from "@/lib/types"

/** Quick-replies bar shown above the composer input. Renders enabled sets as colored chips. */
export function QuickReplyBar({
  onRun,
  onClose,
}: {
  onRun: (reply: QuickReply) => void
  onClose?: () => void
}) {
  const qrSets = useApp((s) => s.qrSets)
  const updateQRSet = useApp((s) => s.updateQRSet)
  const setView = useApp((s) => s.setView)

  const enabledSets = qrSets.filter((s) => s.enabled && s.replies.length > 0)
  if (qrSets.length === 0) return null

  return (
    <div className="flex w-full items-center gap-1 overflow-x-auto">
      <div className="flex flex-1 flex-wrap items-center gap-1">
        {enabledSets.flatMap((set) =>
          set.replies.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onRun(r)}
              title={`${r.mode === "send" ? "Send" : "Insert"}: ${r.message}`}
              className="flex h-6 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[11px] font-medium leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: r.color }} aria-hidden="true" />
              {r.label}
            </button>
          )),
        )}
        {enabledSets.length === 0 && (
          <span className="text-[11px] text-muted-foreground">No shortcut sets shown, enable one via the gear</span>
        )}
      </div>
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label="Manage shortcuts">
              <GearSix className="size-3.5" />
            </Button>
          }
        />
        <PopoverContent align="end" side="top" className="w-64 p-2">
          <p className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Shortcut Sets</p>
          <ScrollArea className="max-h-56">
            <div className="flex flex-col gap-1">
              {qrSets.map((set) => (
                <label key={set.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent/50">
                  <span className="min-w-0 flex-1 truncate">{set.name}</span>
                  <Badge variant="outline" className="text-[9px]">{set.replies.length}</Badge>
                  <Switch
                    checked={set.enabled}
                    onCheckedChange={(v) => updateQRSet(set.id, { enabled: v })}
                    aria-label={`Show ${set.name} in composer`}
                  />
                </label>
              ))}
            </div>
          </ScrollArea>
          <Button variant="outline" size="sm" className="mt-2 w-full text-xs" onClick={() => setView("quickreplies")}>
            Edit shortcuts
          </Button>
        </PopoverContent>
      </Popover>
      {onClose && (
        <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={onClose} aria-label="Hide shortcuts">
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
