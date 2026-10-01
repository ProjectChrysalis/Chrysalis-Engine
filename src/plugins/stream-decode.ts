/**
 * Live decoder for a streaming wire format that wraps the real text in JSON
 * string fields (structured output). A request patch asks for it with
 * `streamDecode: { field }` or `{ fields: [...] }` plus optional literal
 * replacements; the runtime feeds provider deltas in and re-emits the decoded
 * text, so the live bubble shows what the final result will commit instead of
 * the wire format.
 */
export interface StreamDecodeSpec {
  /** The string properties to decode, in wire order. */
  fields: string[];
  /** Literal replacements applied to the decoded text (e.g. a newline token
   *  back to a newline). A sequence split across deltas holds back its tail
   *  until it can be decided. */
  replace?: { from: string; to: string }[];
}

/** Sanitize an untrusted streamDecode patch: bounded field names and
 *  replacements, ignorable as a whole when malformed. */
export function normalizeStreamDecodeSpec(raw: unknown): StreamDecodeSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const rawFields = (raw as { fields?: unknown }).fields;
  const single = (raw as { field?: unknown }).field;
  const list = Array.isArray(rawFields) ? rawFields : typeof single === "string" ? [single] : [];
  const fields: string[] = [];
  for (const entry of list.slice(0, 4)) {
    if (typeof entry !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(entry)) return null;
    fields.push(entry);
  }
  if (!fields.length) return null;
  const replace: { from: string; to: string }[] = [];
  const rawReplace = (raw as { replace?: unknown }).replace;
  if (Array.isArray(rawReplace)) {
    for (const entry of rawReplace.slice(0, 8)) {
      if (!entry || typeof entry !== "object") continue;
      const from = (entry as { from?: unknown }).from;
      const to = (entry as { to?: unknown }).to;
      if (typeof from !== "string" || typeof to !== "string") continue;
      if (!from || from.length > 32 || to.length > 32) continue;
      replace.push({ from, to });
    }
  }
  return replace.length ? { fields, replace } : { fields };
}

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

type Container = { kind: "object" | "array"; expect: "key" | "colon" | "value" | "comma"; key: string };
const MAX_FALLBACK_CHARS = 64 * 1024;
const MAX_DEPTH = 128;

export class JsonFieldStreamDecoder {
  private mode: "head" | "json" | "pass" | "done" = "head";
  private stack: Container[] = [];
  private string: "key" | "value" | null = null;
  private key = "";
  private selected = false;
  private found = false;
  private seen = new Set<string>();
  private escape = "";
  private quotePending = false;
  private quoteWhitespace = "";
  private primitive = false;
  private fallback = "";
  private omitted = 0;
  private output = "";
  private highSurrogate = "";
  private replacementHolds: string[];

  constructor(private readonly spec: StreamDecodeSpec, private readonly emit: (text: string) => void) {
    this.replacementHolds = (spec.replace ?? []).map(() => "");
  }

  push(chunk: string): void {
    if (!chunk || (this.mode === "done" && this.found)) return;
    if (this.mode === "pass") {
      this.emit(chunk);
      return;
    }
    for (const ch of chunk) {
      if (!this.found) {
        if (this.fallback.length < MAX_FALLBACK_CHARS) this.fallback += ch;
        else this.omitted += ch.length;
      }
      if (this.mode === "head") {
        if (/\s/.test(ch)) continue;
        if (ch !== "{") {
          this.mode = "pass";
          this.output += this.fallback;
          this.fallback = "";
          continue;
        }
        this.mode = "json";
        this.stack.push({ kind: "object", expect: "key", key: "" });
        continue;
      }
      if (this.mode === "pass") {
        this.output += ch;
        continue;
      }
      if (this.mode === "done") continue;
      this.consume(ch);
    }
    this.drain();
  }

  private consume(ch: string): void {
    if (this.string) {
      if (this.escape) {
        this.escape += ch;
        if (this.escape === "\\u" || (this.escape.startsWith("\\u") && this.escape.length < 6)) return;
        const value = this.escape.startsWith("\\u")
          ? (/^\\u[0-9a-fA-F]{4}$/.test(this.escape) ? String.fromCharCode(parseInt(this.escape.slice(2), 16)) : this.escape)
          : ESCAPES[this.escape.slice(1)] ?? this.escape.slice(1);
        this.escape = "";
        this.stringText(value);
        return;
      }
      if (this.quotePending) {
        if (/\s/.test(ch)) {
          this.quoteWhitespace += ch;
          return;
        }
        if (ch === "," || ch === "}") {
          this.endString();
          this.consume(ch);
          return;
        }
        // Some model outputs leave quotes unescaped inside selected prose.
        this.stringText('"' + this.quoteWhitespace);
        this.quotePending = false;
        this.quoteWhitespace = "";
      }
      if (ch === "\\") this.escape = "\\";
      else if (ch === '"') {
        if (this.selected) this.quotePending = true;
        else this.endString();
      } else this.stringText(ch);
      return;
    }
    if (this.primitive) {
      if (!/[\s,}\]]/.test(ch)) return;
      this.primitive = false;
      this.completeValue();
    }
    if (/\s/.test(ch)) return;
    const parent = this.stack.at(-1);
    if (!parent) {
      this.mode = "done";
      return;
    }
    if ((ch === "}" && parent.kind === "object") || (ch === "]" && parent.kind === "array")) {
      this.stack.pop();
      if (!this.stack.length) this.mode = "done";
      else this.completeValue();
      return;
    }
    if (parent.expect === "comma") {
      if (ch !== ",") { this.mode = "done"; return; }
      parent.expect = parent.kind === "object" ? "key" : "value";
      return;
    }
    if (parent.expect === "colon") {
      if (ch !== ":") { this.mode = "done"; return; }
      parent.expect = "value";
      return;
    }
    if (parent.expect === "key") {
      if (ch !== '"') { this.mode = "done"; return; }
      this.string = "key";
      this.key = "";
      return;
    }
    if (ch === "{" || ch === "[") {
      if (this.stack.length >= MAX_DEPTH) { this.mode = "done"; return; }
      this.stack.push({ kind: ch === "{" ? "object" : "array", expect: ch === "{" ? "key" : "value", key: "" });
    } else if (ch === '"') {
      this.string = "value";
      this.selected = this.stack.length === 1 && this.spec.fields.includes(parent.key) && !this.seen.has(parent.key);
      if (this.selected) {
        this.found = true;
        this.seen.add(parent.key);
        this.fallback = "";
        this.omitted = 0;
      }
    } else this.primitive = true;
  }

  private stringText(value: string): void {
    if (this.string === "key") {
      if (this.key.length <= 256) this.key += value;
    } else if (this.selected) this.output += value;
  }

  private endString(): void {
    const parent = this.stack.at(-1);
    if (this.string === "key" && parent) {
      parent.key = this.key;
      parent.expect = "colon";
    } else this.completeValue();
    this.string = null;
    this.selected = false;
    this.quotePending = false;
    this.quoteWhitespace = "";
  }

  private completeValue(): void {
    const parent = this.stack.at(-1);
    if (parent) parent.expect = "comma";
  }

  /** Sequential literal replacements, with only undecidable suffixes held.
   *  Full matches are consumed before suffix detection, including overlaps. */
  private replace(text: string, final: boolean): string {
    for (const [index, rule] of (this.spec.replace ?? []).entries()) {
      const source = this.replacementHolds[index]! + text;
      let out = "";
      let start = 0;
      for (let at = source.indexOf(rule.from); at >= 0; at = source.indexOf(rule.from, start)) {
        out += source.slice(start, at) + rule.to;
        start = at + rule.from.length;
      }
      const tail = source.slice(start);
      let hold = 0;
      if (!final) for (let n = Math.min(rule.from.length - 1, tail.length); n > 0; n--) {
        if (tail.endsWith(rule.from.slice(0, n))) { hold = n; break; }
      }
      this.replacementHolds[index] = tail.slice(tail.length - hold);
      text = out + tail.slice(0, tail.length - hold);
    }
    return text;
  }

  private drain(final = false): void {
    let text = this.highSurrogate + this.output;
    this.output = "";
    this.highSurrogate = "";
    const last = text.charCodeAt(text.length - 1);
    if (!final && last >= 0xd800 && last <= 0xdbff) {
      this.highSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    if (this.found) text = this.replace(text, final);
    if (text) this.emit(text);
  }

  flush(): void {
    if (this.selected && this.escape) this.output += this.escape;
    if (!this.found && this.mode !== "pass") {
      this.output += this.fallback;
      if (this.omitted) this.output += `\n[${this.omitted} chars of undecoded output omitted]`;
    }
    this.fallback = "";
    this.omitted = 0;
    this.escape = "";
    this.drain(true);
    this.mode = "done";
  }
}
