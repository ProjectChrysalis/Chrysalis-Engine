import { ModelSelector, type ModelOption } from "@/components/assistant-ui/elements/model-selector.aui"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidebarSimple, WifiSlash } from "@phosphor-icons/react"
import { useMemo, type ReactNode } from "react"
import { useAgent } from "./store"
import { shortModelName } from "@/lib/utils"

export function ComposerSettings(): ReactNode {
  const models = useAgent((s) => s.models)
  const model = useAgent((s) => s.model)
  const reasoning = useAgent((s) => s.reasoning)
  const mode = useAgent((s) => s.mode)
  const setModel = useAgent((s) => s.setModel)
  const setReasoning = useAgent((s) => s.setReasoning)
  const setMode = useAgent((s) => s.setMode)
  const options = useMemo<readonly ModelOption[]>(() => {
    // With more than one connection, show which connection each model comes
    // from under its name; a single connection needs no disambiguation.
    const multi = new Set(models.map((m) => m.connectionName ?? m.provider)).size > 1
    return models.map((m) => ({
      id: `${m.provider}/${m.modelId}`,
      // Keep the full provider label searchable when the button is truncated.
      name: shortModelName(m.label),
      ...(multi ? { description: m.connectionName ?? m.provider } : {}),
      keywords: [m.provider, m.connectionName ?? "", m.label],
      ...(m.reasoning && m.reasoningLevels.length
        ? { efforts: m.reasoningLevels.map((l) => ({ id: l, name: l[0]?.toUpperCase() + l.slice(1) })) }
        : {}),
    }))
  }, [models])

  return (
    <div className="flex min-w-0 items-center gap-1">
      {options.length ? (
        <ModelSelector
          models={options}
          value={model ?? undefined}
          onValueChange={setModel}
          effort={reasoning || undefined}
          onEffortChange={(e) => setReasoning(e)}
          variant="ghost"
          size="sm"
          className="h-8 min-w-0 max-w-60 shrink gap-1 rounded-full px-2 [&>span]:truncate [&>span]:gap-1.5"
          searchable
          align="start"
        />
      ) : null}
      <Select
        items={[
          { label: "Full", value: "full" },
          { label: "Accept", value: "accept" },
          { label: "Plan", value: "plan" },
        ]}
        value={mode === "normal" ? "full" : mode}
        onValueChange={(v) => {
          const next = v === "full" ? "normal" : v
          if (next === "accept" || next === "plan" || next === "normal") setMode(next)
        }}
      >
        <SelectTrigger className="h-8 shrink-0 gap-1 rounded-full border-0 bg-transparent px-1.5 text-xs" aria-label="Mode">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="full" className="text-xs">
            Full
          </SelectItem>
          <SelectItem value="accept" className="text-xs">
            Accept
          </SelectItem>
          <SelectItem value="plan" className="text-xs">
            Plan
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export function Header(): ReactNode {
  const sessionId = useAgent((s) => s.sessionId)
  const title = useAgent((s) => s.sessions.find((item) => item.sessionId === sessionId)?.title)
  const wsDown = useAgent((s) => s.wsDown)
  const sidebarOpen = useAgent((s) => s.sidebarOpen)
  const sidebarPinned = useAgent((s) => s.sidebarPinned)
  const toggleSidebar = () => {
    const state = useAgent.getState()
    if (window.matchMedia("(min-width: 768px)").matches) state.setSidebarPinned(!sidebarPinned)
    else state.setSidebar(!sidebarOpen)
  }
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-3 md:px-4">
      <Button id="agent-sidebar-toggle" variant="ghost" size="icon" className="size-9 shrink-0" aria-label="Toggle sidebar" onClick={toggleSidebar}>
        <SidebarSimple size={18} />
      </Button>
      <span className="min-w-0 truncate text-sm font-medium">{title?.trim() || "New chat"}</span>
      {wsDown ? <span className="text-destructive ml-auto flex shrink-0 items-center gap-1.5 text-xs" role="status"><WifiSlash size={14} />Reconnecting</span> : null}
    </header>
  )
}
