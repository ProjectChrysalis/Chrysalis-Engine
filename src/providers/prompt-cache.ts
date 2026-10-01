/**
 * Anthropic-style prompt cache placement for app requests that know where
 * their prompt is stable ("cache at depth").
 *
 * Providers cache whole prompt prefixes, and the library marks the system
 * prompt, the last tool and the last conversation message. An app whose tail
 * changes every turn (an author's note at a depth, world info, a prefill)
 * can ask for the history breakpoint to sit a fixed number of role runs back
 * instead, so the stable prefix stays cached while the tail churns.
 *
 * Only Anthropic-format transports take cache_control at all; every other
 * provider caches prefixes on its own. pi-ai hands the FINAL provider payload
 * to `onPayload` before it is sent, which is where the markers are rewritten;
 * the marker's TTL comes from the library's own marker (its compat and env
 * resolution already ran), so the connection's real cache window is kept.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

/** The request-side knob (`GenerateRequest.cache`). */
export interface CacheRequest {
  /**
   * Breakpoint distance from the end, counted in role runs. The shallow
   * breakpoint lands on the last message of the run `depth` runs back; the
   * deep one at `depth + 2`, so a changing tail still hits the deeper cache.
   * 0 marks the last turn. Ignored where the transport has no markers.
   */
  depth?: number;
  /**
   * Cache window: "long" asks for the endpoint's extended window (1h on
   * Anthropic, 24h on OpenAI) where the connection supports it, "short" is
   * the provider's default, and "none" drops the markers and cache hints the
   * engine would send. Providers that cache automatically on their own keep
   * doing so regardless.
   */
  retention?: "none" | "short" | "long";
}

export interface CacheStreamOptions {
  cacheRetention?: "none" | "short" | "long";
  onPayload?: (payload: unknown) => unknown;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether the transport takes Anthropic-style cache_control markers. */
export function supportsAnthropicCache(model: Model<Api>): boolean {
  if (model.api === "anthropic-messages") return true;
  if (model.api !== "openai-completions") return false;
  if ((model as Model<"openai-completions">).compat?.cacheControlFormat === "anthropic") return true;
  // the built-in OpenRouter Claude entries detect the format at request time
  // instead of carrying it on the model
  return model.provider === "openrouter" && model.id.startsWith("anthropic/");
}

/** Stream options for an app cache request: the retention choice, plus the
 *  payload rewrite when depth placement is asked for on a transport that
 *  understands it. "none" wins over a depth: caching is off, so there is
 *  nothing to place. */
export function cacheStreamOptions(model: Model<Api>, cache: CacheRequest): CacheStreamOptions {
  const options: CacheStreamOptions = {};
  const retention = cache.retention;
  if (retention === "none" || retention === "short" || retention === "long") options.cacheRetention = retention;
  const depth = cache.depth;
  if (retention !== "none" && typeof depth === "number" && Number.isInteger(depth) && depth >= 0 && supportsAnthropicCache(model)) {
    options.onPayload = (payload: unknown) => {
      applyDepthMarkers(payload, depth);
      return payload;
    };
  }
  return options;
}

/**
 * Rewrites the cache breakpoints on a provider payload: the system prompt,
 * the last tool, and the two history positions the depth asks for. The
 * first marker already on the payload (placed by the library) supplies the
 * TTL, then every marker is cleared before the placement below.
 */
export function applyDepthMarkers(payload: unknown, depth: number): void {
  if (!isRec(payload)) return;
  const locations = cacheLocations(payload);
  const existing = locations.map((node) => node.cache_control).find(isRec);
  const marker: Rec = existing ? { ...existing } : { type: "ephemeral" };
  for (const node of locations) delete node.cache_control;
  // system prompt: a block list on the Anthropic transport, the leading
  // system message on OpenAI-compatible ones
  if (Array.isArray(payload.system)) {
    for (let i = payload.system.length - 1; i >= 0; i--) {
      const block = payload.system[i];
      if (isRec(block) && block.type === "text") {
        block.cache_control = marker;
        break;
      }
    }
  } else if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (!isRec(msg) || (msg.role !== "system" && msg.role !== "developer")) continue;
      markMessage(msg, marker);
      break;
    }
  }
  if (Array.isArray(payload.tools) && payload.tools.length) {
    const last = payload.tools[payload.tools.length - 1];
    if (isRec(last)) last.cache_control = marker;
  }
  if (Array.isArray(payload.messages)) markDepth(payload.messages, depth, marker);
}

/** Marks the last run boundary `depth` and `depth + 2` role runs back. The
 *  trailing assistant run (a prefill) does not count, and system/tool turns
 *  neither take a marker nor advance the count. */
function markDepth(messages: unknown[], depth: number, marker: Rec): void {
  let passedPrefill = false;
  let run = 0;
  let prevRole = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isRec(msg) || typeof msg.role !== "string") continue;
    const role = msg.role;
    if (!passedPrefill && role === "assistant") continue;
    passedPrefill = true;
    if (role === "system" || role === "tool" || role === prevRole) continue;
    if (run === depth || run === depth + 2) markMessage(msg, marker);
    if (run === depth + 2) break;
    run++;
    prevRole = role;
  }
}

/** Places the marker on the last text part of a message, wrapping plain
 *  string content into a text part first (user and system content travels as
 *  a bare string on OpenAI-compatible transports). */
function markMessage(msg: Rec, marker: Rec): boolean {
  const content = msg.content;
  if (typeof content === "string") {
    if (!content) return false;
    msg.content = [{ type: "text", text: content, cache_control: marker }];
    return true;
  }
  if (!Array.isArray(content)) return false;
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (isRec(part) && part.type === "text") {
      part.cache_control = marker;
      return true;
    }
  }
  return false;
}

/** The library's marker, reused so the engine's placement keeps the TTL the
 *  connection actually resolved (compat, env and all). */
function cacheLocations(payload: Rec): Rec[] {
  const locations: Rec[] = [];
  const add = (items: unknown): void => {
    if (Array.isArray(items)) for (const item of items) if (isRec(item)) locations.push(item);
  };
  add(payload.system);
  add(payload.tools);
  if (Array.isArray(payload.messages)) for (const message of payload.messages) {
    if (!isRec(message)) continue;
    locations.push(message);
    add(message.content);
  }
  return locations;
}
