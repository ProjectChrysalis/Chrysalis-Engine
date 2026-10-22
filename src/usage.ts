/**
 * Spending ledger: one line per provider turn (agent steps, app generations,
 * API calls), one file per month beside the credentials. The Spending page
 * totals these; nothing here is estimated.
 */
import fs from "node:fs";
import path from "node:path";

export interface UsageRow {
  /** epoch ms */
  t: number;
  /** "agent", "app:<id>/<plugin>", "api:<route>" */
  src: string;
  model: string;
  /** input tokens not read from the cache */
  in: number;
  out: number;
  cr: number;
  cw: number;
  /** null when the model has no known rates */
  cost: number | null;
}

export interface UsageTotals { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; unpriced: number }

export interface UsageSummary {
  from: string;
  to: string;
  total: UsageTotals;
  days: Array<{ date: string } & UsageTotals>;
  models: Array<{ model: string } & UsageTotals>;
  sources: Array<{ source: string } & UsageTotals>;
}

const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);

export function recordUsage(dir: string, row: UsageRow): void {
  if (row.in + row.out + row.cr + row.cw === 0) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, `${monthOf(row.t)}.jsonl`), JSON.stringify(row) + "\n", { mode: 0o600 });
  } catch {
    /* a full or read-only disk must not fail the generation */
  }
}

/** Who spent it: the agent, one app, or the HTTP API. */
export function usageSource(src: string): string {
  if (src === "agent") return "agent";
  const app = /^app:([^/]+)\//.exec(src);
  if (app) return `app:${app[1]}`;
  return src.startsWith("api:") ? "api" : "other";
}

const empty = (): UsageTotals => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 });

function add(into: UsageTotals, row: UsageRow): void {
  into.calls++;
  into.input += row.in;
  into.output += row.out;
  into.cacheRead += row.cr;
  into.cacheWrite += row.cw;
  if (row.cost === null) into.unpriced++;
  else into.cost += row.cost;
}

/** Calendar date of t in timeZone (YYYY-MM-DD). */
function dayIn(t: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

/** Totals over the last `days` calendar days in timeZone, today included. */
export function usageSummary(dir: string, days: number, timeZone: string, now = Date.now()): UsageSummary {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    timeZone = "UTC";
  }
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = dayIn(now - i * 86_400_000, timeZone);
    if (dates.at(-1) !== d) dates.push(d);
  }
  const first = dates[0]!;
  const byDay = new Map(dates.map((d) => [d, empty()]));
  const byModel = new Map<string, UsageTotals>();
  const bySource = new Map<string, UsageTotals>();
  const total = empty();
  // a day in timeZone can start up to 14 h before the same UTC date
  const earliest = Date.parse(`${first}T00:00:00Z`) - 14 * 3_600_000;
  const months: string[] = [];
  for (const m = new Date(earliest); monthOf(m.getTime()) <= monthOf(now); m.setUTCMonth(m.getUTCMonth() + 1, 1)) months.push(monthOf(m.getTime()));
  for (const month of months) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, `${month}.jsonl`), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let row: UsageRow;
      try {
        row = JSON.parse(line) as UsageRow;
      } catch {
        continue;
      }
      if (row.t < earliest || row.t > now) continue;
      const day = byDay.get(dayIn(row.t, timeZone));
      if (!day) continue;
      add(day, row);
      add(total, row);
      const model = byModel.get(row.model) ?? byModel.set(row.model, empty()).get(row.model)!;
      add(model, row);
      const src = usageSource(row.src);
      add(bySource.get(src) ?? bySource.set(src, empty()).get(src)!, row);
    }
  }
  const ranked = <K extends string>(map: Map<string, UsageTotals>, key: K) =>
    [...map].map(([name, t]) => ({ [key]: name, ...t }) as { [P in K]: string } & UsageTotals).sort((a, b) => b.cost - a.cost || b.calls - a.calls);
  return {
    from: first,
    to: dates.at(-1)!,
    total,
    days: dates.map((date) => ({ date, ...byDay.get(date)! })),
    models: ranked(byModel, "model"),
    sources: ranked(bySource, "source"),
  };
}
