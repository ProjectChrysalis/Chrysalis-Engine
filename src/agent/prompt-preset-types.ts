/** Shapes of agent-prompts.json, shared with the shell and the agent UI (types only there: the shell builds from its own folder). */
export type PromptPlacement = "system" | "message";

/** Dynamic parts of the agent's prompt, filled in when a conversation starts. */
export const MARKERS = ["shell", "apps", "app", "docs", "notes", "persona", "mode"] as const;
export type Marker = (typeof MARKERS)[number];

/** The agent's main prompt: plain text the user may rewrite. */
export const MAIN = "base";
export type BuiltinSection = typeof MAIN | Marker;

/** The default order of the agent's own entries. */
export const BUILTIN_SECTIONS: readonly BuiltinSection[] = [MAIN, ...MARKERS];

/** Parts the agent cannot work without: Plan mode depends on the mode part. */
export const LOCKED_SECTIONS: readonly BuiltinSection[] = ["mode"];

/** Macro name in prompt text ({{name}}) for each marker's content. */
export const MARKER_MACROS: Record<Marker, string> = {
  shell: "shell",
  apps: "apps",
  app: "skills",
  docs: "rules",
  notes: "notes",
  persona: "instructions",
  mode: "mode",
};

export interface AgentPrompt {
  id: string;
  name: string;
  enabled: boolean;
  placement: PromptPlacement;
  /** The prompt's text. On the main prompt, "" means the text as it ships, which follows engine updates. */
  content: string;
  /** Set on the agent's own entries: the main prompt or a marker. */
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
