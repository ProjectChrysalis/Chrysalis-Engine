/**
 * index.html the way bundlers treat it: module scripts and local stylesheets
 * are build entries, other local references are public/ files or assets, and
 * %VITE_*% placeholders take env values. Regex-based on purpose: it runs in
 * the builder frame and in Node tests alike, and only ever rewrites the
 * tags it recognises.
 */
import { type BuildFs, joinPath, normPath } from "./fs.js";
import type { Emitter } from "./plugin.js";

export interface HtmlEntry {
  /** placeholder index */
  n: number;
  kind: "script" | "style";
  /** app-relative source file, or null for an inline module script */
  path: string | null;
  inline?: string;
}

export interface HtmlPlan {
  /** index.html with <!--chrysalis:N--> where each entry was */
  template: string;
  entries: HtmlEntry[];
}

function parseAttrs(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of s.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    out.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

const isLocal = (url: string) => !!url && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);

/** Where a local URL in index.html points, app-relative. */
function localPath(url: string): string | null {
  try {
    return normPath(url.split(/[?#]/)[0]!);
  } catch {
    return null;
  }
}

export async function planHtml(html: string, fs: BuildFs, emitter: Emitter, env: Record<string, string | boolean>): Promise<HtmlPlan> {
  html = html.replace(/%([A-Z_][A-Z0-9_]*)%/g, (whole, key: string) => (key in env ? String(env[key]) : whole));
  const entries: HtmlEntry[] = [];

  // module scripts
  const scripts: Array<{ start: number; end: number; repl: string }> = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = parseAttrs(m[1]!);
    if ((attrs.get("type") ?? "").toLowerCase() !== "module") continue;
    const src = attrs.get("src");
    const n = entries.length;
    if (src !== undefined) {
      if (!isLocal(src)) continue;
      const p = localPath(src);
      if (!p) continue;
      entries.push({ n, kind: "script", path: p });
    } else {
      entries.push({ n, kind: "script", path: null, inline: m[2]! });
    }
    scripts.push({ start: m.index!, end: m.index! + m[0].length, repl: `<!--chrysalis:${n}-->` });
  }
  let out = "";
  let last = 0;
  for (const s of scripts) {
    out += html.slice(last, s.start) + s.repl;
    last = s.end;
  }
  html = out + html.slice(last);

  // stylesheets, and every other local src/href
  const tags: Array<{ start: number; end: number; repl: string }> = [];
  for (const m of html.matchAll(/<(link|img|source|video|audio|track|image|use|input|embed|object)\b([^>]*)>/gi)) {
    const tag = m[1]!.toLowerCase();
    const attrs = parseAttrs(m[2]!);
    const whole = m[0];
    if (tag === "link" && /(^|\s)stylesheet(\s|$)/i.test(attrs.get("rel") ?? "")) {
      const href = attrs.get("href") ?? "";
      const p = isLocal(href) ? localPath(href) : null;
      if (p && !(await fs.isFile(joinPath("public", p))) && (await fs.isFile(p))) {
        const n = entries.length;
        entries.push({ n, kind: "style", path: p });
        tags.push({ start: m.index!, end: m.index! + whole.length, repl: `<!--chrysalis:${n}-->` });
        continue;
      }
    }
    let rewritten = whole;
    for (const attr of ["src", "href", "poster", "data"]) {
      const v = attrs.get(attr);
      if (!v || !isLocal(v)) continue;
      const p = localPath(v);
      if (!p) continue;
      let to: string | null = null;
      if (await fs.isFile(joinPath("public", p))) to = "./" + p;
      else if (tag !== "link" || !/manifest/i.test(attrs.get("rel") ?? "")) {
        if (await fs.isFile(p)) to = "./" + (await emitter.asset(p));
      }
      if (to && to !== v) rewritten = rewritten.replace(new RegExp(`(${attr}\\s*=\\s*)(["']?)${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\2`, "i"), `$1"${to}"`);
    }
    if (rewritten !== whole) tags.push({ start: m.index!, end: m.index! + whole.length, repl: rewritten });
  }
  out = "";
  last = 0;
  for (const t of tags) {
    out += html.slice(last, t.start) + t.repl;
    last = t.end;
  }
  return { template: out + html.slice(last), entries };
}

/** Fill the placeholders: entry n -> the markup for its outputs. Stylesheets
 *  collected from script entries go at the end of <head>. */
export function fillHtml(plan: HtmlPlan, markup: (e: HtmlEntry) => string, headExtra: string): string {
  let html = plan.template.replace(/<!--chrysalis:(\d+)-->/g, (_w, n: string) => {
    const e = plan.entries[Number(n)];
    return e ? markup(e) : "";
  });
  if (headExtra) {
    const at = html.search(/<\/head\s*>/i);
    html = at === -1 ? headExtra + html : html.slice(0, at) + headExtra + html.slice(at);
  }
  return html;
}
