/**
 * Fetches the pinned sandbox runtime release from the chrysalis-sandbox
 * repository into resources/prebuilt/sandbox-k, which the engine serves.
 * Source checkouts run it after pulling; dist runs it before packaging.
 *
 *   bun run sandbox:fetch            (skips when the pinned version is there)
 *   bun run sandbox:fetch --force    (re-download)
 *   CHRYSALIS_SANDBOX_DIR=...        (use a local build instead)
 */
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { resourcesDir } from "../src/install";

const RELEASE = {
  version: "0.4.0",
  url: "https://github.com/ProjectChrysalis/chrysalis-sandbox/releases/download/v0.4.0/sandbox-0.4.0.zip",
  sha256: "e6ebb5ea2fc1dd8e43fff2c1eaebcd2c13b7c202af8b87f1ee47f31542594943",
};

const dest = path.join(resourcesDir(), "prebuilt", "sandbox-k");
const force = process.argv.includes("--force");

const present = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dest, "sources.json"), "utf8")) as { runtime?: { version?: string } }).runtime?.version ?? null;
  } catch {
    return null;
  }
})();
if (!force && present === RELEASE.version && fs.existsSync(path.join(dest, "runtime", "session.mjs"))) {
  console.log(`sandbox ${present} already present at ${dest}`);
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
