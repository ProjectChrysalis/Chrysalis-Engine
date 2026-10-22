// Settings > Spending: what model calls cost, per day, per app and per model,
// from the engine's own ledger of every provider turn.
import { useEffect, useState } from "react"
import { usageApi, type UsageSummary, type UsageTotals } from "./api"
import { tr } from "./i18n/index"
import { Pane } from "./settings"
import { Section } from "./server-settings"
import { Button } from "./ui/button"

const PERIODS = [7, 30, 90] as const

function money(v: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 1 ? 4 : 2 }).format(v)
}

const count = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)

const promptTokens = (t: UsageTotals) => t.input + t.cacheRead + t.cacheWrite

/** Share of prompt tokens the provider served from its cache. */
const cacheRate = (t: UsageTotals) => (promptTokens(t) > 0 ? Math.round((t.cacheRead / promptTokens(t)) * 100) : null)

function sourceLabel(source: string, names: Record<string, string>): string {
  if (source === "agent") return tr("Agent")
  if (source === "api") return tr("API")
  if (source.startsWith("app:")) return names[source] ?? source.slice(4)
  return tr("Other")
}

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function Stat(props: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-12 text-ink-muted">{props.label}</span>
      <span className="truncate text-16 font-medium text-ink tabular-nums">{props.value}</span>
    </div>
  )
}

/** Daily bars; picking a bar shows that day underneath. */
function DailyChart(props: { days: UsageSummary["days"]; byCost: boolean }) {
  const value = (d: UsageTotals) => (props.byCost ? d.cost : promptTokens(d) + d.output)
  const max = Math.max(...props.days.map(value))
  const [picked, setPicked] = useState<string | null>(null)
  const day = props.days.find((d) => d.date === picked) ?? props.days.at(-1)!
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-28 items-end gap-0.5" role="list">
        {props.days.map((d) => {
          const v = value(d)
          return (
            <button
              key={d.date}
              role="listitem"
              className="group flex h-full min-w-0 flex-1 items-end"
              title={`${dayLabel(d.date)}: ${props.byCost ? money(d.cost) : tr("{n} tokens", { n: count(v) })}`}
              onClick={() => setPicked(d.date)}
              onMouseEnter={() => setPicked(d.date)}
            >
              <span
                className={`w-full rounded-t-[4px] transition-colors ${d.date === day.date ? "bg-ink" : "bg-ink-faint group-hover:bg-ink-muted"}`}
                style={{ height: max > 0 && v > 0 ? `${Math.max(2, (v / max) * 100)}%` : "1px" }}
              />
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-12 text-ink-muted tabular-nums">
        <span className="text-ink">{dayLabel(day.date)}</span>
        <span>
          {[props.byCost ? money(day.cost) : null, tr("{n} calls", { n: day.calls }), tr("{n} tokens", { n: count(promptTokens(day) + day.output) })]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
    </div>
  )
}

function Breakdown(props: { rows: Array<{ name: string } & UsageTotals>; byCost: boolean }) {
  const value = (r: UsageTotals) => (props.byCost ? r.cost : promptTokens(r) + r.output)
  const max = Math.max(...props.rows.map(value), 0)
  return (
    <div className="flex flex-col gap-2.5">
      {props.rows.map((r) => (
        <div key={r.name} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-13">
            <span className="min-w-0 truncate text-ink">{r.name}</span>
            <span className="shrink-0 text-ink-muted tabular-nums">
              {props.byCost ? `${money(r.cost)} · ` : ""}
              {tr("{n} calls", { n: r.calls })}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded bg-panel">
            <div className="h-full rounded bg-ink-muted" style={{ width: max > 0 ? `${(value(r) / max) * 100}%` : "0%" }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function SpendingTab() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30)
  const [d, setData] = useState<UsageSummary | null>(null)
  const [err, setErr] = useState("")
  useEffect(() => {
    let live = true
    setErr("")
    usageApi.summary(days).then(
      (s) => live && setData(s),
      (e: unknown) => live && setErr((e as Error).message ?? String(e)),
    )
    return () => {
      live = false
    }
  }, [days])
  const byCost = !!d && d.total.cost > 0
  const rate = d ? cacheRate(d.total) : null
  return (
    <Pane title={tr("Spending")} description={tr("What model calls cost, from the agent, your apps and the API.")}>
      <div className="flex flex-col gap-6 pb-4">
        <div className="flex gap-1.5">
          {PERIODS.map((p) => (
            <Button key={p} variant={days === p ? "contrast" : "neutral"} size="small" onClick={() => setDays(p)}>
              {tr("{n} days", { n: p })}
            </Button>
          ))}
        </div>
        {err ? <div className="rounded-lg border border-danger px-3 py-2 text-13 text-danger">{err}</div> : null}
        {d && d.total.calls === 0 ? <p className="text-13 text-ink-muted">{tr("No model calls in this period.")}</p> : null}
        {d && d.total.calls > 0 ? (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label={tr("Spent")} value={money(d.total.cost)} />
              <Stat label={tr("Calls")} value={count(d.total.calls)} />
              <Stat label={tr("Tokens")} value={count(promptTokens(d.total) + d.total.output)} />
              {rate !== null ? <Stat label={tr("From cache")} value={`${rate}%`} /> : null}
            </div>
            {d.total.unpriced > 0 ? (
              <p className="text-12 text-ink-muted">{tr("{n} calls used models with no known price and are not in the total.", { n: d.total.unpriced })}</p>
            ) : null}
            <Section title={byCost ? tr("Per day") : tr("Tokens per day")}>
              <DailyChart days={d.days} byCost={byCost} />
            </Section>
            <Section title={tr("By app")}>
              <Breakdown rows={d.sources.map((s) => ({ ...s, name: sourceLabel(s.source, d.names) }))} byCost={byCost} />
            </Section>
            <Section title={tr("By model")}>
              <Breakdown rows={d.models.map((m) => ({ ...m, name: m.model }))} byCost={byCost} />
            </Section>
          </>
        ) : null}
      </div>
    </Pane>
  )
}
