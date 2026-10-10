import { tr } from "@/i18n"
import { AgentModelPicker } from "./AgentModelPicker"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidebarSimple, SlidersHorizontal, WifiSlash } from "@phosphor-icons/react"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import type { ReactNode } from "react"
import { useAgent } from "./store"

function ComposerSettings(): ReactNode {
  const mode = useAgent((s) => s.mode)
  const appId = useAgent((s) => s.appId)
  const apps = useAgent((s) => s.apps)
  const running = useAgent((s) => s.running || s.targetChanging)
  const setApp = useAgent((s) => s.setApp)
  const setMode = useAgent((s) => s.setMode)

  return (
    <div className="agent-composer-settings">
      <div className="agent-setting">
        <span className="agent-setting-label">{tr("Working app")}</span>
        <Select items={[{ label: tr("Choose app"), value: "" }, ...apps.map((app) => ({ label: app.name, value: app.id })), ...(appId && !apps.some((app) => app.id === appId) ? [{ label: `${appId} (${tr("missing")})`, value: appId }] : [])]} value={appId ?? ""} onValueChange={(v) => void setApp(v || null)} disabled={running}>
          <SelectTrigger className="agent-composer-app" aria-label={tr("Working app")}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="">{tr("Choose app")}</SelectItem>{apps.map((app) => <SelectItem key={app.id} value={app.id}>{app.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="agent-setting">
        <span className="agent-setting-label">{tr("Current model")}</span>
        <AgentModelPicker />
      </div>
      <div className="agent-setting">
        <span className="agent-setting-label">{tr("Mode")}</span>
        <Select
          items={[
            { label: tr("Full"), value: "full" },
            { label: tr("Accept"), value: "accept" },
            { label: tr("Plan"), value: "plan" },
          ]}
          value={mode === "normal" ? "full" : mode}
          onValueChange={(v) => {
            const next = v === "full" ? "normal" : v
            if (next === "accept" || next === "plan" || next === "normal") setMode(next)
          }}
        >
          <SelectTrigger className="agent-composer-mode" aria-label={tr("Mode")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="full" className="text-xs">{tr("Full")}</SelectItem>
            <SelectItem value="accept" className="text-xs">{tr("Accept")}</SelectItem>
            <SelectItem value="plan" className="text-xs">{tr("Plan")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

export function ComposerSettingsMenu(): ReactNode {
  return (
    <div className="agent-settings-menu">
      <Popover>
        <PopoverTrigger render={<Button variant="ghost" size="icon" className="agent-settings-trigger" aria-label={tr("Settings")} title={tr("Settings")} />}>
          <SlidersHorizontal className="size-4" aria-hidden />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="agent-settings-popover">
          <PopoverTitle>{tr("Settings")}</PopoverTitle>
          <ComposerSettings />
        </PopoverContent>
      </Popover>
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
      <Button id="agent-sidebar-toggle" variant="ghost" size="icon" className="size-9 shrink-0" aria-label={tr("Toggle sidebar")} onClick={toggleSidebar}>
        <SidebarSimple size={18} />
      </Button>
      <span className="min-w-0 truncate text-sm font-medium">{title?.trim() || tr("New chat")}</span>
      {wsDown ? <span className="text-destructive ml-auto flex shrink-0 items-center gap-1.5 text-xs" role="status"><WifiSlash size={14} />{tr("Reconnecting")}</span> : null}
    </header>
  )
}
