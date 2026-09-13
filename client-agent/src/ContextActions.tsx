import { useState } from "react"
import { ArrowsIn } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { useAgent } from "./store"

export function ContextActions() {
  const sessionId = useAgent((s) => s.sessionId)
  const running = useAgent((s) => s.running)
  const compact = useAgent((s) => s.compact)
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" size="icon" className="text-muted-foreground size-8 rounded-full" aria-label="Context actions" />}>
        <ArrowsIn className="size-4" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end">
        <PopoverTitle>Context</PopoverTitle>
        <p className="text-muted-foreground text-xs">Summarize older messages to free space.</p>
        <Button variant="outline" size="sm" disabled={!sessionId || running || pending} onClick={async () => {
          setPending(true)
          try {
            await compact()
            setOpen(false)
          } finally {
            setPending(false)
          }
        }}>{pending ? "Compacting…" : "Compact conversation"}</Button>
      </PopoverContent>
    </Popover>
  )
}
