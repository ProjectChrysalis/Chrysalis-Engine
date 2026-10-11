/**
 * The model routes in the request and reply shapes most chat programs already
 * speak (model list, chat completions with or without a stream), for programs
 * that cannot be taught the engine's own /v1/llm shape: a service app's
 * server, a script, a desktop client.
 *
 * A request is one provider turn. Images in user messages go to the model;
 * tools the caller offers are offered to the model, and a tool call comes
 * back to the caller to run and answer in its next request. Nothing is run
 * here. Text-completion connections have no such turn: they get the text of
 * the conversation and nothing else.
 */
import type { Api, AssistantMessage, AssistantMessageEvent, Context, ImageContent, Message, Model, TextContent, Tool, ToolCall, Usage } from "@earendil-works/pi-ai";
import { ModelNotConfiguredError, zeroUsage, type GenerateRequest, type ModelInfo, type UserModelService } from "./models.js";

/** Stands for "whatever the account's default model is". */
export const DEFAULT_MODEL_ID = "default";

export interface ChatCompletionBody {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  stream_options?: { include_usage?: unknown } | null;
  temperature?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  reasoning_effort?: unknown;
  [key: string]: unknown;
}

/** Keys passed through to the provider untouched when present. */
const PASSED_KEYS = ["top_p", "top_k", "top_a", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty", "seed", "stop", "response_format", "logit_bias", "parallel_tool_calls"];
const REASONING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const IMAGE_DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

export function modelList(models: ModelInfo[]): { object: "list"; data: { id: string; object: "model"; created: number; owned_by: string }[] } {
  const row = (id: string, owner: string) => ({ id, object: "model" as const, created: 0, owned_by: owner });
  return {
    object: "list",
    data: [row(DEFAULT_MODEL_ID, "chrysalis"), ...models.map((m) => row(`${m.provider}/${m.modelId}`, m.connectionName ?? m.provider))],
  };
}

export function errorOf(message: string, type = "invalid_request_error"): { error: { message: string; type: string; code: null; param: null } } {
  return { error: { message, type, code: null, param: null } };
}

// ---------- the request ----------

type Part = TextContent | ImageContent;
type Turn =
  | { role: "system"; text: string }
  | { role: "user"; parts: Part[] }
  | { role: "assistant"; text: string; calls: ToolCall[] }
  | { role: "tool"; id: string; name: string; text: string };

export interface ChatRequest {
  model: string | null;
  stream: boolean;
  includeUsage: boolean;
  turns: Turn[];
  tools: Tool[];
  toolChoice: "auto" | "none" | "required" | { name: string } | undefined;
  temperature?: number;
  maxTokens?: number;
  params: Record<string, unknown>;
  reasoning?: GenerateRequest["reasoning"];
}

function partsOf(content: unknown): Part[] | string {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (content === null || content === undefined) return [];
  if (!Array.isArray(content)) return "content must be text or a list of parts";
  const out: Part[] = [];
  for (const raw of content) {
    const p = raw as { type?: unknown; text?: unknown; image_url?: unknown } | null;
    if (!p || typeof p.type !== "string") return "content parts need a type";
    if (p.type === "text" || p.type === "input_text") {
      if (typeof p.text === "string" && p.text) out.push({ type: "text", text: p.text });
    } else if (p.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : (p.image_url as { url?: unknown } | null)?.url;
      const m = typeof url === "string" ? IMAGE_DATA_URL.exec(url) : null;
      // a link would have the engine fetch whatever address the caller names
      if (!m) return "image_url: send the image itself as a base64 data: URL";
      out.push({ type: "image", mimeType: m[1]!.toLowerCase(), data: m[2]!.replace(/\s+/g, "") });
    } else {
      return `content part "${p.type}" is not supported`;
    }
  }
  return out;
}

const textOf = (parts: Part[]): string => parts.filter((p): p is TextContent => p.type === "text").map((p) => p.text).join("\n");

/** A chat completion body as a request the engine can run, or the reason it
 *  is not one. */
export function parseChatRequest(body: ChatCompletionBody): ChatRequest | { error: string } {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return { error: "messages: a non-empty array is required" };
  const turns: Turn[] = [];
  const callNames = new Map<string, string>();
  for (const raw of body.messages) {
    const m = raw as { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown; name?: unknown } | null;
    if (!m || typeof m.role !== "string") return { error: "messages: every entry needs a role" };
    const parts = partsOf(m.content);
    if (typeof parts === "string") return { error: `messages: ${parts}` };
    if (m.role === "system" || m.role === "developer") {
      turns.push({ role: "system", text: textOf(parts) });
    } else if (m.role === "user" || m.role === "function") {
      turns.push({ role: "user", parts });
    } else if (m.role === "assistant") {
      const calls: ToolCall[] = [];
      for (const rawCall of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const c = rawCall as { id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
        if (!c || typeof c.id !== "string" || typeof c.function?.name !== "string") return { error: "messages: a tool call needs an id and a function name" };
        let args: unknown = {};
        if (typeof c.function.arguments === "string" && c.function.arguments.trim()) {
          try { args = JSON.parse(c.function.arguments); } catch { return { error: `messages: the arguments of tool call ${c.id} are not JSON` }; }
        }
        calls.push({ type: "toolCall", id: c.id, name: c.function.name, arguments: (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as ToolCall["arguments"] });
        callNames.set(c.id, c.function.name);
      }
      turns.push({ role: "assistant", text: textOf(parts), calls });
    } else if (m.role === "tool") {
      if (typeof m.tool_call_id !== "string") return { error: "messages: a tool message needs a tool_call_id" };
      turns.push({ role: "tool", id: m.tool_call_id, name: callNames.get(m.tool_call_id) ?? (typeof m.name === "string" ? m.name : "tool"), text: textOf(parts) });
    } else {
      return { error: `messages: unknown role "${m.role}"` };
    }
  }

  const tools: Tool[] = [];
  for (const raw of Array.isArray(body.tools) ? body.tools : []) {
    const t = raw as { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } } | null;
    if (!t || t.type !== "function" || typeof t.function?.name !== "string") return { error: "tools: only function tools with a name are supported" };
    const parameters = t.function.parameters && typeof t.function.parameters === "object" ? t.function.parameters : { type: "object", properties: {} };
    tools.push({ name: t.function.name, description: typeof t.function.description === "string" ? t.function.description : "", parameters: parameters as Tool["parameters"] });
  }
  const choice = body.tool_choice as string | { function?: { name?: unknown } } | undefined | null;
  const named = choice && typeof choice === "object" && typeof choice.function?.name === "string" ? { name: choice.function.name } : undefined;
  const toolChoice = !tools.length ? undefined : named ?? (choice === "auto" || choice === "none" || choice === "required" ? choice : undefined);

  const params: Record<string, unknown> = {};
  for (const k of PASSED_KEYS) {
    if (body[k] !== undefined && body[k] !== null) params[k] = body[k];
  }
  const maxTokens = typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : typeof body.max_tokens === "number" ? body.max_tokens : undefined;
  const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : "";
  return {
    model: typeof body.model === "string" && body.model && body.model !== DEFAULT_MODEL_ID ? body.model : null,
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
    turns,
    tools,
    toolChoice,
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    params,
    ...(REASONING_LEVELS.has(effort) ? { reasoning: effort as GenerateRequest["reasoning"] } : effort === "none" ? { reasoning: "off" as const } : {}),
  };
}

/** The provider context for a model. Only the leading run of system turns is
 *  the system prompt; one further down keeps its place and speaks as the
 *  user, since where it sits is what it means. */
export function contextFor(req: ChatRequest, model: Pick<Model<Api>, "api" | "provider" | "id">): { context: Context; toolChoice?: unknown } {
  let lead = 0;
  const system: string[] = [];
  while (lead < req.turns.length && req.turns[lead]!.role === "system") {
    const t = req.turns[lead] as Extract<Turn, { role: "system" }>;
    if (t.text.trim()) system.push(t.text);
    lead++;
  }
  const now = Date.now();
  const messages: Message[] = [];
  for (const t of req.turns.slice(lead)) {
    if (t.role === "system") {
      if (t.text.trim()) messages.push({ role: "user", content: t.text, timestamp: now });
    } else if (t.role === "user") {
      messages.push({ role: "user", content: t.parts.some((p) => p.type === "image") ? t.parts : textOf(t.parts), timestamp: now });
    } else if (t.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [...(t.text ? [{ type: "text" as const, text: t.text }] : []), ...t.calls],
        api: model.api, provider: model.provider, model: model.id,
        usage: zeroUsage(), stopReason: t.calls.length ? "toolUse" : "stop", timestamp: now,
      });
    } else {
      messages.push({ role: "toolResult", toolCallId: t.id, toolName: t.name, content: [{ type: "text", text: t.text }], isError: false, timestamp: now });
    }
  }
  // "must call a tool" and "call this one" are spelled differently per API;
  // where there is no spelling the model is left to choose
  const c = req.toolChoice;
  const openai = model.api === "openai-completions" || model.api === "openai-responses";
  const toolChoice = c === undefined ? undefined
    : c === "auto" || c === "none" ? c
    : c === "required" ? (openai ? "required" : model.api === "anthropic-messages" ? { type: "any" } : undefined)
    : openai ? { type: "function", function: { name: c.name } } : model.api === "anthropic-messages" ? { type: "tool", name: c.name } : undefined;
  return {
    context: { ...(system.length ? { systemPrompt: system.join("\n\n") } : {}), messages, ...(req.tools.length ? { tools: req.tools } : {}) },
    ...(toolChoice !== undefined ? { toolChoice } : {}),
  };
}

/** The same conversation as text alone, for connections that take nothing else. */
export function textRequest(req: ChatRequest): GenerateRequest {
  const presetParams = {
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(Object.keys(req.params).length ? { params: req.params } : {}),
  };
  return {
    messages: req.turns.map((t) => t.role === "system" ? { role: "system" as const, content: t.text }
      : t.role === "user" ? { role: "user" as const, content: textOf(t.parts) }
      : t.role === "assistant" ? { role: "assistant" as const, content: t.text }
      : { role: "user" as const, content: t.text }),
    model: req.model,
    ...(Object.keys(presetParams).length ? { presetParams } : {}),
    ...(req.reasoning ? { reasoning: req.reasoning } : {}),
  };
}

// ---------- the reply ----------

type Finish = "stop" | "length" | "tool_calls";
interface Sink {
  text(delta: string): void;
  thinking(delta: string): void;
  call(call: ToolCall): void;
  done(finish: Finish, model: string, usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): void;
  fail(message: string): void;
}

const usageOf = (u: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">) => {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return { prompt_tokens: prompt, completion_tokens: u.output, total_tokens: prompt + u.output };
};
const callOf = (c: ToolCall, index?: number) => ({
  ...(index === undefined ? {} : { index }),
  id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
});

async function relay(stream: AsyncIterable<AssistantMessageEvent>, model: Model<Api>, sink: Sink): Promise<void> {
  const ref = `${model.provider}/${model.id}`;
  for await (const ev of stream) {
    if (ev.type === "text_delta") sink.text(ev.delta);
    else if (ev.type === "thinking_delta") sink.thinking(ev.delta);
    else if (ev.type === "toolcall_end") sink.call(ev.toolCall);
    else if (ev.type === "done") sink.done(ev.reason === "toolUse" ? "tool_calls" : ev.reason === "length" ? "length" : "stop", ref, ev.message.usage);
    else if (ev.type === "error") {
      const failed: AssistantMessage = ev.error;
      // the caller hung up: what was written so far is the whole reply
      if (ev.reason === "aborted") sink.done("stop", ref, failed.usage);
      else sink.fail(failed.errorMessage ?? "the provider returned an error");
    }
  }
}

/** Answer one chat completion request. */
export async function chatCompletions(models: UserModelService, body: ChatCompletionBody, signal: AbortSignal, source: string): Promise<Response> {
  const req = parseChatRequest(body);
  if ("error" in req) return Response.json(errorOf(req.error), { status: 400 });
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  // settled before the first byte, so "no model set up" is a status, not a
  // line in a stream
  let run: (sink: Sink) => Promise<void>;
  try {
    const turn = await models.turn({
      model: req.model, build: (model) => contextFor(req, model), signal, source,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(Object.keys(req.params).length ? { params: req.params } : {}),
      ...(req.reasoning ? { reasoning: req.reasoning } : {}),
    });
    run = turn
      ? (sink) => relay(turn.stream, turn.model, sink)
      : async (sink) => {
        const result = await models.generate({ ...textRequest(req), source, signal }, (d) => sink.text(d), (d) => sink.thinking(d));
        if (result.model === "error") sink.fail(result.error ?? "the model returned nothing");
        else sink.done("stop", result.model, result.usage);
      };
  } catch (e) {
    return e instanceof ModelNotConfiguredError
      ? Response.json(errorOf(e.message, "model_not_configured"), { status: 503 })
      : Response.json(errorOf((e as Error).message, "upstream_error"), { status: 502 });
  }

  if (!req.stream) {
    let text = "";
    let thinking = "";
    const calls: ToolCall[] = [];
    let reply: Response | null = null;
    const sink: Sink = {
      text: (d) => { text += d; },
      thinking: (d) => { thinking += d; },
      call: (c) => { calls.push(c); },
      done: (finish, model, usage) => {
        reply = Response.json({
          id, object: "chat.completion", created, model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: text || (calls.length ? null : ""),
              ...(thinking ? { reasoning_content: thinking } : {}),
              ...(calls.length ? { tool_calls: calls.map((c) => callOf(c)) } : {}),
            },
            finish_reason: finish,
          }],
          usage: usageOf(usage),
        });
      },
      fail: (message) => { reply = Response.json(errorOf(message, "upstream_error"), { status: 502 }); },
    };
    try { await run(sink); } catch (e) { sink.fail((e as Error).message); }
    return reply ?? Response.json(errorOf("the model returned nothing", "upstream_error"), { status: 502 });
  }

  const label = req.model ?? DEFAULT_MODEL_ID;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      let open = true;
      const write = (line: string) => {
        if (!open) return;
        try { controller.enqueue(enc.encode(line)); } catch { open = false; }
      };
      const chunk = (delta: Record<string, unknown>, finish: Finish | null = null, model = label) =>
        write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      // a model can think for minutes before its first word
      const beat = setInterval(() => write(": waiting\n\n"), 15_000);
      let calls = 0;
      const sink: Sink = {
        text: (d) => chunk({ content: d }),
        thinking: (d) => chunk({ reasoning_content: d }),
        // whole, in one piece: a caller that joins pieces by index gets the same call
        call: (c) => chunk({ tool_calls: [callOf(c, calls++)] }),
        done: (finish, model, usage) => {
          chunk({}, finish, model);
          if (req.includeUsage) write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: usageOf(usage) })}\n\n`);
        },
        fail: (message) => write(`data: ${JSON.stringify(errorOf(message, "upstream_error"))}\n\n`),
      };
      chunk({ role: "assistant", content: "" });
      try { await run(sink); } catch (e) { sink.fail((e as Error).message); }
      clearInterval(beat);
      write("data: [DONE]\n\n");
      try { controller.close(); } catch { /* the caller left */ }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" } });
}
