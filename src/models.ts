/**
 * Model layer bridge (SPEC §5.5): per-user pi-ai runtimes.
 * SECURITY INVARIANT: provider credentials NEVER leave this module —
 * scripts/plugins/looks only ever reach llm.generate through here.
 */
import fs from "node:fs";
import path from "node:path";
import { createModels, getSupportedThinkingLevels, uuidv7, type Api, type AssistantMessage, type AssistantMessageEvent, type Context, type Credential, type CredentialInfo, type Message, type Model, type MutableModels, type Tool as PiTool, type ToolResultMessage, type Usage } from "@earendil-works/pi-ai";
import type { AuthOperationOptions, CredentialStore } from "@earendil-works/pi-ai";
import { builtinProviders, builtinImagesModels } from "@earendil-works/pi-ai/providers/all";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import { loadCustomProviders, curatedProviders, buildProvider, reservedProviderIds, isLocalEndpoint, abortLocalGeneration, type CredentialWithBinding } from "./providers/custom.js";
import { readConnections, authTarget, connectionKeyUsable, readAuth } from "./connections.js";
import { formatFromModelName, formatFromTemplate, parsePromptFormat, promptFormatById, renderPrompt, stopStrings, type PromptFormat } from "./providers/prompt-formats.js";
import { log } from "./logger.js";
import { llmLogRequest, llmLogResult, llmLogError, llmLogTool } from "./llm-logger.js";
import type { UserPaths } from "./paths.js";
import type { InstanceConfig } from "./config.js";

/** File-backed CredentialStore over the user's auth.json (outside git). */
class FileCredentialStore implements CredentialStore {
  constructor(private file: string) {}

  private readAll(): Record<string, Credential> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, Credential>;
    } catch {
      return {};
    }
  }

  private writeAll(data: Record<string, Credential>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    void _options;
    return this.readAll()[providerId];
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    void _options;
    return Object.entries(this.readAll()).map(([providerId, c]) => ({
      providerId,
      type: c.type,
    })) as CredentialInfo[];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    void _options;
    const all = this.readAll();
    const next = await fn(all[providerId]);
    if (next === undefined) delete all[providerId];
    else all[providerId] = next;
    this.writeAll(all);
    return next;
  }

  async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    void _options;
    const all = this.readAll();
    delete all[providerId];
    this.writeAll(all);
  }
}

/** One selectable image model. `provider` is the builtin provider id or the
 *  connection id serving it; "<provider>/<id>" is the ref requests carry. */
export interface ImageModelInfo {
  provider: string;
  id: string;
  label: string;
  api: string;
  connectionName: string | null;
}

/** Hosts whose chat endpoint serves a builtin image catalog. */
const IMAGE_CATALOG_HOSTS: readonly { host: string; catalog: string }[] = [{ host: "openrouter.ai", catalog: "openrouter" }];

export interface ModelInfo {
  provider: string;
  modelId: string;
  api: string;
  label: string;
  contextWindow: number | null;
  /** Display name of the named connection this model belongs to, if any. */
  connectionName: string | null;
  /** Model accepts a thinking/reasoning level. */
  reasoning: boolean;
  /** Thinking levels this model supports, per pi-ai's getSupportedThinkingLevels. */
  reasoningLevels: string[];
  /** USD per million tokens (user override first, then the catalog). null when
   *  nobody knows what this model costs — spend for it is NOT reported. */
  pricing: ModelPricing | null;
}

/** USD per million tokens, the unit every catalog and price page quotes. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface GenerateRequest {
  /**
   * Chat turns sent to the model. `system` entries are allowed anywhere in
   * the array (prompt managers let apps place system-role blocks mid-prompt).
   * Only the LEADING run of them becomes the provider system prompt — pi-ai's
   * Context carries just one — and any later system entry keeps its index and
   * is sent as a user turn, because where it sits is what it means.
   */
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  systemPrompt?: string;
  model?: string | null; // "provider/model-id" or null = default/first available
  /** Stable id for this conversation (chat id, agent session, …). Keys
   *  provider prompt caching and, on opencode.ai endpoints, the
   *  routing/caching session headers; a fresh id is generated when a
   *  stateless caller omits it. */
  sessionId?: string;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "med";
  /** Cap thinking tokens for the active level (pi-ai thinkingBudgets;
   *  token-based providers only, ignored elsewhere). */
  thinkingBudget?: number;
  /** Inline-thinking parse: providers that emit raw <think>…</think> in the
   *  text get it split into `reasoning` + answer before the result returns. */
  reasoningTags?: { open: string; close: string };
  /** Echo-only metadata (assistant prefill): the kernel does not use it for
   *  generation; it rides back on the result so two-phase callers can read
   *  pass-A state in pass B without their own module state (which resets). */
  assistantPrefill?: string;
  /** Text completion connections only: the instruct format to write the chat
   *  in, overriding the connection's own setting. A format id, "auto" to
   *  match the loaded model, or a custom format. */
  promptFormat?: string | PromptFormat;
  presetParams?: {
    temperature?: number;
    max_tokens?: number;
    /** Arbitrary sampler keys (top_p, top_k, min_p, repetition_penalty, ...) —
     *  pi-ai passes them through to OpenAI-compatible endpoints (samplingParams);
     *  other APIs ignore unknown keys. */
    params?: Record<string, unknown>;
  };
  /** Opt-in tool calling (SPEC §5.3): tools exposed to the model + executor. */
  tools?: PiTool[];
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
  /** Live tool-call progress (in-process callback, same trust as executeTool):
   *  start fires before execution, end after, with the result. */
  onToolEvent?: (ev: { phase: "start" | "end"; name: string; args: Record<string, unknown>; result?: { text: string; isError: boolean } }) => void;
  /** Structured output (JSON Schema, object root): forces a __structured_output tool call; result lands in `json`. */
  schema?: Record<string, unknown>;
  /** Abort: cancels the provider stream; whatever partial text exists is
   *  salvaged and returned so a cancelled reply can commit mid-sentence. */
  signal?: AbortSignal;
  /** Trace tag for the console LLM log ("app:roleplay/engine", "api:/v1/chat/completions", …). */
  source?: string;
}

export interface GenerateResult {
  text: string;
  /** Reasoning-model thinking (provider-reported ThinkingContent, or inline
   *  tags split out via reasoningTags) — separate from the answer text. */
  reasoning?: string;
  /** Measured thinking span (first thinking_start → last thinking_end). */
  reasoningTimeMs?: number;
  /** Total wall time of the generation (measured by the traced generate()). */
  genTimeMs?: number;
  /** Echo of the request's presetParams (sampler snapshot for the caller). */
  requestParams?: GenerateRequest["presetParams"];
  /** Echo of the request's assistantPrefill metadata. */
  assistantPrefill?: string;
  /** Parsed structured output when `schema` was requested and the model complied. */
  json?: unknown;
  model: string;
  /** Set on synthesized failure results (model: "error"): the underlying
   *  failure text (provider finish_reason, transport error, …) so routes can
   *  surface the real cause instead of a generic connectivity hint. */
  error?: string;
  /** `priced` says whether costTotal came from a real price table. When it is
   *  false the model has no known rates and costTotal is meaningless — callers
   *  must report "unknown", never "$0.00". */
  usage: { input: number; output: number; reasoning?: number; cacheRead: number; cacheWrite: number; costTotal: number; priced: boolean };
  toolTrace?: { name: string; args: Record<string, unknown>; resultText: string; isError: boolean }[];
  /** Interleaved generation segments in true arrival order (only when tools
   *  were used): thinking, text, each tool call with its result, more thinking
   *  or text — nothing consolidated, the timeline as it happened. */
  parts?: ({ type: "text"; text: string } | { type: "thinking"; text: string; ms?: number } | { type: "tool"; name: string; args: Record<string, unknown>; resultText: string; isError: boolean })[];
}

/** OpenCode Zen/Go gateway session headers: a stable per-conversation id is
 *  what keeps a chat's turns routed to the one upstream inference the gateway
 *  picked for it (routing + prompt caching). Sent only to opencode.ai
 *  endpoints; every other provider never sees them. */
const OPENCODE_HOST = "opencode.ai";

function isOpencodeModel(model: Model<Api>): boolean {
  if (model.provider === "opencode" || model.provider === "opencode-go") return true;
  try {
    return new URL(model.baseUrl).hostname === OPENCODE_HOST;
  } catch {
    return false;
  }
}

function opencodeSessionHeaders(model: Model<Api>, sessionId: string): Record<string, string> | undefined {
  return isOpencodeModel(model) ? { "x-opencode-session": sessionId, "x-opencode-client": "chrysalis" } : undefined;
}

/** Per-user model service. One instance per user, cached by the server. */
const STRUCTURED_TOOL = "__structured_output";

/** Accept a price record only when it is complete and non-negative, and only
 *  when something actually costs money — an all-zero table is "no price
 *  known", not "free". */
function normalizePricing(v: unknown): ModelPricing | null {
  if (!v || typeof v !== "object") return null;
  const raw = v as Record<string, unknown>;
  const rate = (k: string): number | null => {
    const n = raw[k];
    if (n === undefined || n === null) return 0;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const input = rate("input"), output = rate("output"), cacheRead = rate("cacheRead"), cacheWrite = rate("cacheWrite");
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  return { input, output, cacheRead, cacheWrite };
}

/** app effort levels → pi-ai thinkingBudgets keys (token-based providers) */
const BUDGET_KEY: Record<string, "minimal" | "low" | "medium" | "high"> = {
  minimal: "minimal", low: "low", medium: "medium", med: "medium", high: "high", xhigh: "high", max: "high",
};

/** Split raw inline thinking (e.g. "<think>…</think>") out of a reply. Handles
 *  tags anywhere in the text and an unclosed tag (stream cut mid-think). */
function splitThinkingTags(text: string, open: string, close: string): { reasoning: string; text: string } {
  const i = text.indexOf(open);
  if (i < 0) return { reasoning: "", text };
  const j = text.indexOf(close, i + open.length);
  if (j < 0) {
    return { reasoning: text.slice(i + open.length).trim(), text: text.slice(0, i).trim() };
  }
  return {
    reasoning: text.slice(i + open.length, j).trim(),
    text: (text.slice(0, i) + text.slice(j + close.length)).trim(),
  };
}

/** How a text completion request's format was chosen: named by the request
 *  or the connection, read from the loaded model's template, guessed from
 *  the model name, or the ChatML fallback when nothing said. */
export type PromptFormatSource = "request" | "connection" | "template" | "model name" | "fallback";

export interface ResolvedPromptFormat {
  /** A format id, or "custom". */
  id: string;
  name: string;
  format: PromptFormat;
  source: PromptFormatSource;
}

const FORMAT_DETECT_TTL = 60_000;

export class UserModelService {
  readonly models: MutableModels;
  /** image-generation side (pi-ai images API) — same credential store */
  private images: ReturnType<typeof builtinImagesModels>;

  constructor(
    readonly username: string,
    private paths: UserPaths,
    private instanceConfig: InstanceConfig,
  ) {
    const credentials = new FileCredentialStore(paths.auth);
    const models = createModels({ credentials });
    for (const provider of builtinProviders()) models.setProvider(provider);
    // curated (NanoGPT etc. — inert until key exists) + user-defined providers;
    // user providers.json upserts over curated by id (setProvider semantics)
    const readCredential = (id: string): CredentialWithBinding => readAuth(paths)[id] as CredentialWithBinding;
    for (const provider of curatedProviders()) models.setProvider(provider);
    for (const provider of loadCustomProviders(paths.root + "/providers.json", readCredential)) models.setProvider(provider);
    // named connections (connections.json + key in auth.json) — user-named
    // providers/endpoints selectable across every app. Builtin-kind connections
    // only LABEL an existing provider; custom ones register a c_* provider.
    const conns = readConnections(paths);
    const reserved = reservedProviderIds();
    for (const [id, def] of Object.entries(conns.connections)) {
      if (def.providerId) continue; // builtin: provider already registered above
      if (def.oauthProvider === "radius" && def.gateway) {
        // Radius gateway (OAuth): dedicated pi-ai provider bound to the user's
        // gateway — only the one the sign-in was made against
        if (!connectionKeyUsable(def, id, readAuth(paths).radius)) {
          log.warn(`[connection:${id}] Radius sign-in is not for ${def.gateway} — sign in again`);
          continue;
        }
        models.setProvider(radiusProvider({ name: def.name, gateway: def.gateway }));
        continue;
      }
      if (!def.baseUrl || !/^https?:\/\//.test(def.baseUrl) || !def.api) continue;
      if (reserved.has(id)) {
        log.warn(`[connection:${id}] skipped: that id belongs to a built-in provider`);
        continue;
      }
      try {
        // Text-completion connections (the 2026 local serving stack: llama.cpp
        // llama-server, vLLM, TabbyAPI, Aphrodite) ride the OpenAI-compatible
        // /v1/completions protocol with a flattened prompt. They register as
        // openai-completions purely so the catalog/model plumbing accepts
        // them; generate() routes them to the text transport below instead.
        if (def.api === "openai-text") {
          this.textCompletions.set(id, { name: def.name, baseUrl: def.baseUrl, promptFormat: def.promptFormat ?? "auto", ...(def.promptFormatCustom ? { promptFormatCustom: def.promptFormatCustom } : {}) });
          models.setProvider(buildProvider(id, { name: def.name, api: "openai-completions", baseUrl: def.baseUrl, models: def.models ?? "auto" }, { keyless: true, readCredential }));
        } else {
          models.setProvider(buildProvider(id, { name: def.name, api: def.api, baseUrl: def.baseUrl, models: def.models ?? "auto" }, { keyless: true, readCredential }));
        }
      } catch (e) {
        log.warn(`[connection:${id}] failed: ${(e as Error).message}`);
      }
    }
    this.connectionNames = new Map(
      Object.entries(conns.connections).map(([id, def]) => [def.oauthProvider === "radius" ? "radius" : def.providerId ?? id, def.name]),
    );
    this.models = models;
    this.images = builtinImagesModels({ credentials });
  }

  private connectionNames: Map<string, string> = new Map();
  /** openai-text connections by provider id: prompt-flattened /v1/completions transports */
  private textCompletions = new Map<string, { name: string; baseUrl: string; promptFormat: string; promptFormatCustom?: PromptFormat }>();
  /** Formats read from a server's loaded model, by endpoint and model. A
   *  local server can swap models under the same name, so answers expire. */
  private detectedFormats = new Map<string, { id: string | null; source: PromptFormatSource; at: number }>();

  /** Dynamic catalogs (connections / providers.json "auto") need one refresh
   *  per service lifetime; getAvailable alone returns only the last snapshot. */
  private refreshOnce: Promise<void> | null = null;

  /** Per-user context-window overrides (model-overrides.json, keyed by
   *  "<provider>/<model>"): the value attached to the model wins over the
   *  catalog's official number. Proxies serve models under ids the catalog
   *  guesses wrong or not at all; the user's number is the truth. */
  contextOverrides(): Record<string, number> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.paths.root, "model-overrides.json"), "utf8")) as Record<string, unknown>;
      const out: Record<string, number> = {};
      for (const [ref, v] of Object.entries(raw)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0 && ref.includes("/")) out[ref] = Math.floor(v);
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Set (or clear with null) one model's context override. Returns the file's
   *  new contents so callers can report state without a re-read. */
  setContextOverride(ref: string, context: number | null): Record<string, number> {
    const file = this.contextOverrides();
    if (context == null) delete file[ref];
    else file[ref] = Math.floor(context);
    fs.writeFileSync(path.join(this.paths.root, "model-overrides.json"), JSON.stringify(file, null, 2));
    return file;
  }

  /** Per-user price table (model-pricing.json, keyed by "<provider>/<model>",
   *  USD per million tokens). Custom endpoints and proxies carry no catalog
   *  prices at all, so without this their spend is simply unknown. */
  pricingOverrides(): Record<string, ModelPricing> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.paths.root, "model-pricing.json"), "utf8")) as Record<string, unknown>;
      const out: Record<string, ModelPricing> = {};
      for (const [ref, v] of Object.entries(raw)) {
        const p = normalizePricing(v);
        if (p && ref.includes("/")) out[ref] = p;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Set (or clear with null) one model's prices. Returns the new file. */
  setPricingOverride(ref: string, pricing: ModelPricing | null): Record<string, ModelPricing> {
    const file = this.pricingOverrides();
    if (pricing == null) delete file[ref];
    else file[ref] = pricing;
    fs.writeFileSync(path.join(this.paths.root, "model-pricing.json"), JSON.stringify(file, null, 2));
    return file;
  }

  /** The rates that actually apply to a model: the user's table first, then
   *  the catalog. null when neither quotes a price. */
  private pricingFor(m: { provider: string; id: string; cost?: unknown }): ModelPricing | null {
    return this.pricingOverrides()[`${m.provider}/${m.id}`] ?? normalizePricing(m.cost);
  }

  /** Spend for one generation, or null when the model has no known rates. */
  private priceUsage(m: { provider: string; id: string; cost?: unknown }, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | null {
    const p = this.pricingFor(m);
    if (!p) return null;
    return (
      (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1_000_000
    );
  }


  private ensureRefreshed(): Promise<void> {
    if (!this.refreshOnce) {
      this.refreshOnce = (this.models as unknown as { refresh: () => Promise<unknown> })
        .refresh()
        .then(() => undefined)
        .catch((e) => {
          log.warn(`[models] catalog refresh failed: ${(e as Error).message}`);
        });
    }
    return this.refreshOnce;
  }

  /** Text embeddings through the user's OpenAI-compatible connections
   *  (POST <baseUrl>/embeddings). Tries each keyed custom connection until
   *  one answers; null when none can — callers fall back to lexical. */
  /** Name of the connection that last answered an embed call (for the
   *  honest status line; null until one does). */
  embedVia: string | null = null;

  /** Embeddings model name: explicit arg > the user's engine setting
   *  (settings.json embedModel, e.g. for non-OpenAI compatible providers)
   *  > the OpenAI default. */
  private embedModelName(model?: string): string {
    if (model && model.trim()) return model;
    try {
      const st = JSON.parse(fs.readFileSync(path.join(this.paths.root, "settings.json"), "utf8")) as { embedModel?: unknown };
      if (typeof st.embedModel === "string" && st.embedModel.trim()) return st.embedModel.trim();
    } catch { /* default */ }
    return "text-embedding-3-small";
  }

  async embed(texts: string[], model?: string): Promise<number[][] | null> {
    const clean = texts.map((t) => String(t).slice(0, 8000)).filter((t) => t.trim());
    if (!clean.length) return null;
    const embedModel = this.embedModelName(model);
    const conns = readConnections(this.paths);
    const auth = new FileCredentialStore(this.paths.auth);
    for (const [id, def] of Object.entries(conns.connections)) {
      if (def.providerId || !def.baseUrl || !def.api) continue;
      // https for public endpoints; plain http only for local model stacks
      try {
        if (new URL(def.baseUrl).protocol !== "https:" && !isLocalEndpoint(def.baseUrl)) continue;
      } catch { continue; }
      const target = authTarget(def, id);
      const cred = await auth.read(target);
      if (!cred || cred.type !== "api_key" || !cred.key) continue;
      if (!connectionKeyUsable(def, id, cred)) continue;
      try {
        const res = await fetch(def.baseUrl.replace(/\/$/, "") + "/embeddings", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cred.key}` },
          body: JSON.stringify({ model: embedModel, input: clean }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { data?: { embedding?: number[] }[] };
        const out = (body.data ?? []).map((d) => d.embedding).filter((v): v is number[] => Array.isArray(v));
        if (out.length === clean.length) {
          this.embedVia = def.name ?? id;
          return out;
        }
      } catch { /* try the next connection */ }
    }
    return null;
  }

  /** One tiny live call: can any connection embed? Powers the status line. */
  async embedProbe(): Promise<{ ok: boolean; via: string | null }> {
    const out = await this.embed(["connection check"]);
    return { ok: Array.isArray(out) && out.length === 1, via: out ? this.embedVia : null };
  }

  async available(): Promise<ModelInfo[]> {
    await this.ensureRefreshed();
    const overrides = this.contextOverrides();
    const pricing = this.pricingOverrides();
    return (await this.models.getAvailable()).map((m) => ({
      provider: m.provider,
      modelId: m.id,
      api: this.textCompletions.has(m.provider) ? "openai-text" : String(m.api),
      label: m.name,
      contextWindow: overrides[`${m.provider}/${m.id}`] ?? (m.contextWindow || null),
      connectionName: this.connectionNames.get(m.provider) ?? null,
      reasoning: m.reasoning === true,
      reasoningLevels: getSupportedThinkingLevels(m),
      pricing: pricing[`${m.provider}/${m.id}`] ?? normalizePricing(m.cost),
    }));
  }

  async hasAnyModel(): Promise<boolean> {
    return (await this.available()).length > 0;
  }

  /** Generation runs on the resolved model object, so the context override
   *  must land here too — not just in the reported list. */
  withOverride(m: Model<Api>): Model<Api> {
    const ctx = this.contextOverrides()[`${m.provider}/${m.id}`];
    return ctx ? { ...m, contextWindow: ctx } : m;
  }

  private async resolveModel(pattern: string | null | undefined): Promise<Model<Api>> {
    const available = await this.models.getAvailable();
    if (available.length === 0) {
      throw new ModelNotConfiguredError(
        `No model providers configured for user "${this.username}". ` +
          `Place a pi-ai auth.json in ${this.paths.auth} (API key or OAuth credential) and restart.`,
      );
    }
    if (pattern) {
      const found = available.find((m) => `${m.provider}/${m.id}` === pattern || m.id === pattern);
      if (found) return this.withOverride(found);
      // a model the caller named is never swapped for another: a chat pinned
      // to a local stack would otherwise go to a cloud provider (and bill it)
      // the moment its connection went offline or lost its key
      throw new ModelNotConfiguredError(`The model "${pattern}" is not available: its connection is missing, offline, or has no usable key.`);
    }
    // user-level default from settings.json (agent-editable, per-user)
    try {
      const user = JSON.parse(fs.readFileSync(this.paths.settings, "utf8")) as { model?: string };
      if (user.model) {
        const found = available.find((m) => `${m.provider}/${m.id}` === user.model || m.id === user.model);
        if (found) return this.withOverride(found);
      }
    } catch {
      /* no settings.json yet */
    }
    const def = this.instanceConfig.defaultModel;
    if (def) {
      const found = available.find((m) => `${m.provider}/${m.id}` === def || m.id === def);
      if (found) return this.withOverride(found);
    }
    return this.withOverride(available[0]!);
  }

  /**
   * The scoped llm bridge (SPEC §5.6). All provider calls funnel through here;
   * credentials never escape. onDelta streams text deltas to the caller.
   * When req.tools + req.executeTool are provided, runs the tool loop
   * (bounded) until the model stops requesting tools.
   */
  /**
   * Traced entry point: every generation prints its request and outcome to
   * the engine console (see llm-logger) — apps, plugins and API callers all
   * funnel through here. The real work happens in generateInner.
   */
  async generate(req: GenerateRequest, onDelta?: (delta: string) => void, onThinking?: (delta: string) => void): Promise<GenerateResult> {
    const t0 = Date.now();
    const label = req.model ?? "default-model";
    try {
      const res = await this.generateWithReasoningFloor(req, onDelta, onThinking);
      llmLogResult(req.source, res.model || label, Date.now() - t0, res);
      // stateless echoes for two-phase callers (their module state resets
      // between passes): timing, sampler snapshot, prefill metadata
      res.genTimeMs = Date.now() - t0;
      if (req.presetParams && Object.keys(req.presetParams).length > 0) res.requestParams = req.presetParams;
      if (req.assistantPrefill) res.assistantPrefill = req.assistantPrefill;
      return res;
    } catch (e) {
      llmLogError(req.source, label, Date.now() - t0, e);
      throw e;
    }
  }

  /** Models that refused a request with reasoning switched off, by ref, and
   *  the lowest level they accept instead. */
  private reasoningFloor = new Map<string, NonNullable<GenerateRequest["reasoning"]>>();

  /** A request that names no reasoning level goes out with reasoning off, and
   *  some models cannot turn it off. Such a refusal retries once at the
   *  model's lowest level, and later requests to that model start there. */
  private async generateWithReasoningFloor(req: GenerateRequest, onDelta?: (delta: string) => void, onThinking?: (delta: string) => void): Promise<GenerateResult> {
    const unset = !req.reasoning || req.reasoning === "off";
    const known = unset && req.model ? this.reasoningFloor.get(req.model) : undefined;
    try {
      return await this.generateInner(known ? { ...req, reasoning: known } : req, onDelta, onThinking);
    } catch (e) {
      if (!unset || known || !/reasoning is mandatory|cannot be disabled|reasoning.{0,40}required/i.test((e as Error).message)) throw e;
      const model = await this.resolveModel(req.model).catch(() => null);
      const lowest = (model ? getSupportedThinkingLevels(model) : []).find((l) => l !== "off") ?? "low";
      const level = lowest as NonNullable<GenerateRequest["reasoning"]>;
      if (req.model) this.reasoningFloor.set(req.model, level);
      return this.generateInner({ ...req, reasoning: level }, onDelta, onThinking);
    }
  }

  /**
   * The instruct format a text completion request is written in, and where
   * that choice came from. The request's own choice wins, then the
   * connection's; "auto" reads the loaded model's chat template from the
   * server, falls back to the model's name, and lands on ChatML only when
   * neither says anything.
   */
  async resolvePromptFormat(provider: string, modelId: string, requested?: string | PromptFormat): Promise<ResolvedPromptFormat | null> {
    const entry = this.textCompletions.get(provider);
    if (!entry) return null;
    const custom = (format: PromptFormat | null | undefined, source: PromptFormatSource): ResolvedPromptFormat | null =>
      format ? { id: "custom", name: "Custom", format, source } : null;
    const named = (id: string, source: PromptFormatSource): ResolvedPromptFormat | null => {
      const found = promptFormatById(id);
      return found ? { id: found.id, name: found.name, format: found, source } : null;
    };
    if (requested !== undefined && requested !== "auto") {
      const picked = typeof requested === "string" ? named(requested, "request") : custom(parsePromptFormat(requested), "request");
      if (picked) return picked;
    }
    if (requested === undefined && entry.promptFormat !== "auto") {
      const picked = entry.promptFormat === "custom" ? custom(entry.promptFormatCustom, "connection") : named(entry.promptFormat, "connection");
      if (picked) return picked;
    }
    const key = `${entry.baseUrl}\n${modelId}`;
    let hit = this.detectedFormats.get(key);
    if (!hit || Date.now() - hit.at > FORMAT_DETECT_TTL) {
      hit = { ...(await this.detectPromptFormat(provider, entry.baseUrl, modelId)), at: Date.now() };
      this.detectedFormats.set(key, hit);
    }
    return (hit.id ? named(hit.id, hit.source) : null) ?? named("chatml", "fallback")!;
  }

  /** Ask the server which template its loaded model carries: llama.cpp's
   *  server and KoboldCpp report it at /props, Ollama at /api/show. */
  private async detectPromptFormat(provider: string, baseUrl: string, modelId: string): Promise<{ id: string | null; source: PromptFormatSource }> {
    const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const headers: Record<string, string> = { "content-type": "application/json", ...(await this.textCompletionAuth(provider)) };
    const read = async (url: string, init: RequestInit, pick: (j: Record<string, unknown>) => unknown): Promise<string> => {
      try {
        const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(3_000) });
        if (!res.ok) return "";
        const v = pick((await res.json()) as Record<string, unknown>);
        return typeof v === "string" ? v : "";
      } catch {
        return "";
      }
    };
    const props = await read(`${root}/props`, {}, (j) => j.chat_template);
    const template = props || (await read(`${root}/api/show`, { method: "POST", body: JSON.stringify({ model: modelId }) }, (j) => j.template));
    const fromTemplate = formatFromTemplate(template);
    if (fromTemplate) return { id: fromTemplate, source: "template" };
    const fromName = formatFromModelName(modelId);
    return fromName ? { id: fromName, source: "model name" } : { id: null, source: "fallback" };
  }

  /** The bearer for a text completion endpoint, when a key is saved for it. */
  private async textCompletionAuth(provider: string): Promise<Record<string, string>> {
    try {
      const def = readConnections(this.paths).connections[provider];
      if (!def) return {};
      const cred = await new FileCredentialStore(this.paths.auth).read(authTarget(def, provider));
      if (cred?.type === "api_key" && cred.key && connectionKeyUsable(def, provider, cred)) return { authorization: `Bearer ${cred.key}` };
    } catch { /* keyless */ }
    return {};
  }

  /**
   * OpenAI-compatible TEXT completions (prompt in, text out): the protocol
   * the local serving stack speaks (llama.cpp llama-server, vLLM, TabbyAPI,
   * Aphrodite, KoboldCpp). Chat turns are written into ONE prompt in the
   * model's instruct format, ending on an open assistant turn, so prefills
   * continue naturally and the format's end-of-turn marker stops the
   * generation. Sampler keys ride the body verbatim; local stacks accept the
   * wider textgen set (top_k, min_p, typical_p, dry_*, …). Inline think tags
   * stream through onThinking and land split in the result, exactly like
   * the chat transports.
   */
  private async generateTextCompletion(
    model: { provider: string; id: string },
    req: GenerateRequest,
    onDelta?: (delta: string) => void,
    onThinking?: (delta: string) => void,
  ): Promise<GenerateResult> {
    const entry = this.textCompletions.get(model.provider);
    if (!entry) throw new ModelNotConfiguredError("text completion connection unavailable");
    // same policy as embeddings: https for public endpoints, plain http for
    // local model stacks only
    if (new URL(entry.baseUrl).protocol !== "https:" && !isLocalEndpoint(entry.baseUrl)) {
      throw new Error("text completion endpoints must be https, or a local address");
    }

    const resolved = (await this.resolvePromptFormat(model.provider, model.id, req.promptFormat))!;
    const prompt = renderPrompt(resolved.format, req.systemPrompt, req.messages, req.assistantPrefill);

    const extra = { ...req.presetParams?.params } as Record<string, unknown>;
    const stop = [...new Set([...(Array.isArray(extra.stop) ? (extra.stop as unknown[]).map(String) : []), ...stopStrings(resolved.format)])];
    delete extra.stop;
    const body: Record<string, unknown> = {
      model: model.id,
      prompt,
      stream: true,
      max_tokens: req.presetParams?.max_tokens ?? 512,
      ...(req.presetParams?.temperature != null ? { temperature: req.presetParams.temperature } : {}),
      ...extra,
      ...(stop.length ? { stop } : {}),
      stream_options: { include_usage: true },
    };
    const auth = await this.textCompletionAuth(model.provider);

    llmLogRequest(req.source, {
      model: `${model.provider}/${model.id}`,
      connection: `${entry.name} · ${resolved.name} (${resolved.source})`,
      params: body,
      prompt,
    });

    const res = await fetch(entry.baseUrl.replace(/\/$/, "") + "/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw new Error(`text completion endpoint ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);

    // incremental <think>-tag split over the stream: deltas route to
    // onThinking while inside the tags, onDelta outside; a chunk boundary
    // may split a tag, so a possible-tag-prefix tail carries over
    const open = req.reasoningTags?.open;
    const close = req.reasoningTags?.close;
    let inThink = false;
    let carry = "";
    const feed = (chunk: string) => {
      if (!open || !close) { onDelta?.(chunk); return; }
      let s = carry + chunk;
      carry = "";
      while (s.length) {
        const tag = inThink ? close : open;
        const at = s.indexOf(tag);
        if (at < 0) {
          let keep = 0;
          for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
            if (s.endsWith(tag.slice(0, k))) { keep = k; break; }
          }
          if (keep) { carry = s.slice(s.length - keep); s = s.slice(0, s.length - keep); }
          if (s) (inThink ? onThinking : onDelta)?.(s);
          return;
        }
        if (at > 0) (inThink ? onThinking : onDelta)?.(s.slice(0, at));
        inThink = !inThink;
        s = s.slice(at + tag.length);
      }
    };

    let text = "";
    let usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0, priced: false };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sse = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sse += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = sse.indexOf("\n")) >= 0) {
          const line = sse.slice(0, nl).trim();
          sse = sse.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload) as {
              choices?: { text?: string }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
            };
            const d = j.choices?.[0]?.text;
            if (d) { text += d; feed(d); }
            if (j.usage) {
              usage = {
                input: j.usage.prompt_tokens ?? 0,
                output: j.usage.completion_tokens ?? 0,
                reasoning: 0,
                cacheRead: j.usage.prompt_tokens_details?.cached_tokens ?? 0,
                cacheWrite: 0,
                costTotal: 0,
                priced: false,
              };
            }
          } catch { /* skip malformed event */ }
        }
      }
    } catch (e) {
      // abort mid-stream: salvage the partial like the chat transports do
      if (!(e instanceof Error && e.name === "AbortError")) throw e;
    }
    if (carry) (inThink ? onThinking : onDelta)?.(carry);

    const split = open && close ? splitThinkingTags(text, open, close) : { reasoning: "", text };
    // these endpoints (local serving stacks, proxies) are outside every price
    // catalog — only the user's own table can put a number on them
    const textCost = this.priceUsage(model, usage);
    if (textCost !== null) { usage.costTotal = textCost; usage.priced = true; }
    const full = `${model.provider}/${model.id}`;
    return {
      text: split.text,
      ...(split.reasoning ? { reasoning: split.reasoning } : {}),
      model: full,
      usage,
      ...(split.reasoning
        ? { parts: [{ type: "thinking" as const, text: split.reasoning }, ...(split.text ? [{ type: "text" as const, text: split.text }] : [])] }
        : {}),
    };
  }

  async generateInner(req: GenerateRequest, onDelta?: (delta: string) => void, onThinking?: (delta: string) => void): Promise<GenerateResult> {
    const model = await this.resolveModel(req.model ?? null);
    const signal = req.signal;
    if (!signal || !isLocalEndpoint(model.baseUrl)) return this.generateModel(model, req, onDelta, onThinking);
    const stopServer = () => abortLocalGeneration(model.baseUrl);
    signal.addEventListener("abort", stopServer, { once: true });
    try {
      return await this.generateModel(model, req, onDelta, onThinking);
    } finally {
      signal.removeEventListener("abort", stopServer);
    }
  }

  private async generateModel(model: Model<Api>, req: GenerateRequest, onDelta?: (delta: string) => void, onThinking?: (delta: string) => void): Promise<GenerateResult> {
    // Stable per-conversation session id (caller-supplied chat/session id, or
    // a fresh one for stateless callers). It keys provider prompt caching
    // (OpenAI prompt_cache_key, Anthropic cache session) and, for the OpenCode
    // gateway, the routing/caching session headers.
    const sessionId = req.sessionId ?? uuidv7();
    const sessionHeaders = opencodeSessionHeaders(model, sessionId);
    // text-completion connections never reach pi-ai: the chat turns flatten
    // into a single prompt and stream back through the same callbacks
    if (this.textCompletions.has(model.provider)) {
      return this.generateTextCompletion(model, req, onDelta, onThinking);
    }
    // Only the LEADING run of system entries is the system prompt. A system
    // entry further down is an in-chat injection — an author's note at a
    // depth, a world-info entry, the post-history instruction block — and its
    // POSITION is the whole point, so it stays where the caller put it and
    // speaks as the user. (Hoisting those to the top moved an instruction
    // meant to be read after the transcript to before it.) The transport
    // carries exactly one system message, so in-place is the only way to keep
    // the order the caller built.
    const systemParts: string[] = [];
    if (req.systemPrompt) systemParts.push(req.systemPrompt);
    let lead = 0;
    while (lead < req.messages.length && req.messages[lead]!.role === "system") {
      const content = req.messages[lead]!.content;
      if (content.trim()) systemParts.push(content);
      lead++;
    }
    const systemPrompt = systemParts.length > 1 ? systemParts.join("\n\n") : systemParts[0];
    const messages: Message[] = req.messages
      .slice(lead)
      .filter((m) => m.role !== "system" || m.content.trim())
      .map((m) => (m.role === "system" ? { role: "user" as const, content: m.content } : m))
      .map((m) =>
        m.role === "user"
          ? { role: "user", content: m.content, timestamp: Date.now() }
          : {
              // pi-ai expects full AssistantMessage objects in context (usage is
              // required — estimate.js walks it). Zero-usage anchors are ignored
              // for estimation, which falls back to char-based tokens.
              role: "assistant",
              content: [{ type: "text", text: m.content }],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: zeroUsage(),
              stopReason: "stop",
              timestamp: Date.now(),
            },
      ) as Message[];
    const toolTrace: GenerateResult["toolTrace"] = [];
    // legacy presets write the short level "med"; pi-ai clamps unknown levels
    // to OFF (silently disabling thinking) — normalize to "medium"
    const reasoningLevel = req.reasoning === "med" ? "medium" : req.reasoning;
    const MAX_TOOL_ROUNDS = 8;

    // Structured output: forced-tool pattern (pi-ai has no first-class
    // responseSchema; anthropic + openai-completions honor toolChoice).
    let schemaTools: PiTool[] = [];
    let schemaSystemSuffix = "";
    let forcedChoice: unknown = undefined;
    if (req.schema) {
      const objectSchema =
        req.schema.type === "object"
          ? req.schema
          : { type: "object", properties: { value: req.schema }, required: ["value"], additionalProperties: false };
      schemaTools = [{
        name: STRUCTURED_TOOL,
        description: "Respond by calling this tool with the complete structured answer.",
        parameters: objectSchema as PiTool["parameters"],
      }];
      schemaSystemSuffix = `\n\n[STRUCTURED MODE] You MUST answer by calling the ${STRUCTURED_TOOL} tool with a single argument object matching the schema exactly. Do not write prose.`;
      if (model.api === "anthropic-messages") {
        forcedChoice = { type: "tool", name: STRUCTURED_TOOL };
      } else if (model.api === "openai-completions" || model.api === "openai-responses") {
        forcedChoice = { type: "function", function: { name: STRUCTURED_TOOL } };
      }
      // other APIs (google etc.): instruction-only; model should still call the tool
    }

    const allTools = [...(req.tools ?? []), ...schemaTools];
    const hasToolExec = !!req.executeTool || schemaTools.length > 0;
    const execute = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> => {
      if (name === STRUCTURED_TOOL) return { text: JSON.stringify(args) };
      if (req.executeTool) return req.executeTool(name, args);
      return { text: "tool not available", isError: true };
    };

    // measured thinking span across the stream: thinking_start → each
    // thinking_end/text_start, summed (reasoning models may think in bursts).
    // The clock starts at the first thinking, not the request: the wait before
    // it (queueing, prompt processing) is not the model thinking.
    let thinkStart = 0;
    let thinkMs = 0;
    const trackThinking = (ev: { type: string }): void => {
      if (ev.type === "thinking_start" && !thinkStart) thinkStart = Date.now();
      else if (thinkStart && (ev.type === "thinking_end" || ev.type === "text_start")) {
        thinkMs += Date.now() - thinkStart;
        thinkStart = 0;
      }
    };

    // console trace: the request EXACTLY as it leaves for the provider —
    // hoisted system prompt, effective params, resolved model + connection
    const genOpts: Record<string, unknown> = {};
    if (reasoningLevel && reasoningLevel !== "off") genOpts.reasoning = reasoningLevel;
    if (req.thinkingBudget && req.thinkingBudget > 0 && reasoningLevel && reasoningLevel !== "off")
      genOpts.thinkingBudget = req.thinkingBudget;
    if (req.presetParams?.temperature != null) genOpts.temperature = req.presetParams.temperature;
    if (req.presetParams?.max_tokens != null) genOpts.maxTokens = req.presetParams.max_tokens;
    if (req.presetParams?.params && Object.keys(req.presetParams.params).length > 0)
      genOpts.samplingParams = req.presetParams.params;
    if (allTools.length && hasToolExec) genOpts.tools = allTools.map((t) => t.name);
    if (req.reasoningTags?.open && req.reasoningTags?.close) genOpts.parseThinking = `${req.reasoningTags.open}…${req.reasoningTags.close}`;
    llmLogRequest(req.source, {
      model: `${model.provider}/${model.id}`,
      connection: this.connectionNames.get(model.provider) ?? null,
      params: genOpts,
      systemPrompt,
      messages: req.messages,
    });

    // text the model writes BEFORE pausing to call tools — kept so the result
    // contains everything that streamed, not just the final round
    let textBeforeTools = "";
    // interleaved segments for callers that render tool calls as their own
    // blocks between text (present on the result only when tools were used)
    const parts: NonNullable<GenerateResult["parts"]> = [];
    // a round's content blocks become parts IN ORDER (thinking first, then
    // text) so the timeline reads exactly as the model produced it; raw
    // inline <think> tags split here too when the provider reports none
    // per-segment thinking duration: first thinking delta of a round → the
    // round's first text (or the round's end for think-only rounds)
    let roundThinkStart = 0;
    let roundThinkEnd = 0;
    const pushRoundParts = (msg: AssistantMessage) => {
      const hasThinking = msg.content.some((c) => c.type === "thinking");
      const thinkMs = roundThinkStart && (roundThinkEnd || Date.now()) - roundThinkStart > 0
        ? (roundThinkEnd || Date.now()) - roundThinkStart
        : 0;
      for (const c of msg.content) {
        if (c.type === "thinking") {
          if (c.thinking) parts.push({ type: "thinking", text: c.thinking, ...(thinkMs > 0 ? { ms: thinkMs } : {}) });
        } else if (c.type === "text") {
          let text = c.text;
          let think = "";
          if (!hasThinking && req.reasoningTags?.open && req.reasoningTags.close) {
            const split = splitThinkingTags(text, req.reasoningTags.open, req.reasoningTags.close);
            think = split.reasoning;
            text = split.text;
          }
          if (think) parts.push({ type: "thinking", text: think, ...(thinkMs > 0 ? { ms: thinkMs } : {}) });
          if (text) parts.push({ type: "text", text });
        }
      }
    };
    // abort salvage: the provider stream emits its error event CARRYING the
    // partial AssistantMessage — capture it so a cancelled reply can still
    // return the text it managed to write
    const consumeStream = async (s: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }): Promise<AssistantMessage> => {
      let partial: AssistantMessage | null = null;
      for await (const ev of s) {
        if ((ev.type === "thinking_start" || ev.type === "thinking_delta") && !roundThinkStart) roundThinkStart = Date.now();
        else if (ev.type === "text_start" && roundThinkStart && !roundThinkEnd) roundThinkEnd = Date.now();
        trackThinking(ev);
        if (ev.type === "text_delta") onDelta?.(ev.delta);
        else if (ev.type === "thinking_delta") onThinking?.(ev.delta);
        else if (ev.type === "error") {
          const msg = (ev as { error?: AssistantMessage }).error;
          if (msg) partial = msg;
        }
      }
      try {
        return await s.result();
      } catch (e) {
        if (!req.signal?.aborted) throw e;
        // salvage anything with real content — text, tool calls, or the
        // thinking itself: a cancelled reply keeps exactly what was on
        // screen, think-only included. A truly empty partial commits nothing.
        if (partial && partial.content.some((c) =>
          (c.type === "text" && c.text.trim()) ||
          c.type === "toolCall" ||
          (c.type === "thinking" && c.thinking.trim()))) return partial;
        if (partial && textBeforeTools.trim()) return { ...partial, content: [{ type: "text", text: textBeforeTools } as AssistantMessage["content"][number]] };
        throw e;
      }
    };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const context: Context = {
        systemPrompt: systemPrompt ? systemPrompt + schemaSystemSuffix : schemaSystemSuffix.trim() || undefined,
        messages,
        ...(allTools.length && hasToolExec ? { tools: allTools } : {}),
      };
      roundThinkStart = 0;
      roundThinkEnd = 0;
      const stream = this.models.streamSimple(model, context, {
        ...(reasoningLevel && reasoningLevel !== "off" ? { reasoning: reasoningLevel } : {}),
        ...(req.thinkingBudget && req.thinkingBudget > 0 && reasoningLevel && reasoningLevel !== "off"
          ? ({ thinkingBudgets: { [BUDGET_KEY[reasoningLevel ?? ""] ?? "medium"]: req.thinkingBudget } } as never)
          : {}),
        ...(forcedChoice ? ({ toolChoice: forcedChoice } as never) : {}),
        ...(req.presetParams?.temperature != null ? { temperature: req.presetParams.temperature } : {}),
        ...(req.presetParams?.max_tokens != null ? { maxTokens: req.presetParams.max_tokens } : {}),
        ...(req.presetParams?.params && Object.keys(req.presetParams.params).length > 0
          ? { samplingParams: req.presetParams.params }
          : {}),
        ...(req.signal ? ({ signal: req.signal } as never) : {}),
        // key provider prompt caching (set when a cache session exists)
        sessionId,
        ...(sessionHeaders ? { headers: sessionHeaders } : {}),
      });
      const final = await consumeStream(stream);
      if (final.stopReason === "error") {
        throw new Error(`model error: ${final.errorMessage ?? "unknown"}`);
      }

      const toolCalls = final.content.filter(
        (c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall",
      );
      if (final.stopReason !== "toolUse" || toolCalls.length === 0 || !hasToolExec) {
        const res = this.resultFrom(final, model, toolTrace, req, thinkMs, textBeforeTools);
        // aborted replies render as segments even without tool calls — a
        // cancelled mid-thought reply keeps its thinking block inline
        if (parts.some((p) => p.type === "tool") || final.stopReason === "aborted") {
          pushRoundParts(final);
          res.parts = parts;
        }
        return res;
      }

      // keep the round's text for the joined result text; parts get the
      // round's blocks in order, then the tool calls that ended it
      const roundText = final.content
        .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (roundText) {
        if (textBeforeTools) textBeforeTools += "\n\n";
        textBeforeTools += roundText;
      }
      pushRoundParts(final);

      // execute requested tools host-side, then feed results back
      messages.push({ ...final });
      for (const tc of toolCalls) {
        req.onToolEvent?.({ phase: "start", name: tc.name, args: tc.arguments ?? {} });
        let out: { text: string; isError?: boolean };
        try {
          out = await execute(tc.name, tc.arguments ?? {});
        } catch (e) {
          out = { text: `tool error: ${(e as Error).message}`, isError: true };
        }
        req.onToolEvent?.({ phase: "end", name: tc.name, args: tc.arguments ?? {}, result: { text: out.text.slice(0, 4000), isError: !!out.isError } });
        parts.push({ type: "tool", name: tc.name, args: tc.arguments ?? {}, resultText: out.text.slice(0, 4000), isError: !!out.isError });
        toolTrace.push({ name: tc.name, args: tc.arguments ?? {}, resultText: out.text.slice(0, 2000), isError: !!out.isError });
        llmLogTool(round + 1, tc.name, tc.arguments ?? {}, out);
        const tr: ToolResultMessage = {
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: "text", text: out.text }],
          isError: !!out.isError,
          timestamp: Date.now(),
        };
        messages.push(tr);
      }
    }
    // exhausted rounds: do one final call WITHOUT tools to force a text answer
    const context: Context = { systemPrompt, messages };
    const stream = this.models.streamSimple(model, context, {
      ...(req.signal ? ({ signal: req.signal } as never) : {}),
      sessionId,
      ...(sessionHeaders ? { headers: sessionHeaders } : {}),
    });
    roundThinkStart = 0;
    roundThinkEnd = 0;
    const final = await consumeStream(stream);
    if (final.stopReason === "error") {
      throw new Error(`model error: ${final.errorMessage ?? "unknown"}`);
    }
    const exhausted = this.resultFrom(final, model, toolTrace, req, thinkMs, textBeforeTools);
    if (parts.some((p) => p.type === "tool") || final.stopReason === "aborted") {
      pushRoundParts(final);
      exhausted.parts = parts;
    }
    return exhausted;
  }

  private resultFrom(
    final: AssistantMessage,
    model: Model<Api>,
    toolTrace: GenerateResult["toolTrace"],
    req?: GenerateRequest,
    thinkMs = 0,
    textBeforeTools = "",
  ): GenerateResult {
    const text = final.content
      .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    // reasoning: provider-reported ThinkingContent wins; otherwise split raw
    // inline tags (<think>…</think> style proxies) when the caller asked
    let reasoning = final.content
      .filter((c): c is Extract<typeof c, { type: "thinking" }> => c.type === "thinking")
      .map((c) => c.thinking)
      .join("\n")
      .trim();
    let answer = textBeforeTools ? textBeforeTools + "\n\n" + text : text;
    if (!reasoning && req?.reasoningTags?.open && req.reasoningTags.close) {
      const split = splitThinkingTags(text, req.reasoningTags.open, req.reasoningTags.close);
      reasoning = split.reasoning;
      answer = split.text;
    }
    // structured output: prefer the last __structured_output tool args
    let json: unknown = undefined;
    const schemaCall = toolTrace?.filter((t) => t.name === STRUCTURED_TOOL).pop();
    if (schemaCall) {
      json = schemaCall.args;
    } else if (answer.trim().startsWith("{") || answer.trim().startsWith("[")) {
      try {
        json = JSON.parse(answer);
      } catch {
        // not JSON — leave undefined
      }
    }
    const priced = this.priceUsage(model, final.usage);
    return {
      text: answer,
      ...(reasoning ? { reasoning } : {}),
      ...(thinkMs > 0 ? { reasoningTimeMs: thinkMs } : {}),
      ...(json !== undefined ? { json } : {}),
      model: `${model.provider}/${model.id}`,
      usage: {
        input: final.usage.input,
        output: final.usage.output,
        ...(final.usage.reasoning != null ? { reasoning: final.usage.reasoning } : {}),
        cacheRead: final.usage.cacheRead,
        cacheWrite: final.usage.cacheWrite,
        // the user's price table wins over the catalog's; when neither knows
        // the rates, cost is unknown rather than zero
        costTotal: priced ?? final.usage.cost.total,
        priced: priced !== null || this.pricingFor(model) !== null,
      },
      ...(toolTrace?.length ? { toolTrace } : {}),
    };
  }

  /** streamFn for pi-agent-core Agents (same funnel, same invariant). */
  streamFn(model: Model<Api>, context: Context, options?: Parameters<MutableModels["streamSimple"]>[2], sessionId?: string) {
    // Same session contract as generate(): the stable id keys provider prompt
    // caching and, on the OpenCode gateway, the routing/caching headers. The
    // built-in agent passes its session id so a chat's turns stay on one
    // upstream inference.
    const sid = sessionId ?? uuidv7();
    const sessionHeaders = opencodeSessionHeaders(model, sid);
    const merged = {
      ...options,
      sessionId: options?.sessionId ?? sid,
      ...(sessionHeaders ? { headers: { ...options?.headers, ...sessionHeaders } } : {}),
    };
    // pi-agent-core sends the ThinkingLevel as `reasoning`, but openai-completions
    // endpoints (deepseek etc.) read `reasoningEffort` — pass both so every
    // api layer actually receives the level.
    const opts = merged as (typeof merged & { reasoning?: string; reasoningEffort?: string }) | undefined
    if (opts?.reasoning && !opts.reasoningEffort) {
      return this.models.streamSimple(model, context, {
        ...opts,
        reasoningEffort: opts.reasoning,
      } as Parameters<MutableModels["streamSimple"]>[2])
    }
    return this.models.streamSimple(model, context, merged)
  }

  // ---------- image generation (pi-ai images API; creds never leave) ----------
  private imageModelList: ImageModelInfo[] | null = null;

  /** Image-capable models on providers the user has credentials for. */
  async imageModels(): Promise<ImageModelInfo[]> {
    const out: ImageModelInfo[] = [];
    for (const provider of this.images.getProviders()) {
      const auth = await this.images.getAuth(provider.id).catch(() => undefined);
      if (!auth) continue; // no credentials for this provider
      for (const m of this.images.getModels(provider.id)) {
        out.push({ provider: String(m.provider), id: String(m.id), label: (m as { name?: string }).name ?? String(m.id), api: String(m.api), connectionName: this.connectionNames.get(String(m.provider)) ?? null });
      }
    }
    for (const src of await this.imageConnections()) {
      for (const m of this.images.getModels(src.catalog)) {
        out.push({ provider: src.id, id: String(m.id), label: (m as { name?: string }).name ?? String(m.id), api: String(m.api), connectionName: src.name });
      }
    }
    this.imageModelList = out;
    return out;
  }

  /** Custom connections that front an image catalog: a keyed OpenAI-compatible
   *  connection whose host serves image models through its chat endpoint is
   *  the same service as the builtin provider under another name, so its
   *  catalog applies with the connection's own URL and key. */
  private async imageConnections(): Promise<{ id: string; name: string; baseUrl: string; key: string; catalog: string }[]> {
    const conns = readConnections(this.paths);
    const auth = new FileCredentialStore(this.paths.auth);
    const out: { id: string; name: string; baseUrl: string; key: string; catalog: string }[] = [];
    for (const [id, def] of Object.entries(conns.connections)) {
      if (def.providerId || !def.baseUrl || def.api !== "openai-completions") continue;
      let host = "";
      try { host = new URL(def.baseUrl).hostname; } catch { continue; }
      const catalog = IMAGE_CATALOG_HOSTS.find((h) => host === h.host || host.endsWith(`.${h.host}`))?.catalog;
      if (!catalog) continue;
      const cred = await auth.read(authTarget(def, id));
      if (!cred || cred.type !== "api_key" || !cred.key) continue;
      if (!connectionKeyUsable(def, id, cred)) continue;
      out.push({ id, name: def.name ?? id, baseUrl: def.baseUrl, key: cred.key, catalog });
    }
    return out;
  }

  /** Generate one image from a prompt. Returns the encoded image bytes. */
  async generateImage(req: { prompt: string; model?: string | null }): Promise<{ data: Buffer; mimeType: string; model: string }> {
    const models = this.imageModelList ?? (await this.imageModels());
    if (!models.length) {
      throw new ModelNotConfiguredError(
        "no image model available — add an OpenRouter key or connection (Settings → API connections)",
      );
    }
    const pick = req.model
      ? models.find((m) => `${m.provider}/${m.id}` === req.model || m.id === req.model)
      : models[0]!;
    if (!pick) throw new Error(`image model not found: ${req.model}`);
    const ctx = { input: [{ type: "text" as const, text: req.prompt }] };
    const viaConnection = (await this.imageConnections()).find((s) => s.id === pick.provider);
    const raw = this.images.getModel(viaConnection?.catalog ?? pick.provider, pick.id);
    if (!raw) throw new Error(`image model not found in registry: ${pick.id}`);
    const out = viaConnection
      ? await this.images.generateImages({ ...raw, baseUrl: viaConnection.baseUrl }, ctx, { apiKey: viaConnection.key })
      : await this.images.generateImages(raw, ctx);
    if (out.stopReason === "error") {
      const message = out.errorMessage ?? "image generation failed";
      // Pure image models reject the chat call the shared adapter makes and
      // answer with the endpoint that does serve them; use it instead of
      // reporting a model the catalog lists as broken.
      if (String(raw.api) === "openrouter-images" && /\/api\/v1\/images endpoint/i.test(message)) {
        const auth = viaConnection ? undefined : (await this.images.getAuth(pick.provider))?.auth;
        const apiKey = viaConnection?.key ?? auth?.apiKey;
        const baseUrl = viaConnection?.baseUrl ?? auth?.baseUrl ?? String(raw.baseUrl ?? "");
        if (apiKey && baseUrl) {
          const image = await postImagePrompt(baseUrl, apiKey, pick.id, req.prompt);
          return { data: image.data, mimeType: image.mimeType, model: `${pick.provider}/${pick.id}` };
        }
      }
      throw new Error(message);
    }
    const img = (out.output as { type: string; data?: string; mimeType?: string }[]).find((c) => c.type === "image" && c.data);
    if (!img?.data) {
      // models that refuse answer in text instead of an image; that text is the reason
      const said = (out.output as { type: string; text?: string }[]).find((c) => c.type === "text" && c.text)?.text;
      throw new Error(said ? `model returned no image: ${said.slice(0, 300)}` : "model returned no image data");
    }
    return { data: Buffer.from(img.data, "base64"), mimeType: img.mimeType ?? "image/png", model: `${pick.provider}/${pick.id}` };
  }
}

/** The OpenAI-compatible image call OpenRouter serves on its dedicated
 *  endpoint: { model, prompt } in, base64 bytes and media type out. */
async function postImagePrompt(baseUrl: string, apiKey: string, model: string, prompt: string): Promise<{ data: Buffer; mimeType: string }> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/images`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt }),
  });
  const body = (await res.json().catch(() => null)) as { data?: { b64_json?: string; media_type?: string }[]; error?: { message?: string } } | null;
  if (!res.ok) {
    const detail = body?.error?.message;
    throw new Error(detail ? `${res.status}: ${detail}` : `image generation failed (${res.status})`);
  }
  const image = body?.data?.[0];
  if (!image?.b64_json) throw new Error("image endpoint returned no image data");
  return { data: Buffer.from(image.b64_json, "base64"), mimeType: image.media_type ?? "image/png" };
}

export class ModelNotConfiguredError extends Error {}

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export type { AssistantMessageEvent };
export { uuidv7 };
