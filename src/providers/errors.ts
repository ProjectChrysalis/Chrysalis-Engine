import type { AssistantMessage } from "@earendil-works/pi-ai";
import { formatProviderError, normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";

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
