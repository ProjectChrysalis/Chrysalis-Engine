/**
 * Dist writer for the two first-party frontends. Same contract as the app
 * writer (staged swap, public/ copied in as-is, content-named assets written
 * from the copy list), except that copy sources may live at the repo root:
 * the frontends' packages are installed there, not beside the project.
 */
import fs from "node:fs";
import path from "node:path";
import type { AssetCopy } from "../../src/builder/plugin.js";

export interface DistFile {
  path: string;
  contents: string;
}

/** A copy source resolved under one of the allowed roots. */
function sourceOf(roots: string[], from: string): string | null {
  if (from.split("/").some((s) => s === ".." || s === "" || s === ".")) return null;
  for (const root of roots) {
    const full = path.join(root, ...from.split("/"));
    if (!path.resolve(full).startsWith(path.resolve(root) + path.sep)) continue;
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      /* not under this root */
    }
  }
  return null;
}

/** public/ is copied as-is: regular, non-dot files only. */
function copyPublic(projectDir: string, dest: string): void {
  const pub = path.join(projectDir, "public");
  const walk = (dir: string, into: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const src = path.join(dir, e.name);
      const out = path.join(into, e.name);
      if (e.isDirectory()) walk(src, out);
      else if (e.isFile()) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(src, out, fs.constants.COPYFILE_FICLONE);
      }
    }
  };
  if (fs.existsSync(pub)) walk(pub, dest);
}

export function writeDist(projectDir: string, repoRoot: string, files: DistFile[], copies: AssetCopy[]): void {
  const dist = path.join(projectDir, "dist");
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const staging = path.join(projectDir, `.dist-next-${stamp}`);
  const old = path.join(projectDir, `.dist-old-${stamp}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    copyPublic(projectDir, staging);
    for (const c of copies) {
      const src = sourceOf([projectDir, repoRoot], c.from);
      if (!src) throw new Error(`copy source ${c.from} is missing`);
      const dest = path.join(staging, ...c.to.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);
    }
    for (const f of files) {
      const dest = path.join(staging, ...f.path.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.contents);
    }
    if (fs.existsSync(dist)) fs.renameSync(dist, old);
    fs.renameSync(staging, dist);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
}
