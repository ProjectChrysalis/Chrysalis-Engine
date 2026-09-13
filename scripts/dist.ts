/**
 * Release builds: everything a person downloads to run Chrysalis without a
 * checkout, Bun, git or Node.
 *
 *   bun run dist                         every target
 *   bun run dist linux-x64 windows-x64   some targets
 *   bun run dist host                    this machine's platform (Docker)
 *   bun run dist ... --no-archive        leave folders, skip .zip/.tar.gz
 *   bun run dist ... --skip-frontends    reuse client/dist and client-agent/dist
 *
 * Output in out/dist/:
 *   Chrysalis-<version>-<target>/        chrysalis[.exe] + resources/
 *   Chrysalis-<version>-<target>.tar.gz  (.zip for Windows)
 *   npm/                                 package for `bun install -g`
 *   android/                             server + resources for the Android launcher
 *   Chrysalis-<version>-android-arm64.apk (target android-apk; needs JAVA_HOME
 *                                        with JDK 17+ and ANDROID_HOME)
 *
 * resources/ holds what the engine serves and seeds but cannot compile in:
 * the two built frontends, the shipped apps, the builder and sandbox browser
 * bundles (prebuilt, since there is no bundler at runtime), and the
 * sandbox's Python runtime files.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { buildBuilderForRelease } from "../src/builder/assets.js";
import { writePrebuilt } from "../src/prebuilt.js";
import { buildSandboxForRelease } from "../src/sandbox/assets.js";

const repo = path.resolve(import.meta.dir, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string; repository?: string };
const version = pkg.version;
const outRoot = path.join(repo, "out", "dist");

/** Download name → Bun compile target. x64 builds use Bun's baseline
 *  runtime, which also runs on CPUs without AVX2. */
const TARGETS: Record<string, { bun: string; exe: string; archive: "zip" | "tar" | null; kind: "binary" | "android" }> = {
  "windows-x64": { bun: "bun-windows-x64-baseline", exe: "chrysalis.exe", archive: "zip", kind: "binary" },
  "macos-arm64": { bun: "bun-darwin-arm64", exe: "chrysalis", archive: "tar", kind: "binary" },
  "macos-x64": { bun: "bun-darwin-x64", exe: "chrysalis", archive: "tar", kind: "binary" },
  "linux-x64": { bun: "bun-linux-x64-baseline", exe: "chrysalis", archive: "tar", kind: "binary" },
  "linux-arm64": { bun: "bun-linux-arm64", exe: "chrysalis", archive: "tar", kind: "binary" },
  "android-arm64": { bun: "bun-linux-arm64-android", exe: "libchrysalis.so", archive: null, kind: "android" },
};
/** Builds android-arm64 first, then the launcher APK around it. */
const APK = "android-apk";

function hostTarget(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  return `${os}-${arch}`;
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const named = args.filter((a) => !a.startsWith("--")).map((a) => (a === "host" ? hostTarget() : a));
const wantNpm = named.length === 0 || named.includes("npm");
const wantApk = named.length === 0 || named.includes(APK);
const targets = named.length === 0 ? Object.keys(TARGETS) : [...new Set(named.filter((n) => n !== "npm").map((n) => (n === APK ? "android-arm64" : n)))];
for (const t of targets) {
  if (!TARGETS[t]) {
    console.error(`unknown target "${t}". Targets: ${[...Object.keys(TARGETS), APK, "npm", "host"].join(", ")}`);
    process.exit(1);
  }
}

const step = (label: string) => console.log(`\n== ${label}`);
const run = (cmd: string, argv: string[], cwd = repo) => execFileSync(cmd, argv, { cwd, stdio: "inherit" });

/** Copy the git-tracked files under `rel` (a clean copy: no local data,
 *  node_modules or builds). Without a git checkout (a container build
 *  context), everything but node_modules and dist. */
function copyTracked(rel: string, dest: string): number {
  let files: string[];
  try {
    files = execFileSync("git", ["ls-files", "-z", "--", rel], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
  } catch {
    files = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        const child = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(child);
        else files.push(child);
      }
    };
    walk(rel);
  }
  for (const f of files) {
    const to = path.join(dest, path.relative(rel, f));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(repo, f), to);
  }
  return files.length;
}

// ---------- resources (shared by every target) ----------

const resources = path.join(outRoot, ".resources");

if (!flags.has("--skip-frontends")) {
  step("frontends");
  run(process.execPath, ["run", "scripts/build-frontends.ts"]);
}

step("resources");
fs.rmSync(resources, { recursive: true, force: true });
for (const dir of ["client/dist", "client-agent/dist"]) {
  if (!fs.existsSync(path.join(repo, dir, "index.html"))) throw new Error(`${dir} is missing: run without --skip-frontends`);
  fs.cpSync(path.join(repo, dir), path.join(resources, dir), { recursive: true });
}
for (const app of fs.readdirSync(path.join(repo, "apps"))) {
  const n = copyTracked(`apps/${app}`, path.join(resources, "apps", app));
  console.log(`apps/${app}: ${n} files`);
}
const builder = await buildBuilderForRelease();
writePrebuilt(path.join(resources, "prebuilt", "builder"), builder);
const sandbox = await buildSandboxForRelease();
writePrebuilt(path.join(resources, "prebuilt", "sandbox"), sandbox);
for (const part of ["browser-worker.js", "package.json", "lib", "assets"]) {
  fs.cpSync(path.join(sandbox.wasmshDir, part), path.join(resources, "prebuilt", "wasmsh", part), { recursive: true });
}
console.log(`builder ${builder.version}, sandbox ${sandbox.version}`);

// ---------- engine bundles ----------

const defines = (kind: string): string[] => [
  "--define", `CHRYSALIS_BUILD=${JSON.stringify({ version, repository: pkg.repository ?? null, kind })}`,
  // compiled: the worker's source path, mapped to the embedded copy;
  // bundled: the file the worker entry lands in beside the engine bundle
  "--define", `CHRYSALIS_SANDBOX_WORKER=${JSON.stringify(kind === "npm" ? "plugins/sandbox-worker.js" : "./plugins/sandbox-worker.mjs")}`,
  // only reached from a source checkout; packaged copies serve prebuilt bundles
  "--external", "esbuild",
];
const ENTRIES = ["src/index.ts", "src/plugins/sandbox-worker.mjs"];

const README = (exe: string) => `Chrysalis ${version}

Start:     ${exe === "chrysalis.exe" ? "double-click chrysalis.exe" : "./chrysalis"}
Help:      ${exe} --help
Settings:  config.yaml in your app-data folder (${exe} paths shows where).
           Put a config.yaml next to ${exe} to keep everything in this folder.

The first start prints a link that creates your account.
Keep the resources folder next to ${exe}.
`;

for (const name of targets) {
  const t = TARGETS[name]!;
  step(name);
  const folder = t.kind === "android" ? path.join(outRoot, "android") : path.join(outRoot, `Chrysalis-${version}-${name}`);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  run(process.execPath, [
    "build", "--compile", `--target=${t.bun}`, "--minify-syntax", "--minify-whitespace",
    ...defines(t.kind), ...ENTRIES, "--outfile", path.join(folder, t.exe),
  ]);
  fs.cpSync(resources, path.join(folder, "resources"), { recursive: true });
  if (t.kind === "android") continue;
  fs.writeFileSync(path.join(folder, "README.txt"), README(t.exe));
  if (flags.has("--no-archive") || !t.archive) continue;
  const base = path.basename(folder);
  if (t.archive === "tar") {
    run("tar", ["-czf", `${base}.tar.gz`, base], outRoot);
  } else {
    const files: Record<string, Uint8Array> = {};
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else files[path.relative(outRoot, full).split(path.sep).join("/")] = fs.readFileSync(full);
      }
    };
    walk(folder);
    fs.writeFileSync(path.join(outRoot, `${base}.zip`), zipSync(files, { level: 6 }));
  }
  console.log(`archived ${base}`);
}

if (wantApk) {
  step(APK);
  const project = path.join(repo, "android");
  const main = path.join(project, "app", "src", "main");
  const payload = path.join(outRoot, "android");
  fs.rmSync(path.join(main, "jniLibs"), { recursive: true, force: true });
  fs.rmSync(path.join(main, "assets"), { recursive: true, force: true });
  fs.mkdirSync(path.join(main, "jniLibs", "arm64-v8a"), { recursive: true });
  fs.mkdirSync(path.join(main, "assets"), { recursive: true });
  fs.copyFileSync(path.join(payload, "libchrysalis.so"), path.join(main, "jniLibs", "arm64-v8a", "libchrysalis.so"));
  // one zip the launcher unpacks on first start; formats that are already
  // compressed are stored as they are
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else entries[path.relative(path.join(payload, "resources"), full).split(path.sep).join("/")] = [fs.readFileSync(full), { level: /\.(whl|zip|png|jpe?g|webp|woff2?|gz)$/i.test(e.name) ? 0 : 6 }];
    }
  };
  walk(path.join(payload, "resources"));
  fs.writeFileSync(path.join(main, "assets", "resources.zip"), zipSync(entries));
  if (!process.env.ANDROID_HOME && !fs.existsSync(path.join(project, "local.properties"))) {
    throw new Error("set ANDROID_HOME to your Android SDK to build the APK");
  }
  const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  run(gradlew, ["--no-daemon", "-q", "assembleRelease"], project);
  fs.copyFileSync(path.join(project, "app", "build", "outputs", "apk", "release", "app-release.apk"), path.join(outRoot, `Chrysalis-${version}-android-arm64.apk`));
  console.log(`built Chrysalis-${version}-android-arm64.apk`);
}

if (wantNpm) {
  step("npm");
  const npm = path.join(outRoot, "npm");
  fs.rmSync(npm, { recursive: true, force: true });
  run(process.execPath, ["build", "--target=bun", ...defines("npm"), ...ENTRIES, "--outdir", npm]);
  fs.renameSync(path.join(npm, "index.js"), path.join(npm, "chrysalis.js"));
  const body = fs.readFileSync(path.join(npm, "chrysalis.js"), "utf8");
  fs.writeFileSync(path.join(npm, "chrysalis.js"), `#!/usr/bin/env bun\n${body.replace(/^#!.*\n/, "")}`);
  fs.chmodSync(path.join(npm, "chrysalis.js"), 0o755);
  fs.cpSync(resources, path.join(npm, "resources"), { recursive: true });
  fs.copyFileSync(path.join(repo, "LICENSE"), path.join(npm, "LICENSE"));
  fs.writeFileSync(
    path.join(npm, "package.json"),
    JSON.stringify(
      {
        name: "chrysalis-engine",
        version,
        description: "The AI frontend you can reshape just by asking.",
        license: "AGPL-3.0-only",
        repository: pkg.repository,
        type: "module",
        bin: { chrysalis: "chrysalis.js" },
        engines: { bun: ">=1.4.0" },
        files: ["chrysalis.js", "plugins", "resources", "*.wasm", "LICENSE"],
      },
      null,
      2,
    ) + "\n",
  );
}

fs.rmSync(resources, { recursive: true, force: true });
console.log(`\ndone: ${outRoot}`);
