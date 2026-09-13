
import { Button } from '@/components/ui/button'

/** List pager for collections that grow for years (thousands of chats,
 *  characters, entries…). Hides itself while everything fits one page.
 *  Same markup as the characters/chats view pagers. */
export function Pager(props: {
  total: number
  page: number
  pageSize: number
  onPage: (p: number) => void
  className?: string
}) {
  if (props.total <= props.pageSize) return null
  const from = props.page * props.pageSize + 1
  const to = Math.min(props.total, (props.page + 1) * props.pageSize)
  return (
    <div className={props.className ?? 'flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground'}>
      <Button variant="outline" size="sm" className="h-7" disabled={props.page === 0} onClick={() => props.onPage(props.page - 1)}>Previous</Button>
      <span className="tabular-nums">{from}–{to} of {props.total}</span>
      <Button variant="outline" size="sm" className="h-7" disabled={to >= props.total} onClick={() => props.onPage(props.page + 1)}>Next</Button>
    </div>
  )
}

/** Clamp a page index against the current list length — deleting the last
 *  item on the last page must not strand the view on an empty page. */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(page, Math.max(0, Math.ceil(total / pageSize) - 1))
}
