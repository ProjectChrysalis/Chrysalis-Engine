import fs from "node:fs";
import path from "node:path";
import { abortable } from "../cancellation.js";
import { atomicText, changeFiles } from "./changes.js";
import type { AgentToolOptions } from "./tools.js";

export class AgentPolicy {
  private grants = new Set<string>();
  private pending = Promise.resolve();
  constructor(private root: string, private sessionId: string, private mode: "normal" | "accept" | "plan", private appId: () => string | null, private ask?: AgentToolOptions["ask"]) {
    try { this.grants = new Set(JSON.parse(fs.readFileSync(this.file(), "utf8")) as string[]); } catch { /* New conversations have no grants. */ }
  }
  private file(): string { return path.join(this.root, "agent", "sessions", this.sessionId + ".permissions.json"); }
  async check(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    if (["read_file", "grep", "app_check", "app_rebuild", "app_console", "ask_user", "present_plan", "app_target", "skill_load", "skill_read", "skill_inspect", "tool_output", "app_inspect", "admin_list_users"].includes(tool)) return;
    if (tool === "server_settings" && args.action === "read") return;
    // a read of what an app's program holds changes nothing
    if (tool === "app_request" && /^(get|head)$/i.test(String(args.method ?? (args.json === undefined && args.body === undefined && args.body_file === undefined && !args.form && !args.files ? "GET" : "POST")))) return;
    if (this.mode === "plan") throw new Error("Plan mode cannot perform this action");
    // Helpers authorize each validated file in their write plan separately.
    if (tool === "skill_edit") return;
    // These tools already present the exact account or server change for approval.
    if (["admin_create_user", "server_settings"].includes(tool)) return;
    // Full mode acts without asking. A remote tool sends data off this machine, so it still asks.
    if (this.mode === "normal" && !tool.startsWith("mcp_")) return;
    const paths = tool === "undo_change" ? changeFiles(this.root, String(args.id)).map(change => change.path)
      : typeof args.path === "string" ? [args.path.replaceAll("\\", "/")]
      : tool.startsWith("app_") && typeof args.id === "string" ? [`apps/${args.id}/`] : [];
    const app = this.appId();
    const scope = paths.length ? paths.join("\n") : JSON.stringify(args);
    const key = JSON.stringify([this.mode, app, tool, scope]);
    if (this.grants.has(key)) return;
    if (!this.ask) throw new Error("Approval is unavailable. The action was not performed.");
    let release!: () => void;
    const before = this.pending;
    const slot = new Promise<void>(resolve => { release = resolve; });
    this.pending = before.then(() => slot);
    try {
      await abortable(before, signal);
      if (this.grants.has(key)) return;
      const answer = await abortable(this.ask({ question: "Allow this action?", options: ["Allow once", "Allow for this chat", "Skip"], detail: `${tool}\n${scope}` }), signal);
      signal?.throwIfAborted();
      if (answer !== "Allow once" && answer !== "Allow for this chat") throw new Error("The action was declined. Continue without it.");
      if (answer === "Allow for this chat") {
        this.grants.add(key);
        atomicText(this.file(), JSON.stringify([...this.grants]));
      }
    } finally { release(); }
  }
}
