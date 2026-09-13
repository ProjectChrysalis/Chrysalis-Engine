/**
 * What every build of one app shares: tsconfig, resolver, Tailwind, env and
 * the esbuild settings that follow from them. The environment (browser
 * frame or a test) supplies esbuild and, in the sandbox only, a way to
 * evaluate a bundled Tailwind plugin.
 */
import type * as esbuild from "esbuild";
import { BuildFs, type FsTransport } from "./fs.js";
import { Resolver, loadTsConfig, type TsConfig } from "./resolve.js";
import { TailwindEngine } from "./tailwind.js";
import { Emitter, createPlugin } from "./plugin.js";

export type Mode = "development" | "production";

export interface BuilderEnv {
  esbuild: typeof esbuild;
  /** tailwindcss's own sheets: index.css, theme.css, preflight.css, utilities.css */
  tailwindSheets: Record<string, string>;
  /** Run a CommonJS bundle and return its module.exports. Only the
   *  sandboxed builder frame provides this. */
  evalCjs?: (code: string) => unknown;
  /** React Refresh transform (Babel) for dev-mode modules. */
  refresh?: (code: string, file: string) => string;
}

/** JS and CSS targets: what Tailwind v4 itself supports, so its output
 *  (nesting, @property, color-mix) is lowered only where needed. */
export const TARGET = ["es2022", "chrome111", "firefox114", "safari16.4", "edge111"];

export interface BuildContext {
  fs: BuildFs;
  env: BuilderEnv;
  mode: Mode;
  ts: TsConfig;
  resolver: Resolver;
  tailwind: TailwindEngine;
  /** import.meta.env as the app sees it */
  metaEnv: Record<string, string | boolean>;
  /** esbuild options derived from the app's tsconfig */
  jsxOptions: Pick<esbuild.BuildOptions, "jsx" | "jsxDev" | "jsxImportSource" | "jsxFactory" | "jsxFragment" | "tsconfigRaw">;
}

export async function createContext(transportOrFs: FsTransport | BuildFs, env: BuilderEnv, mode: Mode): Promise<BuildContext> {
  const fs = transportOrFs instanceof BuildFs ? transportOrFs : new BuildFs(transportOrFs);
  const ts = await loadTsConfig(fs);
  const resolver = new Resolver(fs, ts, mode);
  const vars = await fs.env(mode);
  const metaEnv: Record<string, string | boolean> = { ...vars, MODE: mode, DEV: mode === "development", PROD: mode === "production", SSR: false, BASE_URL: "./" };
  const co = ts.compilerOptions;
  const tsconfigRaw = {
    compilerOptions: Object.fromEntries(
      Object.entries(co).filter(([k]) =>
        ["jsx", "jsxFactory", "jsxFragmentFactory", "jsxImportSource", "experimentalDecorators", "useDefineForClassFields", "verbatimModuleSyntax", "preserveValueImports", "importsNotUsedAsValues", "alwaysStrict"].includes(k),
      ),
    ),
  } as esbuild.TsconfigRaw;
  const jsx = typeof co.jsx === "string" ? co.jsx.toLowerCase() : "";
  const jsxOptions: BuildContext["jsxOptions"] =
    jsx === "react"
      ? { tsconfigRaw }
      : {
          tsconfigRaw,
          jsx: "automatic",
          jsxDev: mode === "development",
          ...(typeof co.jsxImportSource === "string" ? { jsxImportSource: co.jsxImportSource } : {}),
        };
  const ctx: BuildContext = { fs, env, mode, ts, resolver, tailwind: undefined as unknown as TailwindEngine, metaEnv, jsxOptions };
  ctx.tailwind = new TailwindEngine(fs, resolver, {
    sheets: env.tailwindSheets,
    ...(env.evalCjs
      ? {
          loadModule: async (path: string) => {
            // a plugin/config is app code: bundle it and run it here, in the
            // sandbox, where it can reach nothing the app itself cannot
            const out = await bundleForEval(ctx, path);
            return env.evalCjs!(out);
          },
        }
      : {}),
  });
  return ctx;
}

/** esbuild `define` for a mode. */
export function defines(ctx: BuildContext): Record<string, string> {
  const d: Record<string, string> = {
    "process.env.NODE_ENV": JSON.stringify(ctx.mode),
    "import.meta.env": JSON.stringify(ctx.metaEnv),
  };
  for (const [k, v] of Object.entries(ctx.metaEnv)) if (/^[A-Za-z_$][\w$]*$/.test(k)) d[`import.meta.env.${k}`] = JSON.stringify(v);
  return d;
}

async function bundleForEval(ctx: BuildContext, path: string): Promise<string> {
  const emitter = new Emitter(ctx.fs);
  const r = await ctx.env.esbuild.build({
    entryPoints: [path],
    bundle: true,
    format: "cjs",
    platform: "browser",
    write: false,
    logLevel: "silent",
    target: TARGET,
    define: { ...defines(ctx), "import.meta.hot": "undefined" },
    plugins: [
      createPlugin({
        fs: ctx.fs,
        resolver: ctx.resolver,
        tailwind: ctx.tailwind,
        emitter,
        esbuild: ctx.env.esbuild,
        mode: ctx.mode,
        assetUrl: () => '""',
        cssAssetRef: (p) => p,
        define: {},
      }),
    ],
  });
  return r.outputFiles[0]?.text ?? "";
}
