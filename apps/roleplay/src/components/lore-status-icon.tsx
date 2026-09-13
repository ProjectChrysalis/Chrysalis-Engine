import { Circle, RadioButton, LinkSimple } from '@phosphor-icons/react'
import type { EntryStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

export const LORE_STATUS_LABEL: Record<EntryStatus, string> = {
  constant: 'Constant',
  normal: 'Normal',
  vectorized: 'Vectorized',
}

/**
 * Icon for a world-info entry status. Replaces the coloured-emoji dots that
 * rendered as three neutral states.
 */
export function LoreStatusIcon({ status, className }: { status: EntryStatus; className?: string }) {
  const Icon = status === 'constant' ? RadioButton : status === 'vectorized' ? LinkSimple : Circle
  return (
    <Icon
      className={cn('size-3.5 shrink-0', status === 'constant' ? 'text-primary' : 'text-muted-foreground', className)}
      aria-hidden="true"
    />
  )
}
