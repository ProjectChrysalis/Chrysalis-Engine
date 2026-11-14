/** Shapes of agent-prompts.json, shared with the shell and the agent UI. */
export type PromptPlacement = "system" | "message";

export interface AgentPrompt {
  id: string;
  name: string;
  enabled: boolean;
  placement: PromptPlacement;
  content: string;
}

export interface AgentPromptPreset {
  id: string;
  name: string;
  prompts: AgentPrompt[];
}

export interface AgentPromptsFile {
  active: string | null;
  presets: AgentPromptPreset[];
}
