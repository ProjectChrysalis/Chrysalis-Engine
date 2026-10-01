/**
 * Session compaction that fits the model it runs on.
 *
 * The summary is a one-shot call with no session history attached: the
 * session being compacted is usually the one that no longer fits, so it can't
 * ride along. Only runs since the last compact marker are summarized (the
 * marker's summary stands in for everything before it), and a transcript
 * larger than the model's window is folded in chunks, each pass carrying the
 * summary so far.
 */
import { estimateTextTokens, inputBudget, outputCap, type BudgetModel } from "./context-budget.js";

const SUMMARY_PROMPT =
  "Summarize the conversation below into a compact session memory. Preserve: what the user wants, decisions made, every file path created or edited, plugin/app/MCP state, and open threads / next steps. Write it as a self-contained briefing a coding agent can continue from, in plain text with short sections. No preamble, no commentary about summarizing.";
const EARLIER_NOTE = "The summary of the conversation before this part is given first: fold it into the new summary, keeping everything that still matters.";

/** Chunk size when the model's window is unknown: fits any current model. */
const UNKNOWN_WINDOW_CHUNK_TOKENS = 16_000;
/** More chunks than this and the oldest runs are left to the earlier summary. */
const MAX_CHUNKS = 6;
const SUMMARY_MAX_TOKENS = 4096;

type ToolRec = { name?: unknown; ok?: unknown; summary?: unknown; args?: unknown };
type Rec = { type?: unknown; user?: unknown; assistant?: unknown; summary?: unknown; tools?: unknown; turns?: unknown };

/** The argument that says what a tool call touched (a path, a command…). */
function toolTarget(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of ["path", "file", "filePath", "command", "cmd", "app", "id", "query", "pattern"]) {
    if (typeof a[k] === "string" && a[k]) return (a[k] as string).replace(/\s+/g, " ").slice(0, 120);
  }
  return "";
}

function toolLine(tools: ToolRec[]): string {
  const parts = tools
    .filter((t) => typeof t.name === "string")
    .map((t) => {
      const target = toolTarget(t.args);
      return `${t.name as string}${target ? ` ${target}` : ""}${t.ok === false ? " (failed)" : ""}`;
    });
  return parts.length ? `[tools: ${parts.join("; ")}]` : "";
}

function clipMiddle(text: string, maxTokens: number): string {
  if (estimateTextTokens(text) <= maxTokens) return text;
  // chars ≈ tokens × 2 is safe for any script at our estimate's rates
  const keep = Math.max(200, maxTokens * 2);
  const head = text.slice(0, Math.floor(keep * 0.6));
  const tail = text.slice(text.length - Math.floor(keep * 0.4));
  return `${head}\n…[${text.length - head.length - tail.length} chars omitted]…\n${tail}`;
}

/** Plain-text transcript entries since the last compact marker. */
export function compactionInput(records: Rec[]): { earlier?: string; runs: string[] } {
  let earlier: string | undefined;
  let runs: string[] = [];
  for (const r of records) {
    if (r.type === "compact") {
      earlier = typeof r.summary === "string" && r.summary.trim() ? r.summary : undefined;
      runs = [];
      continue;
    }
    if (r.type !== "run") continue;
    const lines: string[] = [];
    if (typeof r.user === "string" && r.user.trim()) lines.push(`User: ${r.user}`);
    const turns = Array.isArray(r.turns) ? (r.turns as { tools?: ToolRec[] }[]) : [];
    const tools = turns.length ? turns.flatMap((t) => t.tools ?? []) : Array.isArray(r.tools) ? (r.tools as ToolRec[]) : [];
    const used = toolLine(tools);
    if (used) lines.push(used);
    if (typeof r.assistant === "string" && r.assistant.trim()) lines.push(`Assistant: ${r.assistant}`);
    if (lines.length) runs.push(lines.join("\n"));
  }
  return { ...(earlier ? { earlier } : {}), runs };
}

/** Pack runs into chunks of at most `budget` tokens, newest last. */
function pack(runs: string[], budget: number): { text: string; runs: number }[] {
  const chunks: { text: string; runs: number }[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  const flush = () => {
    if (cur.length) chunks.push({ text: cur.join("\n\n"), runs: cur.length });
    cur = [];
    curTokens = 0;
  };
  for (const run of runs) {
    const text = clipMiddle(run, budget);
    const t = estimateTextTokens(text) + 2;
    if (cur.length && curTokens + t > budget) flush();
    cur.push(text);
    curTokens += t;
  }
  flush();
  return chunks;
}

export interface SummarizeOptions {
  model: BudgetModel;
  records: Rec[];
  /** One model call: prompt in, text out. Throws on failure. */
  generate: (prompt: string, maxTokens: number) => Promise<string>;
}

/** Fold the session into one summary; throws when there is nothing to fold. */
export async function summarizeSession(opts: SummarizeOptions): Promise<{ summary: string; chunks: number; droppedRuns: number }> {
  const { earlier, runs } = compactionInput(opts.records);
  if (!runs.length) throw new Error("nothing to compact");
  const maxTokens = Math.min(SUMMARY_MAX_TOKENS, outputCap(opts.model));
  const budget = inputBudget(opts.model);
  // room for the prompt, the running summary and the reply
  const chunkBudget = budget ? Math.max(2000, Math.floor(budget * 0.6) - maxTokens) : UNKNOWN_WINDOW_CHUNK_TOKENS;

  let chunks = pack(runs, chunkBudget);
  let droppedRuns = 0;
  if (chunks.length > MAX_CHUNKS) {
    // keep the newest; the oldest are the least likely to matter now
    droppedRuns = chunks.slice(0, -MAX_CHUNKS).reduce((n, c) => n + c.runs, 0);
    chunks = chunks.slice(-MAX_CHUNKS);
  }

  let summary = earlier ?? "";
  for (const { text: chunk } of chunks) {
    const prompt = summary
      ? `${SUMMARY_PROMPT}\n${EARLIER_NOTE}\n\n<earlier_summary>\n${summary}\n</earlier_summary>\n\n<conversation>\n${chunk}\n</conversation>`
      : `${SUMMARY_PROMPT}\n\n<conversation>\n${chunk}\n</conversation>`;
    const out = (await opts.generate(prompt, maxTokens)).trim();
    if (!out) throw new Error("compaction produced no summary (check that a model is configured)");
    summary = out;
  }
  return { summary, chunks: chunks.length, droppedRuns };
}
