/**
 * Module resolution for the in-browser builder: what vite + node would do,
 * over BuildFs. Relative and root-relative paths, tsconfig `paths`, the `@`
 * → src convention, and bare packages (exports / browser / module / main,
 * nearest node_modules first). Everything stays inside the app: the file
 * route refuses anything else, and normPath refuses to climb out.
 */
import { type BuildFs, dirname, joinPath, normPath, extname } from "./fs.js";

export type ImportKind = "js-import" | "js-require" | "css";

export type Resolved =
  | { path: string; sideEffects?: boolean }
  | { external: string }
  | { empty: string };

interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  style?: string;
  browser?: string | Record<string, string | false>;
  exports?: unknown;
  imports?: Record<string, unknown>;
  sideEffects?: boolean | string[];
}

const NODE_BUILTINS = new Set(
  "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split(" "),
);

const JS_EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json"];
const CSS_EXTS = [".css"];

/** tsconfig/jsconfig, JSON with comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export interface TsConfig {
  paths: Array<{ prefix: string; suffix: string; wildcard: boolean; targets: string[] }>;
  compilerOptions: Record<string, unknown>;
}

/** The app's tsconfig (following `extends` inside the app and the
 *  `references` split vite's templates use). */
export async function loadTsConfig(fs: BuildFs): Promise<TsConfig> {
  const merged: Record<string, unknown> = {};
  let pathsBase = "";
  let rawPaths: Record<string, string[]> | undefined;
  const seen = new Set<string>();
  const load = async (file: string, depth: number): Promise<void> => {
    if (depth > 4 || seen.has(file) || !(await fs.isFile(file))) return;
    seen.add(file);
    let json: { extends?: unknown; compilerOptions?: Record<string, unknown>; references?: Array<{ path?: string }> };
    try {
      json = parseJsonc(await fs.readText(file)) as typeof json;
    } catch {
      return;
    }
    const dir = dirname(file);
    if (typeof json.extends === "string" && json.extends.startsWith(".")) {
      let ext = joinPath(dir, json.extends);
      if (!ext.endsWith(".json")) ext += ".json";
      await load(ext, depth + 1);
    }
    const co = json.compilerOptions ?? {};
    Object.assign(merged, co);
    if (co.paths && typeof co.paths === "object") {
      rawPaths = co.paths as Record<string, string[]>;
      pathsBase = typeof co.baseUrl === "string" ? joinPath(dir, co.baseUrl) : dir;
    }
    for (const ref of json.references ?? []) {
      if (typeof ref.path !== "string") continue;
      let target = joinPath(dir, ref.path);
      if (!target.endsWith(".json")) target = (await fs.isDir(target)) ? joinPath(target, "tsconfig.json") : target + ".json";
      // the node-side config (vite.config's own) does not describe the app
      if (target.endsWith("tsconfig.node.json")) continue;
      await load(target, depth + 1);
    }
  };
  await load("tsconfig.json", 0);
  if (!seen.size) await load("jsconfig.json", 0);
  const paths: TsConfig["paths"] = [];
  for (const [key, targets] of Object.entries(rawPaths ?? {})) {
    if (!Array.isArray(targets)) continue;
    const star = key.indexOf("*");
    paths.push({
      prefix: star === -1 ? key : key.slice(0, star),
      suffix: star === -1 ? "" : key.slice(star + 1),
      wildcard: star !== -1,
      targets: targets.filter((t): t is string => typeof t === "string").map((t) => {
        try {
          return joinPath(pathsBase, t);
        } catch {
          return "";
        }
      }).filter(Boolean),
    });
  }
  // longest prefix wins, like TypeScript
  paths.sort((a, b) => b.prefix.length - a.prefix.length);
  return { paths, compilerOptions: merged };
}

export function splitQuery(spec: string): [string, string] {
  // a leading # is a package "imports" specifier, not a fragment
  const q = spec.slice(1).search(/[?#]/);
  return q === -1 ? [spec, ""] : [spec.slice(0, q + 1), spec.slice(q + 1)];
}

function packageName(spec: string): [string, string] {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  return [parts.slice(0, n).join("/"), parts.slice(n).join("/")];
}

/** Node's PACKAGE_EXPORTS_RESOLVE, conditions in the caller's order. */
export function resolveExports(exportsField: unknown, subpath: string, conditions: string[], isImports = false): string | null | undefined {
  let map = exportsField;
  const isSubpathMap = (o: unknown) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).some((k) => k.startsWith("."));
  if (!isImports && (typeof map === "string" || Array.isArray(map) || !isSubpathMap(map))) map = { ".": map };
  const table = map as Record<string, unknown>;
  const target = (t: unknown, star: string): string | null | undefined => {
    if (typeof t === "string") return star === "" ? t : t.split("*").join(star);
    if (t === null) return null;
    if (Array.isArray(t)) {
      for (const x of t) {
        const r = target(x, star);
        if (r) return r;
      }
      return undefined;
    }
    if (t && typeof t === "object") {
      for (const [cond, v] of Object.entries(t)) {
        if (cond === "default" || conditions.includes(cond)) {
          const r = target(v, star);
          if (r !== undefined) return r;
        }
      }
    }
    return undefined;
  };
  if (subpath in table && !subpath.includes("*")) return target(table[subpath], "");
  // the key with the longest prefix before its `*` wins
  let best: string | null = null;
  let bestLen = -1;
  for (const key of Object.keys(table)) {
    const star = key.indexOf("*");
    if (star === -1) {
      // legacy folder mapping "./dir/": "./dist/dir/"
      if (key.endsWith("/") && subpath.startsWith(key) && key.length > bestLen) {
        best = key;
        bestLen = key.length;
      }
      continue;
    }
    const pre = key.slice(0, star);
    const post = key.slice(star + 1);
    if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= key.length - 1 && pre.length > bestLen) {
      best = key;
      bestLen = pre.length;
    }
  }
  if (!best) return undefined;
  const star = best.indexOf("*");
  if (star === -1) {
    const t = target(table[best], "");
    return t ? t + subpath.slice(best.length) : t;
  }
  const middle = subpath.slice(star, subpath.length - (best.length - star - 1));
  return target(table[best], middle);
}

/** `sideEffects: false | [globs]` for a file inside a package. */
function sideEffectsOf(pkg: PackageJson, relInPkg: string): boolean | undefined {
  const se = pkg.sideEffects;
  if (se === false) return false;
  if (!Array.isArray(se)) return undefined;
  const hit = se.some((g) => {
    const pattern = g.replace(/^\.\//, "");
    const re = new RegExp(
      "^" + (pattern.includes("/") ? "" : "(?:.*/)?") +
        pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?|\*/g, (m) => (m.startsWith("**") ? ".*" : "[^/]*")) + "$",
    );
    return re.test(relInPkg);
  });
  return hit ? undefined : false;
}

export class Resolver {
  private pkgs = new Map<string, Promise<PackageJson | null>>();

  constructor(
    private fs: BuildFs,
    private ts: TsConfig,
    private mode: "development" | "production",
  ) {}

  private readPkg(dir: string): Promise<PackageJson | null> {
    let got = this.pkgs.get(dir);
    if (!got) {
      got = (async () => {
        const file = joinPath(dir, "package.json");
        if (!(await this.fs.isFile(file))) return null;
        try {
          return JSON.parse(await this.fs.readText(file)) as PackageJson;
        } catch {
          return null;
        }
      })();
      this.pkgs.set(dir, got);
    }
    return got;
  }

  /** Invalidate cached package.json reads (deps reinstalled). */
  reset(): void {
    this.pkgs.clear();
  }

  /** The package directory a file lives in (nearest node_modules/<pkg>). */
  private packageRootOf(file: string): string | null {
    const idx = file.lastIndexOf("node_modules/");
    if (idx === -1) return null;
    const rest = file.slice(idx + "node_modules/".length).split("/");
    const n = rest[0]?.startsWith("@") ? 2 : 1;
    return file.slice(0, idx + "node_modules/".length) + rest.slice(0, n).join("/");
  }

  /** First existing candidate, stat'd in parallel (one round trip). */
  private async firstFile(cands: string[]): Promise<string | null> {
    const stats = await Promise.all(cands.map((c) => this.fs.stat(c)));
    const i = stats.findIndex((s) => s?.kind === "file");
    return i === -1 ? null : cands[i]!;
  }

  private async resolveFile(p: string, kind: ImportKind): Promise<string | null> {
    const exts = kind === "css" ? CSS_EXTS : JS_EXTS;
    const cands = [p];
    const ext = extname(p);
    // TypeScript's ESM convention: "./x.js" names ./x.ts
    const tsTwin: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
    for (const t of tsTwin[ext] ?? []) cands.push(p.slice(0, -ext.length) + t);
    for (const e of exts) cands.push(p + e);
    const direct = await this.firstFile(cands);
    if (direct) return direct;
    if (!(await this.fs.isDir(p))) return null;
    const pkg = await this.readPkg(p);
    if (pkg && kind !== "css") {
      for (const entry of [typeof pkg.browser === "string" ? pkg.browser : undefined, pkg.module, pkg.main]) {
        if (!entry) continue;
        const hit = await this.resolveFile(joinPath(p, entry), kind);
        if (hit) return hit;
      }
    }
    return this.firstFile(exts.map((e) => joinPath(p, "index" + e)));
  }

  private conditions(kind: ImportKind): string[] {
    if (kind === "css") return ["style", "browser", "import", "module", this.mode];
    return ["browser", kind === "js-require" ? "require" : "import", "module", this.mode];
  }

  private async resolvePackage(spec: string, fromDir: string, kind: ImportKind): Promise<Resolved | null> {
    const [name, sub] = packageName(spec);
    const dirs: string[] = [];
    let d = fromDir;
    for (;;) {
      if (!d.endsWith("node_modules") && !/(^|\/)node_modules$/.test(d)) dirs.push(joinPath(d, "node_modules", name));
      if (d === "") break;
      d = dirname(d);
    }
    const stats = await Promise.all(dirs.map((x) => this.fs.stat(x)));
    const at = stats.findIndex((s) => s?.kind === "dir");
    if (at === -1) return null;
    const pkgDir = dirs[at]!;
    const pkg = (await this.readPkg(pkgDir)) ?? {};
    let file: string | null = null;
    if (pkg.exports !== undefined) {
      const subpath = sub ? "./" + sub : ".";
      let target = resolveExports(pkg.exports, subpath, this.conditions(kind));
      // a package that only answers `require` still bundles fine
      if (target === undefined && kind === "js-import") target = resolveExports(pkg.exports, subpath, this.conditions("js-require"));
      if (target === null) throw new Error(`"${spec}" is not exported by ${name}`);
      if (target !== undefined) file = await this.resolveFile(joinPath(pkgDir, target), kind);
    }
    if (!file && sub) file = await this.resolveFile(joinPath(pkgDir, sub), kind);
    if (!file && !sub) {
      const entries = kind === "css"
        ? [pkg.style, pkg.main, "index.css"]
        : [typeof pkg.browser === "string" ? pkg.browser : undefined, pkg.module, pkg.main, "index"];
      for (const e of entries) {
        if (!e) continue;
        file = await this.resolveFile(joinPath(pkgDir, e), kind);
        if (file) break;
      }
    }
    if (!file) return null;
    return this.applyBrowserMap(file, pkgDir, pkg);
  }

  private applyBrowserMap(file: string, pkgDir: string, pkg: PackageJson): Resolved {
    const rel = file.slice(pkgDir.length + 1);
    if (pkg.browser && typeof pkg.browser === "object") {
      for (const key of ["./" + rel, "./" + rel.replace(/\.[cm]?js$/, ""), rel]) {
        if (!(key in pkg.browser)) continue;
        const to = pkg.browser[key];
        if (to === false) return { empty: `${rel} is disabled for browsers by its package` };
        if (typeof to === "string") return { path: joinPath(pkgDir, to) };
      }
    }
    const se = sideEffectsOf(pkg, rel);
    return se === false ? { path: file, sideEffects: false } : { path: file };
  }

  /**
   * Resolve `spec` imported from app-relative file `importer` ("" for the
   * app root). Returns null when nothing matches.
   */
  async resolve(spec: string, importer: string, kind: ImportKind): Promise<Resolved | null> {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(spec) && !spec.startsWith("node:")) return { external: spec };
    const fromDir = dirname(importer);
    const bare = spec.replace(/^node:/, "");
    if (spec.startsWith("node:") || (NODE_BUILTINS.has(bare.split("/")[0]!) && !spec.startsWith("."))) {
      return { empty: `"${spec}" is a Node.js module and has no browser version` };
    }

    // a bare name inside a package may be remapped by its browser field
    const owner = this.packageRootOf(importer);
    if (owner && !spec.startsWith(".") && !spec.startsWith("/")) {
      const pkg = await this.readPkg(owner);
      if (pkg?.browser && typeof pkg.browser === "object" && spec in pkg.browser) {
        const to = pkg.browser[spec];
        if (to === false) return { empty: `"${spec}" is disabled for browsers by ${pkg.name ?? owner}` };
        if (typeof to === "string") {
          // a relative target is relative to the package root
          if (!to.startsWith(".")) spec = to;
          else {
            const file = await this.resolveFile(joinPath(owner, to), kind);
            return file ? { path: file } : null;
          }
        }
      }
    }

    if (spec.startsWith("#")) {
      // package.json "imports" of the nearest package
      let d = fromDir;
      for (;;) {
        const pkg = await this.readPkg(d);
        if (pkg) {
          const target = pkg.imports ? resolveExports(pkg.imports, spec, this.conditions(kind), true) : undefined;
          if (!target) return null;
          if (!target.startsWith("./")) return this.resolvePackage(target, d, kind);
          const file = await this.resolveFile(joinPath(d, target), kind);
          return file ? this.applyBrowserMap(file, d, pkg) : null;
        }
        if (d === "") return null;
        d = dirname(d);
      }
    }

    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      const file = await this.resolveFile(joinPath(fromDir, spec), kind);
      if (!file) return null;
      const pkgRoot = this.packageRootOf(file);
      return pkgRoot ? this.applyBrowserMap(file, pkgRoot, (await this.readPkg(pkgRoot)) ?? {}) : { path: file };
    }
    if (spec.startsWith("/")) {
      // vite: root-relative to the app, never a host path
      const file = await this.resolveFile(normPath(spec), kind);
      return file ? { path: file } : null;
    }

    // app aliases: tsconfig paths, then the `@` -> src convention
    if (!owner) {
      for (const m of this.ts.paths) {
        if (!spec.startsWith(m.prefix) || !spec.endsWith(m.suffix)) continue;
        if (!m.wildcard && spec !== m.prefix) continue;
        const star = m.wildcard ? spec.slice(m.prefix.length, spec.length - m.suffix.length) : "";
        for (const t of m.targets) {
          const file = await this.resolveFile(t.split("*").join(star), kind);
          if (file) return { path: file };
        }
      }
      if (spec.startsWith("@/") && !this.ts.paths.some((m) => m.prefix === "@/")) {
        const file = await this.resolveFile(joinPath("src", spec.slice(2)), kind);
        if (file) return { path: file };
      }
    }
    return this.resolvePackage(spec, fromDir, kind);
  }
}
