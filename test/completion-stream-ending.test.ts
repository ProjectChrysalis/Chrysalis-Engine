import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserModelService } from "../src/models.js";
import { buildProvider } from "../src/providers/custom.js";
import { bootstrapUserDir } from "../src/paths.js";
import { defaultInstanceConfig } from "../src/config.js";

let root: string;
let server: ReturnType<typeof Bun.serve> | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "completion-ending-")); });
afterEach(() => { server?.stop(true); server = undefined; fs.rmSync(root, { recursive: true, force: true }); });

function chunk(delta: unknown, reason: string | null = null) {
  return `data: ${JSON.stringify({ id: "stream-test", model: "compatible", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
}
function service(response: () => Response) {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: response });
  const svc = new UserModelService("tester", bootstrapUserDir(root, "tester"), defaultInstanceConfig());
  svc.models.setProvider(buildProvider("compatible", {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [{ id: "compatible" }],
  }, { keyless: true }));
  return svc;
}
const response = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const request = { model: "compatible/compatible", messages: [{ role: "user" as const, content: "Hello" }] };

describe("compatible completion stream endings", () => {
  it.each([true, false])("keeps streamed text without a finish field, DONE=%s", async (done) => {
    const svc = service(() => response(chunk({ content: "Hello " }) + chunk({ content: "world" }) + (done ? "data: [DONE]\n\n" : "")));
    const deltas: string[] = [];
    const result = await svc.generate(request, (text) => deltas.push(text));
    expect(result.text).toBe("Hello world");
    expect(deltas.join("")).toBe("Hello world");
  });

  it("infers tool use and executes a complete tool call without a finish field", async () => {
    let requests = 0;
    const svc = service(() => response(++requests === 1
      ? chunk({ tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "lookup", arguments: '{"term":"hello"}' } }] })
      : chunk({ content: "Found it" })));
    const calls: string[] = [];
    const result = await svc.generate({ ...request,
      tools: [{ name: "lookup", description: "Look up a term", parameters: { type: "object", properties: { term: { type: "string" } }, required: ["term"] } as never }],
      executeTool: async (name, args) => { calls.push(`${name}:${args.term}`); return { text: "Result" }; },
    });
    expect(calls).toEqual(["lookup:hello"]);
    expect(result.text).toContain("Found it");
  });

  it("keeps an explicit provider filtering error", async () => {
    const svc = service(() => response(chunk({ content: "Partial" }) + chunk({}, "content_filter")));
    await expect(svc.generate(request)).rejects.toThrow("content_filter");
  });

  it("also finishes cleanly through the agent stream", async () => {
    const svc = service(() => response(chunk({ content: "Agent reply" })));
    const model = (await svc.models.getAvailable()).find((model) => model.provider === "compatible")!;
    const stream = svc.streamFn(model, { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] });
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    expect(events).toContain("done");
    expect(events).not.toContain("error");
    expect((await stream.result()).stopReason).toBe("stop");
  });

  it("keeps connection failures", async () => {
    const svc = service(() => response(chunk({ content: "Reply" })));
    server!.stop(true);
    await expect(svc.generate(request)).rejects.toThrow();
  });

  it("does not turn cancellation into a completed response", async () => {
    const svc = service(() => response(chunk({ content: "Reply" })));
    await expect(svc.generate({ ...request, signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it("keeps HTTP errors", async () => {
    const svc = service(() => Response.json({ error: { message: "Upstream unavailable" } }, { status: 503 }));
    await expect(svc.generate(request)).rejects.toThrow();
  });
});
