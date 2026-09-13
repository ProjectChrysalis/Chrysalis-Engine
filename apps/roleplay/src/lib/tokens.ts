import { countTokens } from 'gpt-tokenizer/encoding/o200k_base'

/** Token counts come from a real BPE tokenizer (the o200k vocabulary modern
 *  models use), not a character estimate. Providers whose own tokenizer
 *  differs will land a few percent apart; the same text always counts the
 *  same here, so budgets and per-field numbers stay comparable.
 *
 *  Counting is pure and repeated on every render for the same strings (field
 *  badges, lorebook lists, prompt previews), so results are memoized. */
const CACHE_MAX = 4000
const cache = new Map<string, number>()

export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const n = countTokens(text)
  // plain FIFO eviction: the working set is whatever is on screen, and a
  // cheap bound beats tracking recency for numbers this small
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(text, n)
  return n
}

export function formatTokens(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Formats a USD amount, keeping sub-cent precision that per-message costs need. */
export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

/** Spend for one generation, or null when it isn't known.
 *
 *  A stored zero alongside real token usage is history from before the engine
 *  distinguished "no price table" from "free" — every generation through a
 *  custom endpoint recorded one. Reading those as $0.00 turned a month of paid
 *  replies into a free lunch, so they count as unknown. */
export function knownCost(usage: { input: number; output: number; costTotal?: number } | undefined): number | null {
  if (!usage || usage.costTotal == null) return null
  if (usage.costTotal === 0 && usage.input + usage.output > 0) return null
  return usage.costTotal
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}


