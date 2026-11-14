import { describe, expect, it } from "bun:test";
import { replaceLines, searchRegex } from "../src/agent/text-match.js";

describe("replaceLines", () => {
  const file = "function a() {\n    const x = 1;   \n    return x;\n}\n";

  it("ignores whitespace at line ends", () => {
    const r = replaceLines(file, "    const x = 1;\n    return x;", "    const x = 2;\n    return x;");
    expect(r).toEqual({ kind: "found", content: "function a() {\n    const x = 2;\n    return x;\n}\n" });
  });

  it("moves a consistently shifted replacement to the file's indent", () => {
    const r = replaceLines(file, "  const x = 1;\n  return x;", "  const y = 1;\n  return y;");
    expect(r).toEqual({ kind: "found", content: "function a() {\n    const y = 1;\n    return y;\n}\n" });
  });

  it("matches typographic dashes and quotes against plain ones", () => {
    const text = "She said “no” — twice.\nNext line.\n";
    const r = replaceLines(text, 'She said "no" - twice.', "She said yes.");
    expect(r).toEqual({ kind: "found", content: "She said yes.\nNext line.\n" });
  });

  it("keeps CRLF line endings", () => {
    const r = replaceLines("a\r\nb  \r\nc\r\n", "b\nc", "B\nC");
    expect(r).toEqual({ kind: "found", content: "a\r\nB\r\nC\r\n" });
  });

  it("refuses an ambiguous match and a missing one", () => {
    expect(replaceLines("x \nx \n", "x", "y")).toEqual({ kind: "ambiguous", count: 2 });
    expect(replaceLines(file, "const z = 3;", "")).toEqual({ kind: "none" });
    expect(replaceLines(file, "\n\n", "x")).toEqual({ kind: "none" });
  });

  it("does not match part of a line", () => {
    expect(replaceLines(file, "const x", "const y")).toEqual({ kind: "none" });
  });
});

describe("searchRegex", () => {
  it("turns a leading inline flag group into flags", () => {
    const re = searchRegex("(?i)lopunny|velvet");
    expect(re.flags).toContain("i");
    expect(re.test("VELVET")).toBe(true);
  });

  it("leaves other patterns alone", () => {
    expect(searchRegex("a(?:b)", true).source).toBe("a(?:b)");
    expect(searchRegex("a(?:b)", true).flags).toBe("gi");
    expect(() => searchRegex("(?x)a")).toThrow();
  });
});
