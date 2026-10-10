import { expect, test } from "bun:test";
import { buildUpload } from "../src/builder/browser/upload.js";
import { BuildBodyError, readBuildBody } from "../src/server/build-body.js";

test("large build uploads compress and decode without changing Unicode contents", async () => {
  const value = { output: "日本語🙂".repeat(30_000) };
  const upload = await buildUpload(value);
  expect(upload.headers).toEqual({ "content-encoding": "gzip" });
  const request = new Request("http://localhost/build", { method: "PUT", ...upload });
  const bytes = await readBuildBody(request, 1024 * 1024);
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(value);
  expect((upload.body as Blob).size).toBeLessThan(bytes.length / 10);
});

test("small build uploads retain ordinary JSON", async () => {
  const upload = await buildUpload({ ok: true });
  expect(upload.headers).toBeUndefined();
  expect(new TextDecoder().decode(await readBuildBody(new Request("http://localhost", { method: "PUT", ...upload }), 100))).toBe('{"ok":true}');
});

test("compressed uploads enforce the expanded limit", async () => {
  const upload = await buildUpload({ output: "x".repeat(100_000) });
  try {
    await readBuildBody(new Request("http://localhost", { method: "PUT", ...upload }), 1024);
    throw new Error("expected limit failure");
  } catch (error) {
    expect(error).toBeInstanceOf(BuildBodyError);
    expect((error as BuildBodyError).status).toBe(413);
  }
});

test("invalid gzip and unsupported encodings report request errors", async () => {
  for (const [encoding, status] of [["gzip", 400], ["br", 415]] as const) {
    await expect(readBuildBody(new Request("http://localhost", { method: "PUT", body: "invalid", headers: { "content-encoding": encoding } }), 100)).rejects.toMatchObject({ status });
  }
});
