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
import { estimateTextTokens, outputCap, type BudgetModel } from "./context-budget.js";

const SUMMARY_PROMPT =
  "Summarize the conversation below into a compact session memory. Preserve: what the user wants, decisions made, every file path created or edited, plugin/app/MCP state, and open threads / next steps. Write it as a self-contained briefing a coding agent can continue from, in plain text with short sections. No preamble, no commentary about summarizing.";
const EARLIER_NOTE = "The summary of the conversation before this part is given first: fold it into the new summary, keeping everything that still matters.";

/** Conservative input allowance when the model catalog has no window. */
const UNKNOWN_WINDOW_CHUNK_TOKENS = 16_000;
const SUMMARY_MAX_TOKENS = 4096;

type ToolRec = { name?: unknown; ok?: unknown; summary?: unknown; args?: unknown };
type Rec = { model?: unknown; type?: unknown; user?: unknown; assistant?: unknown; summary?: unknown; tools?: unknown; turns?: unknown };

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

/** Most recent recorded session model; legacy records have no model. */
export function lastSessionModel(records: readonly Rec[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if ((r.type === "run" || r.type === "compact") && typeof r.model === "string" && /^[^\s/]+\/[^\s]+$/.test(r.model) && r.model.length <= 200) return r.model;
  }
  return undefined;
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
  const window = opts.model.contextWindow && opts.model.contextWindow > 0 ? opts.model.contextWindow : 0;
  const maxTokens = Math.min(SUMMARY_MAX_TOKENS, outputCap(opts.model), window ? Math.max(1, Math.floor(window / 8)) : SUMMARY_MAX_TOKENS);
  const inputLimit = window ? window - maxTokens - Math.max(256, Math.floor(window * 0.03)) : UNKNOWN_WINDOW_CHUNK_TOKENS;
  // The prior summary is folded too: an older engine may have written one
  // bigger than this model can carry. Every byte of every run is visited.
  const transcript = [...(earlier ? [`Earlier session summary:\n${earlier}`] : []), ...runs].join("\n\n");
  let offset = 0;
  let summary = "";
  let chunks = 0;
  while (offset < transcript.length) {
    const prefix = summary
      ? `${SUMMARY_PROMPT}\n${EARLIER_NOTE}\n\n<earlier_summary>\n${summary}\n</earlier_summary>\n\n<conversation>\n`
      : `${SUMMARY_PROMPT}\n\n<conversation>\n`;
    const suffix = "\n</conversation>";
    const room = inputLimit - estimateTextTokens(prefix + suffix) - 32;
    if (room < 1) throw new Error("compaction summary leaves no room for the conversation in this model's context window");
    // Count the actual script instead of assuming a chars-per-token ratio.
    let low = 0;
    let high = transcript.length - offset;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (estimateTextTokens(transcript.slice(offset, offset + middle)) <= room) low = middle;
      else high = middle - 1;
    }
    if (!low) throw new Error("model context window is too small for session compaction");
    const endCode = transcript.charCodeAt(offset + low - 1);
    if (endCode >= 0xd800 && endCode <= 0xdbff && offset + low < transcript.length) low--;
    if (!low) throw new Error("model context window is too small for session compaction");
    const chunk = transcript.slice(offset, offset + low);
    const prompt = prefix + chunk + suffix;
    if (estimateTextTokens(prompt) + 32 > inputLimit) throw new Error("compaction request exceeds its input budget");
    const out = (await opts.generate(prompt, maxTokens)).trim();
    if (!out) throw new Error("compaction produced no summary (check that a model is configured)");
    summary = out;
    offset += low;
    chunks++;
  }
  return { summary, chunks, droppedRuns: 0 };
}
