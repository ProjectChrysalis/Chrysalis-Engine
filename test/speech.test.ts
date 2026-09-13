/**
 * Edge read-aloud synthesis wire formats — the keyless speech source backing
 * the Engine TTS provider. Verifies both output formats arrive as the bytes
 * they claim to be (mp3 frame sync / EBML magic), since clients choose the
 * format based on what their build can decode.
 */
import { describe, it, expect } from "bun:test";
import { edgeSpeakFmt } from "../src/speech.js";

describe("edge tts wire formats", () => {
  it("mp3 output starts with an MPEG frame sync", async () => {
    const clip = await edgeSpeakFmt({ text: "Format probe.", voice: "en-US-AriaNeural", speed: 1, format: "mp3" });
    expect(clip.byteLength).toBeGreaterThan(1000);
    expect(clip[0]).toBe(0xff);
    expect(clip[1]! & 0xe0).toBe(0xe0);
  }, 60_000);

  it("webm output starts with the EBML magic (opus-in-webm for codec-stripped clients)", async () => {
    const clip = await edgeSpeakFmt({ text: "Format probe.", voice: "en-US-AriaNeural", speed: 1, format: "webm" });
    expect(clip.byteLength).toBeGreaterThan(1000);
    // 1A 45 DF A3 — every webm container starts with it
    expect([...clip.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  }, 60_000);
});
