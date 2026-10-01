/**
 * Context budget for the built-in agent.
 *
 * pi-ai clamps max_tokens to "window − estimate − 4096" with a chars/4
 * estimate. That undercounts Cyrillic, CJK and JSON-heavy tool traffic, and
 * a strict endpoint (OpenRouter, vLLM, llama.cpp…) then rejects the request
 * because input + max_tokens > window. Nothing else bounds a single run
 * either: a long task with big tool results grows until the provider refuses.
 *
 * This module estimates conservatively, caps the requested output, and trims
 * old bulk (tool output, written file bodies, old reasoning) from what is SENT
 * to the model. The session record and the agent's own state are never
 * modified here: trimming is recomputed from the full history on every call.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Plain ASCII (English, code, JSON) tokenizes at roughly 3.5–4 chars. */
const ASCII_CHARS_PER_TOKEN = 3.5;
/** Latin-extended, Cyrillic, Greek…: about 2 chars on current tokenizers. */
const ALPHABETIC_CHARS_PER_TOKEN = 2;
/** CJK, emoji and the rest: close to a token per char. */
const OTHER_CHARS_PER_TOKEN = 1;
const IMAGE_TOKENS = 1600;
/** Role markers and framing each message costs on the wire. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Messages at the end of the context that trimming never touches. */
const PROTECTED_TAIL = 6;
/** Trim to this share of the input budget, so one trim lasts many calls. */
const TRIM_TARGET = 0.6;
/** Forced trim after a provider overflow: our estimate was wrong, go deep. */
const FORCED_TRIM_TARGET = 0.5;

export const TRIM_NOTICE = "[Earlier context was trimmed to fit the model's context window. Re-read files or re-run tools if you need details from before this point.]";

export interface BudgetModel {
  contextWindow?: number;
  maxTokens?: number;
}

export interface BudgetContext {
  systemPrompt?: string;
  messages: readonly AgentMessage[];
  tools?: readonly unknown[];
}

/** Conservative token estimate for a string, by script. */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let alphabetic = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) ascii++;
    else if (c < 0x2e80) alphabetic++;
    else other++;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + alphabetic / ALPHABETIC_CHARS_PER_TOKEN + other / OTHER_CHARS_PER_TOKEN);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

type Block = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

function blockTokens(b: Block): number {
  switch (b.type) {
    case "text":
      return estimateTextTokens(b.text ?? "");
    case "thinking":
      return estimateTextTokens(b.thinking ?? "");
    case "image":
      return IMAGE_TOKENS;
    case "toolCall":
      return estimateTextTokens((b.name ?? "") + safeJson(b.arguments));
    default:
      return estimateTextTokens(safeJson(b));
  }
}

export function estimateMessageTokens(m: AgentMessage): number {
  const content = (m as { content?: unknown }).content;
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  if (typeof content === "string") tokens += estimateTextTokens(content);
  else if (Array.isArray(content)) for (const b of content) tokens += blockTokens(b as Block);
  if (m.role === "system") {
    tokens += toolsTokens(m.toolsAdded);
    tokens += estimateTextTokens(safeJson(m.sections ?? {}));
    tokens += estimateTextTokens(safeJson(m.toolsRemoved ?? []));
  }
  return tokens;
}

function toolsTokens(tools: readonly unknown[] | undefined): number {
  if (!tools?.length) return 0;
  return estimateTextTokens(
    safeJson(
      tools.map((t) => {
        const x = t as { name?: unknown; description?: unknown; parameters?: unknown };
        return { name: x.name, description: x.description, parameters: x.parameters };
      }),
    ),
  );
}

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

/** Provider-reported size of the context up to the last healthy reply, if any. */
function lastUsage(messages: readonly AgentMessage[]): { tokens: number; index: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string; usage?: Usage };
    if (m.role !== "assistant" || m.stopReason === "error" || m.stopReason === "aborted") continue;
    const u = m.usage;
    const tokens = u ? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0;
    // restored history carries zero usage: keep looking for a real reading
    if (tokens > 0) return { tokens, index: i };
  }
  return null;
}

/**
 * Estimate the whole request. Takes the larger of the pure estimate and the
 * provider's last reading plus what came after it: the reading is exact for
 * the prefix the provider saw, but that prefix may have been trimmed, so it
 * alone can understate the untrimmed history.
 */
export function estimateContextTokens(ctx: BudgetContext): number {
  const prefix = (ctx.systemPrompt ? estimateTextTokens(ctx.systemPrompt) : 0) + toolsTokens(ctx.tools);
  let full = prefix;
  for (const m of ctx.messages) full += estimateMessageTokens(m);
  const reading = lastUsage(ctx.messages);
  if (!reading) return full;
  let calibrated = reading.tokens;
  for (let i = reading.index + 1; i < ctx.messages.length; i++) calibrated += estimateMessageTokens(ctx.messages[i]!);
  return Math.max(full, calibrated);
}

function windowOf(model: BudgetModel): number {
  return model.contextWindow && model.contextWindow > 0 ? model.contextWindow : 0;
}

function safetyMargin(window: number): number {
  return Math.max(4096, Math.floor(window * 0.03));
}

/**
 * The most output worth asking for. Some catalogs report max output equal to
 * the whole window (a 1M model "allows" 1M of output); asking for that makes
 * input + max_tokens overflow on the first real prompt and, on metered
 * gateways, reserves credit for tokens that never come.
 */
export function outputCap(model: BudgetModel): number {
  const own = model.maxTokens && model.maxTokens > 0 ? model.maxTokens : 8192;
  const window = windowOf(model);
  if (!window) return own;
  return Math.min(own, Math.max(8192, Math.floor(window / 4)));
}

/** Room kept free for the reply when deciding whether the input fits. */
function outputReserve(model: BudgetModel): number {
  return Math.min(outputCap(model), Math.max(4096, Math.floor(windowOf(model) * 0.15)));
}

/** Input tokens a request may carry for this model; 0 when the window is unknown. */
export function inputBudget(model: BudgetModel): number {
  const window = windowOf(model);
  if (!window) return 0;
  return Math.max(1024, window - outputReserve(model) - safetyMargin(window));
}

/**
 * max_tokens for one request: the output cap, lowered to what is left of the
 * window after the (conservatively estimated) input and a safety margin.
 */
export function clampMaxTokens(model: BudgetModel, ctx: BudgetContext, requested?: number): number | undefined {
  const window = windowOf(model);
  const cap = Math.min(requested && requested > 0 ? requested : outputCap(model), outputCap(model));
  if (!window) return requested;
  const room = window - estimateContextTokens(ctx) - safetyMargin(window);
  return Math.max(1, Math.min(cap, room));
}

// ---------- trimming ----------

function clip(text: string, keep: number): string {
  if (text.length <= keep) return text;
  return `${text.slice(0, keep)}\n…[${text.length - keep} chars trimmed to save context]`;
}

function clipArgs(args: unknown, keep: number): unknown {
  if (typeof args === "string") return clip(args, keep);
  if (Array.isArray(args)) return args.map((v) => clipArgs(v, keep));
  if (args && typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) out[k] = clipArgs(v, keep);
    return out;
  }
  return args;
}

/** A lighter copy of an old message. `hard` keeps almost nothing of tool output. */
function slim(m: AgentMessage, hard: boolean): AgentMessage {
  const role = (m as { role?: string }).role;
  const content = (m as { content?: unknown }).content;
  if (!Array.isArray(content)) return m;
  if (role === "toolResult") {
    const blocks = (content as Block[]).map((b) =>
      b.type === "text" ? { ...b, text: hard ? clip(b.text ?? "", 200) : clip(b.text ?? "", 1200) } : b.type === "image" ? { type: "text", text: "[image removed to save context]" } : b,
    );
    return { ...m, content: blocks } as AgentMessage;
  }
  if (role === "assistant") {
    const blocks = (content as Block[])
      // earlier reasoning is never needed again (providers only require the
      // latest turn's thinking, which sits in the protected tail)
      .filter((b) => b.type !== "thinking")
      .map((b) => {
        if (b.type === "toolCall") return { ...b, arguments: clipArgs(b.arguments, hard ? 200 : 1200) };
        if (b.type === "text" && hard) return { ...b, text: clip(b.text ?? "", 4000) };
        return b;
      });
    // an assistant message must keep at least one block
    return { ...m, content: blocks.length ? blocks : [{ type: "text", text: "" }] } as AgentMessage;
  }
  return m;
}

function sum(tokens: number[], from = 0): number {
  let s = 0;
  for (let i = from; i < tokens.length; i++) s += tokens[i]!;
  return s;
}

/**
 * How far trimming has advanced over an agent's history. Messages before
 * `soft` are clipped, before `hard` clipped hard, before `cut` dropped.
 * Kept per agent so every call sends the SAME trimmed prefix until the
 * context outgrows the budget again: a prefix that shifts on every call
 * defeats provider prompt caching and makes the model re-read what it lost.
 */
export interface TrimState {
  soft: number;
  hard: number;
  cut: number;
  /** Usage before this index measured an older, larger request. */
  usageFrom: number;
}

export function newTrimState(): TrimState {
  return { soft: 0, hard: 0, cut: 0, usageFrom: 0 };
}

/**
 * Fit messages under the model's input budget. Returns the input unchanged
 * while it fits and nothing has been trimmed yet, or when the window is
 * unknown.
 *
 * When the context outgrows the budget the trim state advances one message
 * at a time, oldest first, never touching the protected tail or the user's
 * task, until it fits a target well under the budget (room for the calls
 * that follow):
 *  1. clip long tool output and tool arguments, drop old reasoning;
 *  2. clip them hard;
 *  3. drop the oldest messages, starting the kept history at an assistant
 *     message (so no tool result loses its call) behind a trim notice;
 *  4. still too big: clip the remaining tool results, the newest included.
 */
export function fitContext(
  model: BudgetModel,
  ctx: BudgetContext,
  opts: { force?: boolean; state?: TrimState } = {},
): { messages: AgentMessage[]; trimmed: boolean; advanced: boolean; before: number; after: number } {
  const messages = [...ctx.messages];
  const budget = inputBudget(model);
  const st = opts.state ?? newTrimState();
  // history shrank under the state (edit, compaction): start over
  if (st.soft > messages.length || st.hard > messages.length || st.cut > messages.length) Object.assign(st, newTrimState());
  const untouched = st.soft === 0 && st.hard === 0 && st.cut === 0;
  const full = estimateContextTokens(ctx);
  if (!budget || (untouched && !opts.force && full <= budget)) {
    return { messages, trimmed: false, advanced: false, before: full, after: full };
  }

  const prefix = (ctx.systemPrompt ? estimateTextTokens(ctx.systemPrompt) : 0) + toolsTokens(ctx.tools);
  const tailStart = Math.max(0, messages.length - PROTECTED_TAIL);
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string }).role === "user") {
      lastUser = i;
      break;
    }
  }
  const isSystem = (i: number) => messages[i]?.role === "system";
  const slimmable = (i: number) => i < tailStart && i !== lastUser && !isSystem(i);
  const level = (i: number) => (!slimmable(i) ? 0 : i < st.hard ? 2 : i < st.soft ? 1 : 0);
  // per-message token counts at each clip level, computed on demand
  const cache: (number | undefined)[][] = [[], [], []];
  const variant = (i: number, lv: number): AgentMessage => (lv === 0 ? messages[i]! : slim(messages[i]!, lv === 2));
  const tok = (i: number, lv = level(i)): number => (cache[lv]![i] ??= estimateMessageTokens(variant(i, lv)));
  const notice = estimateTextTokens(TRIM_NOTICE) + MESSAGE_OVERHEAD_TOKENS;
  const taskCut = () => lastUser >= 0 && lastUser < st.cut;
  const total = () => {
    let t = prefix + (st.cut > 0 ? notice + (taskCut() ? tok(lastUser, 0) : 0) : 0);
    for (let i = 0; i < st.cut; i++) if (isSystem(i)) t += tok(i, 0);
    for (let i = st.cut; i < messages.length; i++) t += tok(i);
    return t;
  };
  const build = (): AgentMessage[] => {
    const kept: AgentMessage[] = [];
    // Replay all prior instruction and tool updates before the retained history.
    for (let i = 0; i < st.cut; i++) if (isSystem(i)) kept.push(messages[i]!);
    if (st.cut > 0) kept.push(noticeMessage(taskCut() ? messages[lastUser] : undefined));
    for (let i = st.cut; i < messages.length; i++) {
      const m = variant(i, level(i));
      // A pre-trim provider reading cannot calibrate a smaller request.
      kept.push(i < st.usageFrom && m.role === "assistant" && (m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite > 0) ? { ...m, usage: { ...m.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } : m);
    }
    return kept;
  };

  let after = total();
  if (!opts.force && after <= budget) {
    // the trimmed prefix is stable, so the provider's last reading measures
    // it: trust it when it says more than our estimate
    const kept = build();
    after = Math.max(after, estimateContextTokens({ systemPrompt: ctx.systemPrompt, messages: kept, tools: ctx.tools }));
    if (after <= budget) return { messages: kept, trimmed: true, advanced: false, before: full, after };
  }

  const target = Math.floor(budget * (opts.force ? FORCED_TRIM_TARGET : TRIM_TARGET));
  const done = () => {
    st.usageFrom = messages.length;
    return { messages: build(), trimmed: true, advanced: true, before: full, after };
  };

  // passes 1–2: clip oldest first, one message at a time
  for (const key of ["soft", "hard"] as const) {
    while (after > target && st[key] < tailStart) {
      const i = st[key]++;
      if (i < st.cut || !slimmable(i)) continue;
      const lvBefore = key === "soft" ? (i < st.hard ? 2 : 0) : i < st.soft ? 1 : 0;
      const lvAfter = key === "soft" ? (i < st.hard ? 2 : 1) : 2;
      after += tok(i, lvAfter) - tok(i, lvBefore);
    }
    if (after <= target) return done();
  }

  // pass 3: cut the oldest history at an assistant message
  const lastAssistant = messages.map((m) => (m as { role?: string }).role).lastIndexOf("assistant");
  for (let cut = st.cut + 1; cut <= lastAssistant; cut++) {
    if ((messages[cut] as { role?: string }).role !== "assistant") continue;
    st.cut = cut;
    after = total();
    if (after <= target) return done();
  }

  // pass 4: what is left is recent, and still too big — usually one huge
  // tool result (a 256 KB read into a 32k window). Share what room remains
  // between the tool results, most recent included. Not kept in the state:
  // it depends on the tail, which changes every call anyway.
  st.usageFrom = messages.length;
  let work = build();
  const results = work.filter((m) => (m as { role?: string }).role === "toolResult").length;
  if (results) {
    const rest = prefix + sum(work.filter((m) => (m as { role?: string }).role !== "toolResult").map(estimateMessageTokens));
    // ≥ 1 char per token at any script this estimate knows
    const perResult = Math.max(600, Math.floor((target - rest) / results));
    work = work.map((m) => ((m as { role?: string }).role === "toolResult" ? clipResult(m, perResult) : m));
  }
  after = prefix + sum(work.map(estimateMessageTokens));
  return { messages: work, trimmed: true, advanced: true, before: full, after };
}

function clipResult(m: AgentMessage, keep: number): AgentMessage {
  const content = (m as { content?: unknown }).content;
  if (!Array.isArray(content)) return m;
  const blocks = (content as Block[]).map((b) =>
    b.type === "text" && (b.text ?? "").length > keep
      ? { ...b, text: `${clip(b.text ?? "", keep)}\n[This output did not fit the model's context window. Read it in smaller parts (offset/limit) or search it with grep.]` }
      : b,
  );
  return { ...m, content: blocks } as AgentMessage;
}

/** The user message that opens a trimmed history, carrying the task if it was cut. */
function noticeMessage(task: AgentMessage | undefined): AgentMessage {
  const taskContent = task ? (task as { content?: unknown }).content : undefined;
  const taskBlocks = typeof taskContent === "string" ? [{ type: "text", text: taskContent }] : Array.isArray(taskContent) ? taskContent : [];
  const text = task ? `${TRIM_NOTICE}\n\nThe user's current request:` : TRIM_NOTICE;
  return {
    role: "user",
    content: [{ type: "text", text }, ...taskBlocks],
    timestamp: (task as { timestamp?: number } | undefined)?.timestamp ?? Date.now(),
  } as AgentMessage;
}
