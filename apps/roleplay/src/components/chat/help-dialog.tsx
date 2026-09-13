
import { useMemo, useState } from 'react'
import { BracketsCurly, TerminalWindow } from '@phosphor-icons/react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useApp } from '@/lib/store'
import { fuzzy, getSlashCommands, MACROS } from './composer-autocomplete'

/**
 * The /help reference — every slash command (built-ins + quick-reply
 * shortcuts) and every macro the engine expands. Pure UI: nothing here is
 * ever sent to the model or stored in the chat.
 */
export function HelpDialog() {
  const open = useApp((s) => s.helpOpen)
  const setOpen = useApp((s) => s.setHelpOpen)
  const qrSets = useApp((s) => s.qrSets)
  const imageGenEnabled = useApp((s) => s.settings.imageGen?.enabled === true)
  const [q, setQ] = useState('')

  const commands = useMemo(() => getSlashCommands(qrSets, imageGenEnabled), [qrSets, imageGenEnabled])

  const match = (label: string) => !q.trim() || fuzzy(q.trim(), label) !== null
  const cmds = commands.filter((c) => match(c.label))
  const macros = MACROS.filter((m) => match(m.name))

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[80dvh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reference</DialogTitle>
        </DialogHeader>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search commands and macros…"
          aria-label="Search reference"
          className="h-8 text-sm"
        />
        <Tabs defaultValue="commands" className="flex min-h-0 flex-col">
          <TabsList className="h-8 w-max">
            <TabsTrigger value="commands" className="px-3 text-xs">Commands</TabsTrigger>
            <TabsTrigger value="macros" className="px-3 text-xs">Macros</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TabsContent value="commands" className="mt-2">
              <ul className="flex flex-col gap-0.5">
                {cmds.map((c) => (
                  <li key={c.key} className="flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm">
                    <TerminalWindow className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
                    <code className="shrink-0 font-mono text-xs font-semibold">{c.label}</code>
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">{c.hint}</span>
                  </li>
                ))}
                {cmds.length === 0 && <li className="px-2 py-4 text-center text-xs text-muted-foreground">No command matches.</li>}
              </ul>
            </TabsContent>
            <TabsContent value="macros" className="mt-2">
              <ul className="flex flex-col gap-0.5">
                {macros.map((m) => (
                  <li key={m.name} className="flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm">
                    <BracketsCurly className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
                    <code className="shrink-0 font-mono text-xs font-semibold">{'{{' + m.name + '}}'}</code>
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">{m.hint}</span>
                  </li>
                ))}
                {macros.length === 0 && <li className="px-2 py-4 text-center text-xs text-muted-foreground">No macro matches.</li>}
              </ul>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
