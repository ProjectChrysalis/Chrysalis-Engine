
import { Stack } from '@phosphor-icons/react'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { estimateTokens, formatTokens } from '@/lib/tokens'
import { useApp } from '@/lib/store'
import type { AltVariant, Character, Chat } from '@/lib/types'

/** The three fields that support alternates. Greetings use swipes instead. */
const VARIANT_FIELDS = [
  { key: 'desc', label: 'Description', base: 'description', list: 'descVariants' },
  { key: 'personality', label: 'Personality', base: 'personality', list: 'personalityVariants' },
  { key: 'scenario', label: 'Scenario', base: 'scenario', list: 'scenarioVariants' },
] as const

/**
 * Per-chat choice of which alternate description / personality / scenario this
 * conversation sends. Mirrors how alternate greetings let one card cover
 * several framings, but for the always-resident fields. "Primary" means the
 * card's own base value.
 */
export function FieldVariantPicker({ chat, character }: { chat: Chat; character: Character }) {
  const updateChat = useApp((s) => s.updateChat)

  const available = VARIANT_FIELDS.filter(
    (f) => (character[f.list] as AltVariant[]).length > 0,
  )

  if (available.length === 0) {
    return (
      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        <Stack className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        {character.name} has no alternate description, personality or scenario yet. Add them in the character editor to switch framing per chat.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {available.map((f) => {
        const variants = character[f.list] as AltVariant[]
        const selected = chat.fieldVariantSelection[f.key] ?? ''
        const activeText =
          variants.find((v) => v.id === selected)?.content ?? (character[f.base] as string)
        return (
          <div key={f.key} className="flex flex-col gap-1">
            <Label className="flex items-center gap-2 text-xs">
              {f.label}
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
                {formatTokens(estimateTokens(activeText))} tok
              </span>
            </Label>
            <Select
              value={selected || '__base__'}
              onValueChange={(v) =>
                v &&
                updateChat(chat.id, {
                  fieldVariantSelection: {
                    ...chat.fieldVariantSelection,
                    [f.key]: v === '__base__' ? undefined : v,
                  },
                })
              }
            >
              <SelectTrigger className="h-8 text-xs" aria-label={`${f.label} variant for this chat`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__base__">Primary (card default)</SelectItem>
                {variants.map((v) => (
                  <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )
      })}
    </div>
  )
}
