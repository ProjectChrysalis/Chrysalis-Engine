import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { UserModelService } from "../src/models.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";
import { loadCustomProviders, buildProvider } from "../src/providers/custom.js";

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "models-test-"));
});
afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
});

function makeService(username = "alice"): UserModelService {
  const p = bootstrapUserDir(dataDir, username);
  return new UserModelService(username, p, defaultInstanceConfig());
}

describe("UserModelService message construction (regression: assistant history)", () => {
  it("builds full AssistantMessage objects — no usage-undefined crash in pi-ai estimate", async () => {
    const svc = makeService();
    const handle = fauxProvider({ models: [{ id: "faux-echo" }] });
    handle.setResponses([fauxAssistantMessage("FAUX-REPLY")]);
    svc.models.setProvider(handle.provider);

    // This exact shape crashed pre-fix: pi-ai's estimate walks assistant.usage.
    const result = await svc.generate({
      model: "faux/faux-echo",
      messages: [
        { role: "user", content: "hello there" },
        { role: "assistant", content: "hey" },
        { role: "user", content: "say OK" },
      ],
    });
    expect(result.text).toContain("FAUX-REPLY");
    expect(result.model).toBe("faux/faux-echo");
    expect(result.usage).toHaveProperty("input");
    expect(result.usage).toHaveProperty("cacheRead");
  }, 20_000);

  it("only the leading system run becomes the system prompt; later ones keep their place", async () => {
    const svc = makeService();
    const handle = fauxProvider({ models: [{ id: "faux-sys" }] });
    let seen: { systemPrompt?: string; roles: string[]; contents: string[] } | null = null;
    handle.setResponses([(context) => {
      seen = {
        ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
        roles: context.messages.map((m) => m.role),
        contents: context.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
      };
      return fauxAssistantMessage("OK");
    }]);
    svc.models.setProvider(handle.provider);

    await svc.generate({
      model: "faux/faux-sys",
      messages: [
        { role: "system", content: "SYS-A" },
        { role: "system", content: "SYS-B" },
        { role: "user", content: "turn one" },
        { role: "assistant", content: "reply one" },
        { role: "system", content: "AT-DEPTH" },
        { role: "user", content: "turn two" },
        { role: "system", content: "POST-HISTORY" },
      ],
    });

    const got = seen as unknown as { systemPrompt?: string; roles: string[]; contents: string[] };
    expect(got.systemPrompt).toBe("SYS-A\n\nSYS-B");
    // the two later system entries did not move to the front and did not
    // vanish: they sit exactly where the caller put them, spoken as the user
    expect(got.roles).toEqual(["user", "assistant", "user", "user", "user"]);
    expect(got.contents[2]).toBe("AT-DEPTH");
    expect(got.contents[4]).toBe("POST-HISTORY");
  }, 20_000);

  it("tool loop: executes tools host-side and returns final text + trace", async () => {
    const svc = makeService();
    const call = fauxAssistantMessage([{ type: "toolCall", id: "tc1", name: "roll", arguments: { sides: 6 } }]);
    // stopReason for tool call messages — fauxAssistantMessage default? force via options
    const withStop = { ...call, stopReason: "toolUse" as const };
    const final = fauxAssistantMessage("ROLLED-42");
    const handle = fauxProvider({ models: [{ id: "faux-tools" }] });
    handle.setResponses([withStop, final]);
    svc.models.setProvider(handle.provider);

    const trace: { name: string }[] = [];
    const result = await svc.generate({
      model: "faux/faux-tools",
      messages: [{ role: "user", content: "roll for me" }],
      tools: [{ name: "roll", description: "Roll dice", parameters: { type: "object", properties: {} } as never }],
      executeTool: async (name) => {
        trace.push({ name });
        return { text: "rolled 42" };
      },
    });
    expect(trace).toEqual([{ name: "roll" }]);
    expect(result.text).toContain("ROLLED-42");
    expect(result.toolTrace?.[0]?.resultText).toBe("rolled 42");
  }, 20_000);

  it("structured output: schema forces __structured_output tool; json extracted from args", async () => {
    const svc = makeService();
    const toolCallMsg = { ...fauxAssistantMessage([{ type: "toolCall", id: "sc1", name: "__structured_output", arguments: { mood: "tense", beats: 3 } }]), stopReason: "toolUse" as const };
    const finalMsg = fauxAssistantMessage("done");
    const handle = fauxProvider({ models: [{ id: "faux-struct" }] });
    handle.setResponses([toolCallMsg, finalMsg]);
    svc.models.setProvider(handle.provider);

    const result = await svc.generate({
      model: "faux/faux-struct",
      messages: [{ role: "user", content: "set the scene" }],
      schema: {
        type: "object",
        properties: { mood: { type: "string" }, beats: { type: "number" } },
        required: ["mood", "beats"],
      },
    });
    expect(result.json).toEqual({ mood: "tense", beats: 3 });
    expect(result.toolTrace?.[0]?.name).toBe("__structured_output");
  }, 20_000);

  it("structured output fallback: plain JSON text parsed when tool not called", async () => {
    const svc = makeService();
    const handle = fauxProvider({ models: [{ id: "faux-json" }] });
    handle.setResponses([fauxAssistantMessage('{"mood":"calm","beats":2}')]);
    svc.models.setProvider(handle.provider);
    const result = await svc.generate({
      model: "faux/faux-json",
      messages: [{ role: "user", content: "json please" }],
      schema: { type: "object", properties: { mood: { type: "string" } } },
    });
    expect(result.json).toEqual({ mood: "calm", beats: 2 });
  }, 20_000);
});

describe("custom providers loader", () => {
  it("registers providers from providers.json; keys resolve via auth.json credentials", async () => {
    const p = bootstrapUserDir(dataDir, "bob");
    fs.writeFileSync(
      path.join(p.root, "providers.json"),
      JSON.stringify({
        providers: {
          "my-shop": {
            name: "My Shop",
            api: "openai-completions",
            baseUrl: "https://api.myshop.example/v1",
            models: [{ id: "my-model", contextWindow: 65000, maxTokens: 4096 }],
          },
          "anthro-shop": {
            api: "anthropic-messages",
            baseUrl: "https://anthro.example",
            models: [{ id: "a1" }],
          },
          broken: { models: [] }, // skipped: no baseUrl/models
        },
      }),
    );
    const providers = loadCustomProviders(path.join(p.root, "providers.json"));
    expect(providers.map((x) => x.id).sort()).toEqual(["anthro-shop", "my-shop"]);

    const svc = new UserModelService("bob", p, defaultInstanceConfig());
    for (const prov of providers) svc.models.setProvider(prov);
    // without credential → not in available
    expect((await svc.models.getAvailable()).filter((m) => m.provider === "my-shop")).toEqual([]);
    // with credential in auth.json, bound to this endpoint → model becomes available
    fs.writeFileSync(p.auth, JSON.stringify({ "my-shop": { type: "api_key", key: "sk-test", boundBaseUrl: "https://api.myshop.example/v1" } }));
    const svc2 = new UserModelService("bob", p, defaultInstanceConfig());
    for (const prov of providers) svc2.models.setProvider(prov);
    const avail = (await svc2.models.getAvailable()).filter((m) => m.provider === "my-shop");
    expect(avail.map((m) => m.id)).toEqual(["my-model"]);
    expect(avail[0]!.contextWindow).toBe(65000);
  });

  it("missing or invalid file → no custom providers, no throw", () => {
    const p = bootstrapUserDir(dataDir, "carol");
    expect(loadCustomProviders(path.join(p.root, "providers.json"))).toEqual([]);
    fs.writeFileSync(path.join(p.root, "providers.json"), "{not json");
    expect(loadCustomProviders(path.join(p.root, "providers.json"))).toEqual([]);
  });

  it("auto catalog discovery re-reads the stored key: the resolved credential has no binding (regression)", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (url: string | URL, init?: RequestInit) => {
        calls.push(`${String(url)} auth=${(init?.headers as Record<string, string> | undefined)?.authorization ?? "-"}`);
        return new Response(JSON.stringify({ data: [{ id: "m1", context_length: 128000 }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
      { preconnect: (): void => {} },
    ) as typeof fetch;
    try {
      const shop = { name: "Shop", api: "openai-completions" as const, baseUrl: "https://shop.example/v1", models: "auto" as const };
      const ctx = (credential: unknown) =>
        ({
          credential,
          allowNetwork: true,
          signal: new AbortController().signal,
          publish: async (p: { update?: () => void }) => {
            p.update?.();
            return true;
          },
        }) as never;

      // stored key bound to the endpoint: discovery works even though the
      // resolved credential pi-ai passes in carries only { type, key }
      const bound = buildProvider("c_shop", shop, { readCredential: () => ({ key: "sk-bound", boundBaseUrl: "https://shop.example/v1" }) });
      await bound.refreshModels!(ctx({ type: "api_key", key: "sk-bound" }));
      expect(bound.getModels().map((m) => m.id)).toEqual(["m1"]);
      expect(calls[0]).toContain("Bearer sk-bound");

      // stored key bound elsewhere: no network call, no models
      calls.length = 0;
      const moved = buildProvider("c_shop2", shop, { readCredential: () => ({ key: "sk-bound", boundBaseUrl: "https://other.example/v1" }) });
      await moved.refreshModels!(ctx({ type: "api_key", key: "sk-bound" }));
      expect(moved.getModels()).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("spend reporting", () => {
  it("a catalog price makes a generation priced; no price at all reports unknown, never free", async () => {
    const svc = makeService("pricey");
    // $3/M in, $15/M out — the shape an aggregator catalog quotes
    const priced = fauxProvider({ provider: "priced-agg", models: [{ id: "paid", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } }] });
    const free = fauxProvider({ provider: "unpriced-agg", models: [{ id: "unpriced" }] });
    priced.setResponses([fauxAssistantMessage("hello")]);
    free.setResponses([fauxAssistantMessage("hello")]);
    svc.models.setProvider(priced.provider);
    svc.models.setProvider(free.provider);

    const models = await svc.available();
    expect(models.find((m) => m.modelId === "paid")?.pricing).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
    // an all-zero quote is "not quoted", so the client can say so instead of "$0.00"
    expect(models.find((m) => m.modelId === "unpriced")?.pricing).toBeNull();

    const paidRef = models.find((m) => m.modelId === "paid")!;
    const out = await svc.generate({ model: `${paidRef.provider}/paid`, messages: [{ role: "user", content: "hi" }] });
    expect(out.usage.priced).toBe(true);
    // the faux provider reports token counts; the cost has to follow from them
    const expected = (out.usage.input * 3 + out.usage.output * 15 + out.usage.cacheRead * 0.3) / 1_000_000;
    expect(out.usage.costTotal).toBeCloseTo(expected, 12);

    const freeRef = models.find((m) => m.modelId === "unpriced")!;
    const out2 = await svc.generate({ model: `${freeRef.provider}/unpriced`, messages: [{ role: "user", content: "hi" }] });
    expect(out2.usage.priced).toBe(false);
  });
});

describe("context window overrides (the attached value beats the catalog)", () => {
  it("override wins in available(); null clears back to the catalog number", async () => {
    const p = bootstrapUserDir(dataDir, "dave");
    const svc = new UserModelService("dave", p, defaultInstanceConfig());
    const handle = fauxProvider({ models: [{ id: "faux-ctx", contextWindow: 32_000 }] });
    svc.models.setProvider(handle.provider);
    const ctxOf = async (): Promise<number | null> =>
      ((await svc.available()).find((m) => m.modelId === "faux-ctx")?.contextWindow ?? null);
    expect(await ctxOf()).toBe(32_000);

    svc.setContextOverride("faux/faux-ctx", 200_000);
    expect(await ctxOf()).toBe(200_000);

    svc.setContextOverride("faux/faux-ctx", null);
    expect(await ctxOf()).toBe(32_000);
  });

  it("malformed entries are ignored when reading overrides", () => {
    const p = bootstrapUserDir(dataDir, "erin");
    fs.writeFileSync(path.join(p.root, "model-overrides.json"), JSON.stringify({ "a/b": -5, noSlash: 10, "c/d": "big", "e/f": 999.7 }));
    const svc = new UserModelService("erin", p, defaultInstanceConfig());
    expect(svc.contextOverrides()).toEqual({ "e/f": 999 });
  });
});

describe("sampler passthrough (SPEC-v2 §12.1 — full sampler control)", () => {
  it("presetParams reach the provider stream options (temperature, maxTokens, samplingParams)", async () => {
    const svc = makeService();
    let captured: Record<string, unknown> | undefined;
    const handle = fauxProvider({ models: [{ id: "faux-sampler" }] });
    handle.setResponses([(_ctx, options) => {
      captured = options as Record<string, unknown>;
      return fauxAssistantMessage("OK");
    }]);
    svc.models.setProvider(handle.provider);
    const result = await svc.generate({
      model: "faux/faux-sampler",
      messages: [{ role: "user", content: "hi" }],
      presetParams: { temperature: 0.42, max_tokens: 321, params: { top_p: 0.9, min_p: 0.05 } },
    });
    expect(result.text).toBe("OK");
    expect(captured!.temperature).toBe(0.42);
    expect((captured as { maxTokens?: number }).maxTokens).toBe(321);
    expect((captured as { samplingParams?: Record<string, unknown> }).samplingParams).toMatchObject({ top_p: 0.9, min_p: 0.05 });
  }, 20_000);

  it("absent presetParams omit sampler stream options entirely", async () => {
    const svc = makeService();
    let captured: Record<string, unknown> = {};
    const handle = fauxProvider({ models: [{ id: "faux-sampler2" }] });
    handle.setResponses([(_ctx, options) => {
      captured = (options as Record<string, unknown>) ?? {};
      return fauxAssistantMessage("OK");
    }]);
    svc.models.setProvider(handle.provider);
    await svc.generate({ model: "faux/faux-sampler2", messages: [{ role: "user", content: "hi" }] });
    expect(captured.temperature).toBeUndefined();
    expect((captured as { maxTokens?: unknown }).maxTokens).toBeUndefined();
    expect((captured as { samplingParams?: unknown }).samplingParams).toBeUndefined();
  }, 20_000);
});

describe("embeddings probe (honest semantic-recall status)", () => {
  let dir: string;
  let server: import("node:http").Server;
  let baseUrl: string;
  let hits = 0;
  let lastModel = "";

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-probe-"));
    hits = 0;
    lastModel = "";
    const http = await import("node:http");
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        hits++;
        const parsed = JSON.parse(body || "{}") as { input?: string[]; model?: string };
        lastModel = parsed.model ?? "";
        const input = parsed.input ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: input.map(() => ({ embedding: [0.1, 0.2] })) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* races */ }
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("no keyed connection: probe says ok:false (no silent semantic mode)", async () => {
    const svc = new UserModelService("u", userPaths(dir, "u"), defaultInstanceConfig());
    const r = await svc.embedProbe();
    expect(r.ok).toBe(false);
    expect(r.via).toBeNull();
  });

  it("a keyed OpenAI-compatible connection answers and is named", async () => {
    const p = userPaths(dir, "u");
    fs.mkdirSync(path.dirname(p.connections), { recursive: true });
    fs.writeFileSync(p.connections, JSON.stringify({
      connections: { emb1: { name: "Embed Hub", api: "openai-completions", baseUrl, models: [] } },
    }));
    const auth = path.join(p.auth);
    fs.mkdirSync(path.dirname(auth), { recursive: true });
    fs.writeFileSync(auth, JSON.stringify({ emb1: { type: "api_key", key: "sk-test", boundBaseUrl: baseUrl } }));
    const svc = new UserModelService("u", p, defaultInstanceConfig());
    const r = await svc.embedProbe();
    expect(r.ok).toBe(true);
    expect(r.via).toBe("Embed Hub");
    expect(hits).toBe(1);
  });

  it("the configured embeddings model name is what gets sent", async () => {
    const p = userPaths(dir, "u");
    fs.mkdirSync(path.dirname(p.connections), { recursive: true });
    fs.mkdirSync(p.root, { recursive: true });
    fs.writeFileSync(p.connections, JSON.stringify({
      connections: { emb1: { name: "Embed Hub", api: "openai-completions", baseUrl, models: [] } },
    }));
    fs.mkdirSync(path.dirname(p.auth), { recursive: true });
    fs.writeFileSync(p.auth, JSON.stringify({ emb1: { type: "api_key", key: "sk-test", boundBaseUrl: baseUrl } }));
    fs.writeFileSync(path.join(p.root, "settings.json"), JSON.stringify({ embedModel: "nomic-embed-text-v1.5" }));
    const svc = new UserModelService("u", p, defaultInstanceConfig());
    expect(await svc.embed(["x"])).toEqual([[0.1, 0.2]]);
    expect(lastModel).toBe("nomic-embed-text-v1.5");
    // an explicit model argument still wins
    await svc.embed(["x"], "override-model");
    expect(lastModel).toBe("override-model");
  });
});

describe("prompt-cache session passthrough", () => {
  it("generate() keys the prompt cache with the caller's sessionId", async () => {
    const svc = makeService();
    const handle = fauxProvider({ models: [{ id: "faux-cache" }] });
    handle.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    svc.models.setProvider(handle.provider);

    const first = await svc.generate({
      model: "faux/faux-cache",
      sessionId: "chat-123",
      messages: [{ role: "user", content: "hello cache" }],
    });
    // first turn writes the prompt into the session cache
    expect(first.usage.cacheRead).toBe(0);
    expect(first.usage.cacheWrite).toBeGreaterThan(0);

    const second = await svc.generate({
      model: "faux/faux-cache",
      sessionId: "chat-123",
      messages: [{ role: "user", content: "hello cache and then some more" }],
    });
    // same session + shared prefix → the provider reports a cache hit
    expect(second.usage.cacheRead).toBeGreaterThan(0);
  }, 20_000);

  it("the agent streamFn carries its session id into provider caching", async () => {
    const svc = makeService();
    const handle = fauxProvider({ models: [{ id: "faux-agent-cache" }] });
    handle.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    svc.models.setProvider(handle.provider);
    const model = handle.getModel("faux-agent-cache")!;

    const first = await svc.streamFn(model, { messages: [{ role: "user", content: "hi agent", timestamp: Date.now() }] }, undefined, "agent-sess-1").result();
    expect(first.usage.cacheWrite).toBeGreaterThan(0);

    const second = await svc.streamFn(model, { messages: [{ role: "user", content: "hi agent with another turn", timestamp: Date.now() }] }, undefined, "agent-sess-1").result();
    expect(second.usage.cacheRead).toBeGreaterThan(0);
  }, 20_000);
});

describe("providers whose endpoint lives on each model", () => {
  it("a stored opencode key makes its catalog available (no top-level baseUrl)", async () => {
    const p = userPaths(dataDir, "alice");
    fs.mkdirSync(path.dirname(p.auth), { recursive: true });
    fs.writeFileSync(p.auth, JSON.stringify({ opencode: { type: "api_key", key: "test-key" } }), { mode: 0o600 });
    const svc = new UserModelService("alice", p, defaultInstanceConfig());
    const models = await svc.available();
    const opencode = models.filter((m) => m.provider === "opencode");
    expect(opencode.length).toBeGreaterThan(0);
    // multi-API gateway: models span more than one api implementation
    expect(new Set(opencode.map((m) => m.api)).size).toBeGreaterThan(1);
  }, 30_000);
});
