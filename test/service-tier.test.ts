import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { createConnection, updateConnection, validateConnectionInput } from "../src/connections.js";
import { UserModelService } from "../src/models.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir } from "../src/paths.js";

let dataDir: string;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-tier-")); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

const flexModel = googleProvider().getModels().find((m) => /^gemini-2\.5-flash$/.test(m.id))!;
const reply = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1000000,"candidatesTokenCount":0,"totalTokenCount":1000000}}\n\n';

async function send(paths: ReturnType<typeof bootstrapUserDir>) {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? await input.text() : String(init?.body ?? "");
    bodies.push(JSON.parse(raw || "{}"));
    return new Response(reply, { headers: { "Content-Type": "text/event-stream" } });
  }, { preconnect: originalFetch.preconnect });
  try {
    const result = await new UserModelService("alice", paths, defaultInstanceConfig()).generate({ model: `google/${flexModel.id}`, messages: [{ role: "user", content: "Hello" }] });
    return { body: bodies[0]!, cost: result.usage.costTotal };
  } finally { globalThis.fetch = originalFetch; }
}

it("asks Google for the Flex tier and prices the reply at half the standard rate", async () => {
  expect(flexModel).toBeDefined();
  const paths = bootstrapUserDir(dataDir, "alice");
  const connection = createConnection(paths, { name: "Google", providerId: "google", key: "test-key" });
  const standard = await send(paths);
  expect(standard.body.serviceTier).toBeUndefined();
  expect(standard.cost).toBeCloseTo(flexModel.cost.input, 6);
  updateConnection(paths, connection.id, { serviceTier: "flex" });
  const flex = await send(paths);
  expect(flex.body.serviceTier).toBe("flex");
  expect(flex.cost).toBeCloseTo(flexModel.cost.input / 2, 6);
  updateConnection(paths, connection.id, { serviceTier: null });
  expect((await send(paths)).body.serviceTier).toBeUndefined();
});

it("keeps the Flex tier to Google connections", () => {
  expect(validateConnectionInput({ name: "Google", providerId: "google", serviceTier: "flex" })).toMatchObject({ ok: true, value: { serviceTier: "flex" } });
  expect(validateConnectionInput({ name: "OpenRouter", providerId: "openrouter", serviceTier: "flex" }).ok).toBe(false);
  expect(validateConnectionInput({ name: "Google", providerId: "google", serviceTier: "priority" }).ok).toBe(false);
});
