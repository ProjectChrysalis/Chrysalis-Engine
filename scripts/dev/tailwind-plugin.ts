/**
 * Tailwind for the dev servers. Bun's dev bundler loads this from
 * `[serve.static] plugins` in bunfig.toml, and it compiles CSS with the same
 * Tailwind engine the engine's builder uses (src/builder), so dev CSS comes
 * from the same compiler and the same candidate scan as the production bundle
 * and as every app.
 *
 * url()s are rewritten to point at the real file: the compiler writes them
 * app-relative (fonts and package assets as "node_modules/..."), but the
 * frontends resolve packages from wherever they are — the project or the repo
 * root — so each one is looked up before it is emitted. Bun's CSS loader then
 * resolves the emitted path against the stylesheet, which is on disk.
 */
import fs from "node:fs";
import path from "node:path";
import type { BunPlugin } from "bun";
import { createContext, type BuildContext } from "../../src/builder/context.js";
import { isTailwindRoot } from "../../src/builder/tailwind.js";
import { diskTransport } from "../lib/disk-transport.js";
import { tailwindSheets } from "../lib/tailwind-sheets.js";

const REPO = path.resolve(import.meta.dir, "../..");
const PROJECTS = [path.join(REPO, "client"), path.join(REPO, "client-agent")];

const contexts = new Map<string, Promise<BuildContext>>();
const contextFor = (project: string): Promise<BuildContext> => {
  let got = contexts.get(project);
  if (!got) {
    got = (async () => {
      const esbuild = await import("esbuild");
      return createContext(diskTransport(project, REPO), { esbuild, tailwindSheets: tailwindSheets(REPO) }, "development");
    })();
    contexts.set(project, got);
  }
  return got;
};

const projectOf = (file: string): string | undefined =>
  PROJECTS.find((p) => file === p || file.startsWith(p + path.sep));

/** Point every relative url() at the file it means, wherever that file is. */
function fixUrls(css: string, fromFile: string, project: string): string {
  const cssDir = path.dirname(fromFile);
  const appDir = path.relative(project, cssDir).split(path.sep).join("/");
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, quote: string, spec: string) => {
    const url = spec.trim();
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) return whole;
    const appRel = path.posix.normalize(path.posix.join(appDir, url));
    if (appRel.startsWith("..")) return whole;
    const inProject = path.join(project, appRel);
    const real = fs.existsSync(inProject) ? inProject : path.join(REPO, appRel);
    const rel = path.relative(cssDir, real).split(path.sep).join("/");
    return `url(${quote}${rel}${quote})`;
  });
}

export default {
  name: "chrysalis-tailwind",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const project = projectOf(args.path);
      if (!project) return;
      const contents = await Bun.file(args.path).text();
      if (!isTailwindRoot(contents)) return { contents, loader: "css" };
      const ctx = await contextFor(project);
      const rel = path.relative(project, args.path).split(path.sep).join("/");
      const built = await ctx.tailwind.build(rel, contents);
      return { contents: fixUrls(built.css, args.path, project), loader: "css" };
    });
  },
} satisfies BunPlugin;
