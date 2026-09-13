
import { useState } from 'react'
import { Check } from '@phosphor-icons/react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Field, FieldLabel } from '@/components/ui/field'
import { useApp } from '@/lib/store'
import { DEFAULT_AVATAR, cn } from '@/lib/utils'
import { toast } from 'sonner'

export function CreateGroupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const characters = useApp((s) => s.characters)
  const createGroup = useApp((s) => s.createGroup)
  const openChat = useApp((s) => s.openChat)

  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>([])

  const solo = characters.filter((c) => !c.isGroup)

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  const create = () => {
    if (selected.length < 2) {
      toast.error('Pick at least 2 members')
      return
    }
    const title = name.trim() || `Group: ${solo.filter((c) => selected.includes(c.id)).map((c) => c.name).slice(0, 3).join(', ')}`
    onOpenChange(false)
    setName('')
    setSelected([])
    void (async () => {
      try {
        const chatId = await createGroup(title, selected)
        openChat(chatId)
        toast.success('Group created')
      } catch (e) {
        toast.error(String((e as Error).message ?? e))
      }
    })()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create group chat</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="group-name">Group name</FieldLabel>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Leave blank to auto-name"
            />
          </Field>
          <div>
            <p className="mb-2 text-sm font-medium">
              Members <span className="text-muted-foreground">({selected.length} selected)</span>
            </p>
            <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1">
              {solo.map((c) => {
                const isSel = selected.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggle(c.id)}
                    aria-pressed={isSel}
                    className={cn(
                      'flex items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors',
                      isSel ? 'border-primary bg-accent' : 'border-border hover:bg-accent/50',
                    )}
                  >
                    <Avatar className="size-8 rounded-md">
                      <AvatarImage src={c.avatar || DEFAULT_AVATAR} alt="" />
                      <AvatarFallback>{c.name.slice(0, 2)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    {isSel && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} disabled={selected.length < 2}>Create group</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
