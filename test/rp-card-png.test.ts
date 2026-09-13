/**
 * Character card PNGs — the tEXt chunk carries base64 over UTF-8 bytes, so a
 * card whose name or prose is not plain ASCII (routine for shared cards) has
 * to survive the trip in unchanged.
 */
import { describe, it, expect } from "bun:test";
import { extractCharaFromPng } from "../apps/roleplay/src/lib/import-shapes.js";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);

const b64Utf8 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** A PNG that is nothing but the signature plus the given tEXt chunks. */
function pngWithText(chunks: [keyword: string, text: string][]): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (const [keyword, text] of chunks) {
    const body = latin1(`tEXt${keyword}\0${text}`);
    const len = body.length - 4;
    const chunk = new Uint8Array(body.length + 8);
    new DataView(chunk.buffer).setUint32(0, len);
    chunk.set(body, 4);
    new DataView(chunk.buffer).setUint32(chunk.length - 4, crc32(body));
    parts.push(chunk);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const asFile = (bytes: Uint8Array): File => new File([bytes], "card.png", { type: "image/png" });

describe("card PNG import", () => {
  it("keeps non-ASCII text intact", async () => {
    const card = { name: "Élodie 綾", description: "She says “hello” — softly. 🙂" };
    const got = await extractCharaFromPng(asFile(pngWithText([["chara", b64Utf8(JSON.stringify(card))]])));
    expect(got).toEqual(card);
  });

  it("prefers the v3 chunk over the v2 chunk a card carries alongside it", async () => {
    const png = pngWithText([
      ["chara", b64Utf8(JSON.stringify({ name: "old" }))],
      ["ccv3", b64Utf8(JSON.stringify({ name: "new" }))],
    ]);
    expect(await extractCharaFromPng(asFile(png))).toEqual({ name: "new" });
  });

  it("returns null for a PNG with no card, and for a truncated chunk stream", async () => {
    expect(await extractCharaFromPng(asFile(pngWithText([["Software", "some editor"]])))).toBeNull();
    const truncated = pngWithText([["chara", b64Utf8('{"name":"x"}')]]).slice(0, 14);
    expect(await extractCharaFromPng(asFile(truncated))).toBeNull();
  });
});
