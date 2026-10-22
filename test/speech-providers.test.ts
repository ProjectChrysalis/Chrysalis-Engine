/**
 * Speech endpoints of every kind against a stand-in server: the request each
 * service expects, long text read in pieces, Gemini's PCM wrapped as WAV,
 * voice listing, and a model connection's key reused only for its own origin.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultInstanceConfig } from "../src/config.js";
import { createConnection } from "../src/connections.js";
import { bootstrapUserDir } from "../src/paths.js";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import {
  createSpeechEndpoint, edgeSpeakFmt, listSpeechEndpoints, speechEndpointKey, speechVoices, splitForSpeech, synthesize, validateSpeechEndpointInput,
} from "../src/speech.js";

interface Seen { path: string; headers: Record<string, string>; body: any }

let seen: Seen[];
let server: ReturnType<typeof Bun.serve>;
let base: string;
let dir: string;

beforeEach(() => {
  seen = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "speech-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = req.method === "POST" ? await req.text() : "";
      seen.push({ path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: text ? JSON.parse(text) : null });
      if (url.pathname.endsWith(":generateContent")) {
        return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.alloc(480, 1).toString("base64") } }] } }] });
      }
      if (url.pathname === "/v1/voices") return Response.json({ voices: [{ voice_id: "v1", name: "Rachel", labels: { gender: "female", accent: "american" }, preview_url: "https://x/p.mp3" }] });
      if (url.pathname === "/model") {
        return Response.json({ items: url.searchParams.get("self") ? [{ _id: "mine", title: "My voice" }] : [{ _id: "mine", title: "My voice" }, { _id: "pop", title: "Popular", languages: ["en"] }] });
      }
      if (url.pathname === "/local/audio/voices") return Response.json({ voices: ["af_bella", "am_adam"] });
      if (url.pathname.endsWith("/audio/voices")) return new Response("nope", { status: 404 });
      if (url.pathname === "/fail/audio/speech") return Response.json({ error: { message: "quota exceeded" } }, { status: 429 });
      return new Response(new Uint8Array([0xff, 0xf3, 1, 2]), { headers: { "content-type": "audio/mpeg" } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

const request = { text: "Hello there.", voice: "v1", model: "m", speed: 1 };

it("sends each kind the request its service expects", async () => {
  await synthesize({ kind: "openai", baseUrl: `${base}/v1`, key: "k" }, { ...request, style: "calm" });
  expect(seen[0]).toMatchObject({ path: "/v1/audio/speech", headers: { authorization: "Bearer k" }, body: { input: "Hello there.", instructions: "calm", response_format: "mp3" } });

  await synthesize({ kind: "elevenlabs", baseUrl: base, key: "k" }, { ...request, model: "eleven_v3", style: "whispers", speed: 2, stability: 0.2 });
  expect(seen[1]).toMatchObject({ path: "/v1/text-to-speech/v1?output_format=mp3_44100_128", headers: { "xi-api-key": "k" } });
  expect(seen[1]!.body).toEqual({ text: "[whispers] Hello there.", model_id: "eleven_v3", voice_settings: { stability: 0.2, similarity_boost: 0.75, speed: 1.2 } });

  await synthesize({ kind: "fish", baseUrl: base, key: "k" }, { ...request, model: "s2.1-pro", voice: "pop" });
  expect(seen[2]).toMatchObject({ path: "/v1/tts", headers: { model: "s2.1-pro", authorization: "Bearer k" }, body: { text: "Hello there.", reference_id: "pop", format: "mp3" } });

  const clip = await synthesize({ kind: "gemini", baseUrl: base, key: "k" }, { ...request, voice: "Kore", model: "gemini-tts", style: "excited", speed: 1.3 });
  expect(seen[3]).toMatchObject({ path: "/models/gemini-tts:generateContent", headers: { "x-goog-api-key": "k" } });
  const prompt = seen[3]!.body.contents[0].parts[0].text as string;
  expect(prompt).toContain("Delivery: excited");
  expect(prompt).toContain("faster");
  expect(prompt.endsWith("### TRANSCRIPT\nHello there.")).toBe(true);
  expect(seen[3]!.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
  expect(clip.mime).toBe("audio/wav");
  expect(clip.audio.subarray(0, 4).toString()).toBe("RIFF");
  expect(clip.audio.readUInt32LE(24)).toBe(24_000);
  expect(clip.audio.length).toBe(44 + 480);
});

it("reads long text in pieces cut at sentence ends", async () => {
  const sentence = "This sentence is exactly forty-one chars. ";
  const long = sentence.repeat(250).trim();
  const pieces = splitForSpeech(long, 4000);
  expect(pieces.length).toBe(3);
  expect(pieces.every((p) => p.length <= 4000 && p.endsWith("."))).toBe(true);
  expect(pieces.join(" ")).toBe(long);
  const clip = await synthesize({ kind: "openai", baseUrl: `${base}/v1` }, { ...request, text: long });
  expect(seen.length).toBe(3);
  expect(clip.audio.length).toBe(12);

  const gem = await synthesize({ kind: "gemini", baseUrl: base }, { ...request, text: long });
  expect(gem.audio.length).toBe(44 + 480 * splitForSpeech(long, 3000).length);
});

it("reports a service's error message", async () => {
  await expect(synthesize({ kind: "openai", baseUrl: `${base}/fail` }, request)).rejects.toThrow("429: quota exceeded");
});

it("lists voices for each kind", async () => {
  expect(await speechVoices("a", { kind: "elevenlabs", baseUrl: base, key: "k" })).toEqual([
    { id: "v1", name: "Rachel", description: "female, american", preview: "https://x/p.mp3" },
  ]);
  expect((await speechVoices("a", { kind: "fish", baseUrl: base })).map((v) => v.id)).toEqual(["mine", "pop"]);
  expect((await speechVoices("a", { kind: "openai", baseUrl: `${base}/local` })).map((v) => v.id)).toEqual(["af_bella", "am_adam"]);
  expect((await speechVoices("a", { kind: "openai", baseUrl: `${base}/v1` })).map((v) => v.id)).toContain("alloy");
  expect((await speechVoices("a", { kind: "gemini", baseUrl: base })).length).toBe(30);
});

it("fills kind defaults and uses a connection's key only for its own origin", () => {
  const p = bootstrapUserDir(dir, "alice");
  const v = validateSpeechEndpointInput({ name: "Voices", kind: "elevenlabs" });
  expect(v).toMatchObject({ ok: true, value: { baseUrl: "https://api.elevenlabs.io", model: "eleven_multilingual_v2" } });
  expect(validateSpeechEndpointInput({ name: "x", kind: "nope" }).ok).toBe(false);
  expect(validateSpeechEndpointInput({ name: "x" }).ok).toBe(false);

  createConnection(p, { name: "My OpenRouter", providerId: "openrouter", key: "sk-or" });
  createConnection(p, { name: "Shop", api: "openai-completions", baseUrl: "https://api.shop.example/v1", models: "auto", key: "sk-shop" });
  const or = createSpeechEndpoint(p, { name: "OpenRouter speech", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini-tts" });
  const shop = createSpeechEndpoint(p, { name: "Shop speech", baseUrl: "https://api.shop.example/v1/tts", model: "tts" });
  const elsewhere = createSpeechEndpoint(p, { name: "Elsewhere", baseUrl: "https://evil.example/v1", model: "tts" });
  const own = createSpeechEndpoint(p, { name: "Own", baseUrl: "https://openrouter.ai/api/v1", model: "tts", key: "sk-own" });
  expect(speechEndpointKey(p, or.id)).toBe("sk-or");
  expect(speechEndpointKey(p, shop.id)).toBe("sk-shop");
  expect(speechEndpointKey(p, elsewhere.id)).toBeUndefined();
  expect(speechEndpointKey(p, own.id)).toBe("sk-own");
  const listed = listSpeechEndpoints(p);
  expect(listed.find((e) => e.id === or.id)).toMatchObject({ hasKey: true, keyFrom: "My OpenRouter", kind: "openai" });
  expect(listed.find((e) => e.id === own.id)?.keyFrom).toBeUndefined();
  expect(listed.find((e) => e.id === elsewhere.id)?.hasKey).toBe(false);
});

it("refuses an Edge voice name that is not a voice", async () => {
  await expect(edgeSpeakFmt({ text: "hi", voice: "en-US-Aria'><x", speed: 1, format: "mp3" })).rejects.toThrow("not an Edge voice");
});

it("speaks through a service by route, keeping its own voice when handed an OpenAI one", async () => {
  const users = new UserService(dir);
  const token = users.create("alice", "user", { password: "alice-pass-1" }).token;
  const config = defaultInstanceConfig();
  config.apps.packageDownloads = false;
  const app = buildApp({ users, sessions: new SessionService(dir), config, dataDir: dir, bus: new EventBus() });
  const call = (route: string, body?: unknown) =>
    app.request(route, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

  const made = await call("/v1/audio/speech/endpoints", { name: "Voices", kind: "elevenlabs", baseUrl: base, key: "xi", voice: "v1", style: "soft" });
  const { endpoint } = (await made.json()) as { endpoint: { id: string; controls: string[] } };
  expect(endpoint.controls).toContain("stability");

  const res = await call("/v1/audio/speech", { text: "Hi.", provider: "endpoint", endpointId: endpoint.id, model: "tts-1", voice: "alloy", similarity: 0.9 });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { mime: string }).mime).toBe("audio/mpeg");
  const sent = seen.at(-1)!;
  expect(sent.path.startsWith("/v1/text-to-speech/v1?")).toBe(true);
  expect(sent.body).toMatchObject({ model_id: "eleven_multilingual_v2", voice_settings: { similarity_boost: 0.9 } });

  expect((await call("/v1/audio/speech", { text: "x".repeat(20_001), endpointId: endpoint.id })).status).toBe(413);
  const voices = (await (await call(`/v1/audio/speech/endpoints/${endpoint.id}/voices`)).json()) as { voices: { id: string }[] };
  expect(voices.voices.map((v) => v.id)).toEqual(["v1"]);
});
