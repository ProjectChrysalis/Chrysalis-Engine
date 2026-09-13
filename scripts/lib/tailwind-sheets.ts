/**
 * Tailwind v4's own stylesheets, which the builder compiles against instead
 * of an installed package: `@import "tailwindcss"` maps to these, so the CSS
 * always comes from the same compiler version as everything else.
 */
import fs from "node:fs";
import path from "node:path";

const SHEETS = ["index.css", "theme.css", "preflight.css", "utilities.css"];

export function tailwindSheets(repoRoot: string): Record<string, string> {
  const dir = path.join(repoRoot, "node_modules", "tailwindcss");
  return Object.fromEntries(SHEETS.map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
}
