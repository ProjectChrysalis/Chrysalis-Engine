import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as esbuild from "esbuild";
import { createContext } from "../src/builder/context.js";
import { DevSession } from "../src/builder/dev.js";
import { buildProduction } from "../src/builder/prod.js";
import { appFsOps } from "../src/builder/server.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function context(mode: "development" | "production", stages: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-progress-"));
  dirs.push(root);
  const app = path.join(root, "sample");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "index.html"), '<script type="module" src="./main.js"></script>');
  fs.writeFileSync(path.join(app, "main.js"), 'document.body.textContent = "Ready";');
  return createContext(async (ops) => appFsOps(root, "sample", ops), {
    esbuild, tailwindSheets: {}, onProgress: (stage) => stages.push(stage),
  }, mode);
}

test("development builds report actual stages and hot updates finish normally", async () => {
  const stages: string[] = [];
  const ctx = await context("development", stages);
  const dev = new DevSession(ctx, null);
  const full = await dev.full();
  expect(full.ok).toBe(true);
  expect(stages).toEqual(["reading", "bundling", "dependencies"]);
  stages.length = 0;
  fs.writeFileSync(path.join(dirs[0]!, "sample/main.js"), 'document.body.textContent = "Updated";');
  const update = await dev.update(["main.js"]);
  expect(update.ok).toBe(true);
  expect(update.full).toBe(false);
  expect(stages).toEqual(["bundling"]);
});

test("production builds report reading and bundling without inventing a percentage", async () => {
  const stages: string[] = [];
  const out = await buildProduction(await context("production", stages));
  expect(out.ok).toBe(true);
  expect(stages).toEqual(["reading", "bundling"]);
});

test("CSS asset checks share a batch and startup scripts defer in order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-assets-"));
  dirs.push(root);
  const app = path.join(root, "sample");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "index.html"), '<script type="module" src="./main.js"></script>');
  fs.writeFileSync(path.join(app, "main.js"), 'import "./style.css"; document.body.textContent = "Ready";');
  fs.writeFileSync(path.join(app, "style.css"), '@font-face {font-family: a; src: url("./a.woff2"), url("./b.woff2")}');
  fs.writeFileSync(path.join(app, "a.woff2"), "first");
  fs.writeFileSync(path.join(app, "b.woff2"), "second");
  const hashBatches: string[][] = [];
  const ctx = await createContext(async (ops) => {
    const hashes = ops.filter((op) => op.op === "hash").map((op) => op.path);
    if (hashes.length) hashBatches.push(hashes);
    return appFsOps(root, "sample", ops);
  }, { esbuild, tailwindSheets: {} }, "development");
  const out = await new DevSession(ctx, null).full();
  expect(out.errors).toEqual([]);
  expect(hashBatches.some((batch) => batch.includes("a.woff2") && batch.includes("b.woff2"))).toBe(true);
  expect(out.copies?.filter((copy) => copy.from.endsWith(".woff2"))).toHaveLength(2);
  const html = out.files.find((file) => file.path === "index.html")!.contents;
  expect(html).toContain('<script defer src="/client/builder/runtime.js"');
  expect(html.indexOf("runtime.js")).toBeLessThan(html.indexOf("./dev/app-"));
  expect(html.indexOf("./dev/app-")).toBeLessThan(html.indexOf("./dev/boot.js"));
});
