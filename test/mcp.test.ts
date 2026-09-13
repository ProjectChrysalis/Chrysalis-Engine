import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpRegistry } from "../src/mcp/registry.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";

let dataDir: string;
let mcpJson: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
  bootstrapUserDir(dataDir, "alice");
  // mcp.json lives beside the credentials, outside the workspace
  mcpJson = userPaths(dataDir, "alice").mcp;
  // bootstrap seeds the default web-search preset; these tests exercise the
  // registry mechanics with a controlled config
  fs.writeFileSync(mcpJson, JSON.stringify({ servers: {} }));
});
afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
});

/** Minimal stdio MCP dice server using the official SDK (imports rewritten to absolute paths at write time). */
const DICE_SERVER = `
import { McpServer } from "@mcp/server.mcp.js";
import { StdioServerTransport } from "@mcp/server.stdio.js";
import { z } from "@mcp/zod.js";
const server = new McpServer({ name: "dice", version: "1.0.0" });
server.registerTool("roll", {
  description: "Roll dice, e.g. 2d6",
  inputSchema: { sides: z.number().default(6), count: z.number().default(1) },
}, async ({ sides = 6, count = 1 }) => {
  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  return { content: [{ type: "text", text: "rolled: " + rolls.join(", ") + " (total " + rolls.reduce((a, b) => a + b, 0) + ")" }] };
});
await server.connect(new StdioServerTransport());
`;

/** Write the dice server and return its path. */
function writeDiceServer(): string {
  const nm = path.join(process.cwd(), "node_modules");
  const serverFile = path.join(dataDir, "dice-server.mjs");
  const rewritten = DICE_SERVER
    .replaceAll('"@mcp/server.mcp.js"', JSON.stringify(path.join(nm, "@modelcontextprotocol/sdk/dist/esm/server/mcp.js")))
    .replaceAll('"@mcp/server.stdio.js"', JSON.stringify(path.join(nm, "@modelcontextprotocol/sdk/dist/esm/server/stdio.js")))
    .replaceAll('"@mcp/zod.js"', JSON.stringify(path.join(nm, "zod", "index.js")));
  fs.writeFileSync(serverFile, rewritten);
  return serverFile;
}

const stdioDice = (serverFile: string) => ({ type: "stdio" as const, command: process.execPath, args: [serverFile] });

describe("McpRegistry (real stdio server e2e)", () => {
  it("registers, connects, lists namespaced tools, calls them", async () => {
    const registry = new McpRegistry(mcpJson, undefined, undefined, () => true);
    registry.upsertServer("dice", stdioDice(writeDiceServer()));

    const tools = await registry.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0]!.name).toBe("mcp_dice_roll");
    expect(tools[0]!.server).toBe("dice");

    const piTools = await registry.toPiTools();
    expect(piTools[0]!.name).toBe("mcp_dice_roll");
    expect((piTools[0]!.parameters as { type?: string }).type).toBe("object");

    const result = await registry.callTool("mcp_dice_roll", { sides: 6, count: 2 });
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/^rolled: \d+, \d+ \(total \d+\)$/);

    expect(registry.status()).toEqual([{ id: "dice", type: "stdio", connected: true, enabled: true, share: "all", tools: 1 }]);
    await registry.dispose();
  }, 30_000);

  it("unreachable servers are isolated (empty tool list, no throw)", async () => {
    const registry = new McpRegistry(mcpJson, undefined, undefined, () => true);
    registry.upsertServer("dead", { type: "stdio", command: "definitely-not-a-real-binary-xyz", args: [] });
    expect(await registry.listTools()).toEqual([]);
    const call = await registry.callTool("mcp_dead_anything", {});
    expect(call.ok).toBe(false);
    await registry.dispose();
  }, 30_000);

  it("persisted mcp.json is read back", async () => {
    const registry = new McpRegistry(mcpJson, undefined, undefined, () => true);
    registry.upsertServer("demo", { type: "http", url: "https://example.invalid/mcp" });
    const again = new McpRegistry(mcpJson, undefined, undefined, () => true);
    expect(again.readConfig().servers["demo"]?.url).toBe("https://example.invalid/mcp");
    expect(again.deleteServer("demo")).toBe(true);
    expect(again.readConfig().servers["demo"]).toBeUndefined();
  });

  /** stdio is admin-gated and fingerprinted, but http/sse only ever needed a
   *  URL. The file is out of the agent's reach now, but the egress guard is
   *  what stops even a user-written entry from reaching the host's own
   *  network by mistake. */
  it("an http server pointed at a private address never connects", async () => {
    const registry = new McpRegistry(mcpJson, undefined, undefined, () => true);
    registry.upsertServer("meta", { type: "http", url: "http://169.254.169.254/mcp" });
    expect(await registry.listTools()).toEqual([]);
    expect(registry.status().find((s) => s.id === "meta")?.error).toMatch(/private address/);

    registry.upsertServer("lan", { type: "sse", url: "http://192.168.1.20/mcp" });
    expect(await registry.listTools()).toEqual([]);
    expect(registry.status().find((s) => s.id === "lan")?.error).toMatch(/private address/);
    await registry.dispose();
  }, 30_000);

  it("scopes servers by share mode: all / agent / off", async () => {
    const serverFile = writeDiceServer();
    const registry = new McpRegistry(mcpJson, undefined, undefined, () => true);
    registry.upsertServer("shared", stdioDice(serverFile));
    registry.upsertServer("secret", { ...stdioDice(serverFile), share: "agent" });
    registry.upsertServer("gone", { ...stdioDice(serverFile), enabled: false });

    // only the "all" server is offered to apps; the agent still sees both
    // connected ones and never the disabled server
    expect(registry.sharedServers()).toEqual(["shared"]);
    const engineTools = await registry.listTools();
    expect([...new Set(engineTools.map((t) => t.server))].sort()).toEqual(["secret", "shared"]);

    // a narrowing list decides what the app bridge may call
    const appTools = await registry.toPiTools(["shared"]);
    expect(appTools.map((t) => t.name)).toEqual(["mcp_shared_roll"]);
    expect((await registry.callTool("mcp_shared_roll", { sides: 6 }, [])).ok).toBe(false);
    expect((await registry.callTool("mcp_shared_roll", { sides: 6 }, ["shared"])).ok).toBe(true);

    // sharing is the engine's call and shows up in status
    expect(registry.setAccess("shared", { share: "agent" })).toBe(true);
    expect(registry.sharedServers()).toEqual([]);
    expect(registry.status().find((s) => s.id === "shared")?.share).toBe("agent");
    expect(registry.setAccess("shared", { enabled: false })).toBe(true);
    expect(registry.status().find((s) => s.id === "shared")?.enabled).toBe(false);
    expect(registry.setAccess("nope", { share: "all" })).toBe(false);
    await registry.dispose();
  }, 30_000);
});
