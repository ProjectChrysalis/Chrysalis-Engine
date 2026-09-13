export interface StreamEvent {
  type: "text" | "thinking" | "thinking_end" | "tool_start" | "tool_end" | "ask_user" | "ask_user_done" | "autocompact"
  id?: string
  name?: string
  args?: Record<string, unknown>
  delta?: string
  ok?: boolean
  summary?: string
  output?: string
  diff?: string
  ms?: number
  question?: string
  options?: string[]
  detail?: string
}

export type StreamDeltaEvent = StreamEvent & { type: "text" | "thinking" }

export interface DeltaFlushScheduler {
  schedule: (callback: () => void) => number
  cancel: (handle: number) => void
}

export interface StreamDeltaBatcher {
  enqueue: (event: StreamDeltaEvent) => void
  flush: () => void
  reset: () => void
}

function coalesce(events: StreamDeltaEvent[]): StreamDeltaEvent[] {
  const out: StreamDeltaEvent[] = []
  for (const event of events) {
    const last = out[out.length - 1]
    if (last?.type === event.type) {
      out[out.length - 1] = { ...last, delta: (last.delta ?? "") + (event.delta ?? "") }
    } else {
      out.push({ ...event })
    }
  }
  return out
}

/** Keep provider token cadence from becoming React render cadence. */
export function createStreamDeltaBatcher(
  commit: (events: StreamDeltaEvent[]) => void,
  scheduler: DeltaFlushScheduler,
): StreamDeltaBatcher {
  let pending: StreamDeltaEvent[] = []
  let scheduled: number | null = null

  const cancelScheduled = () => {
    if (scheduled === null) return
    scheduler.cancel(scheduled)
    scheduled = null
  }

  const flush = () => {
    cancelScheduled()
    if (!pending.length) return
    const events = coalesce(pending)
    pending = []
    commit(events)
  }

  return {
    enqueue: (event) => {
      pending.push(event)
      if (scheduled === null) scheduled = scheduler.schedule(flush)
    },
    flush,
    reset: () => {
      cancelScheduled()
      pending = []
    },
  }
}
