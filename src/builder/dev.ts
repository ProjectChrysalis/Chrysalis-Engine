/**
 * Dev mode with hot updates: the part of a dev server apps need, run in
 * the builder. Each app source file becomes its own CommonJS-style module
 * (esbuild for TS/JSX, Babel's React Refresh transform so components keep
 * their state), everything from node_modules is pre-bundled once into a deps
 * file, and the app frame's runtime (/client/builder/runtime.js) wires them
 * together and swaps changed modules in place.
 *
 * Output is plain files under dist/: index.html, dev/deps-*.js|css,
 * dev/app-*.js (all modules), dev/hot-<seq>.js (what changed since), and
 * dev/meta.json so a later builder session can continue the sequence.
 */
import type * as esbuild from "esbuild";
import type { BuildContext } from "./context.js";
import { TARGET, defines } from "./context.js";
import { Emitter, MIME, createPlugin, loaderFor, resolveImport, transformGlobs, transformNewUrl, walkFiles } from "./plugin.js";
import { fillHtml, planHtml, type HtmlPlan } from "./html.js";
import { buildWorkerBundle, messages, outRel, type BuildMessage, type BuildOutput } from "./prod.js";
import { isTailwindRoot } from "./tailwind.js";
import { basename, dirname, extname, relativePath } from "./fs.js";

/** Bump when the dev output format changes: older deps bundles are rebuilt. */
const FORMAT = 3;
/** Hot files kept before the next snapshot folds them in. */
const MAX_HOT = 20;

export interface DevMeta {
  format: number;
  depsKey: string;
  depsJs: string;
  depsCss: string | null;
  snapshot: string;
  hot: string[];
  seq: number;
  /** hot files kept past a snapshot for pages still catching up */
  retired: string[];
}

export interface DevOutput extends BuildOutput {
  /** dist files to delete after writing (superseded snapshots, hot files) */
  remove: string[];
  /** on a full replace, files to carry over from the previous dist */
  keep: string[];
  meta: DevMeta;
  /** set for a hot update */
  hot: { seq: number; file: string } | null;
  /** a full replace of dist (vs a patch) */
  full: boolean;
  /** true when nothing needed writing */
  unchanged?: boolean;
}

type Kind = "js" | "css" | "asset" | "raw" | "inline" | "worker" | "sharedworker" | "worker-url" | "empty";

interface Mod {
  id: string;
  file: string;
  kind: Kind;
  code: string;
  deps: Record<string, string>;
  /** files whose change means this module must be rebuilt */
  inputs: Set<string>;
  inline?: string;
  tailwind?: boolean;
  glob?: boolean;
  error?: BuildMessage;
}

const FULL_REBUILD = /^(?:index\.html|package\.json|package-lock\.json|bun\.lock|bun\.lockb|npm-shrinkwrap\.json|(?:ts|js)config[^/]*\.json|\.env[^/]*|node_modules\/.*)$/;
const REQUIRE = /\brequire\("((?:[^"\\]|\\.)*)"\)/g;
const FACTORY = "function (require, module, exports, __chrysalis_meta, $RefreshReg$, $RefreshSig$)";

/** Small sync string hash (cache keys and file names, not security). */
export function strHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822507);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export class DevSession {
  private mods = new Map<string, Mod>();
  private entryIds: string[] = [];
  private plan: HtmlPlan | null = null;
  private depIds = new Set<string>();
  private emitter: Emitter;
  private sentCopies = new Set<string>();
  meta: DevMeta | null = null;

  constructor(private ctx: BuildContext, prior: DevMeta | null) {
    this.emitter = new Emitter(ctx.fs);
    if (prior && prior.format === FORMAT) this.meta = prior;
  }

  private get base() {
    return {
      fs: this.ctx.fs,
      resolver: this.ctx.resolver,
      tailwind: this.ctx.tailwind,
      emitter: this.emitter,
      esbuild: this.ctx.env.esbuild,
      mode: this.ctx.mode,
      define: defines(this.ctx),
      assetUrl: (p: string) => `__chrysalis_dev.url(${JSON.stringify(p)})`,
      // dev CSS is a <style> in the document: emitted files resolve from it
      cssAssetRef: (p: string) => "./" + p,
      buildWorker: (p: string) => buildWorkerBundle(this.ctx, this.emitter, p),
    };
  }

  /** Map one import of `from` to a registry id, creating the module. */
  private async mapImport(spec: string, from: Mod, pending: Mod[]): Promise<string> {
    const r = await resolveImport(this.base, spec, from.file, "import-statement");
    // an unresolved import still builds (the module throws when it loads, so
    // the rest of the app keeps running) but it must be a BUILD error: the
    // error overlay and app_check read the build status, not the runtime
    if (r.errors?.length) {
      const text = r.errors[0]!.text ?? `Could not resolve "${spec}"`;
      from.error = { text, file: from.file };
      return "\0missing:" + text;
    }
    if (r.external) {
      const text = `"${spec}" is a remote URL; an app cannot import code from the network`;
      from.error = { text, file: from.file };
      return "\0missing:" + text;
    }
    const path = r.path!;
    const ns = r.namespace ?? "app";
    if (ns === "empty") return "\0empty";
    let id: string;
    let kind: Kind;
    if (ns === "app") {
      const ext = extname(path);
      if (ext === ".css") {
        id = path;
        kind = "css";
      } else if (path.includes("node_modules/")) {
        this.depIds.add(path);
        return "dep:" + path;
      } else {
        id = path;
        kind = "js";
      }
    } else {
      id = `${path}?${ns}`;
      kind = ns as Kind;
    }
    if (!this.mods.has(id) && !pending.some((m) => m.id === id)) {
      pending.push({ id, file: path, kind, code: "", deps: {}, inputs: new Set([path]) });
    }
    return id;
  }

  private refreshable(file: string, src: string): boolean {
    if (!this.ctx.env.refresh || file.includes("node_modules/")) return false;
    const ext = extname(file);
    if (ext === ".tsx" || ext === ".jsx") return true;
    return /\.(?:[cm]?[jt]s)$/.test(file) && /\bfunction\s+[A-Z]|\b(?:const|let|var)\s+[A-Z]\w*\s*=|\buse[A-Z]\w*\(/.test(src);
  }

  private async buildJs(m: Mod, pending: Mod[]): Promise<void> {
    const t = this.ctx.env.esbuild;
    const raw = m.inline ?? (await this.ctx.fs.readText(m.file));
    m.glob = raw.includes("import.meta.glob");
    const src = transformNewUrl(await transformGlobs(raw, m.file, (d) => walkFiles(this.ctx.fs, d)));
    const loader = m.inline !== undefined ? "tsx" : loaderFor(m.file);
    let code: string;
    if (loader === "json") {
      code = (await t.transform(src, { loader: "json", format: "cjs", sourcefile: m.file })).code;
    } else {
      code = (
        await t.transform(src, {
          loader,
          sourcefile: m.file,
          format: "esm",
          target: "es2022",
          ...this.ctx.jsxOptions,
          define: { "process.env.NODE_ENV": '"development"' },
        })
      ).code;
      if (this.refreshable(m.file, raw)) code = this.ctx.env.refresh!(code, m.file);
      code = (
        await t.transform(code, {
          loader: "js",
          sourcefile: m.file,
          format: "cjs",
          target: "es2022",
          supported: { "dynamic-import": false },
          define: { "import.meta": "__chrysalis_meta" },
        })
      ).code;
    }
    const specs = new Set<string>();
    for (const match of code.matchAll(REQUIRE)) {
      try {
        specs.add(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        /* not a string literal we can read */
      }
    }
    const list = [...specs];
    const targets = await Promise.all(list.map((spec) => this.mapImport(spec, m, pending)));
    m.deps = Object.fromEntries(list.map((spec, i) => [spec, targets[i]!]));
    m.code = code;
  }

  private async buildCss(m: Mod): Promise<void> {
    const inputs = new Set<string>([m.file]);
    const text = await this.ctx.fs.readText(m.file);
    m.tailwind = isTailwindRoot(text);
    const cssModule = m.file.endsWith(".module.css");
    const entries = new Map<string, { path: string; contents?: string; loader?: esbuild.Loader }>();
    const entry = cssModule ? "\0entry:cssmod" : m.file;
    if (cssModule) entries.set(entry, { path: `${dirname(m.file) ? dirname(m.file) + "/" : ""}__cssmod.js`, contents: `export { default } from ${JSON.stringify("./" + basename(m.file))};`, loader: "js" });
    const r = await this.ctx.env.esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      logLevel: "silent",
      target: TARGET,
      format: "cjs",
      outdir: "/__out",
      plugins: [createPlugin({ ...this.base, entries, onLoadFile: (p) => inputs.add(p) })],
    });
    const css = r.outputFiles?.find((f) => f.path.endsWith(".css"))?.text ?? "";
    const js = cssModule ? (r.outputFiles?.find((f) => f.path.endsWith(".js"))?.text ?? "") : "";
    m.inputs = inputs;
    m.deps = {};
    m.code = `${js}\n__chrysalis_dev.css(${JSON.stringify(m.id)}, ${JSON.stringify(css)});` + (cssModule ? "" : "\n__chrysalis_meta.hot.accept();");
  }

  private async buildMod(m: Mod, pending: Mod[]): Promise<void> {
    m.error = undefined;
    const esm = (value: string) => `module.exports = { __esModule: true, default: ${value} };`;
    switch (m.kind) {
      case "js":
        return this.buildJs(m, pending);
      case "css":
        return this.buildCss(m);
      case "asset":
        m.code = esm(`__chrysalis_dev.url(${JSON.stringify(await this.emitter.asset(m.file))})`);
        return;
      case "raw":
        m.code = esm(JSON.stringify(await this.ctx.fs.readText(m.file)));
        return;
      case "inline": {
        const mime = MIME[extname(m.file)] ?? "application/octet-stream";
        m.code = esm(JSON.stringify(`data:${mime};base64,${await this.ctx.fs.readBase64(m.file)}`));
        return;
      }
      case "worker":
      case "sharedworker":
      case "worker-url": {
        const out = await buildWorkerBundle(this.ctx, this.emitter, m.file);
        const url = `__chrysalis_dev.url(${JSON.stringify(out)})`;
        m.code =
          m.kind === "worker-url"
            ? esm(url)
            : esm(`function WorkerWrapper(o) { return new ${m.kind === "sharedworker" ? "SharedWorker" : "Worker"}(${url}, Object.assign({ type: "module" }, o)); }`);
        return;
      }
      case "empty":
        m.code = "module.exports = {};";
    }
  }

  /** Build modules and everything they newly import. */
  private async process(list: Mod[]): Promise<Mod[]> {
    const done: Mod[] = [];
    const queue = [...list];
    while (queue.length) {
      const batch = queue.splice(0, 48);
      const pending: Mod[] = [];
      await Promise.all(
        batch.map(async (m) => {
          try {
            await this.buildMod(m, pending);
          } catch (e) {
            const msg = messages((e as { errors?: esbuild.Message[] }).errors)[0] ?? { text: String((e as Error)?.message ?? e) };
            m.error = { ...msg, file: msg.file ?? m.file };
            m.code = `throw new SyntaxError(${JSON.stringify(`${m.error.file}${m.error.line ? `:${m.error.line}` : ""}: ${m.error.text}`)});`;
            m.deps = {};
          }
        }),
      );
      for (const m of batch) {
        this.mods.set(m.id, m);
        done.push(m);
      }
      for (const p of pending) if (!this.mods.has(p.id) && !queue.some((q) => q.id === p.id)) queue.push(p);
    }
    return done;
  }

  private async depsKey(): Promise<string> {
    const read = async (p: string) => ((await this.ctx.fs.isFile(p)) ? await this.ctx.fs.readText(p) : "");
    // Every lockfile spelling: an install with any of them moves the hash
    const locks = ["package-lock.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"];
    const lockTexts = await Promise.all(locks.map((l) => read(l)));
    return strHash([FORMAT, ...[...this.depIds].sort(), await read("package.json"), ...lockTexts].join("\n"));
  }

  private async buildDeps(): Promise<{ js: string; css: string | null; files: BuildOutput["files"] }> {
    const ids = [...this.depIds].sort();
    const contents =
      ids.map((p, i) => `import * as d${i} from ${JSON.stringify("/" + p)};`).join("\n") +
      `\n__chrysalis_dev.deps({${ids.map((p, i) => `${JSON.stringify(p)}: d${i}`).join(", ")}});\n`;
    const entries = new Map([["\0entry:deps", { path: "__deps.js", contents, loader: "js" as esbuild.Loader }]]);
    const r = await this.ctx.env.esbuild.build({
      entryPoints: ["\0entry:deps"],
      bundle: true,
      format: "iife",
      platform: "browser",
      write: false,
      logLevel: "silent",
      minify: true,
      charset: "utf8",
      target: TARGET,
      outdir: "/__out/dev",
      entryNames: "deps-[hash]",
      assetNames: "[name]-[hash]",
      define: { ...defines(this.ctx), "import.meta.hot": "undefined" },
      plugins: [createPlugin({ ...this.base, entries, cssAssetRef: (p) => relativePath("dev", p) })],
    });
    const files = (r.outputFiles ?? []).map((f) => ({ path: outRel(f.path), contents: f.text }));
    return { js: files.find((f) => f.path.endsWith(".js"))!.path, css: files.find((f) => f.path.endsWith(".css"))?.path ?? null, files };
  }

  private moduleSource(m: Mod): string {
    return `${JSON.stringify(m.id)}: [${JSON.stringify(m.deps)}, ${FACTORY} {\n${m.code}\n}]`;
  }

  private snapshot(): { path: string; contents: string } {
    const body = `__chrysalis_dev.env = ${JSON.stringify(this.ctx.metaEnv)};\n__chrysalis_dev.define({\n${[...this.mods.values()].map((m) => this.moduleSource(m)).join(",\n")}\n});\n`;
    return { path: `dev/app-${strHash(body).slice(0, 12)}.js`, contents: body };
  }

  private html(meta: DevMeta): string {
    const scripts =
      `<script src="/client/builder/runtime.js"></script>` +
      (meta.depsCss ? `<link rel="stylesheet" href="./${meta.depsCss}">` : "") +
      `<script src="./${meta.depsJs}"></script>` +
      `<script src="./${meta.snapshot}"></script>` +
      meta.hot.map((h) => `<script src="./${h}"></script>`).join("") +
      // a file, not inline: the app frame's policy allows no inline script
      `<script src="./dev/boot.js?v=${meta.seq}"></script>`;
    return fillHtml(this.plan!, () => "", scripts);
  }

  /** index.html, meta.json, and meta.js: a page that lost its event stream
   *  loads meta.js to learn which hot updates it missed. */
  private metaFiles(meta: DevMeta): BuildOutput["files"] {
    return [
      { path: "index.html", contents: this.html(meta) },
      { path: "dev/meta.json", contents: JSON.stringify(meta) },
      { path: "dev/meta.js", contents: `__chrysalis_dev.sync(${meta.seq}, ${JSON.stringify(meta.snapshot)});\n` },
      { path: "dev/boot.js", contents: `__chrysalis_dev.start(${JSON.stringify(this.entryIds)}, ${meta.seq});\n` },
    ];
  }

  private newCopies() {
    const out = [];
    for (const c of this.emitter.copies.values()) {
      if (this.sentCopies.has(c.to)) continue;
      this.sentCopies.add(c.to);
      out.push(c);
    }
    return out;
  }

  private newFiles(): BuildOutput["files"] {
    const out = [...this.emitter.files.values()];
    this.emitter.files.clear();
    return out;
  }

  private collectErrors(): BuildMessage[] {
    return [...this.mods.values()].filter((m) => m.error).map((m) => m.error!);
  }

  /**
   * Build everything. With `adopt` (the meta of what dist already holds,
   * built from the same sources), only the in-memory graph is built and
   * nothing is written: the session is warm for the next hot update.
   */
  async full(opts: { adopt?: boolean } = {}): Promise<DevOutput> {
    this.mods.clear();
    this.depIds.clear();
    this.entryIds = [];
    this.emitter = new Emitter(this.ctx.fs);
    this.sentCopies.clear();
    if (!(await this.ctx.fs.isFile("index.html"))) throw new Error("this app has no index.html");
    this.plan = await planHtml(await this.ctx.fs.readText("index.html"), this.ctx.fs, this.emitter, this.ctx.metaEnv);
    if (!this.plan.entries.length) throw new Error('index.html has no <script type="module"> or stylesheet to build');
    const roots: Mod[] = [];
    for (const e of this.plan.entries) {
      if (e.path) {
        const kind: Kind = extname(e.path) === ".css" ? "css" : "js";
        roots.push({ id: e.path, file: e.path, kind, code: "", deps: {}, inputs: new Set([e.path]) });
      } else {
        roots.push({ id: `index.html?inline-${e.n}`, file: "index.html", kind: "js", code: "", deps: {}, inputs: new Set(["index.html"]), inline: e.inline ?? "" });
      }
      this.entryIds.push(roots[roots.length - 1]!.id);
    }
    await this.process(roots);
    const key = await this.depsKey();
    const prior = this.meta;
    if (opts.adopt && prior && prior.depsKey === key) {
      // what dist holds was built from these sources: stay warm, write nothing
      for (const c of this.emitter.copies.values()) this.sentCopies.add(c.to);
      this.emitter.files.clear();
      return { ok: true, mode: "development", files: [], copies: [], warnings: [], errors: this.collectErrors(), remove: [], keep: [], meta: prior, hot: null, full: false, unchanged: true };
    }
    const files: BuildOutput["files"] = [];
    const keep: string[] = [];
    let depsJs: string;
    let depsCss: string | null;
    if (prior && prior.depsKey === key) {
      depsJs = prior.depsJs;
      depsCss = prior.depsCss;
      keep.push(depsJs, ...(depsCss ? [depsCss] : []));
    } else {
      const deps = await this.buildDeps();
      depsJs = deps.js;
      depsCss = deps.css;
      files.push(...deps.files);
    }
    const snap = this.snapshot();
    files.push(snap);
    const meta: DevMeta = { format: FORMAT, depsKey: key, depsJs, depsCss, snapshot: snap.path, hot: [], seq: prior?.seq ?? 0, retired: [] };
    this.meta = meta;
    files.push(...this.metaFiles(meta));
    files.push(...this.newFiles());
    return { ok: true, mode: "development", files, copies: this.newCopies(), warnings: [], errors: this.collectErrors(), remove: [], keep, meta, hot: null, full: true };
  }

  /** Files changed on disk: rebuild what they feed and emit a hot update. */
  async update(changed: string[]): Promise<DevOutput> {
    const { fs, tailwind, resolver } = this.ctx;
    fs.invalidate(changed);
    tailwind.invalidate(changed);
    if (!this.meta || !this.plan || changed.some((p) => FULL_REBUILD.test(p))) {
      resolver.reset();
      // package/lock changes move what the filesystem holds under us (an
      // install writes node_modules, invisible to the watcher): negative
      // stats cached while a package was missing must not survive the rebuild
      fs.invalidate("all");
      return this.full();
    }
    const changedSet = new Set(changed);
    const known = new Set<string>();
    const affected: Mod[] = [];
    for (const m of this.mods.values()) {
      for (const i of m.inputs) known.add(i);
      if ([...m.inputs].some((i) => changedSet.has(i))) affected.push(m);
    }
    // a file no module reads may be new: glob importers must look again
    if (changed.some((p) => !known.has(p))) for (const m of this.mods.values()) if (m.glob && !affected.includes(m)) affected.push(m);
    // Tailwind output depends on every source's classes
    for (const m of this.mods.values()) if (m.tailwind && !affected.includes(m)) affected.push(m);
    const before = new Map(affected.map((m) => [m.id, m.code + JSON.stringify(m.deps)]));
    const depCount = this.depIds.size;
    const built = await this.process(affected.map((m) => ({ ...m, inputs: new Set(m.inputs) })));
    // a new package import needs a new deps bundle, and the page a reload
    if (this.depIds.size !== depCount) return this.full();
    const out = built.filter((m) => before.get(m.id) !== m.code + JSON.stringify(m.deps));
    const meta = this.meta;
    if (!out.length) {
      return { ok: true, mode: "development", files: [], copies: [], warnings: [], errors: this.collectErrors(), remove: [], keep: [], meta, hot: null, full: false, unchanged: true };
    }
    meta.seq += 1;
    const hotFile = `dev/hot-${meta.seq}.js`;
    const errors = this.collectErrors();
    const files: BuildOutput["files"] = [
      { path: hotFile, contents: `__chrysalis_dev.update(${meta.seq}, {\n${out.map((m) => this.moduleSource(m)).join(",\n")}\n}, ${JSON.stringify({ errors })});\n` },
    ];
    const remove: string[] = [];
    meta.hot.push(hotFile);
    if (meta.hot.length > MAX_HOT) {
      // fold the hot files into a fresh snapshot; open pages already have
      // them, and new page loads should not replay a long history. The
      // latest few stay one more round for pages still catching up.
      remove.push(meta.snapshot, ...meta.retired);
      const snap = this.snapshot();
      files.push(snap);
      meta.snapshot = snap.path;
      meta.retired = meta.hot;
      meta.hot = [];
    }
    files.push(...this.metaFiles(meta));
    files.push(...this.newFiles());
    return { ok: true, mode: "development", files, copies: this.newCopies(), warnings: [], errors, remove, keep: [], meta, hot: { seq: meta.seq, file: hotFile }, full: false };
  }
}
