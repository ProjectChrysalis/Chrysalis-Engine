/** Shapes of agent-prompts.json, shared with the shell and the agent UI (types only there: the shell builds from its own folder). */
export type PromptPlacement = "system" | "message";

/** The parts of the agent's own system prompt, in their default order. */
export const BUILTIN_SECTIONS = ["base", "apps", "app", "docs", "notes", "persona", "mode"] as const;
export type BuiltinSection = (typeof BUILTIN_SECTIONS)[number];

/** Parts the agent cannot work without: the tool guide and the current mode. */
export const LOCKED_SECTIONS: readonly BuiltinSection[] = ["base", "mode"];

export interface AgentPrompt {
  id: string;
  name: string;
  enabled: boolean;
  placement: PromptPlacement;
  content: string;
  /** Set on an entry that stands for one part of the agent's own prompt; its text comes from the engine. */
  builtin?: BuiltinSection;
}

export interface AgentPromptPreset {
  id: string;
  name: string;
  prompts: AgentPrompt[];
}

export interface AgentPromptsFile {
  active: string;
  presets: AgentPromptPreset[];
}

