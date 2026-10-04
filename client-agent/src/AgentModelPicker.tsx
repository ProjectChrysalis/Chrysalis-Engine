import { useEffect, useMemo, useRef, useState } from "react"
import { useAui } from "@assistant-ui/react"
import { CaretDown, Check, Star } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { shortModelName } from "@/lib/utils"
import { useAgent } from "./store"
import { modelGroups, modelKey, readModelList, saveModelList, searchModels } from "./model-picker"

const FAVORITES = "agent-model-favorites"
const RECENT = "agent-model-recent"

export function AgentModelPicker() {
  const models = useAgent((s) => s.models)
  const selected = useAgent((s) => s.model)
  const reasoning = useAgent((s) => s.reasoning)
  const setModel = useAgent((s) => s.setModel)
  const setReasoning = useAgent((s) => s.setReasoning)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [connection, setConnection] = useState("")
  const [favorites, setFavorites] = useState(() => readModelList(FAVORITES))
  const [recent, setRecent] = useState(() => readModelList(RECENT).slice(0, 8))
  const input = useRef<HTMLInputElement>(null)
  const model = models.find((m) => modelKey(m) === selected)
  const api = useAui()
  useEffect(() => {
    if (!selected) return
    return api.modelContext.register({ getModelContext: () => ({ config: { modelName: selected, ...(reasoning ? { reasoningEffort: reasoning } : {}) } }) })
  }, [api, selected, reasoning])
  const connections = useMemo(() => [...new Map(models.map((m) => [m.provider, m.connectionName ?? m.provider])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [models])
  const filtered = useMemo(() => searchModels(models, query, connection), [models, query, connection])
  const groups = useMemo(() => modelGroups(filtered, selected, favorites, recent, !!query.trim()), [filtered, selected, favorites, recent, query])
  const choose = (id: string) => {
    const next = [id, ...recent.filter((item) => item !== id)].slice(0, 8)
    setRecent(next)
    saveModelList(RECENT, next)
    setModel(id)
    setOpen(false)
  }
  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((item) => item !== id) : [...favorites, id]
    setFavorites(next)
    saveModelList(FAVORITES, next)
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) { setQuery(""); setConnection("") } }}>
      <DialogTrigger render={<Button variant="ghost" size="sm" className="h-8 min-w-0 max-w-60 shrink gap-1 rounded-full px-2" />} aria-label="Choose model">
        <span className="truncate">{model ? shortModelName(model.label) : "Choose model"}</span>
        <CaretDown className="size-3 shrink-0" />
      </DialogTrigger>
      <DialogContent className="flex h-[min(640px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" initialFocus={input}>
        <div className="shrink-0 px-4 pt-4 pb-3 pr-12">
          <DialogTitle>Choose model</DialogTitle>
          <DialogDescription className="mt-1 text-xs">Search your connections or star a model to keep it handy.</DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <Command shouldFilter={false} className="rounded-none">
            <CommandInput ref={input} value={query} onValueChange={setQuery} placeholder="Search names, IDs, or connections…" aria-label="Search models" className="h-12" />
            <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
              <Select value={connection} onValueChange={(value) => setConnection(value ?? "")} items={[{ value: "", label: "All connections" }, ...connections.map(([value, label]) => ({ value, label }))]}>
                <SelectTrigger className="h-8 w-auto max-w-[75%] text-xs" aria-label="Filter connection"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="">All connections</SelectItem>{connections.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
              </Select>
              <span className="text-muted-foreground shrink-0 text-xs" role="status">{filtered.length} {filtered.length === 1 ? "model" : "models"}</span>
            </div>
            <CommandList className="min-h-0 max-h-none flex-1 px-2 py-1" aria-label="Models">
              {!filtered.length && <div className="text-muted-foreground p-8 text-center text-sm">No models match your search.</div>}
              {groups.map((group) => <CommandGroup key={group.title} heading={group.title}>
                {group.models.map((item) => {
                  const id = modelKey(item)
                  const favorite = favorites.includes(id)
                  return <div key={id} className="flex items-center gap-1">
                    <CommandItem value={id} onSelect={() => choose(id)} className="min-w-0 flex-1 gap-3 py-3">
                      <Check className={`size-4 ${selected === id ? "opacity-100" : "opacity-0"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="break-words font-medium">{item.label}</div>
                        <div className="text-muted-foreground mt-0.5 break-all text-xs">{item.connectionName ?? item.provider} · {item.modelId}</div>
                      </div>
                    </CommandItem>
                    <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label={`${favorite ? "Remove favorite" : "Favorite"}: ${item.label} (${item.connectionName ?? item.provider})`} aria-pressed={favorite} onClick={() => toggleFavorite(id)}><Star className="size-4" weight={favorite ? "fill" : "regular"} /></Button>
                  </div>
                })}
              </CommandGroup>)}
            </CommandList>
          </Command>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-3">
          <div className="min-w-0"><div className="text-muted-foreground text-xs">Current model</div><div className="truncate text-xs font-medium" title={model?.label}>{model?.label ?? "None selected"}</div></div>
          {model?.reasoning && model.reasoningLevels.length > 0 && <Select value={reasoning} onValueChange={(value) => { if (value !== null) setReasoning(value) }} items={model.reasoningLevels.map((value) => ({ value, label: value[0]?.toUpperCase() + value.slice(1) }))}>
            <SelectTrigger className="h-8 w-auto shrink-0 text-xs" aria-label="Reasoning effort"><SelectValue /></SelectTrigger>
            <SelectContent>{model.reasoningLevels.map((level) => <SelectItem key={level} value={level}>{level[0]?.toUpperCase() + level.slice(1)}</SelectItem>)}</SelectContent>
          </Select>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
