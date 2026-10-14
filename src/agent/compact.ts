/**
 * Session compaction.
 *
 * The older part of what the model sees is folded into a structured
 * checkpoint; the most recent messages stay exactly as they are, so work in
 * progress keeps its real tool calls and results. A checkpoint that already
 * exists is updated with what happened since, never summarized a second time.
 *
 * The summary is a one-shot call with no session history attached (the
 * session is what no longer fits). The messages go in as a plain transcript
 * with tool output clipped, and a transcript larger than the model's window
 * is folded in parts, each carrying the checkpoint so far.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateMessageTokens, estimateTextTokens, outputCap, type BudgetModel } from "./context-budget.js";

/** Recent context that stays as it is, in tokens… */
const KEEP_RECENT_TOKENS = 20_000;
/** …but never more than this share of the window, or of what is there. */
const KEEP_WINDOW_SHARE = 0.2;
const KEEP_CONTEXT_SHARE = 0.25;
const TOOL_RESULT_CHARS = 2000;
const TOOL_ARGUMENT_CHARS = 400;
/** Paths listed per kind; the oldest drop off first. */
const FILE_LIST_MAX = 200;
/** Conservative input allowance when the model catalog has no window. */
const UNKNOWN_WINDOW_CHUNK_TOKENS = 16_000;
const SUMMARY_MAX_TOKENS = 8192;

const FORMAT = `## Goal
[What the user wants. Several items when the session covers several tasks.]

## Constraints and preferences
- [Requirements, preferences and corrections the user gave, or "(none)"]

## Progress
### Done
- [Finished work and changes]
### In progress
- [Work under way where the conversation is cut]
### Blocked
- [What stands in the way, or "(none)"]

## Decisions
- [Decision]: [why]

## Next steps
1. [What should happen next, in order]

## Context to keep
- [Facts, values, commands, errors and references needed to continue, or "(none)"]`;
const RULES = "Do not answer or continue the conversation: only write the checkpoint. Keep each section short. Keep file paths, app and plugin ids, function names, commands and error messages exactly as written.";
const SUMMARY_PROMPT = `<conversation> is a conversation between a user and a coding agent. Write a checkpoint another agent will continue the work from. Use exactly this format:\n\n${FORMAT}\n\n${RULES}`;
const UPDATE_PROMPT = `<previous-summary> is the checkpoint of the conversation so far. <conversation> is what happened after it. Rewrite the checkpoint so it covers both: keep what still matters, add new progress and decisions, move finished work to Done, refresh the next steps and drop what no longer applies. Use exactly this format:\n\n${FORMAT}\n\n${RULES}`;
const TAIL_NOTE = "\n\nThe messages that follow this conversation are kept as they are and are not shown here: describe the state at the point where it is cut.";

type Block = { type?: string; text?: string; name?: string; arguments?: unknown };

export interface FileActivity {
  read: string[];
  modified: string[];
}

function clip(text: string, keep: number): string {
  return text.length <= keep ? text : `${text.slice(0, keep)}\n[… ${text.length - keep} more characters]`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map((b) => (b.type === "text" ? (b.text ?? "") : b.type === "image" ? "[image]" : "")).join("");
}

/** Most recent recorded session model; legacy records have no model. */
export function lastSessionModel(records: readonly { type?: unknown; model?: unknown }[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if ((r.type === "run" || r.type === "compact") && typeof r.model === "string" && /^[^\s/]+\/[^\s]+$/.test(r.model) && r.model.length <= 200) return r.model;
  }
  return undefined;
}

/**
 * Where the kept tail starts: the index of the first message that stays, or
 * messages.length when none does. The tail is what fits the keep budget
 * counted back from the newest message, moved forward to a message a context
 * can start at (a tool result would lose its call). Never 0: a compaction
 * always folds something.
 */
export function compactionCut(model: BudgetModel, messages: readonly AgentMessage[]): number {
  const tokens = messages.map(estimateMessageTokens);
  const total = tokens.reduce((a, b) => a + b, 0);
  const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : 0;
  const keep = Math.min(KEEP_RECENT_TOKENS, Math.floor(total * KEEP_CONTEXT_SHARE), window ? Math.floor(window * KEEP_WINDOW_SHARE) : KEEP_RECENT_TOKENS);
  let cut = messages.length;
  for (let i = messages.length - 1, kept = 0; i > 0; i--) {
    kept += tokens[i]!;
    if (kept > keep) break;
    cut = i;
  }
  const role = (i: number) => (messages[i] as { role?: string } | undefined)?.role;
  while (role(cut) === "toolResult") cut++;
  // a closing reply whose question is folded goes with it
  const content = (messages[cut] as { content?: unknown } | undefined)?.content;
  if (role(cut) === "assistant" && role(cut + 1) === "user" && !(Array.isArray(content) && (content as Block[]).some((b) => b.type === "toolCall"))) cut++;
  return cut;
}

/** The messages as text a model reads as data, not as a conversation to continue. */
export function serializeConversation(messages: readonly AgentMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const { role, content } = m as { role?: string; content?: unknown };
    if (role === "user") {
      const text = textOf(content);
      if (text.trim()) parts.push(`[User]: ${text}`);
    } else if (role === "assistant") {
      const text = textOf(content);
      if (text.trim()) parts.push(`[Assistant]: ${text}`);
      const calls = (Array.isArray(content) ? (content as Block[]) : [])
        .filter((b) => b.type === "toolCall")
        .map((b) => {
          const args = b.arguments && typeof b.arguments === "object" ? Object.entries(b.arguments as Record<string, unknown>) : [];
          return `${b.name ?? "tool"}(${args.map(([k, v]) => `${k}=${clip(JSON.stringify(v) ?? "", TOOL_ARGUMENT_CHARS)}`).join(", ")})`;
        });
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    } else if (role === "toolResult") {
      const text = textOf(content);
      if (text.trim()) parts.push(`[Tool result${(m as { isError?: boolean }).isError ? ", failed" : ""}]: ${clip(text, TOOL_RESULT_CHARS)}`);
    }
  }
  return parts.join("\n\n");
}

/** Files the messages read and changed, added to what earlier compactions recorded. */
export function fileActivity(messages: readonly AgentMessage[], earlier?: FileActivity): FileActivity {
  const read = new Set(earlier?.read);
  const modified = new Set(earlier?.modified);
  const touch = (set: Set<string>, file: string) => {
    set.delete(file);
    set.add(file);
  };
  for (const m of messages) {
    const { role, content } = m as { role?: string; content?: unknown };
    if (role !== "assistant" || !Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      const file = b.type === "toolCall" ? (b.arguments as { path?: unknown } | undefined)?.path : undefined;
      if (typeof file !== "string" || !file) continue;
      if (b.name === "read_file") touch(read, file);
      else if (b.name === "edit_file" || b.name === "write_file") touch(modified, file);
    }
  }
  return { read: [...read].filter((file) => !modified.has(file)).slice(-FILE_LIST_MAX), modified: [...modified].slice(-FILE_LIST_MAX) };
}

/** What stands in the model's context for everything a compaction folded. */
export function summaryText(summary: string, files?: FileActivity): string {
  const lists = [
    files?.read.length ? `<read-files>\n${files.read.join("\n")}\n</read-files>` : "",
    files?.modified.length ? `<modified-files>\n${files.modified.join("\n")}\n</modified-files>` : "",
  ].filter(Boolean);
  return [
    "Earlier messages in this conversation were replaced by the summary below to save context. Continue from it, and read a file again when you need details the summary does not carry.",
    `<summary>\n${summary}\n</summary>`,
    ...lists,
  ].join("\n\n");
}

export interface SummarizeOptions {
  model: BudgetModel;
  messages: readonly AgentMessage[];
  /** The checkpoint that stood for everything before these messages. */
  previous?: string;
  /** Messages after these stay in the context as they are. */
  tailKept?: boolean;
  /** One model call: prompt in, text out. Throws on failure. */
  generate: (prompt: string, maxTokens: number) => Promise<string>;
}

/** Fold the messages into one checkpoint; throws when there is nothing to fold. */
export async function summarizeMessages(opts: SummarizeOptions): Promise<{ summary: string; chunks: number }> {
  let transcript = serializeConversation(opts.messages);
  if (!transcript) throw new Error("nothing to compact");
  const window = opts.model.contextWindow && opts.model.contextWindow > 0 ? opts.model.contextWindow : 0;
  const maxTokens = Math.min(SUMMARY_MAX_TOKENS, outputCap(opts.model), window ? Math.max(1, Math.floor(window / 8)) : SUMMARY_MAX_TOKENS);
  const inputLimit = window ? window - maxTokens - Math.max(256, Math.floor(window * 0.03)) : UNKNOWN_WINDOW_CHUNK_TOKENS;
  let summary = opts.previous?.trim() ?? "";
  // a checkpoint written for a bigger model may not leave room beside the
  // conversation: it is folded like the rest instead of riding every part
  if (summary && estimateTextTokens(summary) > inputLimit / 2) {
    transcript = `[Checkpoint of the conversation so far]: ${summary}\n\n${transcript}`;
    summary = "";
  }
  const head = "<conversation>\n";
  let offset = 0;
  let chunks = 0;
  while (offset < transcript.length) {
    const tail = `\n</conversation>\n\n${summary ? `<previous-summary>\n${summary}\n</previous-summary>\n\n${UPDATE_PROMPT}` : SUMMARY_PROMPT}${opts.tailKept ? TAIL_NOTE : ""}`;
    const room = inputLimit - estimateTextTokens(head + tail) - 32;
    if (room < 1) throw new Error("compaction summary leaves no room for the conversation in this model's context window");
    // Count the actual script instead of assuming a chars-per-token ratio.
    let low = 0;
    let high = transcript.length - offset;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (estimateTextTokens(transcript.slice(offset, offset + middle)) <= room) low = middle;
      else high = middle - 1;
    }
    const endCode = low ? transcript.charCodeAt(offset + low - 1) : 0;
    if (endCode >= 0xd800 && endCode <= 0xdbff && offset + low < transcript.length) low--;
    if (!low) throw new Error("model context window is too small for session compaction");
    const prompt = head + transcript.slice(offset, offset + low) + tail;
    if (estimateTextTokens(prompt) + 32 > inputLimit) throw new Error("compaction request exceeds its input budget");
    const out = (await opts.generate(prompt, maxTokens)).trim();
    if (!out) throw new Error("compaction produced no summary (check that a model is configured)");
    summary = out;
    offset += low;
    chunks++;
  }
  return { summary, chunks };
}
