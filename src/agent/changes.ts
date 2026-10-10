import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { agentWriteDenied, safeResolve } from "../paths.js";
import { makePathGuard } from "../sandbox/workspace.js";

export const revisionOf = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
export interface FileChange { path: string; before: string | null; after: string }
const queues = new Map<string, Promise<unknown>>();

export async function withMutation<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = fs.realpathSync(root);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  queues.set(key, next);
  try { return await next; }
  finally { if (queues.get(key) === next) queues.delete(key); }
}

export function atomicText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  try { fs.writeFileSync(temp, text, { flag: "wx", mode }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}

export function writableFile(root: string, rel: string): string {
  const denied = agentWriteDenied(rel);
  if (denied) throw new Error(`Refused: ${denied}`);
  const full = safeResolve(root, rel);
  makePathGuard(root).assertWritable(full, rel);
  return full;
}

export function recordChange(root: string, changes: FileChange[]): string {
  const id = crypto.randomUUID();
  atomicText(path.join(root, "agent", "changes", id + ".json"), JSON.stringify({ changes }));
  return id;
}

export function changeFiles(root: string, id: string): FileChange[] {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid change id");
  return (JSON.parse(fs.readFileSync(path.join(root, "agent", "changes", id + ".json"), "utf8")) as { changes: FileChange[] }).changes;
}

export async function undoChange(root: string, id: string): Promise<string[]> {
  return withMutation(root, async () => {
    const changes = changeFiles(root, id);
    const files = changes.map(change => writableFile(root, change.path));
    for (const [index, change] of changes.entries()) {
      if (!fs.existsSync(files[index]!) || fs.readFileSync(files[index]!, "utf8") !== change.after) throw new Error(`Changed since this action: ${change.path}. Nothing was undone.`);
    }
    const restored: number[] = [];
    try {
      for (const [index, change] of changes.entries()) {
        if (change.before === null) fs.unlinkSync(files[index]!);
        else atomicText(files[index]!, change.before);
        restored.push(index);
      }
    } catch (error) {
      for (const index of restored) atomicText(files[index]!, changes[index]!.after);
      throw error;
    }
    return changes.map(change => change.path);
  });
}
