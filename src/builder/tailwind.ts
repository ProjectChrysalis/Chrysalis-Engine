/**
 * Tailwind v4 in the builder. The compiler is the real one (pure JS); what a
 * bundler's Tailwind plugin does in Node is done here over BuildFs:
 *   - `@import "tailwindcss"` and its sheets come from the builder's own copy,
 *     so the CSS always matches the compiler and apps need not install it
 *   - other @imports resolve inside the app, with their url()s rewritten to
 *     stay correct from the root stylesheet
 *   - class candidates come from scanning the app's text sources (and any
 *     @source paths, which can only name files inside the app)
 *   - @plugin / @config run only where the host supplies `loadModule`, which
 *     the sandboxed builder frame does and nothing on the engine side does
 */
import { compile } from "tailwindcss";
import { type BuildFs, dirname, joinPath, relativePath, extname, normPath } from "./fs.js";
import type { Resolver } from "./resolve.js";

/** Stylesheets that make a file a Tailwind root (what a bundler's Tailwind
 *  plugin checks). */
export function isTailwindRoot(css: string): boolean {
  return /@import\s+(?:url\()?\s*['"]tailwindcss(?:\/[^'"]*)?['"]|@tailwind\b|@(?:theme|utility|custom-variant|variant|plugin|config|reference|apply|source)\b/.test(css);
}

const SCAN_EXTS = new Set([".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".astro", ".md", ".mdx", ".json", ".txt"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "data", "plugins"]);
const SKIP_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);

/** Every plausible class name in a text file. Over-inclusive on purpose:
 *  the compiler drops what is not a utility, and a missed class is a
 *  visible bug while an extra token costs nothing. */
export function extractCandidates(text: string, into: Set<string> = new Set()): Set<string> {
  const add = (t: string) => {
    if (t.length < 2 || t.length > 200 || !/[a-z]/i.test(t)) return;
    into.add(t);
  };
  for (const m of text.matchAll(/[^\s"'`]+/g)) {
    const tok = m[0];
    add(tok);
    const trimmed = tok.replace(/^[({,;]+/, "").replace(/[;,)}:.]+$/, "");
    if (trimmed !== tok) add(trimmed);
    // `class=flex` / `{flex}` / `>text` in markup
    for (const part of tok.split(/[=<>{}]/)) if (part && part !== tok) add(part.replace(/[;,)}:.]+$/, ""));
  }
  // arbitrary values that carry their own quotes: content-['x'], font-["Inter"]
  for (const m of text.matchAll(/[^\s"'`<>]*\[[^\]\s]*?['"][^\]\s]*?\][^\s"'`<>]*/g)) add(m[0]);
  return into;
}

/** Minimal glob: ** , * , ? and {a,b}. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += "(?:" + glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

/** Rewrite relative url()s in a sheet moved from `fromDir` into `toDir`. */
export function rewriteCssUrls(css: string, fromDir: string, toDir: string): string {
  if (fromDir === toDir) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, q: string, url: string) => {
    const u = url.trim();
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(u)) return whole;
    try {
      return `url(${q}${relativePath(toDir, joinPath(fromDir, u))}${q})`;
    } catch {
      return whole;
    }
  });
}

export interface TailwindOptions {
  /** The builder's own tailwindcss stylesheets by file name. */
  sheets: Record<string, string>;
  /** Evaluate a JS module (plugin/config) — only inside the sandbox. */
  loadModule?: (appPath: string) => Promise<unknown>;
}

interface RootState {
  css: string;
  compiler: Awaited<ReturnType<typeof compile>>;
  deps: Set<string>;
  /** files and globs this root scans */
  scan: Array<{ dir: string; re: RegExp | null; negated: boolean; auto: boolean }>;
}

const BUILTIN = "\0tailwindcss";

export class TailwindEngine {
  private roots = new Map<string, RootState>();
  /** file -> candidates found in it */
  private candidates = new Map<string, Set<string>>();
  /** directory walks, cached until invalidated */
  private walks = new Map<string, Promise<string[]>>();

  constructor(private fs: BuildFs, private resolver: Resolver, private opts: TailwindOptions) {}

  private builtinSheet(id: string): { path: string; content: string } | null {
    let name = id === "tailwindcss" ? "index.css" : id.startsWith("tailwindcss/") ? id.slice("tailwindcss/".length) : null;
    if (name === null) return null;
    if (!name.endsWith(".css")) name += ".css";
    const content = this.opts.sheets[name];
    return content === undefined ? null : { path: `${BUILTIN}/${name}`, content };
  }

  private async compileRoot(path: string, css: string): Promise<RootState> {
    const rootDir = dirname(path);
    const deps = new Set<string>();
    const compiler = await compile(css, {
      base: rootDir,
      from: path,
      loadStylesheet: async (id: string, base: string) => {
        if (base === BUILTIN && id.startsWith("./")) id = "tailwindcss/" + id.slice(2);
        const builtin = this.builtinSheet(id);
        if (builtin) return { path: builtin.path, base: BUILTIN, content: builtin.content };
        const r = await this.resolver.resolve(id, joinPath(base, "__importer.css"), "css");
        if (!r || !("path" in r)) throw new Error(`Can't resolve '${id}' in '${base || "."}'`);
        deps.add(r.path);
        const content = rewriteCssUrls(await this.fs.readText(r.path), dirname(r.path), rootDir);
        return { path: r.path, base: dirname(r.path), content };
      },
      loadModule: async (id: string, base: string, hint: "plugin" | "config") => {
        if (!this.opts.loadModule) throw new Error(`Tailwind ${hint}s run only in the browser builder (${id})`);
        const r = await this.resolver.resolve(id, joinPath(base, "__importer.js"), "js-import");
        if (!r || !("path" in r)) throw new Error(`Can't resolve ${hint} '${id}' in '${base || "."}'`);
        deps.add(r.path);
        const mod = (await this.opts.loadModule(r.path)) as { default?: unknown } | null;
        const value = mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
        return { path: r.path, base: dirname(r.path), module: value as never };
      },
    });
    const scan: RootState["scan"] = [];
    const root = compiler.root;
    if (root === null) scan.push({ dir: "", re: null, negated: false, auto: true });
    else if (root !== "none") scan.push(this.sourceEntry(root.base, root.pattern, false));
    for (const s of compiler.sources) scan.push(this.sourceEntry(s.base, s.pattern, s.negated));
    return { css, compiler, deps, scan };
  }

  /** An @source / source() entry as a directory walk plus a filter. */
  private sourceEntry(base: string, pattern: string, negated: boolean): RootState["scan"][number] {
    const full = normPath(joinPath(base, pattern));
    const segs = full.split("/");
    const staticSegs: string[] = [];
    for (const s of segs) {
      if (/[*?{]/.test(s)) break;
      staticSegs.push(s);
    }
    const dir = staticSegs.join("/");
    const hasGlob = staticSegs.length < segs.length;
    return { dir, re: hasGlob ? globToRegExp(full) : null, negated, auto: false };
  }

  private walk(dir: string, auto: boolean): Promise<string[]> {
    const key = (auto ? "a:" : "e:") + dir;
    let got = this.walks.get(key);
    if (!got) {
      got = (async () => {
        const st = await this.fs.stat(dir);
        if (st?.kind === "file") return [dir];
        const out: string[] = [];
        let level = [dir];
        for (let depth = 0; level.length && depth < 24; depth++) {
          const lists = await Promise.all(level.map((d) => this.fs.readdir(d)));
          const next: string[] = [];
          lists.forEach((entries, i) => {
            for (const e of entries ?? []) {
              const p = level[i] ? `${level[i]}/${e.name}` : e.name;
              if (e.kind === "dir") {
                if (e.name.startsWith(".") || (auto || depth > 0 ? SKIP_DIRS.has(e.name) : false)) continue;
                next.push(p);
              } else if (SCAN_EXTS.has(extname(e.name)) && !SKIP_FILES.has(e.name)) out.push(p);
            }
          });
          level = next;
        }
        return out;
      })();
      this.walks.set(key, got);
    }
    return got;
  }

  private async fileCandidates(file: string): Promise<Set<string>> {
    let got = this.candidates.get(file);
    if (!got) {
      got = new Set();
      try {
        extractCandidates(await this.fs.readText(file), got);
      } catch {
        /* unreadable or too large: nothing to scan */
      }
      this.candidates.set(file, got);
    }
    return got;
  }

  private async rootCandidates(state: RootState): Promise<string[]> {
    const include = new Set<string>();
    const exclude = new Set<string>();
    for (const s of state.scan) {
      const files = (await this.walk(s.dir, s.auto)).filter((f) => !s.re || s.re.test(f));
      for (const f of files) (s.negated ? exclude : include).add(f);
    }
    const all = new Set<string>();
    const sets = await Promise.all([...include].filter((f) => !exclude.has(f)).map((f) => this.fileCandidates(f)));
    for (const set of sets) for (const c of set) all.add(c);
    return [...all];
  }

  /** Full CSS for a root stylesheet, plus the files it depends on. */
  async build(path: string, css: string): Promise<{ css: string; deps: string[] }> {
    let state = this.roots.get(path);
    if (!state || state.css !== css) {
      state = await this.compileRoot(path, css);
      this.roots.set(path, state);
    }
    return { css: state.compiler.build(await this.rootCandidates(state)), deps: [...state.deps] };
  }

  /** Files changed on disk: rescan them, recompile roots that imported them. */
  invalidate(paths: string[]): void {
    for (const p of paths) {
      this.candidates.delete(p);
      for (const [root, st] of this.roots) if (root === p || st.deps.has(p)) this.roots.delete(root);
    }
    // a new or deleted file changes directory listings
    this.walks.clear();
  }

  roots_(): string[] {
    return [...this.roots.keys()];
  }
}
