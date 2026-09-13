
import { useRef, useState } from 'react'
import { useApp } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Database, FileText, CircleNotch, Trash, UploadSimple } from '@phosphor-icons/react'
import { useConfirm } from '@/components/ui/confirm'
import { toast } from 'sonner'
import { j } from '@/lib/engine'

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const TEXT_EXTENSIONS = ['.txt', '.md', '.json', '.csv', '.log', '.jsonl']

/** Retrieved chunk shown by the search probe below the list. */
interface SearchHit {
  fileId: string
  fileName: string
  chunkIndex: number
  text: string
  score: number
}

export function DataBankTab() {
  const dataBank = useApp((s) => s.dataBank)
  const uploadDataBankFile = useApp((s) => s.uploadDataBankFile)
  const updateDataBankFile = useApp((s) => s.updateDataBankFile)
  const deleteDataBankFile = useApp((s) => s.deleteDataBankFile)
  const fileRef = useRef<HTMLInputElement>(null)
  const [confirm, confirmDialog] = useConfirm()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)

  const upload = async (files: FileList) => {
    for (const f of Array.from(files)) {
      if (!TEXT_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext))) {
        toast.error(`${f.name}: only text formats are indexed (${TEXT_EXTENSIONS.join(', ')})`)
        continue
      }
      if (f.size > 2 * 1024 * 1024) {
        toast.error(`${f.name}: over the 2 MB text limit`)
        continue
      }
      try {
        await uploadDataBankFile(f.name, await f.text())
      } catch (e) {
        toast.error(`${f.name} failed`, { description: (e as Error).message })
      }
    }
  }

  const search = async () => {
    if (!query.trim()) { setHits(null); return }
    setSearching(true)
    try {
      const r = await j<{ results: SearchHit[] }>(`/databank/search?q=${encodeURIComponent(query)}`)
      setHits(r.results)
    } catch (e) {
      toast.error('Search failed', { description: (e as Error).message })
    } finally { setSearching(false) }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-pretty text-muted-foreground">
          <Database className="size-4 shrink-0" aria-hidden="true" />
          Attach documents for retrieval. The engine chunks them and injects the most
          relevant passages into the prompt when you send a message.
        </p>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={TEXT_EXTENSIONS.join(',')}
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void upload(e.target.files)
            e.target.value = ''
          }}
        />
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <UploadSimple className="size-4" aria-hidden="true" /> Upload
        </Button>
      </div>

      <ul className="flex flex-col gap-2">
        {dataBank.map((f) => (
          <li key={f.id} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
            <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{f.name}</p>
              <p className="text-xs text-muted-foreground">{formatSize(f.size)} · {f.chunks} chunk{f.chunks === 1 ? '' : 's'}</p>
            </div>
            <Switch
              checked={f.enabled}
              onCheckedChange={(v) => { updateDataBankFile(f.id, { enabled: v }); toast.success(v ? `${f.name} is now injected` : `${f.name} paused`) }}
              aria-label={`Enable ${f.name}`}
            />
            <Button
              size="icon"
              variant="ghost"
              className="size-8 text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${f.name}`}
              onClick={() => void confirm({
                title: `Delete ${f.name}?`,
                description: 'The document and its chunks are removed from disk.',
              }).then((yes) => {
                if (!yes) return
                deleteDataBankFile(f.id)
                toast.success('File removed')
              })}
            >
              <Trash className="size-4" aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      {dataBank.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No documents yet. Upload text files to make them available to the AI.
        </p>
      )}

      {/* Search probe: proves the retrieval half end-to-end without sending a chat. */}
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Search the bank</p>
            <p className="text-xs text-muted-foreground">The same retrieval that runs when you send a message.</p>
          </div>
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void search() }}
              placeholder="terms to look for…"
              className="h-8 w-44 rounded-md border border-border bg-transparent px-2 text-xs"
              aria-label="Search the data bank"
            />
            <Button variant="outline" size="sm" onClick={() => void search()} disabled={searching}>
              {searching ? <CircleNotch className="size-3.5 animate-spin" /> : null} Search
            </Button>
          </div>
        </div>
        {hits && (
          hits.length === 0 ? (
            <p className="text-xs text-muted-foreground">No matching passages.</p>
          ) : hits.map((h, i) => (
            <div key={i} className="rounded-md bg-muted/50 p-2">
              <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{h.fileName} · chunk {h.chunkIndex} · score {h.score}</p>
              <p className="line-clamp-3 text-xs leading-relaxed">{h.text}</p>
            </div>
          ))
        )}
      </div>
      {confirmDialog}
    </div>
  )
}
