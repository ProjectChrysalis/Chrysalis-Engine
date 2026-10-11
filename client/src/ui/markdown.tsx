import type { ReactNode } from "react"
import { cn } from "./cn"

// Markdown for showing a file of instructions: headings, lists, code, quotes,
// tables and inline marks. Everything becomes elements, never markup text, so
// nothing a file holds can run in the page. Links open only when they are web
// addresses; anything else stays as the text that was written.

const INLINE = /(`+)([\s\S]*?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|\b_([^_\s][^_]*?)_\b|\[([^\]]+)\]\(([^)\s]+)\)/g
const FENCE = /^\s*(`{3,}|~{3,})/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?/
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let at = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push(text.slice(at, m.index))
    const k = `${key}.${n++}`
    const strong = m[3] ?? m[4]
    const em = m[5] ?? m[6]
    if (m[1]) out.push(<code key={k}>{m[2]!.trim()}</code>)
    else if (strong) out.push(<strong key={k}>{inline(strong, k)}</strong>)
    else if (em) out.push(<em key={k}>{inline(em, k)}</em>)
    else if (/^https?:\/\//i.test(m[8]!)) out.push(<a key={k} href={m[8]} target="_blank" rel="noreferrer">{inline(m[7]!, k)}</a>)
    else out.push(m[0])
    at = m.index + m[0].length
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

const cells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
const indentOf = (line: string): number => line.length - line.trimStart().length
const startsBlock = (line: string): boolean => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line)

function blocks(lines: string[], key: string): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const k = `${key}.${out.length}`
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) body.push(lines[i]!)
      i++
      out.push(<pre key={k}><code>{body.join("\n")}</code></pre>)
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      // the dialog's own title is the first level
      const Tag = (["h3", "h4", "h5", "h6", "h6", "h6"] as const)[heading[1]!.length - 1]!
      out.push(<Tag key={k}>{inline(heading[2]!, k)}</Tag>)
      i++
      continue
    }
    if (RULE.test(line)) {
      out.push(<hr key={k} />)
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) body.push(lines[i]!.replace(QUOTE, ""))
      out.push(<blockquote key={k}>{blocks(body, k)}</blockquote>)
      continue
    }
    if (line.includes("|") && DIVIDER.test(lines[i + 1] ?? "")) {
      const head = cells(line)
      const rows: string[][] = []
      for (i += 2; i < lines.length && lines[i]!.includes("|"); i++) rows.push(cells(lines[i]!))
      out.push(
        <div key={k} data-slot="markdown-table">
          <table>
            <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `${k}.h${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, y) => <tr key={y}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? "", `${k}.${y}.${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }
    const first = ITEM.exec(line)
    if (first) {
      const base = first[1]!.length
      const ordered = /\d/.test(first[2]!)
      const items: ReactNode[] = []
      while (i < lines.length) {
        const item = ITEM.exec(lines[i]!)
        if (!item || item[1]!.length !== base || /\d/.test(item[2]!) !== ordered) break
        // what sits deeper than the marker belongs to this item
        const inner: string[] = []
        for (i++; i < lines.length; i++) {
          const next = lines[i]!
          if (next.trim() ? indentOf(next) <= base : !(lines[i + 1]?.trim() && indentOf(lines[i + 1]!) > base)) break
          inner.push(next.slice(Math.min(indentOf(next), base + 2)))
        }
        const ik = `${k}.${items.length}`
        items.push(<li key={ik}>{inline(item[3]!, ik)}{inner.length ? blocks(inner, ik) : null}</li>)
      }
      out.push(ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>)
      continue
    }
    const text: string[] = []
    for (; i < lines.length && lines[i]!.trim() && !(text.length && startsBlock(lines[i]!)); i++) text.push(lines[i]!.trim())
    out.push(<p key={k}>{inline(text.join(" "), k)}</p>)
  }
  return out
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div data-component="markdown" className={cn(className)}>
      {blocks(text.replace(/\r\n?/g, "\n").split("\n"), "m")}
    </div>
  )
}
