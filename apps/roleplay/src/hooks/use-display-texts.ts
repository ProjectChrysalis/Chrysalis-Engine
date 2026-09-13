import { useEffect, useState } from 'react'
import { isBadPattern, runRegexSafe } from '@/lib/safe-regex'

/** One display-stage script, fully resolved: macros already substituted into
 *  `find`; `replace` keeps its macros because capture values need them too. */
export interface DisplayScript {
  find: string
  flags: string
  replace: string
  trims: string[]
  macros: Record<string, string>
}

// Display results per exact (text, script list). Streaming produces new keys
// every tick, so the map is bounded.
const cache = new Map<string, string[]>()
const CACHE_MAX = 256

async function applyChain(texts: string[], scripts: DisplayScript[]): Promise<string[]> {
  const out: string[] = []
  for (const text of texts) {
    let cur = text
    for (const s of scripts) {
      if (isBadPattern(s.find, s.flags)) continue
      const r = await runRegexSafe(s.find, s.flags, s.replace, cur, { trims: s.trims, timeoutMs: 300, macros: s.macros })
      // timed-out patterns are remembered and skipped; the text stays as-is
      if (r.timedOut) continue
      if (r.ok && typeof r.output === 'string') cur = r.output
    }
    out.push(cur)
  }
  return out
}

/** Apply display-stage regex scripts to rendered text. The work runs in the
 *  regex worker, never synchronously in render: a hostile imported pattern
 *  would otherwise freeze the tab before any timeout could fire. Until a
 *  result is ready the raw text renders, then the transformed text swaps in. */
export function useDisplayTexts(texts: string[], scripts: DisplayScript[]): string[] {
  const cacheKey = scripts.length > 0 ? JSON.stringify([texts, scripts]) : ''
  const cached = cacheKey ? cache.get(cacheKey) : undefined
  const [, force] = useState(0)
  useEffect(() => {
    if (!cacheKey || cache.has(cacheKey)) return
    let alive = true
    void applyChain(texts, scripts).then((out) => {
      if (!alive) return
      cache.set(cacheKey, out)
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
      force((n) => n + 1)
    })
    return () => { alive = false }
  }, [cacheKey]) // eslint-disable-line react-hooks/exhaustive-deps
  return cached ?? texts
}
