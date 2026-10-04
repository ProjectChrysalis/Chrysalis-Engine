import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { generationError, providerError } from "../src/providers/errors.js";

describe("provider error details", () => {
  it.each(["content_filter", "refusal", "sensitive", "SAFETY", "guardrail_intervened", "incomplete.content_filter"])("keeps the raw stop reason %s", (rawStopReason) => {
    const message = generationError({
      ...fauxAssistantMessage("partial reply"),
      provider: "gateway", model: "model-id", stopReason: "error", rawStopReason,
      responseId: "response-123", errorMessage: "Provider declined the request",
    }).message;
    expect(message).toContain(`stop_reason: ${rawStopReason}`);
    expect(message).toContain("response: response-123");
    expect(message).toContain("gateway/model-id");
    expect(message).toContain("Provider declined the request");
  });

  it("does not invent a filtering reason when the provider supplies none", () => {
    const message = generationError({ ...fauxAssistantMessage(""), stopReason: "error" }).message;
    expect(message).toContain("Provider returned no error detail.");
    expect(message).not.toContain("content_filter");
  });

  it("includes HTTP status and structured error code without exposing request headers", () => {
    const original = Object.assign(new Error("Request failed"), {
      status: 403, error: { message: "Blocked by upstream", type: "permission_error", code: "content_filter" },
      headers: { authorization: "secret-credential" },
    });
    const error = providerError(original);
    expect(error.message).toContain("403");
    expect(error.message).toContain("content_filter");
    expect(error.message).toContain("Blocked by upstream");
    expect(error.message).not.toContain("secret-credential");
    expect(error.cause).toBe(original);
  });

  it("retains HTTP status even without a response body", () => {
    expect(providerError(Object.assign(new Error("Too many requests"), { statusCode: 429 })).message)
      .toBe("Provider error (429): Too many requests");
  });

  it("preserves local errors and their stack", () => {
    const error = new Error("Connection refused");
    expect(providerError(error)).toBe(error);
  });
});
