import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { UserPaths } from "../paths.js";
import { PluginSandbox } from "../plugins/sandbox.js";
import { commitWrittenPaths } from "../git.js";
import { makePathGuard } from "../sandbox/workspace.js";
import { availableSkills, type AppContext } from "./skills.js";
import { atomicText, revisionOf, recordChange, withMutation, writableFile, type FileChange } from "./changes.js";

export function buildSkillTools(p: UserPaths, username: string, context: AppContext, readOnly: boolean, authorize: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>): AgentTool[] {
  return (["inspect", ...(readOnly ? [] : ["edit"])] as const).map(kind => ({
    name: `skill_${kind}`, label: kind === "inspect" ? "Inspect app data" : "Edit app data",
    description: `Run the loaded app skill's ${kind}.js helper. Arguments follow that skill's instructions. ${kind === "edit" ? "Inspect first and pass the returned revision. Saves preserve concurrent changes and return an undo id." : "Reads only the selected app's data, including revisions. Available in Plan mode."}`,
    parameters: Type.Object({ name: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }),
    executionMode: "sequential" as const,
    async execute(_id, input, signal) {
      const { name, args } = input as { name: string; args: Record<string, unknown> };
      if (!context.appId || !context.loaded.includes(name)) throw new Error("Load the selected app's skill first");
      const skill = availableSkills(p, context.appId).skills.find(item => item.name === name);
      if (!skill || skill.scope === "engine") throw new Error("App skill helper is unavailable");
      if (Buffer.byteLength(JSON.stringify(args)) > 16384) throw new Error("Skill arguments exceed 16 KB");
      const appRoot = fs.realpathSync(path.join(p.apps, context.appId));
      const moduleFile = path.join(p.root, path.dirname(skill.file), `${kind}.js`);
      const realModule = fs.realpathSync(moduleFile);
      if (!realModule.startsWith(appRoot + path.sep) || fs.statSync(realModule).size > 32768) throw new Error("Invalid skill module");
      const dataRoot = path.join(appRoot, "data");
      const realDataRoot = fs.realpathSync(dataRoot);
      if (!realDataRoot.startsWith(appRoot + path.sep)) throw new Error("App data escapes its app");
      const dataGuard = makePathGuard(realDataRoot);
      const sandbox = new PluginSandbox();
      let result: Awaited<ReturnType<PluginSandbox["eval"]>>;
      try {
        result = await sandbox.eval({ source: fs.readFileSync(realModule, "utf8"), hook: kind, ctx: args, storeSnapshot: {}, storeAllowed: false, llmAllowed: false, fsAllowed: true, fsReadOnly: true, fsRoot: dataRoot, executionTimeoutMs: 2000, memoryLimitBytes: 32 * 1024 * 1024 });
      } finally { await sandbox.dispose(); }
      signal?.throwIfAborted();
      if (!result.ok) throw new Error(result.error ?? "Skill failed");
      if (kind === "inspect") {
        const text = JSON.stringify(result.out);
        if (Buffer.byteLength(text) > 65536) throw new Error("Skill result exceeds 64 KB. Narrow the request.");
        return { content: [{ type: "text" as const, text }], details: { skill: name } };
      }
      const plan = result.out as { writes?: unknown; result?: unknown } | null;
      if (!plan || !Array.isArray(plan.writes) || plan.writes.length < 1 || plan.writes.length > 20 || Buffer.byteLength(JSON.stringify(plan)) > 8 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(plan.result) ?? "null") > 65536) throw new Error("Invalid skill write plan");
      const seen = new Set<string>();
      const writes = plan.writes.map((value: unknown) => {
        const write = value as { path?: unknown; expectedRevision?: unknown; content?: unknown };
        if (typeof write.path !== "string" || !/\.(json|jsonl)$/.test(write.path) || typeof write.content !== "string" || Buffer.byteLength(write.content) > 1024 * 1024 || !(write.expectedRevision === null || typeof write.expectedRevision === "string")) throw new Error("Invalid skill write");
        const rel = path.posix.normalize(write.path.replaceAll("\\", "/"));
        if (rel.startsWith("../") || rel.startsWith("/") || seen.has(rel)) throw new Error("Invalid or duplicate skill path");
        seen.add(rel);
        const jsonLines = rel.endsWith(".jsonl") ? write.content.split("\n").filter(line => line.trim()) : [write.content];
        for (const line of jsonLines) JSON.parse(line);
        const workspacePath = `apps/${context.appId}/data/${rel}`;
        const file = writableFile(p.root, workspacePath);
        dataGuard.assertWritable(file, rel);
        return { path: workspacePath, file, expectedRevision: write.expectedRevision, content: write.content };
      });
      for (const write of writes) await authorize("write_file", { path: write.path }, signal);
      return withMutation(p.root, async () => {
        signal?.throwIfAborted();
        const changes: FileChange[] = [];
        const check = (write: typeof writes[number]) => {
          writableFile(p.root, write.path);
          dataGuard.assertWritable(write.file, write.path);
          const before = fs.existsSync(write.file) ? fs.readFileSync(write.file, "utf8") : null;
          if ((before === null ? null : revisionOf(before)) !== write.expectedRevision) throw new Error(`Stale record: ${write.path}. Inspect again.`);
          return before;
        };
        for (const write of writes) check(write);
        try {
          for (const write of writes) {
            const before = check(write);
            atomicText(write.file, write.content);
            changes.push({ path: write.path, before, after: write.content });
          }
        } catch (error) {
          for (const change of changes.reverse()) {
            const file = writableFile(p.root, change.path);
            if (fs.readFileSync(file, "utf8") !== change.after) continue;
            if (change.before === null) fs.unlinkSync(file); else atomicText(file, change.before);
          }
          throw error;
        }
        const changeId = recordChange(p.root, changes);
        let commitError: string | undefined;
        try { await commitWrittenPaths(p.root, username, `agent: ${name}`, changes.map(change => change.path), true); }
        catch (error) { commitError = (error as Error).message; }
        return { content: [{ type: "text" as const, text: JSON.stringify({ result: plan.result, changeId, ...(commitError ? { commitError } : {}) }) }], details: { changeId, paths: changes.map(change => change.path) } };
      });
    },
  }));
}
