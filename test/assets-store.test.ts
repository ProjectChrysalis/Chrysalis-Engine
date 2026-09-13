/** The asset store is shared across a user's apps: content-addressed bytes
 *  get one record, and an app uploading bytes another app already stored must
 *  not be able to rewrite that record or grow the store past its quota. */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { putAsset, getAsset } from "../src/assets/store.js";
import { bootstrapUserDir } from "../src/paths.js";

function tempUser() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-assets-"));
  return bootstrapUserDir(dir, "alice");
}

describe("asset store ownership", () => {
  it("first writer keeps mime, name and createdAt however many owners reuse the bytes", () => {
    const p = tempUser();
    const first = putAsset(p, Buffer.from("same bytes"), "image/png", "cover.png", "one");
    const second = putAsset(p, Buffer.from("same bytes"), "text/html", "evil.html", "two");
    expect(second.mime).toBe("image/png");
    expect(second.name).toBe("cover.png");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.apps).toEqual(["one", "two"]);
    expect(getAsset(p, first.id)?.record.mime).toBe("image/png");
  });

  it("refuses new bytes past the total quota while known bytes still reuse", () => {
    const p = tempUser();
    const limits = { maxBytes: 1024, maxTotalBytes: 8 };
    putAsset(p, Buffer.alloc(8, 1), "image/png", null, "one", limits);
    expect(() => putAsset(p, Buffer.alloc(1, 2), "image/png", null, "one", limits)).toThrow(/quota/);
    // content-addressed reuse never grows the store, so it is always allowed
    expect(() => putAsset(p, Buffer.alloc(8, 1), "image/png", null, "two", limits)).not.toThrow();
    // the per-asset cap still fires
    expect(() => putAsset(p, Buffer.alloc(9, 3), "image/png", null, "one", { maxBytes: 8, maxTotalBytes: 100 })).toThrow(/too large/);
  });
});
