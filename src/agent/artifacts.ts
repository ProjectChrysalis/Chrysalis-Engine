import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { atomicText } from "./changes.js";

export function spillOutput(root: string, text: string): string {
  if (Buffer.byteLength(text) <= 24576) return text;
  const id = crypto.randomUUID();
  atomicText(path.join(root, "agent", "outputs", id + ".txt"), text);
  return `${text.slice(0, 8000)}\n\n[Full output saved: ${id}. Use tool_output with this id to read more.]\n\n${text.slice(-4000)}`;
}

export function outputTool(root: string): AgentTool {
  return {
    name: "tool_output", label: "Read saved tool output",
    description: "Retrieve saved tool output by id. Offset is a zero-based character position; limit is at most 16000 characters.",
    parameters: Type.Object({ id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) }),
    async execute(_id, input) {
      const { id, offset = 0, limit = 16000 } = input as { id: string; offset?: number; limit?: number };
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid output id");
      const text = fs.readFileSync(path.join(root, "agent", "outputs", id + ".txt"), "utf8");
      return { content: [{ type: "text", text: JSON.stringify({ text: text.slice(offset, offset + Math.min(limit, 16000)), nextOffset: offset + Math.min(limit, 16000) < text.length ? offset + Math.min(limit, 16000) : null, characters: text.length }) }], details: {} };
    },
  };
}
