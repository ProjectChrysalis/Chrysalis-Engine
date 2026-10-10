import fs from "node:fs";
import crypto from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { atomicText } from "./changes.js";

export interface LiveEvent { type: string; delta?: string; [key: string]: unknown }
export interface RunSnapshot { id: string; seq: number; at: number; user: string; model: string; messages: AgentMessage[]; events: LiveEvent[] }

export class RunJournal {
  readonly snapshot: RunSnapshot;
  private lastFlush = 0;
  constructor(private file: string, user: string, model: string) {
    this.snapshot = { id: crypto.randomUUID(), seq: 0, at: Date.now(), user, model, messages: [], events: [] };
    this.flush();
  }
  message(message: AgentMessage): void {
    this.snapshot.messages.push(JSON.parse(JSON.stringify(message)) as AgentMessage);
    this.flush();
  }
  event(event: LiveEvent): void {
    this.snapshot.seq++;
    const last = this.snapshot.events.at(-1);
    if ((event.type === "text" || event.type === "thinking") && last?.type === event.type) last.delta = (last.delta ?? "") + (event.delta ?? "");
    else this.snapshot.events.push({ ...event });
    if (Date.now() - this.lastFlush > 1000 || event.type === "tool_start" || event.type === "tool_end") this.flush();
  }
  flush(): void { atomicText(this.file + ".active.json", JSON.stringify(this.snapshot)); this.lastFlush = Date.now(); }
  finish(): void { fs.rmSync(this.file + ".active.json", { force: true }); }
}

export function recoverRun(file: string): void {
  const active = file + ".active.json";
  if (!fs.existsSync(active)) return;
  const snapshot = JSON.parse(fs.readFileSync(active, "utf8")) as RunSnapshot;
  const records = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { runId?: string }) : [];
  if (records.some(record => record.runId === snapshot.id)) { fs.rmSync(active, { force: true }); return; }
  const messages = snapshot.messages;
  if (!messages.some(message => message.role === "user")) messages.unshift({ role: "user", content: snapshot.user, timestamp: snapshot.at });
  const resolved = new Set(messages.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []));
  for (const message of [...messages]) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall" || resolved.has(block.id)) continue;
      messages.push({ role: "toolResult", toolCallId: block.id, toolName: block.name, isError: true, content: [{ type: "text", text: "Run interrupted. This action may have already happened. Inspect its current state before deciding what to do; do not blindly repeat it." }], timestamp: Date.now() });
      resolved.add(block.id);
    }
  }
  const text = snapshot.events.filter(event => event.type === "text").map(event => event.delta ?? "").join("");
  const thinking = snapshot.events.filter(event => event.type === "thinking").map(event => event.delta ?? "").join("");
  const tools = snapshot.events.filter(event => event.type === "tool_end").map(event => ({ name: event.name, ok: event.ok, args: snapshot.events.find(start => start.type === "tool_start" && start.id === event.id)?.args, summary: event.summary, output: event.output, diff: event.diff }));
  const pending = new Map<string, string>();
  for (const event of snapshot.events) {
    if (event.type === "queue_added" && typeof event.id === "string" && typeof event.text === "string") pending.set(event.id, event.text);
    if ((event.type === "queue_sent" || event.type === "queue_cancelled") && typeof event.id === "string") pending.delete(event.id);
  }
  const queueNote = pending.size ? "\nQueued messages were not sent:\n" + [...pending.values()].join("\n") : "";
  fs.appendFileSync(file, JSON.stringify({ type: "run", runId: snapshot.id, at: snapshot.at, model: snapshot.model, user: snapshot.user, assistant: (text || "Run interrupted. Inspect completed changes before continuing.") + queueNote, thinking, tools, native: messages, interrupted: true }) + "\n");
  fs.rmSync(active, { force: true });
}
