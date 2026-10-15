import type { AssistantMessage, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { formatProviderError, normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

function googlePromptFeedback(
  start: (options: StreamOptions) => AssistantMessageEventStream,
  options: StreamOptions = {},
): AssistantMessageEventStream {
  let blockReason: string | undefined;
  let responseId: string | undefined;
  const source = start({
    ...options,
    onProviderStreamEvent: async (data, model) => {
      if (data && typeof data === "object") {
        const chunk = data as { responseId?: unknown; promptFeedback?: { blockReason?: unknown } };
        if (typeof chunk.responseId === "string") responseId ??= chunk.responseId;
        const reason = chunk.promptFeedback?.blockReason;
        if (typeof reason === "string" && reason && reason !== "BLOCK_REASON_UNSPECIFIED") blockReason = reason;
      }
      await options.onProviderStreamEvent?.(data, model);
    },
  });
  const output = new AssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "error" && blockReason && event.reason !== "aborted" &&
          (event.error.errorMessage === "Google stream ended without a finish reason" ||
            event.error.errorMessage === "Google Vertex stream ended without a finish reason")) {
          output.push({ ...event, error: {
            ...event.error,
            rawStopReason: blockReason,
            ...(responseId ? { responseId } : {}),
            errorMessage: `Google blocked the prompt: ${blockReason}`,
          } });
        } else output.push(event);
      }
    } finally { output.end(await source.result()); }
  })();
  return output;
}

export function withGooglePromptFeedback(provider: Provider): Provider {
  return {
    ...provider,
    stream: (model, context, options) => model.api === "google-generative-ai" || model.api === "google-vertex"
      ? googlePromptFeedback((observed) => provider.stream(model, context, { ...options, onProviderStreamEvent: observed.onProviderStreamEvent } as NonNullable<typeof options>), options)
      : provider.stream(model, context, options),
    streamSimple: (model, context, options) => model.api === "google-generative-ai" || model.api === "google-vertex"
      ? googlePromptFeedback((observed) => provider.streamSimple(model, context, { ...options, onProviderStreamEvent: observed.onProviderStreamEvent }), options)
      : provider.streamSimple(model, context, options),
  };
}

/** Keep provider-native reasons intact instead of guessing a cause from prose. */
export function generationError(message: AssistantMessage): Error {
  const details = [
    ...(message.rawStopReason ? [`stop_reason: ${message.rawStopReason}`] : []),
    ...(message.responseId ? [`response: ${message.responseId}`] : []),
  ];
  return new Error(`${message.provider}/${message.model} failed${details.length ? ` (${details.join("; ")})` : ""}: ${message.errorMessage || "Provider returned no error detail."}`);
}

export function providerError(error: unknown): Error {
  const message = formatProviderError(normalizeProviderError(error), "Provider error");
  return error instanceof Error && error.message === message ? error : new Error(message, { cause: error });
}
