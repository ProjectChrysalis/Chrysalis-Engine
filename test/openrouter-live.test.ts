import { afterEach, expect, it } from "bun:test";
import { validateConnectionInput } from "../src/connections.js";
import { catalogProviders } from "../src/model-catalog.js";
import { parseOpenRouterModels, refreshOpenRouterModels, setOpenRouterModels } from "../src/providers/openrouter-live.js";

afterEach(() => { setOpenRouterModels(null); });

const openrouter = () => catalogProviders().find((p) => p.id === "openrouter")!;
const shipped = () => openrouter().getModels().find((m) => m.api === "openai-completions" && m.id.startsWith("anthropic/"))!;

const listing = (known: string) => ({
  data: [
    {
      id: "newvendor/brand-new-model",
      name: "New Vendor: Brand New",
      context_length: 262144,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_parameters: ["reasoning", "temperature"],
      pricing: { prompt: "0.000001", completion: "0.000004" },
      top_provider: { context_length: 262144, max_completion_tokens: 32768 },
    },
    {
      id: "anthropic/claude-brand-new",
      name: "Anthropic: Claude Brand New",
      context_length: 500000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.000003", completion: "0.000015" },
      top_provider: { max_completion_tokens: null },
    },
    { id: known, context_length: 123456, pricing: { prompt: "0.000002", completion: "0.000002" }, top_provider: { max_completion_tokens: 4321 } },
    { id: "vendor/image-only", context_length: 1000, architecture: { output_modalities: ["image"] } },
    { id: "vendor/no-context" },
  ],
});

it("reads OpenRouter's listing into chat models with real limits and prices", () => {
  const models = parseOpenRouterModels(listing("x/y"));
  expect(models.map((m) => m.id)).toEqual(["newvendor/brand-new-model", "anthropic/claude-brand-new", "x/y"]);
  expect(models[0]).toMatchObject({ contextWindow: 262144, maxTokens: 32768, reasoning: true, input: ["text", "image"] });
  expect(models[0]!.cost).toMatchObject({ input: 1, output: 4 });
  // no published output limit: the reply may use what the context leaves
  expect(models[1]!.maxTokens).toBe(500000);
});

it("adds new models and updates shipped ones, taking request settings from the same vendor", async () => {
  const known = shipped();
  const changed = await refreshOpenRouterModels((async () => Response.json(listing(known.id))) as never, true);
  expect(changed).toBe(true);
  const models = openrouter().getModels();
  const updated = models.find((m) => m.id === known.id)!;
  expect(updated).toMatchObject({ contextWindow: 123456, maxTokens: 4321 });
  expect(updated.cost).toMatchObject({ input: 2, output: 2 });
  const fresh = models.find((m) => m.id === "anthropic/claude-brand-new")!;
  expect(fresh).toMatchObject({ api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", provider: "openrouter", contextWindow: 500000 });
  expect((fresh as { compat?: unknown }).compat).toEqual((known as { compat?: unknown }).compat);
  expect(models.some((m) => m.id === "newvendor/brand-new-model")).toBe(true);
  // the same list again is no change
  expect(await refreshOpenRouterModels((async () => Response.json(listing(known.id))) as never, true)).toBe(false);
});

it("lets a pasted OpenRouter id through without limits once the live list knows it", () => {
  const input = { name: "OR", providerId: "openrouter", models: [{ id: "newvendor/brand-new-model" }] };
  expect(validateConnectionInput(input).ok).toBe(false);
  setOpenRouterModels(parseOpenRouterModels(listing("x/y")));
  expect(validateConnectionInput(input).ok).toBe(true);
});
