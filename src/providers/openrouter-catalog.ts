export interface RoutingProvider { slug: string; name: string }

export function parseRoutingProviders(body: unknown): RoutingProvider[] {
  const data = body && typeof body === "object" && "data" in body ? body.data : undefined;
  if (!Array.isArray(data) || !data.length) throw new Error("OpenRouter returned an empty provider catalog");
  const providers = new Map<string, RoutingProvider>();
  for (const item of data) {
    if (!item || typeof item.slug !== "string" || !item.slug.trim() || /\s/.test(item.slug) || typeof item.name !== "string" || !item.name.trim()) {
      throw new Error("OpenRouter returned an invalid provider catalog");
    }
    providers.set(item.slug, { slug: item.slug, name: item.name });
  }
  return [...providers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function createRoutingCatalog(fetcher: typeof fetch = fetch): () => Promise<RoutingProvider[]> {
  let cached: RoutingProvider[] | undefined;
  let expires = 0;
  let pending: Promise<RoutingProvider[]> | undefined;
  return () => {
    if (cached && Date.now() < expires) return Promise.resolve(cached);
    if (pending) return pending;
    pending = (async () => {
      const response = await fetcher("https://openrouter.ai/api/v1/providers", { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`OpenRouter provider catalog: HTTP ${response.status}`);
      const providers = parseRoutingProviders(await response.json());
      cached = providers;
      expires = Date.now() + 600_000;
      return providers;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
