import {
  AuiConfig,
  defineToolkit,
  Tools,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react"
import { CodeDiff, parseDiff } from "@/components/assistant-ui/elements/code-diff"
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui"
import type { ReactNode } from "react"

export interface ToolResult {
  ok: boolean
  summary?: string
  output?: string
  diff?: string
}

/** One line of plain text where a diff would go: a write that changed nothing,
 *  a refused write, an edit still running. */
function EditNote({ path, note, tone }: { path: string; note: string; tone?: "error" }): ReactNode {
  return (
    <div className="my-1 flex items-center gap-2 px-2.5 py-1.5 font-mono text-[11px]">
      <span className="min-w-0 truncate text-muted-foreground" title={path}>{path}</span>
      <span className={tone === "error" ? "text-destructive" : "text-muted-foreground/70"}>{note}</span>
    </div>
  )
}

const EditTool: ToolCallMessagePartComponent<Record<string, unknown>, ToolResult> = (p): ReactNode => {
  const path = typeof p.args?.path === "string" ? p.args.path : "file"
  if (p.status?.type === "running") return <EditNote path={path} note="writing…" />
  if (p.result && !p.result.ok) return <EditNote path={path} note={p.result.summary ?? "failed"} tone="error" />
  if (!p.result?.diff) {
    // the tool reports a diff for every write that changed the file, so a
    // result without one means the file already held what was written
    return <EditNote path={path} note={p.result ? "no changes" : ""} />
  }
  return (
    <div className="my-1.5">
      <CodeDiff filename={path} diff={parseDiff(p.result.diff)} />
    </div>
  )
}

const toolkit = defineToolkit({
  edit_file: { render: EditTool },
  write_file: { render: EditTool },
})

export const toolConfig = AuiConfig({ tools: Tools({ toolkit }) })

/** Engine results are `{ ok, summary, output?, diff? }`: the reader gets the
 *  whole output when the engine kept more than the summary. */
export const AgentToolFallback: ToolCallMessagePartComponent = (props) => {
  const r = props.result as Partial<ToolResult> | undefined
  const text = r && typeof r === "object" ? (r.output ?? r.summary) : undefined
  return <ToolFallback {...props} result={text ?? props.result} />
}
