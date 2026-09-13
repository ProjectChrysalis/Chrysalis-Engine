/**
 * Instruct formats for text completion endpoints. A text completion server
 * takes one prompt string, so the chat has to be written out in the markers
 * the loaded model was trained on; the wrong markers make a model ramble,
 * speak for the user, or never stop.
 *
 * A format is six strings and one switch. The newline after a role header is
 * part of the prefix, so every format renders exactly as its chat template
 * would, with no separate wrap rule.
 */

export interface PromptFormat {
  /** Wraps the system block at the top of the prompt, and later system
   *  entries when the format has a system role. */
  systemPrefix: string;
  systemSuffix: string;
  userPrefix: string;
  userSuffix: string;
  assistantPrefix: string;
  assistantSuffix: string;
  /** The model has no system role: system entries after the top block are
   *  written as user turns. */
  systemAsUser: boolean;
}

export interface NamedPromptFormat extends PromptFormat {
  id: string;
  name: string;
}

const f = (id: string, name: string, v: Omit<PromptFormat, "systemAsUser"> & { systemAsUser?: boolean }): NamedPromptFormat => ({
  id,
  name,
  ...v,
  systemAsUser: v.systemAsUser ?? false,
});

const chatml = (role: string) => `<|im_start|>${role}\n`;
const llama3 = (role: string) => `<|start_header_id|>${role}<|end_header_id|>\n\n`;

export const PROMPT_FORMATS: readonly NamedPromptFormat[] = [
  f("chatml", "ChatML", {
    systemPrefix: chatml("system"), systemSuffix: "<|im_end|>\n",
    userPrefix: chatml("user"), userSuffix: "<|im_end|>\n",
    assistantPrefix: chatml("assistant"), assistantSuffix: "<|im_end|>\n",
  }),
  f("llama3", "Llama 3", {
    systemPrefix: llama3("system"), systemSuffix: "<|eot_id|>",
    userPrefix: llama3("user"), userSuffix: "<|eot_id|>",
    assistantPrefix: llama3("assistant"), assistantSuffix: "<|eot_id|>",
  }),
  f("llama4", "Llama 4", {
    systemPrefix: "<|header_start|>system<|header_end|>\n\n", systemSuffix: "<|eot|>",
    userPrefix: "<|header_start|>user<|header_end|>\n\n", userSuffix: "<|eot|>",
    assistantPrefix: "<|header_start|>assistant<|header_end|>\n\n", assistantSuffix: "<|eot|>",
  }),
  f("llama2", "Llama 2", {
    systemPrefix: "[INST] <<SYS>>\n", systemSuffix: "\n<</SYS>> Understood. [/INST]\n",
    userPrefix: "[INST] ", userSuffix: " [/INST]\n",
    assistantPrefix: "", assistantSuffix: "\n",
    systemAsUser: true,
  }),
  f("mistral-v7-tekken", "Mistral V7 Tekken", {
    systemPrefix: "[SYSTEM_PROMPT]", systemSuffix: "[/SYSTEM_PROMPT]",
    userPrefix: "[INST]", userSuffix: "[/INST]",
    assistantPrefix: "", assistantSuffix: "</s>",
  }),
  f("mistral-v7", "Mistral V7", {
    systemPrefix: "[SYSTEM_PROMPT] ", systemSuffix: "[/SYSTEM_PROMPT]",
    userPrefix: "[INST] ", userSuffix: "[/INST]",
    assistantPrefix: " ", assistantSuffix: "</s>",
  }),
  f("mistral-v3-tekken", "Mistral V3 Tekken", {
    systemPrefix: "[INST]", systemSuffix: "[/INST]Understood.</s>",
    userPrefix: "[INST]", userSuffix: "",
    assistantPrefix: "[/INST]", assistantSuffix: "</s>",
    systemAsUser: true,
  }),
  f("mistral-v2", "Mistral V2 and V3", {
    systemPrefix: "[INST] ", systemSuffix: "[/INST] Understood.</s>",
    userPrefix: "[INST] ", userSuffix: "",
    assistantPrefix: "[/INST] ", assistantSuffix: "</s>",
    systemAsUser: true,
  }),
  f("gemma", "Gemma 2 and 3", {
    systemPrefix: "<start_of_turn>user\n", systemSuffix: "<end_of_turn>\n",
    userPrefix: "<start_of_turn>user\n", userSuffix: "<end_of_turn>\n",
    assistantPrefix: "<start_of_turn>model\n", assistantSuffix: "<end_of_turn>\n",
    systemAsUser: true,
  }),
  f("gemma4", "Gemma 4", {
    systemPrefix: "<|turn>system\n", systemSuffix: "<turn|>\n",
    userPrefix: "<|turn>user\n", userSuffix: "<turn|>\n",
    assistantPrefix: "<|turn>model\n", assistantSuffix: "<turn|>\n",
  }),
  f("command-r", "Command R", {
    systemPrefix: "<|START_OF_TURN_TOKEN|><|SYSTEM_TOKEN|>", systemSuffix: "<|END_OF_TURN_TOKEN|>",
    userPrefix: "<|START_OF_TURN_TOKEN|><|USER_TOKEN|>", userSuffix: "<|END_OF_TURN_TOKEN|>",
    assistantPrefix: "<|START_OF_TURN_TOKEN|><|CHATBOT_TOKEN|>", assistantSuffix: "<|END_OF_TURN_TOKEN|>",
  }),
  f("phi", "Phi", {
    systemPrefix: "<|system|>\n", systemSuffix: "<|end|>\n",
    userPrefix: "<|user|>\n", userSuffix: "<|end|>\n",
    assistantPrefix: "<|assistant|>\n", assistantSuffix: "<|end|>\n",
  }),
  f("glm4", "GLM 4", {
    systemPrefix: "[gMASK]<sop><|system|>\n", systemSuffix: "",
    userPrefix: "<|user|>\n", userSuffix: "",
    assistantPrefix: "<|assistant|>\n", assistantSuffix: "",
    systemAsUser: true,
  }),
  f("deepseek", "DeepSeek", {
    systemPrefix: "", systemSuffix: "",
    userPrefix: "<｜User｜>", userSuffix: "",
    assistantPrefix: "<｜Assistant｜>", assistantSuffix: "<｜end▁of▁sentence｜>",
    systemAsUser: true,
  }),
  f("kimi", "Kimi", {
    systemPrefix: "<|im_system|>system<|im_middle|>", systemSuffix: "<|im_end|>",
    userPrefix: "<|im_user|>user<|im_middle|>", userSuffix: "<|im_end|>",
    assistantPrefix: "<|im_assistant|>assistant<|im_middle|>", assistantSuffix: "<|im_end|>",
  }),
  f("harmony", "gpt-oss (Harmony)", {
    systemPrefix: "<|start|>developer<|message|>", systemSuffix: "<|end|>",
    userPrefix: "<|start|>user<|message|>", userSuffix: "<|end|>",
    assistantPrefix: "<|start|>assistant<|channel|>final<|message|>", assistantSuffix: "<|end|>",
  }),
  f("tulu", "Tulu", {
    systemPrefix: "<|system|>\n", systemSuffix: "\n",
    userPrefix: "<|user|>\n", userSuffix: "\n",
    assistantPrefix: "<|assistant|>\n", assistantSuffix: "<|end_of_text|>\n",
  }),
  f("metharme", "Metharme (Pygmalion)", {
    systemPrefix: "<|system|>", systemSuffix: "",
    userPrefix: "<|user|>", userSuffix: "",
    assistantPrefix: "<|model|>", assistantSuffix: "",
  }),
  f("alpaca", "Alpaca", {
    systemPrefix: "", systemSuffix: "\n\n",
    userPrefix: "### Instruction:\n", userSuffix: "\n\n",
    assistantPrefix: "### Response:\n", assistantSuffix: "\n\n",
    systemAsUser: true,
  }),
  f("vicuna", "Vicuna", {
    systemPrefix: "", systemSuffix: "\n\n",
    userPrefix: "USER: ", userSuffix: "\n",
    assistantPrefix: "ASSISTANT: ", assistantSuffix: "</s>\n",
    systemAsUser: true,
  }),
];

export function promptFormatById(id: string): NamedPromptFormat | undefined {
  return PROMPT_FORMATS.find((x) => x.id === id);
}

const FIELDS = ["systemPrefix", "systemSuffix", "userPrefix", "userSuffix", "assistantPrefix", "assistantSuffix"] as const;
const FIELD_MAX = 400;

/** A custom format from untrusted input (a connection file, an app request),
 *  or null when it is not one. */
export function parsePromptFormat(raw: unknown): PromptFormat | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out = { systemAsUser: r.systemAsUser === true } as PromptFormat;
  for (const k of FIELDS) {
    const v = r[k] ?? "";
    if (typeof v !== "string" || v.length > FIELD_MAX) return null;
    out[k] = v;
  }
  if (!out.userPrefix && !out.assistantPrefix) return null;
  return out;
}

/**
 * Markers that identify a chat template, most specific first: several
 * families share a marker ("[INST]", "<|user|>") and only a second one tells
 * them apart.
 */
const TEMPLATE_MARKERS: readonly [string, (t: string) => boolean][] = [
  ["kimi", (t) => t.includes("<|im_user|>")],
  ["harmony", (t) => t.includes("<|start|>") && t.includes("<|channel|>")],
  ["llama4", (t) => t.includes("<|header_start|>")],
  ["llama3", (t) => t.includes("<|start_header_id|>")],
  ["gemma4", (t) => t.includes("<|turn>")],
  ["gemma", (t) => t.includes("<start_of_turn>")],
  ["mistral-v7", (t) => t.includes("[SYSTEM_PROMPT] ") || (t.includes("[SYSTEM_PROMPT]") && t.includes("[INST] "))],
  ["mistral-v7-tekken", (t) => t.includes("[SYSTEM_PROMPT]")],
  ["llama2", (t) => t.includes("[INST]") && t.includes("<<SYS>>")],
  ["mistral-v2", (t) => t.includes("[INST] ")],
  ["mistral-v3-tekken", (t) => t.includes("[INST]")],
  ["command-r", (t) => t.includes("<|START_OF_TURN_TOKEN|>")],
  ["deepseek", (t) => t.includes("<｜User｜>")],
  ["glm4", (t) => t.includes("[gMASK]")],
  ["chatml", (t) => t.includes("<|im_start|>")],
  ["phi", (t) => t.includes("<|assistant|>") && t.includes("<|end|>")],
  ["tulu", (t) => t.includes("<|assistant|>") && t.includes("<|end_of_text|>")],
  ["metharme", (t) => t.includes("<|model|>")],
  ["alpaca", (t) => t.includes("### Instruction")],
  ["vicuna", (t) => t.includes("ASSISTANT:")],
];

/** The format a model's own chat template (Jinja or Go) is written in. */
export function formatFromTemplate(template: string): string | null {
  if (!template.trim()) return null;
  return TEMPLATE_MARKERS.find(([, test]) => test(template))?.[0] ?? null;
}

/** Model names that give the family away, for servers that do not report
 *  the template. Finetunes usually keep their base's name, and the ones that
 *  do not are why this is only the fallback. */
const NAME_HINTS: readonly [string, RegExp][] = [
  ["harmony", /gpt-?oss/i],
  ["kimi", /kimi|moonshot/i],
  ["llama4", /llama-?4/i],
  ["llama3", /llama-?3/i],
  ["llama2", /llama-?2/i],
  ["gemma4", /gemma-?4/i],
  ["gemma", /gemma/i],
  ["mistral-v3-tekken", /nemo/i],
  ["mistral-v7-tekken", /mistral-small-(?:3|24b)|magistral|devstral|-25(?:01|03|06|07)/i],
  ["mistral-v7", /mistral-large-2411|pixtral-large/i],
  ["mistral-v2", /mistral|mixtral/i],
  ["command-r", /command-?[ra]|c4ai|aya/i],
  ["phi", /phi-?[34]/i],
  ["glm4", /glm-?4/i],
  ["deepseek", /deepseek/i],
  ["tulu", /tulu/i],
  ["metharme", /pygmalion|metharme/i],
  ["chatml", /qwen|hermes|yi-|dolphin|chatml|magnum|intern|smollm/i],
];

export function formatFromModelName(modelId: string): string | null {
  return NAME_HINTS.find(([, re]) => re.test(modelId))?.[0] ?? null;
}

export interface Turn {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Write the chat as one prompt. The leading system entries (and the separate
 * system prompt) form the top block; later system entries keep their place.
 * The prompt ends on an open assistant turn: a trailing assistant entry is
 * that turn (a prefill or a continue), otherwise `prefill` starts it.
 */
export function renderPrompt(format: PromptFormat, systemPrompt: string | undefined, messages: readonly Turn[], prefill?: string): string {
  const top: string[] = [];
  if (systemPrompt?.trim()) top.push(systemPrompt.trim());
  let i = 0;
  for (; i < messages.length && messages[i]!.role === "system"; i++) {
    const text = messages[i]!.content.trim();
    if (text) top.push(text);
  }
  const rest = messages.slice(i);
  const last = rest[rest.length - 1];
  const open = last?.role === "assistant" ? last.content : prefill;
  const closed = last?.role === "assistant" ? rest.slice(0, -1) : rest;

  let prompt = top.length ? format.systemPrefix + top.join("\n\n") + format.systemSuffix : "";
  for (const m of closed) {
    if (m.role === "assistant") prompt += format.assistantPrefix + m.content + format.assistantSuffix;
    else if (m.role === "user" || format.systemAsUser) prompt += format.userPrefix + m.content + format.userSuffix;
    else if (m.content.trim()) prompt += format.systemPrefix + m.content + format.systemSuffix;
  }
  // a trailing space in the header would be a token the model never saw
  // before its own first word
  return prompt + (open ? format.assistantPrefix + open : format.assistantPrefix.replace(/ +$/, ""));
}

/** Where the model should stop: the end of its own turn, or the start of a
 *  turn that is not its own. */
export function stopStrings(format: PromptFormat): string[] {
  const out = [format.assistantSuffix, format.userPrefix, format.systemAsUser ? "" : format.systemPrefix]
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(out)];
}
