/**
 * The builder, running inside its own sandboxed iframe (served from
 * /client/builder/frame.html: opaque origin, no cookies, connect-src 'none').
 * Everything that interprets app content happens here: esbuild (wasm),
 * Babel's React Refresh transform, Tailwind, and any Tailwind plugin the app
 * brings. Its only channel out is postMessage to the shell, which answers
 * file reads for this one app and uploads what comes back.
 */
import * as esbuild from "esbuild-wasm";
import * as Babel from "@babel/standalone";
import refreshPlugin from "react-refresh/babel";
import indexCss from "tailwindcss/index.css";
import themeCss from "tailwindcss/theme.css";
import preflightCss from "tailwindcss/preflight.css";
import utilitiesCss from "tailwindcss/utilities.css";
import type { FsOp, FsResult } from "../fs.js";
import { createContext, type BuildContext, type BuilderEnv } from "../context.js";
import { DevSession, type DevMeta } from "../dev.js";
import { buildProduction, failure, type BuildOutput } from "../prod.js";

type Msg =
  | { t: "init"; wasm: ArrayBuffer; prior: DevMeta | null }
  | { t: "build"; id: number; kind: "full" | "warm" | "update" | "production"; changed?: string[] }
  | { t: "fs-result"; rid: number; results: FsResult[] };

const post = (m: unknown, transfer: Transferable[] = []) => parent.postMessage({ __chrysalisBuilder: 1, ...(m as object) }, "*", transfer);

let rid = 0;
const waiting = new Map<number, (r: FsResult[]) => void>();
const transport = (ops: FsOp[]): Promise<FsResult[]> =>
  new Promise((resolve) => {
    const n = ++rid;
    waiting.set(n, resolve);
    post({ t: "fs", rid: n, ops });
  });

const env: BuilderEnv = {
  esbuild: esbuild as unknown as BuilderEnv["esbuild"],
  tailwindSheets: { "index.css": indexCss, "theme.css": themeCss, "preflight.css": preflightCss, "utilities.css": utilitiesCss },
  // app code (a Tailwind plugin) runs here and only here: this frame can
  // reach nothing but the files of the app it is building
  evalCjs: (code: string) => {
    const module = { exports: {} as unknown };
    new Function("module", "exports", "require", code)(module, module.exports, (id: string) => {
      throw new Error(`require("${id}") is not available in a Tailwind plugin here`);
    });
    return module.exports;
  },
  refresh: (code: string, file: string) =>
    Babel.transform(code, {
      filename: file,
      sourceType: "module",
      babelrc: false,
      configFile: false,
      compact: false,
      plugins: [[refreshPlugin, { skipEnvCheck: true, emitFullSignatures: true }]],
    }).code ?? code,
};

let prior: DevMeta | null = null;
let devCtx: BuildContext | null = null;
let dev: DevSession | null = null;
let chain = Promise.resolve();

async function build(kind: Extract<Msg, { t: "build" }>["kind"], changed: string[]) {
  if (kind === "production") return buildProduction(await createContext(transport, env, "production"));
  if (kind === "full" || kind === "warm" || !devCtx || !dev) {
    devCtx = await createContext(transport, env, "development");
    dev = new DevSession(devCtx, dev?.meta ?? prior);
    if (kind === "update") {
      // a cold session: catch up with what dist holds first; if dist is not
      // from these sources, the full build IS the update
      const warm = await dev.full({ adopt: true });
      if (!warm.unchanged) return warm;
    }
  }
  const out = kind === "update" ? await dev.update(changed) : await dev.full({ adopt: kind === "warm" });
  // top-level await cannot become a hot-swappable module: build the app as
  // one production bundle instead
  if (out.errors.some((e) => /top-level await/i.test(e.text))) {
    const prod = await buildProduction(await createContext(transport, env, "production"));
    dev = null;
    return prod;
  }
  return out;
}

addEventListener("message", (e: MessageEvent) => {
  if (e.source !== parent) return;
  const d = e.data as Msg & { __chrysalisBuilder?: number };
  if (!d || d.__chrysalisBuilder !== 1) return;
  if (d.t === "fs-result") {
    waiting.get(d.rid)?.(d.results);
    waiting.delete(d.rid);
  } else if (d.t === "init") {
    prior = d.prior;
    void (async () => {
      try {
        const wasmModule = await WebAssembly.compile(d.wasm);
        await esbuild.initialize({ wasmModule, worker: true }).catch(() => esbuild.initialize({ wasmModule, worker: false }));
        post({ t: "ready" });
      } catch (err) {
        post({ t: "fatal", error: String((err as Error)?.message ?? err) });
      }
    })();
  } else if (d.t === "build") {
    const { id, kind } = d;
    chain = chain.then(async () => {
      const started = Date.now();
      let output: BuildOutput;
      try {
        output = await build(kind, d.changed ?? []);
      } catch (err) {
        output = failure(kind === "production" ? "production" : "development", err);
      }
      post({ t: "result", id, output, ms: Date.now() - started });
    });
  }
});

// anything that escapes a build still reaches the shell's console
const report = (text: string) => post({ t: "log", text: text.slice(0, 4000) });
addEventListener("error", (e) => report(String(e.error?.stack ?? e.message)));
addEventListener("unhandledrejection", (e) => report(String((e.reason as Error)?.stack ?? e.reason)));

post({ t: "loaded" });
