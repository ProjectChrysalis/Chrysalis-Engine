import { expect, it } from "bun:test";
import { createRoutingCatalog, parseRoutingProviders } from "../src/providers/openrouter-catalog.js";
import { routingBody, routingDraft, toggleRoutingSelection, moveRoutingSelection } from "../client/src/openrouter-routing-state.js";

it("uses reported provider names and IDs and rejects missing catalogs", () => {
  expect(parseRoutingProviders({ data: [{ name: "Google", slug: "google-vertex" }, { name: "DeepInfra", slug: "deepinfra" }] })).toEqual([{ name: "DeepInfra", slug: "deepinfra" }, { name: "Google", slug: "google-vertex" }]);
  for (const body of [{}, { data: [] }, { data: [{ name: "Google" }] }]) expect(() => parseRoutingProviders(body)).toThrow();
});

it("shares in-flight catalog requests, caches success, and retries failures", async () => {
  let calls = 0;
  const fetcher = Object.assign(async () => {
    calls++;
    if (calls === 1) return new Response("", { status: 503 });
    return Response.json({ data: [{ name: "DeepInfra", slug: "deepinfra" }] });
  }, { preconnect: fetch.preconnect });
  const catalog = createRoutingCatalog(fetcher);
  await expect(catalog()).rejects.toThrow("HTTP 503");
  const [first, second] = await Promise.all([catalog(), catalog()]);
  expect(first).toEqual([{ name: "DeepInfra", slug: "deepinfra" }]);
  expect(second).toEqual(first);
  expect(await catalog()).toEqual(first);
  expect(calls).toBe(2);
});

it("picks providers without typing IDs, resolves allowed/blocked conflicts and preserves priority", () => {
  let draft = routingDraft({ only: ["saved/endpoint"], ignore: ["deepinfra"] });
  draft = toggleRoutingSelection(draft, "only", "deepinfra");
  expect(routingBody(draft)).toEqual({ only: ["saved/endpoint", "deepinfra"] });
  draft = toggleRoutingSelection(draft, "order", "google-vertex");
  draft = toggleRoutingSelection(draft, "order", "deepinfra");
  draft = moveRoutingSelection(draft, "deepinfra", -1);
  expect(routingBody(draft)?.order).toEqual(["deepinfra", "google-vertex"]);
  draft = toggleRoutingSelection(draft, "only", "saved/endpoint");
  expect(routingBody(draft)?.only).toEqual(["deepinfra"]);
  draft = toggleRoutingSelection(draft, "quantizations", "bf16");
  expect(routingBody(draft)?.quantizations).toEqual(["bf16"]);
});
