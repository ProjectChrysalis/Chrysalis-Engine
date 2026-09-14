import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverAppPlugins, discoverPlugins, invalidatePluginCache } from "../src/plugins/runtime.js";
import { CURATED_PROVIDERS, curatedProviders, mapOpenAiModelsResponse } from "../src/providers/custom.js";
import { UserModelService } from "../src/models.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir } from "../src/paths.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-test-"));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* watcher races */ }
  invalidatePluginCache();
});

function writePlugin(base: string, id: string, manifest: Record<string, unknown>, code: string): void {
  const p = path.join(base, id);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(p, "plugin.js"), code);
}

describe("plugin discovery (apps)", () => {
  it("app plugins are namespaced by app, scoped to its data, and know their app", () => {
    writePlugin(path.join(dir, "plugins"), "user-plugin", { name: "U", version: "1", permissions: ["hooks"] }, "export const x = 1;");
    writePlugin(path.join(dir, "apps", "vn", "plugins"), "engine", { name: "E", version: "1", permissions: ["hooks"] }, "export const z = 3;");

    expect(discoverPlugins(path.join(dir, "plugins")).map((p) => p.id)).toEqual(["user-plugin"]);

    const bundled = discoverAppPlugins(path.join(dir, "apps"), "vn");
    expect(bundled.map((p) => p.id)).toEqual(["vn__engine"]);
    expect(bundled[0]!.appId).toBe("vn");
    expect(bundled[0]!.fsRoot).toBe(path.join(dir, "apps", "vn", "data"));
  });
});

describe("curated providers", () => {
  it("registry includes NanoGPT with auto models", () => {
    expect(CURATED_PROVIDERS["nanogpt"]?.baseUrl).toContain("nano-gpt.com");
    expect(CURATED_PROVIDERS["nanogpt"]?.models).toBe("auto");
  });

  it("aggregator presets are OpenAI-compatible with auto catalogs", () => {
    const ids = [
      "aimlapi", "chutes", "cohere", "cometapi", "deepinfra", "dreamgen",
      "electronhub", "featherless", "infermatic", "novita", "ollama-cloud",
      "siliconflow", "siliconflow-cn", "umans", "venice", "zenmux",
    ];
    for (const id of ids) {
      expect(CURATED_PROVIDERS[id]?.api, id).toBe("openai-completions");
      expect(CURATED_PROVIDERS[id]?.models, id).toBe("auto");
      expect(CURATED_PROVIDERS[id]?.baseUrl, id).toMatch(/^https:\/\//);
    }
  });

  it("Perplexity has no discovery route, so its catalog is static", () => {
    const models = CURATED_PROVIDERS["perplexity"]?.models;
    expect(Array.isArray(models) && models.some((m) => m.id === "sonar-pro")).toBe(true);
  });

  it("curated providers register but stay inert without a key", async () => {
    const p = bootstrapUserDir(dir, "alice");
    const svc = new UserModelService("alice", p, defaultInstanceConfig());
    for (const prov of curatedProviders()) svc.models.setProvider(prov);
    const avail = (await svc.models.getAvailable()).filter((m) => m.provider === "nanogpt");
    expect(avail).toEqual([]); // no key in auth.json → invisible
  });

  it("maps OpenAI-compatible /models responses", () => {
    expect(mapOpenAiModelsResponse({ data: [{ id: "openai/gpt-x" }, { id: "anthropic/claude-y" }, { nope: 1 }] })).toEqual([
      { id: "openai/gpt-x" },
      { id: "anthropic/claude-y" },
    ]);
    expect(mapOpenAiModelsResponse({})).toEqual([]);
    expect(mapOpenAiModelsResponse(null)).toEqual([]);
  });

  it("keeps the catalog metadata aggregators quote: name, context, prices", () => {
    const [m] = mapOpenAiModelsResponse({
      data: [
        {
          id: "anthropic/claude-x",
          name: "Anthropic: Claude X",
          context_length: 200000,
          supported_parameters: ["reasoning", "temperature"],
          pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", request: "0" },
          top_provider: { max_completion_tokens: 8192 },
        },
      ],
    });
    expect(m).toEqual({
      id: "anthropic/claude-x",
      name: "Anthropic: Claude X",
      contextWindow: 200000,
      maxTokens: 8192,
      reasoning: true,
      // per-token quotes become the per-million rates the cost math uses
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    });
  });

  it("reads the detailed per-million catalog NanoGPT serves", () => {
    const [m] = mapOpenAiModelsResponse({
      data: [
        {
          id: "anthropic/claude-sonnet-5",
          name: "Claude Sonnet 5",
          context_length: 1000000,
          max_output_tokens: 128000,
          architecture: { input_modalities: ["text", "image"] },
          capabilities: { vision: true, reasoning: false },
          pricing: { prompt: 2, completion: 10, cacheReadInputPer1kTokens: 0.0002, cacheWriteInputPer1kTokens: 0.0025, currency: "USD", unit: "per_million_tokens" },
        },
      ],
    });
    expect(m).toEqual({
      id: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      contextWindow: 1000000,
      maxTokens: 128000,
      vision: true,
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    });
  });

  it("NanoGPT connects by id, asks for reasoning as an object, and caches Claude with its own switch", async () => {
    const { validateConnectionInput } = await import("../src/connections.js");
    expect(validateConnectionInput({ name: "NanoGPT", providerId: "nanogpt", key: "k" })).toEqual({
      ok: true,
      value: { name: "NanoGPT", providerId: "nanogpt", key: "k" },
    });

    const { buildProvider } = await import("../src/providers/custom.js");
    const prov = buildProvider("nanogpt", { ...CURATED_PROVIDERS["nanogpt"]!, models: [{ id: "anthropic/claude-x", reasoning: true }, { id: "zai/glm-x" }] }, { codeDefined: true });
    const models = prov.getModels() as readonly { id: string; compat?: { cacheControlFormat?: string; thinkingFormat?: string } }[];
    // the endpoint places cache breakpoints itself, so no inline markers
    expect(models[0]?.compat).toEqual({ thinkingFormat: "openrouter" });

    const bodies: Record<string, unknown>[] = [];
    const fakeFetch = async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("nope", { status: 400 });
    };
    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
    for (const model of prov.getModels()) {
      const events = prov.streamSimple(model, context, { apiKey: "k", fetch: fakeFetch as never, reasoning: "low" });
      for await (const ev of events) if (ev.type === "error" || ev.type === "done") break;
    }
    expect(bodies[0]?.prompt_caching).toEqual({ enabled: true, ttl: "5m", stickyProvider: true });
    expect(bodies[0]?.reasoning).toEqual({ effort: "low" });
    // other routes cache implicitly; the switch would steer them off subscription upstreams
    expect(bodies[1]?.prompt_caching).toBeUndefined();
  });

  it("turns on prompt caching for Anthropic models behind a custom OpenAI-compatible endpoint", async () => {
    const { buildProvider } = await import("../src/providers/custom.js");
    const prov = buildProvider("c_agg", {
      name: "agg",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      models: [{ id: "anthropic/claude-x" }, { id: "claude-y" }, { id: "openai/gpt-x" }, { id: "meta/llama" }],
    });
    // without the marker every turn re-reads the whole context at full price
    const models = prov.getModels() as readonly { id: string; compat?: { cacheControlFormat?: string } }[];
    const compatOf = (id: string) => models.find((m) => m.id === id)?.compat?.cacheControlFormat;
    expect(compatOf("anthropic/claude-x")).toBe("anthropic");
    expect(compatOf("claude-y")).toBe("anthropic");
    // the marker means nothing to any other vendor, so it is not sent
    expect(compatOf("openai/gpt-x")).toBeUndefined();
    expect(compatOf("meta/llama")).toBeUndefined();

    // a local stack never serves Anthropic, whatever it named its model
    const local = buildProvider("c_local", {
      name: "local",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8080/v1",
      models: [{ id: "claude-ish-merge" }],
    });
    const localModel = local.getModels()[0] as { compat?: { cacheControlFormat?: string } };
    expect(localModel.compat).toBeUndefined();
  });

  it("sizes bare-id models from the catalog entry at the same endpoint, and leaves the rest unknown", async () => {
    const { buildProvider } = await import("../src/providers/custom.js");
    const { getBuiltinModels } = await import("@earendil-works/pi-ai/providers/all");
    const listed = getBuiltinModels("opencode-go").find((m) => m.id === "deepseek-v4-pro");
    expect(listed).toBeDefined();
    const prov = buildProvider("c_go", {
      name: "go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      models: [{ id: "deepseek-v4-pro" }, { id: "not-in-any-catalog" }],
    });
    const models = prov.getModels();
    const known = models.find((m) => m.id === "deepseek-v4-pro");
    expect(known?.contextWindow).toBe(listed?.contextWindow);
    expect(known?.maxTokens).toBe(listed?.maxTokens);
    // an unknown window is 0, never a guess the context meter would measure against
    expect(models.find((m) => m.id === "not-in-any-catalog")?.contextWindow).toBe(0);

    // the same id at a different host is not the catalog's model
    const other = buildProvider("c_other", {
      name: "other",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      models: [{ id: "deepseek-v4-pro" }],
    });
    expect(other.getModels()[0]?.contextWindow).toBe(0);
  });

  it("refuses a quote that cannot be per-token rather than inventing a cost", () => {
    // "3" as a per-token price would read as $3,000,000 per million
    const [m] = mapOpenAiModelsResponse({ data: [{ id: "odd/units", pricing: { prompt: "3", completion: "15" } }] });
    expect(m).toEqual({ id: "odd/units" });
  });

  it("leaves a model unpriced when the catalog quotes nothing", () => {
    // an all-zero quote is "free tier / not quoted", and a stored 0 would read
    // as "this generation cost nothing"
    const [m] = mapOpenAiModelsResponse({ data: [{ id: "local/llama", pricing: { prompt: "0", completion: "0" } }] });
    expect(m).toEqual({ id: "local/llama" });
  });
});
