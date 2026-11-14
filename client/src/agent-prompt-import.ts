import type { AgentPrompt, AgentPromptPreset } from "../../src/agent/prompt-preset-types"

const newId = () => crypto.randomUUID()

/** Prompts placed after the chat history, which ride each message here. */
const AFTER_HISTORY = new Set(["jailbreak", "postHistoryInstructions"])

/**
 * A prompt preset from a JSON file: one exported from here, or a roleplay
 * preset with a `prompts` list and a `prompt_order`. Roleplay prompts with
 * text become prompts here, in their order and with their on/off state;
 * empty placeholders (character card, world info, chat history) are left out.
 */
export function importPromptPreset(json: unknown, fallbackName: string): AgentPromptPreset | null {
  if (!json || typeof json !== "object") return null
  const raw = json as { name?: unknown; prompts?: unknown; prompt_order?: unknown }
  if (!Array.isArray(raw.prompts)) return null
  const name = (typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fallbackName).slice(0, 120)
  const items = raw.prompts.filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
  if (items.every((p) => p.placement === "system" || p.placement === "message")) {
    const prompts = items.flatMap((p): AgentPrompt[] => typeof p.content === "string" ? [{
      id: newId(), name: typeof p.name === "string" ? p.name.slice(0, 120) : "", enabled: p.enabled !== false,
      placement: p.placement === "message" ? "message" : "system", content: p.content.slice(0, 32_000),
    }] : [])
    return { id: newId(), name, prompts }
  }
  const orders = Array.isArray(raw.prompt_order) ? raw.prompt_order.filter((o): o is { character_id?: unknown; order?: unknown } => !!o && typeof o === "object") : []
  const order = (orders.find((o) => o.character_id === 100001) ?? orders.find((o) => o.character_id === 100000) ?? orders[0])?.order
  const listed = Array.isArray(order) ? order.filter((o): o is { identifier: string; enabled?: unknown } => !!o && typeof o === "object" && typeof (o as { identifier?: unknown }).identifier === "string") : []
  const byId = new Map(items.map((p) => [String(p.identifier ?? ""), p]))
  const sequence = [
    ...listed.map((o) => ({ prompt: byId.get(o.identifier), enabled: o.enabled !== false })),
    ...items.filter((p) => !listed.some((o) => o.identifier === p.identifier)).map((prompt) => ({ prompt, enabled: !listed.length && prompt.enabled !== false })),
  ]
  const prompts: AgentPrompt[] = []
  for (const { prompt, enabled } of sequence) {
    if (!prompt || typeof prompt.content !== "string" || !prompt.content.trim()) continue
    const id = String(prompt.identifier ?? "")
    const afterHistory = AFTER_HISTORY.has(id) || (prompt.injection_position === 1 && Number(prompt.injection_depth ?? 0) === 0)
    prompts.push({
      id: newId(),
      name: (typeof prompt.name === "string" ? prompt.name : id).slice(0, 120),
      enabled,
      placement: afterHistory ? "message" : "system",
      content: prompt.content.slice(0, 32_000),
    })
  }
  return prompts.length ? { id: newId(), name, prompts: prompts.slice(0, 100) } : null
}
