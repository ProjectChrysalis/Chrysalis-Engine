/**
 * Builds the two first-party frontends with the pipeline apps are built with
 * (src/builder): esbuild for the module graph, the real Tailwind v4 compiler
 * for CSS, content-named assets, and a staged swap of `dist/` that copies
 * `public/` in as-is. No separate frontend toolchain.
 *
 *   bun run build:client
 *
 * The shell's index.html is served at "/" while its assets live under
 * /client/, and the agent UI is served under /agent/, so the emitted HTML's
 * relative asset URLs get those prefixes.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext } from "../src/builder/context.js";
import { buildProduction } from "../src/builder/prod.js";
import { diskTransport } from "./lib/disk-transport.js";
import { writeDist } from "./lib/write-dist.js";
import { tailwindSheets } from "./lib/tailwind-sheets.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Target {
  /** project dir under the repo */
  dir: string;
  /** URL prefix its dist is served under ("" when the project owns the root) */
  base: string;
}

const TARGETS: Target[] = [
  { dir: "client", base: "/client/" },
  { dir: "client-agent", base: "/agent/" },
];

const kb = (n: number): string => `${(n / 1024).toFixed(1)}kB`;

async function build({ dir, base }: Target): Promise<boolean> {
  const projectDir = path.join(repo, dir);
  const esbuild = await import("esbuild");
  const started = Date.now();
  const ctx = await createContext(diskTransport(projectDir, repo), { esbuild, tailwindSheets: tailwindSheets(repo) }, "production");
  const out = await buildProduction(ctx);
  if (!out.ok) {
    console.error(`\n${dir}: build failed`);
    for (const e of out.errors) console.error(`  ${e.file ?? "?"}${e.line ? `:${e.line}` : ""} ${e.text}`);
    return false;
  }
  // assets are siblings of index.html in dist/, but the HTML is served from a
  // different path than its assets, so its relative URLs become absolute
  const files = out.files.map((f) =>
    f.path === "index.html" ? { ...f, contents: f.contents.replace(/(src|href)="\.\/assets\//g, `$1="${base}assets/`) } : f,
  );
  writeDist(projectDir, repo, files, out.copies);
  const bytes = files.reduce((n, f) => n + f.contents.length, 0);
  console.log(`${dir}: ${files.length} files (${kb(bytes)}), ${out.copies.length} copied assets, ${Date.now() - started}ms`);
  for (const w of out.warnings) console.warn(`  warn ${w.text}`);
  return true;
}

const only = process.argv[2];
const chosen = only ? TARGETS.filter((t) => t.dir === only) : TARGETS;
if (!chosen.length) {
  console.error(`unknown target ${only}: expected ${TARGETS.map((t) => t.dir).join(" or ")}`);
  process.exit(1);
}
let ok = true;
for (const target of chosen) ok = (await build(target)) && ok;
if (!ok) process.exit(1);
