/**
 * The esbuild plugin every builder mode shares. It claims every import, so
 * esbuild never touches a file system of its own: resolution goes through
 * Resolver, contents through BuildFs, and assets are emitted by name (the
 * engine copies the bytes inside the app; they never travel through here).
 *
 * Covers what apps expect from a bundler: TS/JSX, JSON, CSS (+ modules, +
 * Tailwind), assets as URLs, ?raw ?url ?inline ?worker, import.meta.glob,
 * new URL('./x', import.meta.url), public/ paths in CSS, Node builtins as
 * empty modules.
 */
import type * as esbuild from "esbuild";
import { type BuildFs, basename, dirname, extname, joinPath, normPath, relativePath } from "./fs.js";
import { type ImportKind, type Resolver, splitQuery } from "./resolve.js";
import { type TailwindEngine, globToRegExp, isTailwindRoot } from "./tailwind.js";

export const ASSET_EXTS = new Set([
  ".apng", ".png", ".jpg", ".jpeg", ".jfif", ".pjpeg", ".pjp", ".gif", ".svg", ".ico", ".webp", ".avif", ".cur", ".jxl", ".bmp",
  ".mp4", ".webm", ".ogg", ".mp3", ".wav", ".flac", ".aac", ".opus", ".mov", ".m4a", ".vtt", ".mid", ".midi",
  ".woff", ".woff2", ".eot", ".ttf", ".otf",
  ".webmanifest", ".pdf", ".txt", ".wasm", ".glb", ".gltf", ".bin", ".hdr", ".ktx2", ".atlas", ".fnt", ".zip",
]);

const LOADERS: Record<string, esbuild.Loader> = {
  ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".jsx": "jsx",
  ".js": "js", ".mjs": "js", ".cjs": "js", ".json": "json", ".css": "css",
};

/** Where the bytes of an emitted asset come from and go to (dist-relative). */
export interface AssetCopy {
  from: string;
  to: string;
}

export interface EmittedFile {
  path: string;
  contents: string;
}

/** What one build run emitted besides esbuild's own outputs. */
export class Emitter {
  copies = new Map<string, AssetCopy>();
  files = new Map<string, EmittedFile>();
  warnings: string[] = [];

  constructor(private fs: BuildFs) {}

  /** dist path for an app file, named by content so caches bust on change. */
  async asset(from: string): Promise<string> {
    const hit = this.copies.get(from);
    if (hit) return hit.to;
    const hash = (await this.fs.hash(from)).slice(0, 8);
    const ext = extname(from);
    const stem = basename(from).slice(0, basename(from).length - ext.length).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "asset";
    const to = `assets/${stem}-${hash}${ext}`;
    this.copies.set(from, { from, to });
    return to;
  }
}

export interface PluginOptions {
  fs: BuildFs;
  resolver: Resolver;
  tailwind: TailwindEngine;
  emitter: Emitter;
  esbuild: typeof esbuild;
  mode: "development" | "production";
  /** JS expression for the URL of an emitted dist file (the build mode
   *  knows whether import.meta.url or the document is the right base). */
  assetUrl: (distPath: string) => string;
  /** How CSS output refers to an emitted file, from where the CSS lands. */
  cssAssetRef: (distPath: string) => string;
  define: Record<string, string>;
  /** Files esbuild loaded, for dev-mode dependency tracking. */
  onLoadFile?: (path: string) => void;
  /** Virtual entry sources ("\0entry:<n>" -> {path, contents}). */
  entries?: Map<string, { path: string; contents?: string; loader?: esbuild.Loader }>;
  /** Build a worker entry to a dist file; returns its dist path. */
  buildWorker?: (path: string) => Promise<string>;
}

const QUERY_KINDS = ["raw", "url", "inline", "worker", "sharedworker"] as const;
type QueryKind = (typeof QUERY_KINDS)[number];

function queryKind(query: string): QueryKind | null {
  const params = new URLSearchParams(query.replace(/^\?/, "").split("#")[0]);
  if (params.has("worker") || params.has("sharedworker")) {
    if (params.has("url")) return "url";
    return params.has("sharedworker") ? "sharedworker" : "worker";
  }
  for (const k of QUERY_KINDS) if (params.has(k)) return k;
  return null;
}

function importKind(k: esbuild.ImportKind): ImportKind {
  if (k === "import-rule" || k === "composes-from") return "css";
  if (k === "require-call" || k === "require-resolve") return "js-require";
  return "js-import";
}

export function loaderFor(path: string): esbuild.Loader {
  if (path.endsWith(".module.css")) return "local-css";
  const ext = extname(path);
  // JSX in .js is common in hand-written apps; node_modules stay strict
  if ((ext === ".js" || ext === ".mjs") && !path.includes("node_modules/")) return "jsx";
  return LOADERS[ext] ?? "js";
}

/** A JS string literal parser for the few spots that need one. */
function readStringLiteral(src: string, at: number): { value: string; end: number } | null {
  const q = src[at];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let out = "";
  for (let i = at + 1; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "\\") {
      out += src[i + 1] ?? "";
      i++;
    } else if (ch === q) return { value: out, end: i + 1 };
    else if (q === "`" && ch === "$" && src[i + 1] === "{") return null;
    else out += ch;
  }
  return null;
}

/** Skip whitespace and comments. */
function skipWs(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src.startsWith("//", i)) i = src.indexOf("\n", i) === -1 ? src.length : src.indexOf("\n", i);
    else if (src.startsWith("/*", i)) i = src.indexOf("*/", i) === -1 ? src.length : src.indexOf("*/", i) + 2;
    else return i;
  }
}

interface GlobOptions {
  eager: boolean;
  import: string | null;
  query: string;
}

/** Parse `{ eager: true, import: 'default', query: '?url' }` (literals only). */
function parseGlobOptions(src: string, at: number): { opts: GlobOptions; end: number } | null {
  const opts: GlobOptions = { eager: false, import: null, query: "" };
  let i = skipWs(src, at + 1);
  while (i < src.length && src[i] !== "}") {
    const key = /^['"]?([A-Za-z_$][\w$]*)['"]?\s*:/.exec(src.slice(i, i + 64));
    if (!key) return null;
    i = skipWs(src, i + key[0].length);
    let value: string | boolean;
    const lit = readStringLiteral(src, i);
    if (lit) {
      value = lit.value;
      i = lit.end;
    } else if (src.startsWith("true", i)) {
      value = true;
      i += 4;
    } else if (src.startsWith("false", i)) {
      value = false;
      i += 5;
    } else return null;
    if (key[1] === "eager") opts.eager = value === true;
    else if (key[1] === "import" && typeof value === "string") opts.import = value;
    else if (key[1] === "query" && typeof value === "string") opts.query = value.startsWith("?") ? value : "?" + value;
    else if (key[1] === "as" && typeof value === "string") opts.query = "?" + value;
    i = skipWs(src, i);
    if (src[i] === ",") i = skipWs(src, i + 1);
  }
  return src[i] === "}" ? { opts, end: i + 1 } : null;
}

/** import.meta.glob -> real imports (bundler semantics for literal args). */
export async function transformGlobs(src: string, file: string, walk: (dir: string) => Promise<string[]>): Promise<string> {
  if (!src.includes("import.meta.glob")) return src;
  const hoisted: string[] = [];
  let out = "";
  let last = 0;
  let n = 0;
  const re = /import\.meta\.glob(?:Eager)?\s*(?:<[^>]*>)?\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const eagerFn = m[0].startsWith("import.meta.globEager");
    let i = skipWs(src, m.index + m[0].length);
    const patterns: string[] = [];
    if (src[i] === "[") {
      i = skipWs(src, i + 1);
      while (src[i] !== "]") {
        const lit = readStringLiteral(src, i);
        if (!lit) break;
        patterns.push(lit.value);
        i = skipWs(src, lit.end);
        if (src[i] === ",") i = skipWs(src, i + 1);
      }
      if (src[i] !== "]") continue;
      i = skipWs(src, i + 1);
    } else {
      const lit = readStringLiteral(src, i);
      if (!lit) continue;
      patterns.push(lit.value);
      i = skipWs(src, lit.end);
    }
    let opts: GlobOptions = { eager: eagerFn, import: null, query: "" };
    if (src[i] === ",") {
      i = skipWs(src, i + 1);
      if (src[i] === "{") {
        const parsed = parseGlobOptions(src, i);
        if (!parsed) continue;
        opts = { ...parsed.opts, eager: parsed.opts.eager || eagerFn };
        i = skipWs(src, parsed.end);
      }
      if (src[i] === ",") i = skipWs(src, i + 1);
    }
    if (src[i] !== ")") continue;
    const fromDir = dirname(file);
    const matched = new Set<string>();
    const excluded = new Set<string>();
    for (const raw of patterns) {
      const neg = raw.startsWith("!");
      const pat = neg ? raw.slice(1) : raw;
      const full = pat.startsWith("/") ? joinPath(pat) : joinPath(fromDir, pat);
      const segs = full.split("/");
      const staticSegs: string[] = [];
      for (const s of segs) {
        if (/[*?{]/.test(s)) break;
        staticSegs.push(s);
      }
      const rx = globToRegExp(full);
      for (const f of await walk(staticSegs.join("/"))) if (rx.test(f)) (neg ? excluded : matched).add(f);
    }
    const entries: string[] = [];
    for (const f of [...matched].filter((f) => !excluded.has(f)).sort()) {
      if (f === file) continue;
      const key = patterns[0]?.startsWith("/") ? "/" + f : relativePath(fromDir, f);
      const spec = JSON.stringify(relativePath(fromDir, f) + opts.query);
      if (opts.eager) {
        const id = `__glob_${n}_${entries.length}`;
        hoisted.push(opts.import ? `import { ${opts.import === "default" ? "default" : opts.import} as ${id} } from ${spec};` : `import * as ${id} from ${spec};`);
        entries.push(`${JSON.stringify(key)}: ${id}`);
      } else {
        entries.push(`${JSON.stringify(key)}: () => import(${spec})${opts.import ? `.then((m) => m[${JSON.stringify(opts.import)}])` : ""}`);
      }
    }
    out += src.slice(last, m.index) + `({${entries.join(", ")}})`;
    last = i + 1;
    n++;
  }
  if (!n) return src;
  return hoisted.join("\n") + (hoisted.length ? "\n" : "") + out + src.slice(last);
}

/** new URL('./x', import.meta.url) -> an imported URL (a bundled worker for scripts). */
export function transformNewUrl(src: string): string {
  if (!src.includes("import.meta.url")) return src;
  const hoisted: string[] = [];
  let n = 0;
  const out = src.replace(/new\s+URL\(\s*(['"])(\.{1,2}\/[^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g, (_w, _q: string, rel: string) => {
    const id = `__chrysalis_url_${n++}`;
    const script = /\.(?:[cm]?[jt]sx?)$/.test(rel);
    hoisted.push(`import ${id} from ${JSON.stringify(rel + (script ? "?worker&url" : "?url"))};`);
    return `new URL(${id}, import.meta.url)`;
  });
  if (!n) return src;
  // only ES modules can take a hoisted import
  if (!/^\s*(?:import|export)\b/m.test(src)) return src;
  return hoisted.join("\n") + "\n" + out;
}

/**
 * Classify one import the way every build mode must: an external URL, an
 * empty module, an asset, a ?raw/?url/?inline/?worker variant, or an app
 * file. Returns esbuild's resolve shape; the dev transform maps namespaces
 * onto its own module kinds.
 */
export async function resolveImport(o: Pick<PluginOptions, "fs" | "resolver" | "emitter" | "cssAssetRef">, rawSpec: string, importer: string, kind: esbuild.ImportKind): Promise<esbuild.OnResolveResult> {
  const [spec, query] = splitQuery(rawSpec);
  if (/^(?:data|https?|blob):|^\/\//i.test(rawSpec) || (kind === "url-token" && rawSpec.startsWith("#"))) {
    return { path: rawSpec, external: true };
  }
  const qk = query ? queryKind(query) : null;
  const bareish = !/^(?:\.{1,2}\/|\/|~)/.test(spec);
  let resolved = null;
  // CSS: url(fonts/x.woff2) is always relative; @import "x.css" is
  // relative first, a package second (what browsers and bundlers do)
  if (kind === "url-token" && bareish) resolved = await o.resolver.resolve("./" + spec, importer, "css");
  else if (kind === "import-rule" && bareish && spec.endsWith(".css")) resolved = await o.resolver.resolve("./" + spec, importer, "css");
  resolved ??= await o.resolver.resolve(spec.replace(/^~/, ""), importer, importKind(kind));
  if (!resolved) {
    // a root-relative url() naming a public/ file stays a URL
    if (kind === "url-token" && spec.startsWith("/") && (await o.fs.isFile(joinPath("public", spec)))) {
      return { path: o.cssAssetRef(spec.slice(1)), external: true };
    }
    return { errors: [{ text: `Could not resolve "${rawSpec}"${importer ? ` from ${importer}` : ""}` }] };
  }
  if ("external" in resolved) return { path: resolved.external, external: true };
  if ("empty" in resolved) return { path: spec, namespace: "empty", pluginData: { reason: resolved.empty } };
  const file = resolved.path;
  if (kind === "url-token") {
    if (ASSET_EXTS.has(extname(file)) || qk === "url") return { path: o.cssAssetRef(await o.emitter.asset(file)), external: true };
  }
  if (qk === "raw") return { path: file, namespace: "raw" };
  if (qk === "inline") return { path: file, namespace: "inline" };
  if (qk === "worker" || qk === "sharedworker") return { path: file, namespace: qk };
  if (qk === "url") {
    if (/[?&](?:shared)?worker/.test(query)) return { path: file, namespace: "worker-url" };
    return { path: file, namespace: "asset" };
  }
  if (ASSET_EXTS.has(extname(file))) return { path: file, namespace: "asset" };
  return { path: file, namespace: "app", ...(resolved.sideEffects === false ? { sideEffects: false } : {}) };
}

/** Every file under `dir` (node_modules and dot-dirs skipped). */
export async function walkFiles(fs: BuildFs, dir: string): Promise<string[]> {
  const out: string[] = [];
  let level = [dir];
  for (let depth = 0; level.length && depth < 24; depth++) {
    const lists = await Promise.all(level.map((d) => fs.readdir(d)));
    const next: string[] = [];
    lists.forEach((entries, i) => {
      for (const e of entries ?? []) {
        const p = level[i] ? `${level[i]}/${e.name}` : e.name;
        if (e.kind === "dir") {
          if (e.name !== "node_modules" && !e.name.startsWith(".")) next.push(p);
        } else out.push(p);
      }
    });
    level = next;
  }
  return out;
}

export function createPlugin(o: PluginOptions): esbuild.Plugin {
  const walk = (dir: string) => walkFiles(o.fs, dir);
  return {
    name: "chrysalis-builder",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args): Promise<esbuild.OnResolveResult | undefined> => {
        if (args.kind === "entry-point") {
          const entry = o.entries?.get(args.path);
          if (entry) return { path: entry.path, namespace: entry.contents !== undefined ? "entry" : "app", pluginData: { entryKey: args.path } };
          // esbuild hands relative entry points back as "./x"
          return { path: normPath(args.path), namespace: "app" };
        }
        const importer = args.namespace === "app" || args.namespace === "entry" ? args.importer : ((args.pluginData as { importer?: string } | undefined)?.importer ?? "");
        return resolveImport(o, args.path, importer, args.kind);
      });

      build.onLoad({ filter: /.*/, namespace: "entry" }, (args) => {
        const entry = o.entries?.get((args.pluginData as { entryKey: string }).entryKey);
        return { contents: entry?.contents ?? "", loader: entry?.loader ?? "js" };
      });

      build.onLoad({ filter: /.*/, namespace: "app" }, async (args) => {
        o.onLoadFile?.(args.path);
        const loader = loaderFor(args.path);
        let contents = await o.fs.readText(args.path);
        if (loader === "css" && isTailwindRoot(contents)) {
          const built = await o.tailwind.build(args.path, contents);
          for (const d of built.deps) o.onLoadFile?.(d);
          contents = built.css;
        } else if (loader !== "css" && loader !== "local-css" && loader !== "json") {
          contents = transformNewUrl(await transformGlobs(contents, args.path, walk));
        }
        return { contents, loader };
      });

      build.onLoad({ filter: /.*/, namespace: "asset" }, async (args) => {
        o.onLoadFile?.(args.path);
        return { contents: `export default ${o.assetUrl(await o.emitter.asset(args.path))};`, loader: "js" };
      });

      build.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => {
        o.onLoadFile?.(args.path);
        return { contents: `export default ${JSON.stringify(await o.fs.readText(args.path))};`, loader: "js" };
      });

      build.onLoad({ filter: /.*/, namespace: "inline" }, async (args) => {
        o.onLoadFile?.(args.path);
        const ext = extname(args.path);
        const mime = MIME[ext] ?? "application/octet-stream";
        return { contents: `export default ${JSON.stringify(`data:${mime};base64,${await o.fs.readBase64(args.path)}`)};`, loader: "js" };
      });

      build.onLoad({ filter: /.*/, namespace: "empty" }, (args) => ({
        contents: "module.exports = {};",
        loader: "js",
        warnings: [{ text: String((args.pluginData as { reason?: string } | undefined)?.reason ?? `${args.path} is empty in the browser`) }],
      }));

      const workerModule = async (path: string, shared: boolean) => {
        if (!o.buildWorker) throw new Error("workers are not available in this build");
        const url = o.assetUrl(await o.buildWorker(path));
        const ctor = shared ? "SharedWorker" : "Worker";
        return `export default function WorkerWrapper(options) { return new ${ctor}(${url}, Object.assign({ type: "module" }, options)); }`;
      };
      build.onLoad({ filter: /.*/, namespace: "worker" }, async (args) => ({ contents: await workerModule(args.path, false), loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: "sharedworker" }, async (args) => ({ contents: await workerModule(args.path, true), loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: "worker-url" }, async (args) => {
        if (!o.buildWorker) throw new Error("workers are not available in this build");
        return { contents: `export default ${o.assetUrl(await o.buildWorker(args.path))};`, loader: "js" };
      });
    },
  };
}

export const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".opus": "audio/ogg",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".json": "application/json", ".txt": "text/plain", ".wasm": "application/wasm", ".pdf": "application/pdf",
};

/** CSS output lives in assets/: emitted files sit beside it. */
export const cssRefFromAssets = (distPath: string): string => relativePath("assets", distPath);
