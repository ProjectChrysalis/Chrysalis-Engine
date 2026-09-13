
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '@/lib/store'
import { detectExpressionLabels, resolveExpressionSprite } from '@/lib/expressions'
import type { Chat } from '@/lib/types'

const POS_KEY = 'expr-panel-pos'

/**
 * Floating expression sprite — reads the latest character message, detects
 * its emotion (keyword rules) and shows the speaker's matching sprite with a
 * soft crossfade. Draggable anywhere; position persists. Hidden when the
 * speaker has no sprites or Settings turns sprites off.
 */
export function ExpressionPanel({ chat }: { chat: Chat }) {
  const characters = useApp((s) => s.characters)
  const show = useApp((s) => s.settings.showExpressionSprites !== false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try { return JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') } catch { return null }
  })
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  // memoized: this panel sits over the scrolling log and re-renders with the
  // chat view — detection (a regex pass per rule) + the reverse-copy only re-run
  // when the latest character message actually changes
  const lastAsst = useMemo(
    () => [...chat.messages].reverse().find((m) => m.role === 'assistant'),
    [chat.messages],
  )
  const speaker = characters.find((c) => c.id === (lastAsst?.characterId ?? chat.characterId))
  const sprites = speaker?.expressions ?? []

  const text = lastAsst?.swipes[lastAsst.activeSwipe]?.content ?? ''
  const sprite = useMemo(
    () => resolveExpressionSprite(detectExpressionLabels(text), sprites, speaker?.defaultExpression),
    [text, sprites, speaker?.defaultExpression],
  )

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragRef.current) return
      const next = { x: e.clientX - dragRef.current.dx, y: e.clientY - dragRef.current.dy }
      setPos({
        x: Math.min(Math.max(0, next.x), window.innerWidth - 80),
        y: Math.min(Math.max(0, next.y), window.innerHeight - 80),
      })
    }
    const up = () => {
      if (!dragRef.current) return
      dragRef.current = null
      // a browser blocking site data throws here; the panel keeps the
      // position for this session either way
      setPos((p) => { try { if (p) localStorage.setItem(POS_KEY, JSON.stringify(p)) } catch { /* storage unavailable */ } return p })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [])

  if (!show || !sprite || !speaker) return null

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : { right: '1rem', bottom: '5rem' }

  return (
    <div
      className="fixed z-30 max-h-[42dvh] cursor-grab touch-none select-none active:cursor-grabbing"
      style={style}
      onPointerDown={(e) => {
        dragRef.current = { dx: e.clientX - (pos?.x ?? 0), dy: e.clientY - (pos?.y ?? 0) }
        if (!pos) setPos({ x: e.clientX - 60, y: e.clientY - 60 })
      }}
      role="img"
      aria-label={`${speaker.name}: ${sprite.name}`}
      title={`${speaker.name}: ${sprite.name} (drag to move)`}
    >
      <img
        key={sprite.url}
        src={sprite.url}
        alt={`${speaker.name} ${sprite.name}`}
        draggable={false}
        onLoad={(e) => { e.currentTarget.style.opacity = '1' }}
        className="max-h-[42dvh] rounded-lg border border-border/40 bg-card/60 shadow-lg [opacity:0] transition-opacity duration-200"
      />
    </div>
  )
}
