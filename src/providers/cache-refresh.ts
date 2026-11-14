import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { GenerateRequest, GenerateResult } from "../models.js";
import { supportsAnthropicCache } from "./prompt-cache.js";

const REFRESH_APIS = new Set(["anthropic-messages", "openai-completions", "openai-responses", "azure-openai-responses", "google-generative-ai", "google-vertex", "bedrock-converse-stream"]);

/** Apply the cap after provider adaptation, preserving thinking and cache fields. */
export function capCacheRefreshPayload(api: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid cache refresh payload");
  const p = payload as Record<string, unknown>;
  if ("n" in p) p.n = 1;
  if ("best_of" in p) p.best_of = 1;
  if (api === "google-generative-ai" || api === "google-vertex") {
    p.config = { ...(p.config as Record<string, unknown>), maxOutputTokens: 16 };
  } else if (api === "openai-responses" || api === "azure-openai-responses") {
    p.max_output_tokens = 16;
  } else if (api === "bedrock-converse-stream") {
    p.inferenceConfig = { ...(p.inferenceConfig as Record<string, unknown>), maxTokens: 1 };
  } else if ("max_completion_tokens" in p) {
    p.max_completion_tokens = 1;
    if ("max_tokens" in p) p.max_tokens = 1;
  } else p.max_tokens = 1;
  return p;
}

function positiveCount(value: number | undefined): boolean {
  return Number.isFinite(value) && value! > 0;
}

type Snapshot = { owner: string; request: GenerateRequest; expiresAt: number; windowMs: number; busy: boolean };

/** Snapshots are process-local; tokens never grant access outside their app. */
export class PromptRefreshes {
  private snapshots = new Map<string, Snapshot>();
  constructor(private now: () => number = Date.now) {}

  remember(owner: string, request: GenerateRequest, result: GenerateResult, model: Model<Api>): NonNullable<GenerateResult["cacheRefresh"]> {
    const startedAt = result.startedAt ?? this.now();
    const explicit = supportsAnthropicCache(model) || model.api === "bedrock-converse-stream";
    // Automatic caches expose hits, not expiry. This is a replay safety limit.
    const windowMs = request.cache?.retention === "long" ? (explicit ? 3_600_000 : 86_400_000) : 300_000;
    const info = { startedAt, expiresAt: startedAt + windowMs, windowMs };
    let reason: string | undefined;
    if (request.cache?.retention === "none") reason = "Prompt caching is off";
    else if (!REFRESH_APIS.has(model.api)) reason = "This transport cannot bound cache refresh output";
    else if (explicit && (result.reasoningEnabled || (request.reasoning && request.reasoning !== "off") || request.thinkingBudget)) reason = "This transport cannot refresh thinking with a small output limit";
    else if (request.schema) reason = "Cache refresh is unavailable with structured output";
    else if (result.toolTrace?.length) reason = "Cache refresh is unavailable after a tool sequence";
    else if (!positiveCount(result.usage?.cacheRead) && !positiveCount(result.usage?.cacheWrite)) reason = "No cache usage was reported";
    else if (info.expiresAt <= this.now()) reason = "Refresh session elapsed during generation";
    if (reason) return { ...info, reason };
    this.prune();
    while (this.snapshots.size >= 32) this.snapshots.delete(this.snapshots.keys().next().value!);
    // Only data crosses the snapshot boundary; executors and abort signals expire.
    const { executeTool: _execute, onToolEvent: _event, signal: _signal, ...data } = request;
    const saved = structuredClone({ ...data, reasoning: result.effectiveReasoning ?? data.reasoning });
    const token = randomUUID();
    this.snapshots.set(token, { owner, request: saved, expiresAt: info.expiresAt, windowMs, busy: false });
    return { ...info, token };
  }

  async refresh(owner: string, token: string, generate: (req: GenerateRequest) => Promise<GenerateResult>): Promise<GenerateResult> {
    const saved = this.snapshots.get(token);
    if (!saved || saved.owner !== owner) throw new Error("Cache snapshot unavailable, send another message");
    if (saved.expiresAt <= this.now()) { this.snapshots.delete(token); throw new Error("Refresh session expired"); }
    if (saved.busy) throw new Error("Cache refresh already running");
    saved.busy = true;
    const startedAt = this.now();
    try {
      const result = await generate({ ...structuredClone(saved.request), captureCache: false, refreshOnly: true,
        ...(saved.request.tools?.length ? { executeTool: async () => { throw new Error("Cache refresh cannot execute tools"); } } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (result.model === "error" || !positiveCount(result.usage?.cacheRead)) this.snapshots.delete(token);
      else saved.expiresAt = startedAt + saved.windowMs;
      result.cacheRefresh = { token, startedAt, expiresAt: saved.expiresAt, windowMs: saved.windowMs };
      return result;
    } catch (e) {
      this.snapshots.delete(token);
      throw e;
    } finally { saved.busy = false; }
  }

  private prune(): void {
    for (const [key, value] of this.snapshots) if (value.expiresAt <= this.now() && !value.busy) this.snapshots.delete(key);
  }
}

export const promptRefreshes = new PromptRefreshes();
