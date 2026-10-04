import { expect, it } from "bun:test"
import type { EngineModel } from "../client-agent/src/api.js"
import { modelGroups, modelKey, searchModels } from "../client-agent/src/model-picker.js"

const model = (modelId: string, label: string, provider = "router", connectionName = "OpenRouter"): EngineModel => ({ provider, connectionName, modelId, label, reasoning: false, reasoningLevels: [], contextWindow: null })

it("finds a model across a large catalog using connection, family, and punctuation-free IDs", () => {
  const models = Array.from({ length: 500 }, (_, n) => model(`model-${n}`, `Model ${n}`))
  const target = model("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5")
  models.push(target, model("claude-sonnet-4.5", "Claude Sonnet 4.5", "direct", "Anthropic"))
  expect(searchModels(models, "openrouter claude 45", "")).toEqual([target])
  expect(searchModels(models, "claudesonnet45", "router")).toEqual([target])
  expect(searchModels(models, "sonnet", "direct")).toHaveLength(1)
  expect(searchModels(models, "missing", "")).toEqual([])
})

it("ranks exact names ahead of longer variants", () => {
  const exact = model("a", "GPT-4.1")
  const longer = model("b", "GPT-4.1 Mini")
  expect(searchModels([longer, exact], "gpt41", "")).toEqual([exact, longer])
})

it("keeps current, favorite, and recent models handy without duplicate or stale rows", () => {
  const models = [model("a", "A"), model("b", "B"), model("c", "C"), model("d", "D")]
  const groups = modelGroups(models, modelKey(models[0]!), [modelKey(models[0]!), modelKey(models[1]!), "gone"], [modelKey(models[1]!), modelKey(models[2]!)], false)
  expect(groups.map((group) => group.title)).toEqual(["Current", "Favorites", "Recent", "All models"])
  expect(groups.flatMap((group) => group.models)).toEqual(models)
  expect(modelGroups(models, "router/a", ["router/b"], [], true)).toEqual([{ title: "Results", models }])
})
