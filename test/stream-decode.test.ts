import { describe, it, expect } from "bun:test";
import { JsonFieldStreamDecoder, normalizeStreamDecodeSpec, type StreamDecodeSpec } from "../src/plugins/stream-decode.js";

function decode(spec: StreamDecodeSpec, chunks: string[]): string {
  const out: string[] = [];
  const d = new JsonFieldStreamDecoder(spec, (t) => out.push(t));
  for (const c of chunks) d.push(c);
  d.flush();
  return out.join("");
}

describe("JsonFieldStreamDecoder", () => {
  it("selects top-level fields in wire order, regardless of spec order or metadata", () => {
    const cases: [string, string[], string][] = [
      [JSON.stringify({ response: "BODY", prefix: "HEAD" }), ["prefix", "response"], "BODYHEAD"],
      [JSON.stringify({ metadata: "x".repeat(200), response: "BODY" }), ["response"], "BODY"],
      [JSON.stringify({ metadata: { response: "WRONG", nested: [{ prefix: "WRONG" }] }, response: "BODY" }), ["response", "prefix"], "BODY"],
      [JSON.stringify({ metadata: [true, 1, null, { response: "WRONG" }], response: "BODY", unused: "tail" }), ["response"], "BODY"],
      ['{"re\\u0073ponse":"BODY"}', ["response"], "BODY"],
      [JSON.stringify({ metadata: 'contains "response": "WRONG"', response: "BODY" }), ["response"], "BODY"],
    ];
    for (const [wire, fields, expected] of cases) {
      expect(decode({ fields }, [...wire])).toBe(expected);
      for (let cut = 0; cut <= wire.length; cut++) expect(decode({ fields }, [wire.slice(0, cut), wire.slice(cut)])).toBe(expected);
    }
  });

  it("does not expose metadata when no selected string has arrived yet", () => {
    const emitted: string[] = [];
    const d = new JsonFieldStreamDecoder({ fields: ["response"] }, (t) => emitted.push(t));
    d.push('{"metadata":"' + "x".repeat(100_000) + '",');
    expect(emitted).toEqual([]);
    d.push('"response":"Hello');
    expect(emitted.join("")).toBe("Hello");
    d.push(' world"}');
    d.flush();
    expect(emitted.join("")).toBe("Hello world");
  });

  it("consumes overlapping replacements consistently across chunk boundaries", () => {
    const spec = { fields: ["response"], replace: [{ from: "aa", to: "X" }, { from: "XX", to: "Y" }] };
    const wire = JSON.stringify({ response: "aaaa aaaa" });
    expect(decode(spec, [...wire])).toBe("Y Y");
    for (let cut = 0; cut <= wire.length; cut++) expect(decode(spec, [wire.slice(0, cut), wire.slice(cut)])).toBe("Y Y");
  });

  it("emits Unicode escape pairs without exposing a lone high surrogate", () => {
    const emitted: string[] = [];
    const d = new JsonFieldStreamDecoder({ fields: ["response"] }, (t) => emitted.push(t));
    d.push('{"response":"\\uD83D');
    expect(emitted).toEqual([]);
    d.push('\\uDE00"}');
    d.flush();
    expect(emitted).toEqual(["😀"]);
  });

  it("falls back only at the end when no top-level selected string exists", () => {
    for (const wire of ['{"response":null,"other":"x"}', '{"nested":{"response":"hidden"}}', '{"other":"x"} trailing']) {
      expect(decode({ fields: ["response"] }, [...wire])).toBe(wire);
      expect(decode({ fields: ["response"] }, [wire])).toBe(wire);
    }
  });

  it("decodes the field value across hostile chunk boundaries", () => {
    const wire = JSON.stringify({ response: "Hello there" });
    expect(decode({ fields: ["response"] }, [wire])).toBe("Hello there");
    // field name and colon split across deltas
    expect(decode({ fields: ["response"] }, ['{"resp', 'onse"', ' : "Hi', ' there', '"}'])).toBe("Hi there");
  });

  it("decodes escapes split across deltas, including \\u sequences", () => {
    const wire = JSON.stringify({ response: "line1\nline2 \"quoted\" \u2014 end" });
    for (let cut = 1; cut < wire.length; cut++) {
      expect(decode({ fields: ["response"] }, [wire.slice(0, cut), wire.slice(cut)])).toBe("line1\nline2 \"quoted\" \u2014 end");
    }
  });

  it("decodes several fields in wire order", () => {
    const wire = JSON.stringify({ prefix: "Here is my response:\n\n", response: "Hello there" });
    for (let cut = 1; cut < wire.length; cut++) {
      expect(decode({ fields: ["prefix", "response"] }, [wire.slice(0, cut), wire.slice(cut)])).toBe("Here is my response:\n\nHello there");
    }
  });

  it("handles unescaped quotes inside the value (best-effort models)", () => {
    expect(decode({ fields: ["response"] }, ['{"response":"say "hi" ok"}'])).toBe('say "hi" ok');
  });

  it("stops at the closing quote and ignores trailing fields", () => {
    expect(decode({ fields: ["response"] }, ['{"response": "done" , "other": "x"}'])).toBe("done");
    // no closing brace at all: flush drops the dangling quote
    expect(decode({ fields: ["response"] }, ['{"response":"abc"'])).toBe("abc");
  });

  it("applies replacements held across chunk splits", () => {
    const wire = JSON.stringify({ response: "a\\nb" });
    // wire contains a literal backslash + n in the decoded value
    for (let cut = 1; cut < wire.length; cut++) {
      const out = decode({ fields: ["response"], replace: [{ from: "\\n", to: "\n" }] }, [wire.slice(0, cut), wire.slice(cut)]);
      expect(out).toBe("a\nb");
    }
  });

  it("preserves a plain-text surrogate pair split across the first chunks", () => {
    const text = "😃 plain response";
    expect(decode({ fields: ["response"] }, [text.slice(0, 1), text.slice(1, 2), text.slice(2)])).toBe(text);
  });

  it("passes plain prose through untouched instead of showing nothing", () => {
    expect(decode({ fields: ["response"] }, ["Sure, ", "here is the reply."])).toBe("Sure, here is the reply.");
    // a JSON head without the field never becomes the envelope
    const junk = '{"something":"' + "x".repeat(80) + '"}';
    expect(decode({ fields: ["response"] }, [junk])).toBe(junk);
  });

  it("normalizes untrusted specs and refuses malformed ones", () => {
    expect(normalizeStreamDecodeSpec({ field: "response" })).toEqual({ fields: ["response"] });
    expect(normalizeStreamDecodeSpec({ fields: ["prefix", "response"] })).toEqual({ fields: ["prefix", "response"] });
    expect(normalizeStreamDecodeSpec({ fields: ["response"], replace: [{ from: "\\n", to: "\n" }, { from: "" }, { from: "a".repeat(64), to: "x" }] }))
      .toEqual({ fields: ["response"], replace: [{ from: "\\n", to: "\n" }] });
    expect(normalizeStreamDecodeSpec({ fields: ["not a field"] })).toBeNull();
    expect(normalizeStreamDecodeSpec({ fields: [] })).toBeNull();
    expect(normalizeStreamDecodeSpec(null)).toBeNull();
    expect(normalizeStreamDecodeSpec("response")).toBeNull();
  });
});
