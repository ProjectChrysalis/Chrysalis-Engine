/**
 * Helpers (opt in, Settings > Agent > Tools): the agent hands a side job,
 * such as a search across many files or a question about one app, to a
 * short-lived agent that can only read, and gets back its answer alone. The
 * reading stays out of the conversation's context.
 *
 * Every helper in a conversation opens with the same prompt and tools, so
 * the provider caches that prefix once for all of them.
 */
import fs from "node:fs";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fitContext, newTrimState } from "./context-budget.js";
import type { UserPaths } from "../paths.js";

/** What a helper may use: reads only, so any number can run at once. */
export const HELPER_TOOLS = new Set(["read_file", "grep", "tool_output", "app_inspect", "app_console", "skill_read", "skill_inspect"]);

const MAX_TOOL_CALLS = 60;

const HELPER_PROMPT = `You are a helper the main agent sent on one job in the user's Chrysalis workspace. You can read files and search; you cannot change anything, and nobody sees your work but the main agent.
- Do the job, reading only what it needs. Search with grep before opening big files, and read line ranges of them.
- Reply with what the main agent needs to act: findings, exact file paths with line numbers, the values you found. No preamble, no advice it did not ask for.
- If the job needs a change or cannot be done by reading, say so and say what you found.`;

export function helpersOn(paths: UserPaths): boolean {
  try {
    return (JSON.parse(fs.readFileSync(paths.settings, "utf8")) as { helpers?: unknown }).helpers === true;
  } catch {
    return false;
  }
}

export function helperTool(deps: {
  /** The conversation's tools; a helper takes the read-only ones. */
  tools: () => AgentTool[];
  model: () => Model<Api>;
  /** The workspace contract and the working app's instructions. */
  context: () => string;
  streamFn: StreamFn;
  spill: (text: string) => string;
}): AgentTool {
  return {
    name: "helper",
    label: "Helper",
    description:
      "Send a read-only helper on one self-contained job and get back only its answer: searching many files, checking every entry of a kind for something, or working out how an app does one thing. Use it when the reading would fill your context and you need just the result. Call it several times in one turn to run jobs in parallel. A helper cannot change files, ask the user, or see this conversation, so put everything it needs in the job, including what to report.",
    parameters: Type.Object({
      job: Type.String({ description: "The job, written so someone with no other context can do it, ending with what to report back" }),
    }),
    async execute(_id, params, signal, onUpdate) {
      const job = (params as { job: string }).job.trim();
      if (!job) throw new Error("The job is empty.");
      const model = deps.model();
      const tools = deps.tools().filter((t) => HELPER_TOOLS.has(t.name));
      const head = createInitialSystemMessage(`${HELPER_PROMPT}\n\n${deps.context()}`, tools.map(toToolDeclaration));
      const trim = newTrimState();
      let calls = 0;
      const helper = new Agent({
        initialState: { model, tools, messages: head ? [head as AgentMessage] : [] },
        streamFn: deps.streamFn,
        transformContext: async (messages) => fitContext(model, { messages }, { state: trim }).messages,
        beforeToolCall: async () => (++calls > MAX_TOOL_CALLS ? { block: true, reason: "Tool limit reached: answer with what you found.", terminate: true } : undefined),
        afterToolCall: async ({ result }) => ({ content: result.content.map((b) => (b.type === "text" ? { ...b, text: deps.spill(b.text) } : b)) }),
      });
      const stop = () => helper.abort();
      signal?.addEventListener("abort", stop, { once: true });
      const unsub = helper.subscribe((ev) => {
        if (ev.type === "tool_execution_start") onUpdate?.({ content: [{ type: "text", text: `${ev.toolName} ${JSON.stringify(ev.args ?? {}).slice(0, 160)}` }], details: { calls } });
      });
      try {
        await helper.prompt(job);
      } finally {
        unsub();
        signal?.removeEventListener("abort", stop);
      }
      signal?.throwIfAborted();
      const last = [...helper.state.messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
      if (last?.stopReason === "error") throw new Error(`The helper failed: ${last.errorMessage ?? "the provider returned an error"}`);
      const answer = last?.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (!answer) throw new Error("The helper finished without an answer.");
      return { content: [{ type: "text", text: answer }], details: { calls } };
    },
  };
}
