import { YAML } from "bun";
import instructions from "./builtin-skills/chrysalis-docs/SKILL.md" with { type: "text" };
import overview from "./builtin-skills/chrysalis-docs/references/overview.md" with { type: "text" };
import settings from "./builtin-skills/chrysalis-docs/references/settings.md" with { type: "text" };
import apps from "./builtin-skills/chrysalis-docs/references/apps.md" with { type: "text" };
import plugins from "./builtin-skills/chrysalis-docs/references/plugins.md" with { type: "text" };
import agent from "./builtin-skills/chrysalis-docs/references/agent.md" with { type: "text" };
import troubleshooting from "./builtin-skills/chrysalis-docs/references/troubleshooting.md" with { type: "text" };

const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(instructions)!;
const meta = YAML.parse(header[1]!) as { name: string; description: string };

// Text imports keep documentation available offline in compiled and npm builds.
export const engineSkills = [{
  ...meta,
  scope: "engine" as const,
  file: `engine-skills/${meta.name}/SKILL.md`,
  body: header[2]!.trim(),
  resources: {
    "references/overview.md": overview,
    "references/settings.md": settings,
    "references/apps.md": apps,
    "references/plugins.md": plugins,
    "references/agent.md": agent,
    "references/troubleshooting.md": troubleshooting,
  } as Record<string, string>,
}];

export function readEngineSkillResource(name: string, resource: string): string {
  const skill = engineSkills.find(s => s.name === name);
  const text = skill && Object.hasOwn(skill.resources, resource) ? skill.resources[resource] : undefined;
  if (text === undefined) throw new Error("Engine skill resource not found");
  return text;
}

export function engineSkillsLoaded(loaded: readonly string[]): string[] {
  return loaded.filter(name => engineSkills.some(skill => skill.name === name));
}
