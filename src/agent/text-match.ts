/**
 * Lenient matching for the file tools. Models quote text from memory: a
 * trailing space, a shifted indent or a typographic quote is enough to miss
 * an exact match, and each miss costs a re-read and another call.
 */

const PUNCTUATION: Record<string, string> = {
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
};

function plain(line: string): string {
  return line
    .trim()
    .replace(/[‐-―−‘-‟]/g, (c) => PUNCTUATION[c] ?? c)
    .replace(/[  -   　]/g, " ");
}

/** Each pass is looser than the one before; the first with a match decides. */
const PASSES: ((line: string) => string)[] = [(l) => l.trimEnd(), (l) => l.trim(), plain];

export type LineMatch =
  | { kind: "found"; content: string }
  | { kind: "ambiguous"; count: number }
  | { kind: "none" };

/**
 * Replace `oldText` in `content` by whole lines when it only differs in
 * whitespace at line ends, indentation, or dash and quote characters. A match
 * must be unique within the first pass that finds any. When only indentation
 * differed and every new line carries the indent the model used, that indent
 * becomes the file's, so the replacement lands at the right depth.
 */
export function replaceLines(content: string, oldText: string, newText: string): LineMatch {
  const pattern = oldText.replace(/\r?\n$/, "").split(/\r?\n/);
  if (!pattern.some((l) => l.trim())) return { kind: "none" };
  const lines = content.split("\n");
  for (const norm of PASSES) {
    const want = pattern.map(norm);
    const hits: number[] = [];
    for (let i = 0; i + pattern.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length && ok; j++) ok = norm(lines[i + j]!) === want[j];
      if (ok) hits.push(i);
    }
    if (hits.length > 1) return { kind: "ambiguous", count: hits.length };
    if (hits.length === 0) continue;
    const at = hits[0]!;
    const eol = lines[at]!.endsWith("\r") ? "\r\n" : "\n";
    const fileIndent = /^[ \t]*/.exec(lines[at]!)![0];
    const modelIndent = /^[ \t]*/.exec(pattern[0]!)![0];
    let body = newText.replace(/\r?\n$/, "").split(/\r?\n/);
    if (fileIndent !== modelIndent && body.every((l) => !l.trim() || l.startsWith(modelIndent))) {
      body = body.map((l) => (l.trim() ? fileIndent + l.slice(modelIndent.length) : l));
    }
    const last = lines[at + pattern.length - 1]!;
    const replaced = body.join(eol) + (last.endsWith("\r") ? "\r" : "");
    return { kind: "found", content: [...lines.slice(0, at), replaced, ...lines.slice(at + pattern.length)].join("\n") };
  }
  return { kind: "none" };
}

/**
 * A search pattern as a JavaScript RegExp. A leading inline flag group such
 * as `(?i)` is common in other regex dialects and a syntax error here, so it
 * becomes the matching flags instead.
 */
export function searchRegex(pattern: string, ignoreCase?: boolean): RegExp {
  const inline = /^\(\?([ims]+)\)/.exec(pattern);
  const flags = new Set(["g", ...(ignoreCase ? ["i"] : [])]);
  let source = pattern;
  if (inline) {
    source = pattern.slice(inline[0].length);
    for (const f of inline[1]!) flags.add(f);
  }
  return new RegExp(source, [...flags].join(""));
}
