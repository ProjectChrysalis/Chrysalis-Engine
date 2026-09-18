/**
 * Fetches the pinned sandbox release (frame + kernel + image + lazy programs)
 * from the chrysalis-sandbox repository into resources/prebuilt/sandbox-k.
 * The engine serves that directory; source checkouts run this once.
 *
 *   bun run sandbox:fetch            (skips when already present)
 *   bun run sandbox:fetch --force    (re-download)
 *   CHRYSALIS_SANDBOX_DIR=...        (use a local build instead)
 */
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { resourcesDir } from "../src/install";

const RELEASE = {
  version: "0.3.8",
  url: "https://github.com/ProjectChrysalis/chrysalis-sandbox/releases/download/v0.3.8/sandbox-0.3.8.zip",
  sha256: "20faf1e859b3f5eb3e410223285b14f01e6f7e9d4ffd912b1960dc43c6e0a4f0",
};

const dest = path.join(resourcesDir(), "prebuilt", "sandbox-k");
const force = process.argv.includes("--force");

if (!force && fs.existsSync(path.join(dest, "runtime", "sandbox.mjs"))) {
  console.log(`sandbox already present at ${dest}`);
  process.exit(0);
}

console.log(`fetching sandbox ${RELEASE.version} ...`);
const response = await fetch(RELEASE.url);
if (!response.ok) throw new Error(`${RELEASE.url}: HTTP ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
if (hash !== RELEASE.sha256) throw new Error(`sandbox archive sha256 mismatch: ${hash}`);

const files = unzipSync(bytes);
fs.rmSync(dest, { recursive: true, force: true });
for (const [name, data] of Object.entries(files)) {
  const target = path.resolve(dest, name);
  if (!target.startsWith(path.resolve(dest))) throw new Error(`archive path escapes: ${name}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}
console.log(`sandbox ${RELEASE.version} ready at ${dest} (${Object.keys(files).length} files)`);
