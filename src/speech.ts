/**
 * Speech synthesis service (engine-level, any app can call):
 *
 *  · Edge voices — Microsoft's read-aloud neural voices, streamed from the
 *    same websocket endpoint the Edge browser uses. Free and keyless.
 *  · Speech endpoints — user-configured services, each of one kind:
 *    "openai" (any /audio/speech server: OpenAI, OpenRouter, Groq, local
 *    Kokoro), "elevenlabs", "fish" (Fish Audio) or "gemini". Definitions
 *    live in speech.json beside the credentials (outside the workspace);
 *    API keys go to auth.json (0600) under "speech/<id>". An endpoint with
 *    no key of its own uses a model connection's key for the same origin.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { edgeToken } from "./edge-token.js";
import type { UserPaths } from "./paths.js";
import { readAuth, writeAuth, slugId, listConnections, connectionKeyUsable } from "./connections.js";

export const SPEECH_KINDS = ["openai", "elevenlabs", "fish", "gemini"] as const;
export type SpeechKind = (typeof SPEECH_KINDS)[number];

/** What each kind defaults to, and how much text one request may carry. */
export const SPEECH_KIND_INFO: Record<SpeechKind, { baseUrl: string; model: string; models: string[]; chunk: number; controls: SpeechControl[] }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"], chunk: 4000, controls: ["speed", "style"] },
  elevenlabs: {
    baseUrl: "https://api.elevenlabs.io",
    model: "eleven_multilingual_v2",
    models: ["eleven_multilingual_v2", "eleven_v3", "eleven_flash_v2_5", "eleven_turbo_v2_5"],
    chunk: 4500,
    controls: ["speed", "style", "stability", "similarity"],
  },
  fish: { baseUrl: "https://api.fish.audio", model: "s2.1-pro", models: ["s2.1-pro", "s2-pro", "s1"], chunk: 3000, controls: ["speed", "style"] },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash-preview-tts",
    models: ["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"],
    chunk: 3000,
    controls: ["speed", "style"],
  },
};

/** speed and pitch are multipliers (1 = normal); style is free text
 *  ("whispering, nervous"); stability and similarity are 0-1. */
export type SpeechControl = "speed" | "pitch" | "style" | "stability" | "similarity";

export interface SpeechEndpointDef {
  name: string;
  /** absent on endpoints saved before kinds existed: those are "openai" */
  kind?: SpeechKind;
  baseUrl: string;
  /** speech model id (tts-1, eleven_multilingual_v2, s2.1-pro, …) */
  model: string;
  /** optional default voice for this endpoint */
  voice?: string;
  /** optional default delivery, e.g. "warm and calm" */
  style?: string;
}

export interface SpeechEndpointsFile {
  endpoints: Record<string, SpeechEndpointDef>;
}

export interface SpeechEndpointInfo extends SpeechEndpointDef {
  id: string;
  kind: SpeechKind;
  hasKey: boolean;
  /** name of the model connection whose key this endpoint uses */
  keyFrom?: string;
  controls: SpeechControl[];
}

export interface SpeechVoice {
  id: string;
  name: string;
  description?: string;
  language?: string;
  preview?: string;
}

// ---------- endpoints store (speech.json + auth.json) ----------

function readEndpoints(p: UserPaths): SpeechEndpointsFile {
  try {
    const file = JSON.parse(fs.readFileSync(p.speech, "utf8")) as SpeechEndpointsFile;
    return { endpoints: file.endpoints ?? {} };
  } catch {
    return { endpoints: {} };
  }
}

function writeEndpoints(p: UserPaths, file: SpeechEndpointsFile): void {
  fs.mkdirSync(path.dirname(p.speech), { recursive: true });
  fs.writeFileSync(p.speech, JSON.stringify(file, null, 2) + "\n");
}

const authTarget = (id: string) => `speech/${id}`;
/** Base URLs compare without trailing slashes (like provider connections). */
const normalizeUrl = (u: string): string => u.replace(/\/+$/, "");
const kindOf = (def: SpeechEndpointDef): SpeechKind => def.kind ?? "openai";

function originOf(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/** The stored key only counts for the base URL it was saved against. A
 *  changed endpoint URL must not receive a key the user pasted for the old
 *  one (same binding provider connections get). */
function ownKey(p: UserPaths, id: string, def: SpeechEndpointDef): string | undefined {
  const cred = readAuth(p)[authTarget(id)] as { key?: unknown; boundBaseUrl?: unknown } | undefined;
  if (!cred || typeof cred.key !== "string") return undefined;
  if (typeof cred.boundBaseUrl === "string" && normalizeUrl(cred.boundBaseUrl) !== normalizeUrl(def.baseUrl)) return undefined;
  return cred.key;
}

/** A model connection's API key, when that connection already sends it to
 *  the endpoint's origin. The key never reaches a host it wasn't saved for. */
function connectionKey(p: UserPaths, def: SpeechEndpointDef): { key: string; from: string } | undefined {
  const want = originOf(def.baseUrl);
  if (!want) return undefined;
  const auth = readAuth(p);
  for (const conn of listConnections(p)) {
    const cred = auth[conn.effectiveProviderId];
    if (!cred || cred.type !== "api_key" || typeof cred.key !== "string") continue;
    if (!connectionKeyUsable(conn, conn.id, cred)) continue;
    const base = conn.baseUrl ?? builtinProviders().find((b) => b.id === conn.effectiveProviderId)?.baseUrl;
    if (base && originOf(base) === want) return { key: cred.key, from: conn.name };
  }
  return undefined;
}

function infoOf(p: UserPaths, id: string, def: SpeechEndpointDef): SpeechEndpointInfo {
  const kind = kindOf(def);
  const own = ownKey(p, id, def);
  const shared = own ? undefined : connectionKey(p, def);
  return { id, ...def, kind, hasKey: !!(own ?? shared), ...(shared ? { keyFrom: shared.from } : {}), controls: SPEECH_KIND_INFO[kind].controls };
}

export function listSpeechEndpoints(p: UserPaths): SpeechEndpointInfo[] {
  const { endpoints } = readEndpoints(p);
  return Object.entries(endpoints)
    .map(([id, def]) => infoOf(p, id, def))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type EndpointInput = { name: string; kind: SpeechKind; baseUrl: string; model: string; voice?: string; style?: string; key?: string };

const cleanStyle = (s: unknown): string | undefined => (typeof s === "string" && s.trim() ? s.trim().slice(0, 500) : undefined);

export function validateSpeechEndpointInput(input: {
  name?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  voice?: unknown;
  style?: unknown;
  key?: unknown;
}): { ok: true; value: EndpointInput } | { ok: false; error: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 60) return { ok: false, error: "name must be 1-60 characters" };
  if (input.kind !== undefined && !SPEECH_KINDS.includes(input.kind as SpeechKind)) return { ok: false, error: `kind must be one of ${SPEECH_KINDS.join(", ")}` };
  const kind = (input.kind as SpeechKind | undefined) ?? "openai";
  const given = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  const baseUrl = given || (kind === "openai" ? "" : SPEECH_KIND_INFO[kind].baseUrl);
  if (!/^https?:\/\/.{3,}/.test(baseUrl)) return { ok: false, error: "baseUrl must be an http(s) URL" };
  const model = (typeof input.model === "string" ? input.model.trim() : "") || SPEECH_KIND_INFO[kind].model;
  if (model.length > 120) return { ok: false, error: "model is too long" };
  const voice = typeof input.voice === "string" && input.voice.trim() ? input.voice.trim().slice(0, 120) : undefined;
  const style = cleanStyle(input.style);
  const key = typeof input.key === "string" ? input.key.trim() : undefined;
  if (key !== undefined && !key) return { ok: false, error: "key must be non-empty when provided" };
  return { ok: true, value: { name, kind, baseUrl, model, ...(voice ? { voice } : {}), ...(style ? { style } : {}), ...(key ? { key } : {}) } };
}

export function createSpeechEndpoint(p: UserPaths, value: Omit<EndpointInput, "kind"> & { kind?: SpeechKind }): SpeechEndpointInfo {
  const file = readEndpoints(p);
  let id = slugId(value.name);
  while (file.endpoints[id]) id = slugId(value.name);
  file.endpoints[id] = {
    name: value.name,
    ...(value.kind && value.kind !== "openai" ? { kind: value.kind } : {}),
    baseUrl: value.baseUrl,
    model: value.model,
    ...(value.voice ? { voice: value.voice } : {}),
    ...(value.style ? { style: value.style } : {}),
  };
  writeEndpoints(p, file);
  if (value.key) {
    const auth = readAuth(p);
    auth[authTarget(id)] = { type: "api_key", key: value.key, boundBaseUrl: file.endpoints[id]!.baseUrl };
    writeAuth(p, auth);
  }
  return infoOf(p, id, file.endpoints[id]!);
}

export function updateSpeechEndpoint(
  p: UserPaths,
  id: string,
  patch: { name?: string; baseUrl?: string; model?: string; voice?: string; style?: string; key?: string },
): SpeechEndpointInfo | null {
  const file = readEndpoints(p);
  const def = file.endpoints[id];
  if (!def) return null;
  if (patch.name !== undefined && patch.name.trim()) def.name = patch.name.trim().slice(0, 60) || def.name;
  if (patch.baseUrl !== undefined && /^https?:\/\/.{3,}/.test(patch.baseUrl)) def.baseUrl = patch.baseUrl.trim();
  if (patch.model !== undefined && patch.model.trim()) def.model = patch.model.trim();
  if (patch.voice !== undefined) def.voice = patch.voice.trim().slice(0, 120) || undefined;
  if (patch.style !== undefined) def.style = cleanStyle(patch.style);
  writeEndpoints(p, file);
  if (patch.key !== undefined && patch.key.trim()) {
    const auth = readAuth(p);
    auth[authTarget(id)] = { type: "api_key", key: patch.key.trim(), boundBaseUrl: def.baseUrl };
    writeAuth(p, auth);
  }
  return infoOf(p, id, def);
}

export function deleteSpeechEndpoint(p: UserPaths, id: string): boolean {
  const file = readEndpoints(p);
  if (!file.endpoints[id]) return false;
  delete file.endpoints[id];
  writeEndpoints(p, file);
  const auth = readAuth(p);
  delete auth[authTarget(id)];
  writeAuth(p, auth);
  return true;
}

/** Key for an endpoint (engine-internal only — never returned over HTTP).
 *  Its own key, bound to the base URL it was saved with, else a model
 *  connection's key for the same origin. */
export function speechEndpointKey(p: UserPaths, id: string): string | undefined {
  const def = readEndpoints(p).endpoints[id];
  return def ? ownKey(p, id, def) ?? connectionKey(p, def)?.key : undefined;
}

// ---------- synthesis ----------

export interface SpeakRequest {
  text: string;
  voice: string;
  model: string;
  speed: number;
  style?: string;
  stability?: number;
  similarity?: number;
}

export interface SpeechTarget {
  kind: SpeechKind;
  baseUrl: string;
  key?: string;
}

export interface SpeechClip {
  audio: Buffer;
  mime: string;
}

const MAX_AUDIO = 25 * 1024 * 1024;
/** Longest text one synthesis call reads; longer text is refused, not cut. */
export const SPEECH_TEXT_MAX = 20_000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

async function failure(res: Response, label: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  let message = body.slice(0, 300);
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; detail?: { message?: string } | string; message?: string };
    const e = j.error ?? j.detail ?? j.message;
    message = (typeof e === "string" ? e : e?.message) ?? message;
  } catch { /* not JSON */ }
  return new Error(`${label} ${res.status}: ${message || res.statusText}`);
}

async function audioOf(res: Response, label: string): Promise<Buffer> {
  if (!res.ok) throw await failure(res, label);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > MAX_AUDIO) throw new Error(`${label} returned an empty or oversized body`);
  return buf;
}

/** Split at sentence ends (then spaces) so each piece fits one request. */
export function splitForSpeech(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "), window.lastIndexOf("\n"));
    if (cut < max / 3) cut = window.lastIndexOf(" ");
    if (cut < max / 3) cut = max - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function speakOpenAi(t: SpeechTarget, r: SpeakRequest): Promise<Buffer> {
  const res = await fetch(`${normalizeUrl(t.baseUrl)}/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(t.key ? { authorization: `Bearer ${t.key}` } : {}) },
    body: JSON.stringify({
      model: r.model,
      input: r.text,
      voice: r.voice,
      response_format: "mp3",
      speed: clamp(r.speed, 0.25, 4),
      // only voice-directable models read it; strict servers reject unknown fields
      ...(r.style ? { instructions: r.style } : {}),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  return audioOf(res, "speech endpoint");
}

async function speakElevenLabs(t: SpeechTarget, r: SpeakRequest): Promise<Buffer> {
  const url = `${normalizeUrl(t.baseUrl)}/v1/text-to-speech/${encodeURIComponent(r.voice)}?output_format=mp3_44100_128`;
  // v3 takes delivery as inline audio tags; the other models have no text cue
  const text = r.style && r.model.startsWith("eleven_v3") ? `[${r.style}] ${r.text}` : r.text;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "audio/mpeg", ...(t.key ? { "xi-api-key": t.key } : {}) },
    body: JSON.stringify({
      text,
      model_id: r.model,
      voice_settings: {
        stability: clamp(r.stability ?? 0.5, 0, 1),
        similarity_boost: clamp(r.similarity ?? 0.75, 0, 1),
        speed: clamp(r.speed, 0.7, 1.2),
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  return audioOf(res, "ElevenLabs");
}

async function speakFish(t: SpeechTarget, r: SpeakRequest): Promise<Buffer> {
  const res = await fetch(`${normalizeUrl(t.baseUrl)}/v1/tts`, {
    method: "POST",
    headers: { "content-type": "application/json", model: r.model, ...(t.key ? { authorization: `Bearer ${t.key}` } : {}) },
    body: JSON.stringify({
      text: r.style ? `[${r.style}] ${r.text}` : r.text,
      format: "mp3",
      ...(r.voice && r.voice !== "default" ? { reference_id: r.voice } : {}),
      prosody: { speed: clamp(r.speed, 0.5, 2) },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  return audioOf(res, "Fish Audio");
}

/** Gemini returns raw 16-bit PCM; pieces join before the WAV header goes on. */
async function speakGeminiPcm(t: SpeechTarget, r: SpeakRequest): Promise<{ pcm: Buffer; rate: number }> {
  const notes: string[] = [];
  if (r.style) notes.push(`Delivery: ${r.style}`);
  if (Math.abs(r.speed - 1) >= 0.05) notes.push(`Pace: ${r.speed > 1 ? "faster" : "slower"} than normal, about ${r.speed.toFixed(2)}x`);
  const prompt = notes.length
    ? `Read the TRANSCRIPT aloud. Follow the NOTES for delivery and do not read them.\n\n### NOTES\n${notes.join("\n")}\n\n### TRANSCRIPT\n${r.text}`
    : r.text;
  const res = await fetch(`${normalizeUrl(t.baseUrl)}/models/${encodeURIComponent(r.model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(t.key ? { "x-goog-api-key": t.key } : {}) },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: r.voice } } } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw await failure(res, "Gemini");
  const body = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] };
  const part = body.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data)?.inlineData;
  if (!part?.data) throw new Error("Gemini returned no audio");
  const rate = Number(/rate=(\d+)/.exec(part.mimeType ?? "")?.[1]) || 24_000;
  return { pcm: Buffer.from(part.data, "base64"), rate };
}

/** Synthesize through one endpoint. Text longer than the service takes in a
 *  request is read in pieces and joined (MP3 frames and PCM both join). */
export async function synthesize(t: SpeechTarget, r: SpeakRequest): Promise<SpeechClip> {
  const pieces = splitForSpeech(r.text, SPEECH_KIND_INFO[t.kind].chunk);
  if (t.kind === "gemini") {
    const parts: Buffer[] = [];
    let rate = 24_000;
    for (const text of pieces) {
      const out = await speakGeminiPcm(t, { ...r, text });
      parts.push(out.pcm);
      rate = out.rate;
    }
    return { audio: wav(Buffer.concat(parts), rate), mime: "audio/wav" };
  }
  const one = t.kind === "elevenlabs" ? speakElevenLabs : t.kind === "fish" ? speakFish : speakOpenAi;
  const parts: Buffer[] = [];
  for (const text of pieces) parts.push(await one(t, { ...r, text }));
  const audio = Buffer.concat(parts);
  if (audio.byteLength > MAX_AUDIO) throw new Error("the spoken audio is too long");
  return { audio, mime: "audio/mpeg" };
}

// ---------- voices ----------

const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

const GEMINI_VOICES: [string, string][] = [
  ["Zephyr", "Bright"], ["Puck", "Upbeat"], ["Charon", "Informative"], ["Kore", "Firm"], ["Fenrir", "Excitable"],
  ["Leda", "Youthful"], ["Orus", "Firm"], ["Aoede", "Breezy"], ["Callirrhoe", "Easy-going"], ["Autonoe", "Bright"],
  ["Enceladus", "Breathy"], ["Iapetus", "Clear"], ["Umbriel", "Easy-going"], ["Algieba", "Smooth"], ["Despina", "Smooth"],
  ["Erinome", "Clear"], ["Algenib", "Gravelly"], ["Rasalgethi", "Informative"], ["Laomedeia", "Upbeat"], ["Achernar", "Soft"],
  ["Alnilam", "Firm"], ["Schedar", "Even"], ["Gacrux", "Mature"], ["Pulcherrima", "Forward"], ["Achird", "Friendly"],
  ["Zubenelgenubi", "Casual"], ["Vindemiatrix", "Gentle"], ["Sadachbia", "Lively"], ["Sadaltager", "Knowledgeable"], ["Sulafat", "Warm"],
];

const voiceCache = new Map<string, { at: number; voices: SpeechVoice[] }>();
const VOICE_TTL = 10 * 60_000;

async function getJson<T>(url: string, headers: Record<string, string>, label: string): Promise<T> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw await failure(res, label);
  return (await res.json()) as T;
}

async function fetchVoices(t: SpeechTarget): Promise<SpeechVoice[]> {
  const base = normalizeUrl(t.baseUrl);
  if (t.kind === "gemini") return GEMINI_VOICES.map(([id, description]) => ({ id, name: id, description }));
  if (t.kind === "elevenlabs") {
    const body = await getJson<{ voices?: { voice_id: string; name?: string; description?: string; preview_url?: string; labels?: Record<string, string> }[] }>(
      `${base}/v1/voices`,
      t.key ? { "xi-api-key": t.key } : {},
      "ElevenLabs",
    );
    return (body.voices ?? []).map((v) => {
      const labels = v.labels ?? {};
      const description = [labels.gender, labels.age, labels.accent, labels.description ?? labels.descriptive].filter(Boolean).join(", ") || v.description;
      return { id: v.voice_id, name: v.name ?? v.voice_id, ...(description ? { description } : {}), ...(labels.language ? { language: labels.language } : {}), ...(v.preview_url ? { preview: v.preview_url } : {}) };
    });
  }
  if (t.kind === "fish") {
    type Page = { items?: { _id: string; title?: string; description?: string; languages?: string[] }[] };
    const auth: Record<string, string> = t.key ? { authorization: `Bearer ${t.key}` } : {};
    const own = await getJson<Page>(`${base}/model?type=tts&self=true&page_size=100`, auth, "Fish Audio").catch(() => ({ items: [] }) as Page);
    const popular = await getJson<Page>(`${base}/model?type=tts&sort_by=score&page_size=60`, auth, "Fish Audio");
    const seen = new Set<string>();
    return [...(own.items ?? []), ...(popular.items ?? [])]
      .filter((v) => v._id && !seen.has(v._id) && seen.add(v._id))
      .map((v) => ({ id: v._id, name: v.title ?? v._id, ...(v.description ? { description: v.description.slice(0, 120) } : {}), ...(v.languages?.[0] ? { language: v.languages[0] } : {}) }));
  }
  // servers that publish their voices (local engines do) are asked; the
  // standard set is the answer for everything else
  try {
    const body = await getJson<{ voices?: (string | { id?: string; name?: string; voice_id?: string })[] }>(
      `${base}/audio/voices`,
      t.key ? { authorization: `Bearer ${t.key}` } : {},
      "speech endpoint",
    );
    const voices = (body.voices ?? [])
      .map((v) => (typeof v === "string" ? { id: v, name: v } : { id: v.id ?? v.voice_id ?? v.name ?? "", name: v.name ?? v.id ?? v.voice_id ?? "" }))
      .filter((v) => v.id);
    if (voices.length) return voices;
  } catch { /* no voice list on this server */ }
  return OPENAI_VOICES.map((id) => ({ id, name: id }));
}

/** Voices an endpoint offers, cached for a few minutes per endpoint. */
export async function speechVoices(cacheKey: string, t: SpeechTarget): Promise<SpeechVoice[]> {
  const key = `${cacheKey}\0${t.kind}\0${t.baseUrl}`;
  const hit = voiceCache.get(key);
  if (hit && Date.now() - hit.at < VOICE_TTL) return hit.voices;
  const voices = await fetchVoices(t);
  voiceCache.set(key, { at: Date.now(), voices });
  return voices;
}

/** True for OpenAI's own voice and model names, which a caller written for
 *  OpenAI-style services may send to any service. */
export function isOpenAiStock(kind: SpeechKind, name: string): boolean {
  return kind !== "openai" && (OPENAI_VOICES.includes(name) || /^(tts-1(-hd)?|gpt-4o(-mini)?-tts.*)$/.test(name));
}

/** The voice an endpoint speaks with when the caller names none. */
export function defaultVoice(kind: SpeechKind): string {
  return kind === "gemini" ? "Kore" : kind === "elevenlabs" ? "21m00Tcm4TlvDq8ikWAM" : kind === "fish" ? "default" : "alloy";
}

// ---------- Edge voices (keyless read-aloud websocket) ----------

/** Curated set of the popular Edge neural voices (ShortName form). */
export const EDGE_VOICES: string[] = [
  "en-US-AriaNeural", "en-US-JennyNeural", "en-US-GuyNeural", "en-US-AnaNeural",
  "en-US-ChristopherNeural", "en-US-EricNeural", "en-US-MichelleNeural", "en-US-RogerNeural",
  "en-US-SteffanNeural", "en-GB-SoniaNeural", "en-GB-RyanNeural", "en-GB-LibbyNeural",
  "en-GB-MaisieNeural", "en-GB-ThomasNeural", "en-AU-NatashaNeural", "en-AU-WilliamNeural",
  "en-IE-EmilyNeural", "en-IN-NeerjaNeural", "en-IN-PrabhatNeural", "en-CA-ClaraNeural",
  "es-ES-ElviraNeural", "es-ES-AlvaroNeural", "es-MX-DaliaNeural", "es-MX-JorgeNeural",
  "fr-FR-DeniseNeural", "fr-FR-HenriNeural", "fr-FR-EloiseNeural", "fr-CA-SylvieNeural",
  "fr-CA-AntoineNeural", "de-DE-KatjaNeural", "de-DE-ConradNeural", "de-DE-AmalaNeural",
  "it-IT-ElsaNeural", "it-IT-DiegoNeural", "pt-BR-FranciscaNeural", "pt-BR-AntonioNeural",
  "pt-PT-DuarteNeural", "nl-NL-ColetteNeural", "nl-NL-MaartenNeural", "pl-PL-ZofiaNeural",
  "pl-PL-MarekNeural", "ru-RU-SvetlanaNeural", "ru-RU-DmitryNeural", "tr-TR-EmelNeural",
  "ja-JP-NanamiNeural", "ja-JP-KeitaNeural", "ko-KR-SunHiNeural", "ko-KR-InJoonNeural",
  "zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-YunyangNeural", "zh-TW-HsiaoChenNeural",
  "ar-EG-SalmaNeural", "ar-SA-HamedNeural", "hi-IN-SwaraNeural", "hi-IN-MadhurNeural",
  "id-ID-GadisNeural", "vi-VN-HoaiMyNeural", "th-TH-PremwadeeNeural", "uk-UA-PolinaNeural",
];

const EDGE_TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_WSS =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_CHROMIUM = "143.0.3650.75";

/** JS-style GMT date the service expects in X-Timestamp ("Microsoft Edge bug"). */
function edgeDate(): string {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function escapeSsml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ShortName shape; the name goes into SSML, so nothing else is accepted. */
const EDGE_VOICE = /^[a-z]{2,3}-[A-Z]{2,4}(-[A-Za-z]+)?-[A-Za-z0-9]+Neural$/;
const EDGE_CHUNK = 3000;

const PATH_AUDIO_MARKER = Buffer.from("Path:audio\r\n");

/** One websocket attempt; on a 403 with a Date header, reports the server's
 *  clock so the caller can skew-correct and retry once. */
function edgeSpeakOnce(opts: { text: string; voice: string; speed: number; pitch?: number; skewSeconds: number; format?: EdgeFormat }): Promise<Buffer | { retryWithSkew: number }> {
  const text = opts.text.slice(0, EDGE_CHUNK).trim();
  return new Promise((resolve, reject) => {
    const connectionId = randomUUID().replace(/-/g, "");
    const url =
      `${EDGE_WSS}?TrustedClientToken=${EDGE_TRUSTED_TOKEN}&ConnectionId=${connectionId}` +
      `&Sec-MS-GEC=${edgeToken(Date.now() / 1000 + opts.skewSeconds, EDGE_TRUSTED_TOKEN)}&Sec-MS-GEC-Version=2-${EDGE_CHROMIUM}`;
    const major = EDGE_CHROMIUM.split(".")[0];
    const ws = new WebSocket(url, {
      headers: {
        pragma: "no-cache",
        "cache-control": "no-cache",
        origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
        cookie: `muid=${randomBytes(16).toString("hex").toUpperCase()};`,
      },
      handshakeTimeout: 10_000,
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already gone */ }
      reject(new Error("edge tts timed out"));
    }, 30_000);
    const fail = (e: Error) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      reject(e);
    };
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      if (res.statusCode === 403 && res.headers.date) {
        const skew = Math.floor(new Date(res.headers.date).getTime() / 1000 - Date.now() / 1000);
        resolve({ retryWithSkew: skew });
        return;
      }
      reject(new Error(`edge tts handshake failed (${res.statusCode ?? "?"})`));
    });
    ws.on("error", (e: Error) => fail(new Error(`edge tts: ${e.message}`)));
    ws.on("open", () => {
      const ts = edgeDate();
      ws.send(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                  outputFormat: EDGE_FORMATS[opts.format ?? "mp3"].outputFormat,
                },
              },
            },
          }),
      );
      const rate = Math.round((clamp(opts.speed, 0.5, 4) - 1) * 100);
      const pitch = Math.round((clamp(opts.pitch ?? 1, 0.5, 1.5) - 1) * 100);
      const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}%`;
      const lang = /^([a-z]{2}-[A-Z]{2})-/.exec(opts.voice)?.[1] ?? (opts.voice.slice(0, 5) || "en-US");
      ws.send(
        `X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` +
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${opts.voice}'><prosody pitch='${signed(pitch)}' rate='${signed(rate)}' volume='+0%'>${escapeSsml(text)}</prosody></voice></speak>`,
      );
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // binary frames: 0x00 + header block, audio bytes straight after
        // "Path:audio\r\n" (metadata frames say Path:audio.metadata — skipped)
        const marker = data.indexOf(PATH_AUDIO_MARKER);
        if (marker >= 0) chunks.push(data.subarray(marker + PATH_AUDIO_MARKER.length));
        return;
      }
      const s = data.toString("utf8");
      if (s.includes("Path:turn.end")) {
        clearTimeout(timer);
        try { ws.close(); } catch { /* already gone */ }
        const out = Buffer.concat(chunks);
        if (!out.byteLength) reject(new Error("edge tts returned no audio"));
        else resolve(out);
      }
    });
  });
}

/** Edge output formats we can request, and what they arrive as. */
export const EDGE_FORMATS = {
  mp3: { outputFormat: "audio-24khz-48kbitrate-mono-mp3", mime: "audio/mpeg" },
  webm: { outputFormat: "webm-24khz-16bit-mono-opus", mime: "audio/webm" },
} as const;
export type EdgeFormat = keyof typeof EDGE_FORMATS;

/** Synthesize through the Edge read-aloud service; resolves the audio bytes.
 *  Retries once with server-clock skew applied on a 403. webm/opus is there
 *  for clients whose build lacks the proprietary MP3 decoder; MP3 text past
 *  one request's limit is read in pieces and joined. */
export async function edgeSpeakFmt(opts: { text: string; voice: string; speed: number; pitch?: number; format: EdgeFormat }): Promise<Buffer> {
  if (!EDGE_VOICE.test(opts.voice)) throw new Error("not an Edge voice name");
  if (opts.format === "mp3" && opts.text.length > EDGE_CHUNK) {
    const parts: Buffer[] = [];
    for (const text of splitForSpeech(opts.text, EDGE_CHUNK)) parts.push(await edgeSpeakFmt({ ...opts, text }));
    return Buffer.concat(parts);
  }
  const first = await edgeSpeakOnce({ ...opts, skewSeconds: 0 });
  if (Buffer.isBuffer(first)) return first;
  const second = await edgeSpeakOnce({ ...opts, skewSeconds: (first as { retryWithSkew: number }).retryWithSkew });
  if (Buffer.isBuffer(second)) return second;
  throw new Error("edge tts rejected the request (403) — clock skew correction failed");
}
