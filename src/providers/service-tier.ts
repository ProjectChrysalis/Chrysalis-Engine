import type { Api, Model, Provider } from "@earendil-works/pi-ai";

/** Gemini models the Flex tier serves; the rest stay on the standard tier at standard prices. */
const FLEX_MODEL = /^gemini-(?:2\.5-(?:pro|flash)|[3-9])/;

export const flexEligible = (model: Pick<Model<Api>, "api" | "id">): boolean =>
  model.api === "google-generative-ai" && FLEX_MODEL.test(model.id);

/**
 * The Gemini API's Flex tier: half the standard rate per token, slower, and
 * refused rather than moved to the standard tier when capacity is short. A
 * request that succeeds was billed at Flex rates, so eligible models carry
 * halved prices and every cost the engine reports follows from them.
 */
export function withFlexTier(provider: Provider): Provider {
  const halve = <M extends Model<Api>>(model: M): M => flexEligible(model)
    ? { ...model, cost: Object.fromEntries(Object.entries(model.cost).map(([key, value]) => [key, typeof value === "number" ? value / 2 : value])) as M["cost"] }
    : model;
  const tiered = <O extends { onPayload?: (payload: unknown, model: Model<Api>) => unknown } | undefined>(model: Model<Api>, options: O): O => {
    if (!flexEligible(model)) return options;
    const previous = options?.onPayload;
    return {
      ...options,
      onPayload: async (payload: unknown, m: Model<Api>) => {
        const next = (previous ? await previous(payload, m) : undefined) ?? payload;
        if (next && typeof next === "object") {
          const body = next as { config?: Record<string, unknown> };
          body.config = { ...body.config, serviceTier: "flex" };
        }
        return next;
      },
    } as O;
  };
  return {
    ...provider,
    getModels: () => provider.getModels().map(halve),
    ...(provider.getAllModels ? { getAllModels: () => provider.getAllModels!().map((model) => (model.type && model.type !== "chat" ? model : halve(model as Model<Api>))) } : {}),
    stream: (model, context, options) => provider.stream(model, context, tiered(model as Model<Api>, options as never)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, tiered(model, options as never)),
  } as Provider;
}
