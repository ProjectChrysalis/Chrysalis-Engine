
import { Cpu } from '@phosphor-icons/react'
import { MODEL_ICONS, iconKeyForModel } from '@/lib/model-icons'
import { cn } from '@/lib/utils'

/** A message/header model badge mark: the provider's own glyph when we have
 *  it, a generic chip otherwise. Mono glyphs — they inherit text colour. */
export function ModelMark({ model, className }: { model: string; className?: string }) {
  const icon = MODEL_ICONS[iconKeyForModel(model) ?? '']
  if (!icon) return <Cpu className={cn('size-3', className)} aria-hidden="true" />
  return (
    <svg viewBox={icon.viewBox} className={cn('size-3', className)} fill="currentColor" aria-hidden="true">
      {icon.paths.map((p, i) => (
        <path key={i} d={p.d} {...(p.fillRule ? { fillRule: p.fillRule, clipRule: p.fillRule } : {})} />
      ))}
    </svg>
  )
}
