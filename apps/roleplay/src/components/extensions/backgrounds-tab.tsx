
import { useRef, useState } from 'react'
import { useApp } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Check, ImageSquare, Trash } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { DEFAULT_AVATAR, cn } from '@/lib/utils'
import { fileToRawDataUrl } from '@/lib/engine'
import { useConfirm } from '@/components/ui/confirm'

export function BackgroundsTab() {
  const backgrounds = useApp((s) => s.backgrounds)
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const updateBackground = useApp((s) => s.updateBackground)
  const addBackground = useApp((s) => s.addBackground)
  const deleteBackground = useApp((s) => s.deleteBackground)
  const [newName, setNewName] = useState('')
  const [dragging, setDragging] = useState(false)
  const [confirm, confirmDialog] = useConfirm()
  const fileRef = useRef<HTMLInputElement>(null)

  const addFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'))
    if (list.length === 0) return
    for (let i = 0; i < list.length; i++) {
      const base = newName.trim() && list.length === 1 ? newName.trim() : list[i]!.name.replace(/\.[^.]+$/, '')
      // data URL, not an object URL — backgrounds persist to the library and
      // must survive reloads (object URLs die with the page)
      addBackground(base || `Background ${i + 1}`, await fileToRawDataUrl(list[i]!))
    }
    setNewName('')
    toast.success(`Added ${list.length} background${list.length === 1 ? '' : 's'}`)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-pretty text-muted-foreground">
          Manage chat backgrounds. The active background applies to all chats unless a chat overrides it.
        </p>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
        className={cn(
          'flex flex-col gap-2 rounded-lg border border-dashed p-3 transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-border',
        )}
      >
        <p className="text-xs text-muted-foreground">
          Drop image files here to add your own backgrounds, or name one and browse for it.
        </p>
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Optional name…"
            aria-label="New background name"
            className="h-8 text-sm"
          />
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
            <ImageSquare className="size-4" aria-hidden="true" /> Upload
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = '' }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {backgrounds.map((bg) => {
          const active = settings.activeBackgroundId === bg.id
          return (
            <figure key={bg.id} className={cn('overflow-hidden rounded-lg border', active ? 'border-primary' : 'border-border')}>
              <button
                type="button"
                className="relative block aspect-video w-full"
                onClick={() => updateSettings({ activeBackgroundId: active ? null : bg.id })}
                aria-pressed={active}
                aria-label={active ? `Deactivate ${bg.name}` : `Set ${bg.name} as active background`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={bg.url || DEFAULT_AVATAR} alt="" className="size-full object-cover" />
                {active && (
                  <span className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="size-3.5" aria-hidden="true" />
                  </span>
                )}
              </button>
              <figcaption className="flex items-center gap-1.5 p-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{bg.name}</span>
                <Badge variant="outline" className="hidden text-[10px] lg:inline-flex">{bg.type}</Badge>
                <Select value={bg.fitting} onValueChange={(v) => v && updateBackground(bg.id, { fitting: v as never })}>
                  <SelectTrigger className="h-6 w-20 px-1.5 text-[11px]" aria-label={`Fitting for ${bg.name}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="cover">Cover</SelectItem>
                      <SelectItem value="contain">Contain</SelectItem>
                      <SelectItem value="stretch">Stretch</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete ${bg.name}`}
                  onClick={() => void confirm({
                    title: `Delete ${bg.name}?`,
                    description: 'The image is removed; chats using it fall back to plain color.',
                  }).then((yes) => {
                    if (!yes) return
                    deleteBackground(bg.id); toast.success('Background deleted')
                  })}
                >
                  <Trash className="size-3.5" aria-hidden="true" />
                </Button>
              </figcaption>
            </figure>
          )
        })}
      </div>
    {confirmDialog}
    </div>
  )
}
