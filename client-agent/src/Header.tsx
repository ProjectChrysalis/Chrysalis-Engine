import { tr } from "@/i18n"
import { AgentModelPicker } from "./AgentModelPicker"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Paperclip, PanelLeft, SlidersHorizontal, WifiOff, X } from "lucide-react"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { useEffect, useState, type ReactNode } from "react"
import { api } from "./api"
import type { AgentPromptsFile } from "../../src/agent/prompt-preset-types"
import { useAgent } from "./store"

/** Shows and switches the active prompt preset; Edit opens the presets in Settings. */
function PromptPresetPicker(): ReactNode {
  const [file, setFile] = useState<AgentPromptsFile | null>(null)
  const running = useAgent((s) => s.running)
  const version = useAgent((s) => s.promptsVersion)
  useEffect(() => { void api<AgentPromptsFile>("GET", "/v1/settings/agent-prompts").then(setFile).catch(() => setFile(null)) }, [version])
  if (!file?.presets.length) return null
  const choose = async (value: string) => {
    const latest = await api<AgentPromptsFile>("GET", "/v1/settings/agent-prompts")
    setFile(await api<AgentPromptsFile>("PUT", "/v1/settings/agent-prompts", { active: value, presets: latest.presets }))
  }
  const items = file.presets.map((p) => ({ label: p.name, value: p.id }))
  return (
    <div className="agent-setting">
      <span className="agent-setting-label">{tr("Prompt preset")}</span>
      <div className="flex items-center gap-1">
        <Select items={items} value={file.active} onValueChange={(v) => { if (v) void choose(String(v)).catch(() => undefined) }} disabled={running}>
          <SelectTrigger className="agent-composer-mode" aria-label={tr("Prompt preset")}><SelectValue /></SelectTrigger>
          <SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={() => window.parent.postMessage({ __chrysalisAgent: "settings", tab: "agent-prompts" }, location.origin)}>{tr("Edit")}</Button>
      </div>
    </div>
  )
}

function ComposerSettings(): ReactNode {
  const mode = useAgent((s) => s.mode)
  const appId = useAgent((s) => s.appId)
  const apps = useAgent((s) => s.apps)
  const running = useAgent((s) => s.running || s.targetChanging)
  const setApp = useAgent((s) => s.setApp)
  const setMode = useAgent((s) => s.setMode)
  const selection = useAgent((s) => s.selection)
  const available = useAgent((s) => s.availableSelection)
  const queueMode = useAgent(s => s.queueMode)
  const label = (value: unknown): string => typeof (value as { label?: unknown } | null)?.label === "string" ? (value as { label: string }).label : "";
  const item = available?.appId === appId ? label(available.selection) : "";
  const attached = selection ? label(selection.selection) : "";
  useEffect(() => {
    useAgent.setState({ availableSelection: null });
    if (!appId || window.parent === window) return;
    const refresh = () => window.parent.postMessage({ __chrysalisAgent: "selection_preview", appId }, location.origin);
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, [appId]);

  return (
    <div className="agent-composer-settings">
      <div className="agent-setting">
        <span className="agent-setting-label">{tr("Working app")}</span>
        <Select items={[{ label: tr("Choose app"), value: "" }, ...apps.map((app) => ({ label: app.name, value: app.id })), ...(appId && !apps.some((app) => app.id === appId) ? [{ label: `${appId} (${tr("missing")})`, value: appId }] : [])]} value={appId ?? ""} onValueChange={(v) => void setApp(v || null)} disabled={running}>
          <SelectTrigger className="agent-composer-app" aria-label={tr("Working app")}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="">{tr("Choose app")}</SelectItem>{apps.map((app) => <SelectItem key={app.id} value={app.id}>{app.name}</SelectItem>)}</SelectContent>
        </Select>
        {attached ? (
          <div className="agent-attachment">
            <Paperclip size={14} aria-hidden />
            <span className="truncate" title={attached}>{tr("Attached: {item}", { item: attached })}</span>
            <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={tr("Remove attachment")} title={tr("Remove attachment")} onClick={() => useAgent.setState({ selection: null })}><X size={14} aria-hidden /></Button>
          </div>
        ) : null}
        {item && item !== attached ? (
          <Button variant="ghost" size="sm" className="agent-attach" disabled={running} title={item} onClick={() => { if (available) useAgent.setState({ selection: available }); }}>
            <Paperclip size={14} aria-hidden />
            <span className="truncate">{tr("Attach {item}", { item })}</span>
          </Button>
        ) : null}
      </div>
      <div className="agent-setting">
        <span className="agent-setting-label">{tr("Current model")}</span>
        <AgentModelPicker />
      </div>
      <PromptPresetPicker />
      <div className="agent-setting">
        <span className="agent-setting-label">{tr("Queued messages")}</span>
        <Select items={[{ label: tr("Change course now"), value: "steer" }, { label: tr("After this task"), value: "followUp" }]} value={queueMode} onValueChange={value => useAgent.setState({ queueMode: value === "followUp" ? "followUp" : "steer" })}>
          <SelectTrigger className="agent-composer-mode"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="steer">{tr("Change course now")}</SelectItem><SelectItem value="followUp">{tr("After this task")}</SelectItem></SelectContent>
        </Select>
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
  const workingApp = useAgent(s => s.apps.find(app => app.id === s.appId)?.name ?? s.appId)
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
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border/60 ps-[max(0.5rem,env(safe-area-inset-left))] pe-[max(0.75rem,env(safe-area-inset-right))] sm:ps-3 sm:pe-5">
      <Button id="agent-sidebar-toggle" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground shrink-0" aria-label={tr("Toggle sidebar")} onClick={toggleSidebar}>
        <PanelLeft />
      </Button>
      <h1 className="min-w-0 truncate text-sm font-medium">{title?.trim() || tr("New chat")}</h1>
      {workingApp ? <span className="border-border text-muted-foreground hidden max-w-[40%] shrink-0 truncate rounded-full border px-2 py-0.5 text-2xs sm:inline" title={`${tr("Working app")}: ${workingApp}`}>{workingApp}</span> : null}
      {wsDown ? <span className="text-destructive ml-auto flex shrink-0 items-center gap-1.5 text-xs" role="status"><WifiOff className="size-3.5" />{tr("Reconnecting")}</span> : null}
    </header>
  )
}
