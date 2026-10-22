import { Combobox as Base } from "@base-ui/react/combobox"
import { useMemo, useRef, useState } from "react"
import { agentModelScopes, searchAgentModelScopes, type AgentCatalogModel, type AgentModelScope } from "./agent-model-scopes"
import { tr } from "./i18n/index"
import { Button } from "./ui/button"
import { Icon } from "./ui/icon"

const VISIBLE_LIMIT = 60

export function AgentModelScopePicker(props: { models: AgentCatalogModel[]; saved: string[]; value: string; disabled: boolean; onChange: (ref: string) => void }) {
  const [query, setQuery] = useState("")
  const [visibleCount, setVisibleCount] = useState(VISIBLE_LIMIT)
  const input = useRef<HTMLInputElement>(null)
  const scopes = useMemo(() => agentModelScopes(props.models, props.saved, props.value, tr("Agent defaults")), [props.models, props.saved, props.value])
  const matches = useMemo(() => searchAgentModelScopes(scopes, query), [scopes, query])
  const selected = scopes.find((scope) => scope.ref === props.value) ?? null
  return <Base.Root<AgentModelScope> items={scopes} filteredItems={matches.slice(0, visibleCount)} value={selected} inputValue={query} onInputValueChange={(value) => { setQuery(value); setVisibleCount(VISIBLE_LIMIT) }} onOpenChange={(open) => { if (open) { setQuery(""); setVisibleCount(VISIBLE_LIMIT) } }} onValueChange={(value) => { if (value) props.onChange(value.ref) }} itemToStringLabel={(item) => item.label} isItemEqualToValue={(item, value) => item.ref === value.ref} disabled={props.disabled} autoHighlight limit={visibleCount}>
    <Base.Trigger data-component="select" aria-label={tr("Settings for")}>
      <span data-slot="select-value"><Base.Value>{(value: AgentModelScope | null) => value ? `${value.label}${value.detail ? ` · ${value.detail}` : ""}` : ""}</Base.Value></span>
      <Icon name="chevron-down" size={16} />
    </Base.Trigger>
    <Base.Portal>
      <Base.Positioner data-slot="select-positioner" sideOffset={4} align="start">
        <Base.Popup data-slot="select-content" className="agent-model-scope-popup" initialFocus={input}>
          <div className="agent-model-scope-search">
            <Base.Input ref={input} placeholder={tr("Search models")} aria-label={tr("Search models")} />
          </div>
          <Base.Empty className="agent-model-scope-empty">{tr("No models match your search.")}</Base.Empty>
          <Base.List data-slot="select-listbox">
            {(scope: AgentModelScope) => <Base.Item key={scope.ref} value={scope} data-slot="select-item">
              <span className="agent-model-scope-name"><span>{scope.label}</span>{scope.detail ? <small>{scope.detail}</small> : null}</span>
              <Base.ItemIndicator data-slot="select-item-indicator"><Icon name="circle-check" size={14} /></Base.ItemIndicator>
            </Base.Item>}
          </Base.List>
          <div className="agent-model-scope-count"><span role="status">{tr("Results")}: {Math.min(visibleCount, matches.length)} / {matches.length}</span>{matches.length > visibleCount ? <Button variant="ghost" size="small" onClick={() => setVisibleCount((count) => count + VISIBLE_LIMIT)}>{tr("More")}</Button> : null}</div>
        </Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  </Base.Root>
}
