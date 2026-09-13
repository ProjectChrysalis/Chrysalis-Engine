
import { Plus, Trash } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useApp } from '@/lib/store'
import { shortModel } from '@/lib/utils'
import type { ConnectionProfile } from '@/lib/types'

/**
 * Edit quick-switch chips: app-side saved (connection, model) pairs —
 * Connection profiles. Shared by the Connections page and the
 * in-chat quick switcher.
 */
export function ProfilesSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const models = useApp((s) => s.models)
  const profiles = useApp((s) => s.connectionProfiles)
  const addProfile = useApp((s) => s.addConnectionProfile)
  const updateProfile = useApp((s) => s.updateConnectionProfile)
  const deleteProfile = useApp((s) => s.deleteConnectionProfile)
  const connections = [...new Set(models.map((m) => m.provider))]

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="overflow-y-auto p-0">
        {/* pr-12 keeps New clear of the sheet's absolutely-positioned close X */}
        <SheetHeader className="flex-row items-center border-b border-border px-4 py-3 pr-12">
          <SheetTitle>Connection profiles</SheetTitle>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 text-xs"
            disabled={connections.length === 0}
            onClick={() => {
              const first = models[0]
              addProfile({ name: 'New profile', provider: first?.provider ?? '', modelId: first?.ref ?? '' })
            }}
          >
            <Plus className="size-3.5" aria-hidden="true" />New
          </Button>
        </SheetHeader>
        <div className="flex flex-col gap-4 p-4">
          {profiles.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No profiles yet. A profile pins a provider + model under a name, so switching
              is one tap from the chat header or the Connections page.
            </p>
          )}
          {profiles.map((p: ConnectionProfile) => {
            // profiles store the QUALIFIED ref; legacy bare names keep working
            const current = models.find((m) => m.ref === p.modelId || m.id === p.modelId)
            return (
              <div key={p.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    value={p.name}
                    onChange={(e) => updateProfile(p.id, { name: e.target.value.slice(0, 60) })}
                    className="h-8 flex-1 text-sm"
                    aria-label={`Profile name ${p.name}`}
                  />
                  <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" aria-label={`Delete profile ${p.name}`} onClick={() => deleteProfile(p.id)}>
                    <Trash className="size-4" aria-hidden="true" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    value={current?.provider ?? p.provider}
                    onValueChange={(v) => {
                      if (!v) return
                      const first = models.find((m) => m.provider === v)
                      updateProfile(p.id, { provider: v, modelId: first?.ref ?? '' })
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs" aria-label={`Provider for ${p.name}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {connections.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={current?.ref ?? ''} onValueChange={(v) => v && updateProfile(p.id, { modelId: v })}>
                    <SelectTrigger className="h-8 text-xs" aria-label={`Model for ${p.name}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {models.filter((m) => m.provider === (current?.provider ?? p.provider)).map((m) => (
                        <SelectItem key={m.ref} value={m.ref}><span className="font-mono text-xs">{shortModel(m.id)}</span></SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )
          })}
        </div>
      </SheetContent>
    </Sheet>
  )
}
