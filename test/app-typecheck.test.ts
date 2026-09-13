/**
 * The roleplay app typechecks as part of the gate. The app build (esbuild)
 * only transpiles — it never resolves identifiers, so a render-time
 * ReferenceError (the `pagedGallery` blank-screen bug: a state block pasted
 * inside a useEffect callback, referenced from JSX) ships green. tsc catches
 * that class before deploy.
 */
import { describe, it, expect } from "bun:test";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "roleplay");

describe("roleplay app typecheck", () => {
  it("src compiles under the app's own tsconfig (the browser build never typechecks)", async () => {
    const r = await new Promise<{ failed: boolean; output: string }>((resolve) => {
      execFile(
        "npx",
        ["tsc", "--noEmit", "-p", "tsconfig.json"],
        { cwd: appDir, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ failed: !!err, output: `${String(stdout)}${String(stderr)}` }),
      );
    });
    // npm prints "npm notice run …" banners on some versions — not tsc output
    const tscOutput = r.output.split("\n").filter((l) => l.trim() && !l.startsWith("npm notice")).join("\n");
    expect(tscOutput).toBe("");
    expect(r.failed).toBe(false);
  }, 360_000);
});
