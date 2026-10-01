import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractSandboxFiles } from "../scripts/sandbox-files.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-archive-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test("invalid archive paths preserve the installed runtime", () => {
  const dest = path.join(dir, "runtime");
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, "old"), "previous runtime");
  for (const name of ["../runtime-other/file", "/absolute", "C:/absolute", "C:relative", "runtime/file:stream", "..\\runtime-other\\file", "runtime/../file", "./file"]) {
    expect(() => extractSandboxFiles({ "runtime/session.mjs": new Uint8Array([1]), [name]: new Uint8Array([2]) }, dest), name).toThrow(/archive path escapes/);
    expect(fs.readFileSync(path.join(dest, "old"), "utf8")).toBe("previous runtime");
  }
  expect(fs.existsSync(path.join(dir, "runtime-other"))).toBe(false);
});

test("valid runtime entries replace the old cache and preserve bytes", () => {
  const dest = path.join(dir, "runtime");
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, "old"), "old");
  extractSandboxFiles({ "runtime/session.mjs": new Uint8Array([0, 128, 255]), "sources.json": new TextEncoder().encode("{}") }, dest);
  expect(fs.existsSync(path.join(dest, "old"))).toBe(false);
  expect([...fs.readFileSync(path.join(dest, "runtime", "session.mjs"))]).toEqual([0, 128, 255]);
});
