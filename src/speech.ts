/**
 * Speech synthesis service (engine-level, any app can call):
 *
 *  · Edge voices — Microsoft's read-aloud neural voices, streamed from the
 *    same websocket endpoint the Edge browser uses. Free and keyless.
 *  · Custom endpoints — user-configured OpenAI-compatible /audio/speech
 *    servers (OpenAI, Groq, local Kokoro/openedai-speech, …). Definitions
 *    live in speech.json beside the credentials (outside the workspace);
 *    API keys go to auth.json (0600) under "speech/<id>".
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { UserPaths } from "./paths.js";
import { readAuth, writeAuth, slugId } from "./connections.js";

export interface SpeechEndpointDef {
  name: string;
  baseUrl: string;
  /** speech model id (tts-1, gpt-4o-mini-tts, playai-tts, kokoro, …) */
  model: string;
  /** optional default voice for this endpoint */
  voice?: string;
}

export interface SpeechEndpointsFile {
  endpoints: Record<string, SpeechEndpointDef>;
}

export interface SpeechEndpointInfo extends SpeechEndpointDef {
  id: string;
  hasKey: boolean;
}

// ---------- endpoints store (speech.json + auth.json) ----------

function speechPath(p: UserPaths): string {
  return p.speech;
}

function readEndpoints(p: UserPaths): SpeechEndpointsFile {
  try {
    const file = JSON.parse(fs.readFileSync(speechPath(p), "utf8")) as SpeechEndpointsFile;
    return { endpoints: file.endpoints ?? {} };
  } catch {
    return { endpoints: {} };
  }
}

function writeEndpoints(p: UserPaths, file: SpeechEndpointsFile): void {
  const full = speechPath(p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(file, null, 2) + "\n");
}

const authTarget = (id: string) => `speech/${id}`;
/** Base URLs compare without trailing slashes (like provider connections). */
const normalizeUrl = (u: string): string => u.replace(/\/+$/, "");

/** The stored key only counts for the base URL it was saved against. A
 *  changed endpoint URL must not receive a key the user pasted for the old
 *  one (same binding provider connections get). */
function endpointKeyFor(p: UserPaths, id: string, def: SpeechEndpointDef): string | undefined {
  const cred = readAuth(p)[authTarget(id)] as { key?: unknown; boundBaseUrl?: unknown } | undefined;
  if (!cred || typeof cred.key !== "string") return undefined;
  if (typeof cred.boundBaseUrl === "string" && normalizeUrl(cred.boundBaseUrl) !== normalizeUrl(def.baseUrl)) return undefined;
  return cred.key;
}

export function listSpeechEndpoints(p: UserPaths): SpeechEndpointInfo[] {
  const { endpoints } = readEndpoints(p);
  return Object.entries(endpoints)
    .map(([id, def]) => ({ id, ...def, hasKey: !!endpointKeyFor(p, id, def) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function validateSpeechEndpointInput(input: {
  name?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  voice?: unknown;
  key?: unknown;
}): { ok: true; value: { name: string; baseUrl: string; model: string; voice?: string; key?: string } } | { ok: false; error: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 60) return { ok: false, error: "name must be 1-60 characters" };
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!/^https?:\/\/.{3,}/.test(baseUrl)) return { ok: false, error: "baseUrl must be an http(s) URL" };
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model || model.length > 120) return { ok: false, error: "model is required" };
  const voice = typeof input.voice === "string" && input.voice.trim() ? input.voice.trim().slice(0, 60) : undefined;
  const key = typeof input.key === "string" ? input.key.trim() : undefined;
  if (key !== undefined && !key) return { ok: false, error: "key must be non-empty when provided" };
  return { ok: true, value: { name, baseUrl, model, ...(voice ? { voice } : {}), ...(key ? { key } : {}) } };
}

export function createSpeechEndpoint(
  p: UserPaths,
  value: { name: string; baseUrl: string; model: string; voice?: string; key?: string },
): SpeechEndpointInfo {
  const file = readEndpoints(p);
  let id = slugId(value.name);
  while (file.endpoints[id]) id = slugId(value.name);
  file.endpoints[id] = { name: value.name, baseUrl: value.baseUrl, model: value.model, ...(value.voice ? { voice: value.voice } : {}) };
  writeEndpoints(p, file);
  if (value.key) {
    const auth = readAuth(p);
    auth[authTarget(id)] = { type: "api_key", key: value.key, boundBaseUrl: file.endpoints[id]!.baseUrl };
    writeAuth(p, auth);
  }
  return { id, ...file.endpoints[id]!, hasKey: !!value.key };
}

export function updateSpeechEndpoint(
  p: UserPaths,
  id: string,
  patch: { name?: string; baseUrl?: string; model?: string; voice?: string; key?: string },
): SpeechEndpointInfo | null {
  const file = readEndpoints(p);
  const def = file.endpoints[id];
  if (!def) return null;
  if (patch.name !== undefined && patch.name.trim()) def.name = patch.name.trim().slice(0, 60) || def.name;
  if (patch.baseUrl !== undefined && /^https?:\/\/.{3,}/.test(patch.baseUrl)) def.baseUrl = patch.baseUrl.trim();
  if (patch.model !== undefined && patch.model.trim()) def.model = patch.model.trim();
  if (patch.voice !== undefined) def.voice = patch.voice.trim() || undefined;
  writeEndpoints(p, file);
  if (patch.key !== undefined && patch.key.trim()) {
    const auth = readAuth(p);
    auth[authTarget(id)] = { type: "api_key", key: patch.key.trim(), boundBaseUrl: def.baseUrl };
    writeAuth(p, auth);
  }
  return { id, ...def, hasKey: !!endpointKeyFor(p, id, def) };
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
 *  Bound to the base URL it was saved with. */
export function speechEndpointKey(p: UserPaths, id: string): string | undefined {
  const def = readEndpoints(p).endpoints[id];
  return def ? endpointKeyFor(p, id, def) : undefined;
}

/** Proxy one synthesis request to an OpenAI-compatible /audio/speech. */
export async function endpointSpeak(opts: {
  baseUrl: string;
  key?: string;
  model: string;
  voice: string;
  speed: number;
  text: string;
}): Promise<Buffer> {
  const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
    body: JSON.stringify({
      model: opts.model,
      input: opts.text.slice(0, 4000),
      voice: opts.voice,
      response_format: "mp3",
      speed: Math.min(4, Math.max(0.25, opts.speed)),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`speech endpoint ${res.status}: ${errText.slice(0, 200) || res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > 20 * 1024 * 1024) {
    throw new Error("speech endpoint returned an empty or oversized body");
  }
  return buf;
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

/** DRM token the endpoint requires since late 2024: SHA-256 of the
 *  5-minute-floored Windows filetime (100ns ticks) + the trusted client
 *  token. Clock skew matters — 403 Date headers feed skewSeconds. */
function secMsgGec(skewSeconds = 0): string {
  const ticks = BigInt(Math.floor((Date.now() / 1000 + skewSeconds) / 300) * 300 + 11_644_473_600) * 10_000_000n;
  return createHash("sha256").update(ticks.toString() + EDGE_TRUSTED_TOKEN).digest("hex").toUpperCase();
}

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

const PATH_AUDIO_MARKER = Buffer.from("Path:audio\r\n");

/** One websocket attempt; on a 403 with a Date header, reports the server's
 *  clock so the caller can skew-correct and retry once. */
function edgeSpeakOnce(opts: { text: string; voice: string; speed: number; skewSeconds: number; format?: EdgeFormat }): Promise<Buffer | { retryWithSkew: number }> {
  const text = opts.text.slice(0, 3000).trim();
  return new Promise((resolve, reject) => {
    const connectionId = randomUUID().replace(/-/g, "");
    const url =
      `${EDGE_WSS}?TrustedClientToken=${EDGE_TRUSTED_TOKEN}&ConnectionId=${connectionId}` +
      `&Sec-MS-GEC=${secMsgGec(opts.skewSeconds)}&Sec-MS-GEC-Version=1-${EDGE_CHROMIUM}`;
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
      const rate = Math.round((Math.min(4, Math.max(0.5, opts.speed)) - 1) * 100);
      const lang = /^([a-z]{2}-[A-Z]{2})-/.exec(opts.voice)?.[1] ?? (opts.voice.slice(0, 5) || "en-US");
      ws.send(
        `X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` +
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${opts.voice}'><prosody pitch='+0Hz' rate='${rate >= 0 ? "+" : ""}${rate}%' volume='+0%'>${escapeSsml(text)}</prosody></voice></speak>`,
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
 *  for clients whose build lacks the proprietary MP3 decoder. */
export async function edgeSpeakFmt(opts: { text: string; voice: string; speed: number; format: EdgeFormat }): Promise<Buffer> {
  const first = await edgeSpeakOnce({ ...opts, skewSeconds: 0 });
  if (Buffer.isBuffer(first)) return first;
  const second = await edgeSpeakOnce({ ...opts, skewSeconds: (first as { retryWithSkew: number }).retryWithSkew });
  if (Buffer.isBuffer(second)) return second;
  throw new Error("edge tts rejected the request (403) — clock skew correction failed");
}

