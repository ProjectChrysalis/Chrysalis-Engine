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
