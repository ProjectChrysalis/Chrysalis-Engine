import fs from "node:fs";
import path from "node:path";

/** Validate every entry before replacing the previous runtime. */
export function extractSandboxFiles(files: Record<string, Uint8Array>, dest: string): void {
  const root = path.resolve(dest);
  const entries = Object.entries(files).map(([name, data]) => {
    const normalized = name.replace(/\\/g, "/");
    const segments = normalized.split("/");
    if (normalized.includes("\0") || normalized.includes(":") || segments.some((s) => !s || s === "." || s === "..")) throw new Error(`archive path escapes: ${name}`);
    const target = path.resolve(root, normalized);
    if (!target.startsWith(root + path.sep)) throw new Error(`archive path escapes: ${name}`);
    return { target, data };
  });
  fs.rmSync(root, { recursive: true, force: true });
  for (const { target, data } of entries) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}
