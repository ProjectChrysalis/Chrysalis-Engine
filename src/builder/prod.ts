/**
 * Production build: one esbuild bundle per index.html entry, code-split,
 * minified, CSS extracted. The fallback for apps the dev runtime cannot
 * host, and what an app is exported as.
 */
import type * as esbuild from "esbuild";
import type { BuildContext } from "./context.js";
import { TARGET, defines } from "./context.js";
import { Emitter, cssRefFromAssets, createPlugin, type AssetCopy } from "./plugin.js";
import { fillHtml, planHtml } from "./html.js";

export interface BuildMessage {
  text: string;
  file?: string;
  line?: number;
  column?: number;
  lineText?: string;
}

export interface BuildOutput {
  ok: boolean;
  mode: "production" | "development";
  /** dist-relative files to write */
  files: Array<{ path: string; contents: string }>;
  /** app files to copy into dist */
  copies: AssetCopy[];
  warnings: BuildMessage[];
  errors: BuildMessage[];
}

export function messages(list: esbuild.Message[] | undefined): BuildMessage[] {
  return (list ?? []).map((m) => ({
    text: m.text,
    ...(m.location
      ? { file: m.location.file.replace(/^[a-z-]+:/, ""), line: m.location.line, column: m.location.column, lineText: m.location.lineText }
      : {}),
  }));
}

export function failure(mode: BuildOutput["mode"], e: unknown): BuildOutput {
  const errs = (e as { errors?: esbuild.Message[] })?.errors;
  return {
    ok: false,
    mode,
    files: [],
    copies: [],
    warnings: [],
    errors: errs?.length ? messages(errs) : [{ text: String((e as Error)?.message ?? e) }],
  };
}

/** Dist-relative path of an esbuild output file (outdir is "/__out"). */
export const outRel = (p: string): string => p.replace(/\\/g, "/").replace(/^(?:.*\/)?__out\//, "");

export async function buildWorkerBundle(ctx: BuildContext, emitter: Emitter, path: string): Promise<string> {
  const r = await ctx.env.esbuild.build({
    entryPoints: [path],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "silent",
    minify: ctx.mode === "production",
    target: TARGET,
    outdir: "/__out/assets",
    entryNames: "[name]-[hash]",
    assetNames: "[name]-[hash]",
    ...ctx.jsxOptions,
    define: { ...defines(ctx), "import.meta.hot": "undefined" },
    plugins: [
      createPlugin({
        ...pluginBase(ctx, emitter),
        // a worker is its own module: its assets resolve from its own URL
        assetUrl: (p) => `new URL(${JSON.stringify(cssRefFromAssets(p))}, import.meta.url).href`,
        cssAssetRef: cssRefFromAssets,
        buildWorker: (p) => buildWorkerBundle(ctx, emitter, p),
      }),
    ],
  });
  let js = "";
  for (const f of r.outputFiles ?? []) {
    const rel = outRel(f.path);
    emitter.files.set(rel, { path: rel, contents: f.text });
    if (rel.endsWith(".js")) js = rel;
  }
  return js;
}

export function pluginBase(ctx: BuildContext, emitter: Emitter) {
  return {
    fs: ctx.fs,
    resolver: ctx.resolver,
    tailwind: ctx.tailwind,
    emitter,
    esbuild: ctx.env.esbuild,
    mode: ctx.mode,
    define: defines(ctx),
  };
}

export async function buildProduction(ctx: BuildContext): Promise<BuildOutput> {
  const emitter = new Emitter(ctx.fs);
  try {
    if (!(await ctx.fs.isFile("index.html"))) throw new Error("this app has no index.html");
    const plan = await planHtml(await ctx.fs.readText("index.html"), ctx.fs, emitter, ctx.metaEnv);
    if (!plan.entries.length) throw new Error("index.html has no <script type=\"module\"> or stylesheet to build");
    const entries = new Map<string, { path: string; contents?: string; loader?: esbuild.Loader }>();
    for (const e of plan.entries) {
      entries.set(`\0entry:${e.n}`, e.path ? { path: e.path } : { path: `index-inline-${e.n}.tsx`, contents: e.inline ?? "", loader: "tsx" });
    }
    const r = await ctx.env.esbuild.build({
      entryPoints: [...entries.keys()],
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "browser",
      write: false,
      metafile: true,
      logLevel: "silent",
      minify: true,
      charset: "utf8",
      target: TARGET,
      outdir: "/__out/assets",
      entryNames: "[name]-[hash]",
      chunkNames: "[name]-[hash]",
      assetNames: "[name]-[hash]",
      ...ctx.jsxOptions,
      define: { ...defines(ctx), "import.meta.hot": "undefined" },
      plugins: [
        createPlugin({
          ...pluginBase(ctx, emitter),
          entries,
          assetUrl: (p) => `new URL(${JSON.stringify(cssRefFromAssets(p))}, import.meta.url).href`,
          cssAssetRef: cssRefFromAssets,
          buildWorker: (p) => buildWorkerBundle(ctx, emitter, p),
        }),
      ],
    });
    const files: BuildOutput["files"] = [];
    for (const f of r.outputFiles ?? []) files.push({ path: outRel(f.path), contents: f.text });
    // which output belongs to which html entry
    const byEntry = new Map<number, { js?: string; css: string[] }>();
    for (const [out, meta] of Object.entries(r.metafile?.outputs ?? {})) {
      if (!meta.entryPoint) continue;
      // "app:src/main.tsx" or "entry:index-inline-0.tsx"
      const inline = /index-inline-(\d+)\.tsx$/.exec(meta.entryPoint);
      const n = inline ? Number(inline[1]) : plan.entries.find((e) => e.path && meta.entryPoint!.replace(/^[a-z-]+:/, "") === e.path)?.n;
      if (n === undefined) continue;
      const slot = byEntry.get(n) ?? { css: [] };
      const rel = outRel(out);
      if (rel.endsWith(".css")) slot.css.push(rel);
      else slot.js = rel;
      if (meta.cssBundle) slot.css.push(outRel(meta.cssBundle));
      byEntry.set(n, slot);
    }
    const headCss = new Set<string>();
    for (const e of plan.entries) if (e.kind === "script") for (const c of byEntry.get(e.n)?.css ?? []) headCss.add(c);
    const html = fillHtml(
      plan,
      (e) => {
        const slot = byEntry.get(e.n);
        if (e.kind === "style") return (slot?.css ?? []).map((c) => `<link rel="stylesheet" crossorigin href="./${c}">`).join("");
        return slot?.js ? `<script type="module" crossorigin src="./${slot.js}"></script>` : "";
      },
      [...headCss].map((c) => `<link rel="stylesheet" crossorigin href="./${c}">`).join(""),
    );
    files.push({ path: "index.html", contents: html });
    for (const f of emitter.files.values()) files.push(f);
    return { ok: true, mode: "production", files, copies: [...emitter.copies.values()], warnings: messages(r.warnings), errors: [] };
  } catch (e) {
    return failure("production", e);
  }
}
