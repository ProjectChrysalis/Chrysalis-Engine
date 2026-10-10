import { tr } from "@/i18n"
import { useState } from "react"
import { Broom, ChartPie } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { useAgent } from "./store"

export function ContextActions() {
  const sessionId = useAgent((s) => s.sessionId)
  const running = useAgent((s) => s.running)
  const compact = useAgent((s) => s.compact)
  const usage = useAgent((s) => s.usage)
  const model = useAgent((s) => s.model)
  const models = useAgent((s) => s.models)
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState(false)
  const contextWindow = models.find((item) => `${item.provider}/${item.modelId}` === model)?.contextWindow
  const tokens = usage ? usage.input + usage.cacheRead : null
  const percent = tokens != null && contextWindow && contextWindow > 0 ? tokens / contextWindow * 100 : null
  const severity = percent != null && percent >= 85 ? "high" : percent != null && percent >= 65 ? "moderate" : "normal"
  const compactConversation = async () => {
    setPending(true)
    try {
      await compact()
      setOpen(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="agent-context-actions">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="ghost" size="sm" className="agent-context-trigger" aria-label={tr("Context usage")} data-usage={severity} />}>
          <ChartPie className="size-4 shrink-0" aria-hidden />
          <span>{tr("Context")}</span>
          {percent != null && <span className="agent-context-percent">{Math.round(percent)}%</span>}
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="agent-context-popover">
          <div className="flex items-center justify-between gap-3">
            <PopoverTitle>{tr("Context usage")}</PopoverTitle>
            {percent != null && <span className="text-sm tabular-nums font-medium">{Math.round(percent)}%</span>}
          </div>
          {usage ? <>
            {percent != null && <div className="agent-context-meter" data-usage={severity} role="meter" aria-label={tr("Context usage")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(percent, 100)}>
              <span style={{ width: `${Math.min(percent, 100)}%` }} />
            </div>}
            <p className="text-muted-foreground text-xs">{tr("Last request")}{tokens != null && contextWindow ? `: ${tokens.toLocaleString()} / ${contextWindow.toLocaleString()}` : ""}</p>
            <dl className="agent-context-details">
              <dt>{tr("Input tokens")}</dt><dd>{usage.input.toLocaleString()}</dd>
              <dt>{tr("Cached input")}</dt><dd>{usage.cacheRead.toLocaleString()}</dd>
              <dt>{tr("Output")}</dt><dd>{usage.output.toLocaleString()}</dd>
            </dl>
          </> : <p className="text-muted-foreground text-xs">{tr("Usage available after a run.")}</p>}
          <div className="agent-context-compact">
            <p className="text-muted-foreground text-xs">{tr("Summarize older messages to free space.")}</p>
            <Button variant="outline" size="sm" disabled={!sessionId || running || pending} onClick={compactConversation}>
              <Broom className="size-4" aria-hidden />{pending ? tr("Compacting…") : tr("Compact conversation")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
