import { useState } from 'react'
import { toast } from 'sonner'
import { useApp } from '@/lib/store'
import type { ID } from '@/lib/types'
import { cn, shortModel } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'
import { ProfilesSheet } from '@/components/connections/profiles-sheet'
import { BookmarkSimple, Check, PencilSimple, GearSix } from '@phosphor-icons/react'

/**
 * Chat-header quick switcher: ONE compact control (icon on mobile,
 * "Preset: <name>" on desktop) opening a searchable palette — Preset /
 * Persona / Profile groups, so a library of hundreds stays one query away.
 * Edits jump into the full editor; the chat stays open behind.
 *
 * Profiles are connection profiles: a saved (provider, model)
 * pair. Picking one swaps the model for the NEXT generation — switching
 * mid-RP never touches chat content.
 */
/** cmdk renders every item it's given — with years of presets/personas that's
 *  thousands of DOM nodes. Cap each group and tell the user to type. */
const GROUP_CAP = 60
function GroupCapHint({ hidden }: { hidden: number }) {
  return (
    <div className="px-2 py-1.5 text-[11px] text-muted-foreground" aria-live="polite">
      +{hidden} more, keep typing to narrow
    </div>
  )
}

export function ChatQuickSwitch({ chatId }: { chatId: ID }) {
  const chat = useApp((s) => s.chats.find((c) => c.id === chatId))
  const presets = useApp((s) => s.presets)
  const personas = useApp((s) => s.personas)
  const profiles = useApp((s) => s.connectionProfiles)
  const models = useApp((s) => s.models)
  const model = useApp((s) => s.model)
  const setModel = useApp((s) => s.setModel)
  const addProfile = useApp((s) => s.addConnectionProfile)
  const updateChat = useApp((s) => s.updateChat)
  const focusPreset = useApp((s) => s.focusPreset)
  const focusPersona = useApp((s) => s.focusPersona)
  const [open, setOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  if (!chat) return null

  const preset = presets.find((p) => p.id === chat.presetId) ?? presets.find((p) => p.isDefault)
  const persona = personas.find((p) => p.id === chat.personaId) ?? personas.find((p) => p.isDefault)
  // resolve through the catalog so qualified refs AND legacy bare names agree
  const current = model ? (models.find((m) => m.ref === model) ?? models.find((m) => m.id === model) ?? null) : null
  const activeProfile = current
    ? profiles.find((p) => {
        const t = models.find((m) => m.ref === p.modelId || m.id === p.modelId)
        return t != null && t.ref === current.ref
      })
    : undefined

  // create flow: snapshot the live connection under an auto-name
  const saveCurrentAsProfile = () => {
    if (!current) return
    const base = `${current.provider} ${shortModel(current.id)}`
    let name = base
    let n = 2
    while (profiles.some((p) => p.name === name)) name = `${base} ${n++}`
    addProfile({ name, provider: current.provider, modelId: current.ref })
    toast.success(`Profile saved: ${name}`, { description: 'Rename it in Manage profiles.' })
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            'flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border bg-card/60 px-2 text-[11px] text-muted-foreground',
            'hover:bg-accent hover:text-foreground',
          )}
          aria-label={`Switch: preset ${preset?.name ?? 'none'}, persona ${persona?.name ?? 'none'}, profile ${activeProfile?.name ?? (current ? shortModel(current.id) : model) ?? 'none'}`}
        >
          {/* mobile: just the icon; desktop: the live preset rides along */}
          <svg viewBox="0 0 20 20" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M3.5 6h13M3.5 14h13" strokeLinecap="square" />
            <circle cx="8" cy="6" r="1.8" fill="currentColor" stroke="none" />
            <circle cx="12" cy="14" r="1.8" fill="currentColor" stroke="none" />
          </svg>
          <span className="hidden min-w-0 items-center gap-1 md:flex">
            <span className="shrink-0 font-medium">Preset:</span>
            <span className="max-w-36 truncate">{preset?.name ?? '—'}</span>
          </span>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0">
          <Command>
            <CommandInput placeholder="Search presets, personas, profiles…" />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>

              <CommandGroup heading={`Preset: ${preset?.name ?? 'none'}`}>
                {presets.slice(0, GROUP_CAP).map((p) => (
                  <CommandItem key={p.id} value={`preset ${p.name}`} onSelect={() => updateChat(chatId, { presetId: p.id })}>
                    <Check className={cn('size-3.5 shrink-0', p.id === preset?.id ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </CommandItem>
                ))}
                {presets.length > GROUP_CAP && <GroupCapHint hidden={presets.length - GROUP_CAP} />}
                <CommandItem value="edit preset" onSelect={() => { if (preset) focusPreset(preset.id) }}>
                  <PencilSimple className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="flex-1">Edit preset…</span>
                </CommandItem>
              </CommandGroup>

              <CommandGroup heading={`Persona: ${persona?.name ?? 'none'}`}>
                {personas.slice(0, GROUP_CAP).map((p) => (
                  <CommandItem key={p.id} value={`persona ${p.name}`} onSelect={() => updateChat(chatId, { personaId: p.id })}>
                    <Check className={cn('size-3.5 shrink-0', p.id === persona?.id ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </CommandItem>
                ))}
                {personas.length > GROUP_CAP && <GroupCapHint hidden={personas.length - GROUP_CAP} />}
                <CommandItem value="edit personas" onSelect={() => { if (persona) focusPersona(persona.id) }}>
                  <PencilSimple className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="flex-1">Edit personas…</span>
                </CommandItem>
              </CommandGroup>

              <CommandGroup heading={`Profile: ${activeProfile?.name ?? (current ? shortModel(current.id) : model) ?? 'engine picks'}`}>
                {profiles.length === 0 && !current && (
                  <div className="px-2 py-1.5 text-[11px] text-muted-foreground">No model selected</div>
                )}
                {profiles.slice(0, GROUP_CAP).map((p) => {
                  const target = models.find((m) => m.ref === p.modelId || m.id === p.modelId)
                  return (
                    <CommandItem
                      key={p.id}
                      value={`profile ${p.name} ${p.modelId}`}
                      onSelect={() => {
                        if (!target) return
                        void setModel(target.ref)
                        toast.success(`Model: ${shortModel(target.id)}`, { description: target.provider })
                      }}
                    >
                      <Check className={cn('size-3.5 shrink-0', p.id === activeProfile?.id ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {target && (
                        <span className="ml-auto max-w-28 truncate text-[10px] text-muted-foreground">
                          {target.provider} · {shortModel(target.id)}
                        </span>
                      )}
                    </CommandItem>
                  )
                })}
                {profiles.length > GROUP_CAP && <GroupCapHint hidden={profiles.length - GROUP_CAP} />}
                <CommandItem
                  value="save current profile"
                  disabled={!current}
                  onSelect={() => saveCurrentAsProfile()}
                >
                  <BookmarkSimple className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="flex-1">Save current as profile…</span>
                </CommandItem>
                <CommandItem
                  value="manage profiles"
                  onSelect={() => { setOpen(false); setManageOpen(true) }}
                >
                  <GearSix className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="flex-1">Manage profiles…</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <ProfilesSheet open={manageOpen} onOpenChange={setManageOpen} />
    </>
  )
}
