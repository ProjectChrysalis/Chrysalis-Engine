/**
 * Browser bundles built at release time. A packaged copy of the engine has
 * neither the browser sources nor a bundler, so it serves these instead:
 *
 *   resources/prebuilt/<name>/manifest.json   { version, files: { name: type } }
 *   resources/prebuilt/<name>/<file>          one per manifest entry
 */
import fs from "node:fs";
import path from "node:path";

export interface PrebuiltFiles {
  version: string;
  files: Map<string, { body: Buffer; type: string }>;
}

export async function readPrebuilt(dir: string): Promise<PrebuiltFiles> {
  const manifestFile = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestFile)) throw new Error(`missing ${manifestFile}: this copy of Chrysalis is incomplete, reinstall it`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { version: string; files: Record<string, string> };
  const files: PrebuiltFiles["files"] = new Map();
  for (const [name, type] of Object.entries(manifest.files)) {
    files.set(name, { body: fs.readFileSync(path.join(dir, name)), type });
  }
  return { version: manifest.version, files };
}

export function writePrebuilt(dir: string, built: PrebuiltFiles): void {
  fs.mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const [name, f] of built.files) {
    fs.writeFileSync(path.join(dir, name), f.body);
    files[name] = f.type;
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: built.version, files }, null, 2) + "\n");
}
