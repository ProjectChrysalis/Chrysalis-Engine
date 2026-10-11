/**
 * Script changes applied to an open page without loading it again, for
 * service apps whose pages load their script files as they are on disk.
 *
 * Running a changed file a second time would register everything it
 * registers twice and lose what the first run built, so nothing is run
 * again. Instead every function a page loads gets one line at its start:
 * when a newer body is on record for it, that body runs in its place, in the
 * same scope. A save then sends only the bodies that changed. The functions
 * already handed out (listeners, callbacks, methods) stay the same objects
 * and run the new code the next time they are called.
 *
 * What this cannot carry, and loads the page again instead: a change outside
 * every function (module-level code, imports, the parameters of a top-level
 * function). Generator functions and class constructors are left as they
 * are; a change inside one counts as a change to what surrounds it. Code
 * that already ran and will not run again (what built the page at start)
 * takes the new body and shows nothing until the page is loaded again.
 *
 * The added line calls eval where it stands, which is what lets the new body
 * see the function's own scope. It adds no lines, so line numbers in errors
 * stay true.
 */

/** The table a page keeps: newer bodies by function, and what it loaded. */
const TABLE = "__cH";
const MAX_SOURCE = 2_000_000;
/** Longer lines than this on average: built output, not a file to edit. */
const MAX_AVERAGE_LINE = 400;
const KEPT_STATES = 4000;
const KEPT_TEXTS = 400;

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
type Parse = (code: string, options: Record<string, unknown>) => { program: AstNode };

interface Unit {
  /** Where the function starts; its head runs up to `from`. */
  head: number;
  /** What a newer body replaces: a block body with its braces, or all that
   *  follows the arrow. */
  from: number;
  to: number;
  expr: boolean;
  async: boolean;
  /** Block bodies: where the added line goes, and whether a directive sits
   *  right before it. */
  at: number;
  afterDirective: boolean;
  depth: number;
  kids: Unit[];
  id: string;
}

/** What is remembered of a function between saves. */
interface Kept {
  id: string;
  /** Its body with the bodies of the functions inside it left out. */
  own: string;
  head: string;
  kids: Kept[];
}
interface FileState {
  own: string;
  kids: Kept[];
}

interface Insert {
  at: number;
  text: string;
  depth: number;
}

export type HotAnswer = { key: string; patches: Record<string, string> } | { reload: true } | { wait: true };

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
const NOT_CHILDREN = new Set(["loc", "extra", "leadingComments", "trailingComments", "innerComments", "tokens", "errors"]);

let parser: Promise<Parse> | undefined;
const loadParser = (): Promise<Parse> =>
  (parser ??= import("@babel/standalone").then((m) => m.packages.parser.parse as Parse));

const digest = (text: string): string => Bun.hash(text).toString(36);

const isNode = (v: unknown): v is AstNode => !!v && typeof (v as AstNode).type === "string" && typeof (v as AstNode).start === "number";

/** The end of the arrow that sits between an arrow function's parameters and
 *  its body. Only blanks, comments and brackets can come before it. */
function afterArrow(source: string, from: number, before: number): number {
  let i = from;
  while (i < before) {
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      if (end < 0) return -1;
      i = end;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 2;
    } else if (source.startsWith("=>", i)) {
      return i + 2;
    } else {
      i++;
    }
  }
  return -1;
}

function unitOf(node: AstNode, source: string, depth: number): Unit | null {
  if (node.generator === true) return null;
  if (node.type === "ClassMethod" && node.kind === "constructor") return null;
  const body = node.body;
  if (!isNode(body)) return null;
  const base = { head: node.start, async: node.async === true, depth, kids: [], id: "" };
  if (body.type === "BlockStatement") {
    const last = (Array.isArray(body.directives) ? (body.directives as AstNode[]) : []).at(-1);
    return { ...base, from: body.start, to: body.end, expr: false, at: last ? last.end : body.start + 1, afterDirective: !!last };
  }
  const params = Array.isArray(node.params) ? (node.params as AstNode[]) : [];
  const from = afterArrow(source, params.at(-1)?.end ?? node.start, body.start);
  if (from < 0) return null;
  return { ...base, from, to: node.end, expr: true, at: from, afterDirective: false };
}

/** The functions of a file, nested as they are in it. */
function read(parse: Parse, source: string): { kids: Unit[]; at: number; afterDirective: boolean } | null {
  let program: AstNode;
  try {
    program = parse(source, { sourceType: "unambiguous", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }).program;
  } catch {
    return null;
  }
  const top: Unit[] = [];
  const stack: Unit[][] = [top];
  const children = (node: AstNode, skip?: string): void => {
    for (const key in node) {
      if (key === skip || NOT_CHILDREN.has(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) visit(c);
      } else if (isNode(v)) {
        visit(v);
      }
    }
  };
  const visit = (node: AstNode): void => {
    const unit = FUNCTIONS.has(node.type) ? unitOf(node, source, stack.length) : null;
    if (!unit) {
      children(node);
      return;
    }
    // a function among the parameters belongs to what surrounds this one
    children(node, "body");
    (stack.at(-1) as Unit[]).push(unit);
    stack.push(unit.kids);
    visit(node.body as AstNode);
    stack.pop();
    unit.kids.sort((a, b) => a.from - b.from);
  };
  try {
    children(program);
  } catch {
    // nesting too deep to walk
    return null;
  }
  top.sort((a, b) => a.from - b.from);
  const last = (Array.isArray(program.directives) ? (program.directives as AstNode[]) : []).at(-1);
  return { kids: top, at: last ? last.end : 0, afterDirective: !!last };
}

function ownText(source: string, from: number, to: number, kids: Unit[]): string {
  let out = "";
  let at = from;
  for (const k of kids) {
    out += `${source.slice(at, k.from)}\0`;
    at = k.to;
  }
  return out + source.slice(at, to);
}

const headOf = (source: string, unit: Unit): string => digest(`${unit.async ? "a" : ""}${unit.expr ? "e" : ""}\0${source.slice(unit.head, unit.from)}`);

/** Give every function its name in the page's table: the one it had when
 *  the page still holds functions made from it, a new one otherwise. Those
 *  that keep a name and changed are collected. */
function settle(source: string, unit: Unit, was: Kept | null, tag: string, at: string, changed: Unit[]): Kept {
  unit.id = was ? was.id : `${tag}.${at}`;
  const own = digest(ownText(source, unit.from, unit.to, unit.kids));
  const same = was?.own === own;
  // a changed body still holds the same functions when it holds as many,
  // each with the head it had
  const old = was && (same || was.kids.length === unit.kids.length) ? was.kids : null;
  const kids = unit.kids.map((k, i) => {
    const o = old?.[i];
    return settle(source, k, o && (same || o.head === headOf(source, k)) ? o : null, tag, `${at}.${i}`, changed);
  });
  if (was && !same) changed.push(unit);
  return { id: unit.id, own, head: headOf(source, unit), kids };
}

function inserts(unit: Unit, out: Insert[]): void {
  const slot = `${TABLE}.s[${JSON.stringify(unit.id)}]`;
  const line = `if(${slot})return eval(${slot});`;
  if (unit.expr) {
    out.push({ at: unit.from, text: `{${line}return(`, depth: unit.depth }, { at: unit.to, text: ")}", depth: unit.depth });
  } else {
    out.push({ at: unit.at, text: (unit.afterDirective ? ";" : "") + line, depth: unit.depth });
  }
  for (const k of unit.kids) inserts(k, out);
}

function render(source: string, from: number, to: number, list: Insert[]): string {
  // arrows that end at the same place close from the inside out
  list.sort((a, b) => a.at - b.at || b.depth - a.depth);
  let out = "";
  let at = from;
  for (const i of list) {
    out += source.slice(at, i.at) + i.text;
    at = i.at;
  }
  return out + source.slice(at, to);
}

/** A newer body, as the added line runs it: called where the old one stood,
 *  so `this`, `arguments` and every name in reach are the function's own. */
function bodyOf(source: string, unit: Unit): string {
  const list: Insert[] = [];
  for (const k of unit.kids) inserts(k, list);
  const body = render(source, unit.from, unit.to, list);
  return `(${unit.async ? "async" : ""}()=>${unit.expr ? `(${body})` : body})()`;
}

function looksBuilt(source: string): boolean {
  let lines = 1;
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) lines++;
  return source.length / lines > MAX_AVERAGE_LINE;
}

function keep<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as string);
}

export class HotScripts {
  /** By the key a page holds for a file: what its functions are called there. */
  private states = new Map<string, FileState>();
  private texts = new Map<string, string | null>();

  /** A script as a page should load it, or null when it is served as it is. */
  async load(url: string, source: string): Promise<string | null> {
    const key = digest(`${url}\0${source}`);
    const had = this.texts.get(key);
    if (had === null || (had !== undefined && this.states.has(key))) return had;
    let text: string | null = null;
    const file = source.length <= MAX_SOURCE && !looksBuilt(source) ? read(await loadParser(), source) : null;
    if (file) {
      const kids = file.kids.map((k, i) => settle(source, k, null, key, String(i), []));
      keep(this.states, key, { own: digest(ownText(source, 0, source.length, file.kids)), kids }, KEPT_STATES);
      const list: Insert[] = [{
        at: file.at,
        text: `${file.afterDirective ? ";" : ""}globalThis.${TABLE}||(globalThis.${TABLE}={s:{},f:{}});${TABLE}.f[${JSON.stringify(url)}]=${JSON.stringify(key)};`,
        depth: -1,
      }];
      for (const k of file.kids) inserts(k, list);
      text = render(source, 0, source.length, list);
    }
    keep(this.texts, key, text, KEPT_TEXTS);
    return text;
  }

  /** What turns the copy a page holds (by its key) into this source. */
  async patch(key: string, source: string): Promise<HotAnswer> {
    const was = this.states.get(key);
    if (!was) return { reload: true };
    const file = read(await loadParser(), source);
    // saved halfway through a change: the save that parses again tells
    if (!file) return { wait: true };
    if (digest(ownText(source, 0, source.length, file.kids)) !== was.own) return { reload: true };
    const next = digest(`${key}\0${source}`);
    const changed: Unit[] = [];
    const kids = file.kids.map((k, i) => settle(source, k, was.kids[i] ?? null, next, String(i), changed));
    keep(this.states, next, { own: was.own, kids }, KEPT_STATES);
    const patches: Record<string, string> = {};
    for (const unit of changed) patches[unit.id] = bodyOf(source, unit);
    return { key: next, patches };
  }
}
