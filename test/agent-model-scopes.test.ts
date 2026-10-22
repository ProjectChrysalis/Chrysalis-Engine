import { expect, it } from "bun:test"
import { agentModelScopes, searchAgentModelScopes, type AgentCatalogModel } from "../client/src/agent-model-scopes.js"

const model = (modelId: string, label: string, provider = "router", connectionName = "OpenRouter"): AgentCatalogModel => ({ modelId, label, provider, connectionName, contextWindow: 128000 })

it("keeps defaults, the selected model, and configured models ahead of a large catalog", () => {
  const models = Array.from({ length: 5000 }, (_, index) => model(`model-${index}`, `Model ${index}`))
  const scopes = agentModelScopes(models, ["router/model-4999", "missing/saved"], "router/model-4998", "Agent defaults")
  expect(scopes.slice(0, 4).map((item) => item.ref)).toEqual(["", "router/model-4998", "missing/saved", "router/model-4999"])
  expect(new Set(scopes.map((item) => item.ref)).size).toBe(5002)
  expect(searchAgentModelScopes(scopes, "model 4999").map((item) => item.ref)).toEqual(["router/model-4999"])
  expect(searchAgentModelScopes(scopes, "missing saved").map((item) => item.ref)).toEqual(["missing/saved"])
})

it("searches names, punctuation-free IDs and connections without merging duplicate model names", () => {
  const scopes = agentModelScopes([
    model("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5"),
    model("claude-sonnet-4.5", "Claude Sonnet 4.5", "direct", "Anthropic"),
    model("anthropic/claude-sonnet-4.5-long", "Claude Sonnet 4.5 Long"),
  ], ["router/anthropic/claude-sonnet-4.5-long"], "", "Agent defaults")
  expect(searchAgentModelScopes(scopes, "openrouter claude 45")).toHaveLength(2)
  expect(searchAgentModelScopes(scopes, "claudesonnet45")[0]?.ref).toBe("direct/claude-sonnet-4.5")
  expect(searchAgentModelScopes(scopes, "direct claude").map((item) => item.ref)).toEqual(["direct/claude-sonnet-4.5"])
  expect(searchAgentModelScopes(scopes, "unknown")).toEqual([])
  expect(searchAgentModelScopes(scopes, "agent defaults").map((item) => item.ref)).toEqual([""])
})
