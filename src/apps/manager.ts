/**
 * App manager (SPEC-v2 §3): apps are folders under users/<u>/apps/<app-id>/.
 *   manifest.json  { name, version, kind, description?, origin? }
 *   package.json, index.html, src/
 *                  the app's UI — index.html + src/, built in the user's
 *                  browser by src/builder (a bundler config is never run)
 *   plugins/<id>/  bundled backend behavior (namespaced <app>__<plugin>)
 *   data/          app-owned data (git-tracked; plugins get scoped fs here)
 *   node_modules/, dist/  derived, engine-managed, outside git
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** App shape: "web" is a UI the builder builds, "app"/"skin" are backend
 *  only. Older manifests carry "vite" for a UI; it reads as "web". */
export type AppKind = "skin" | "app" | "web";

/** Manifest kind values written before the shape was renamed. */
const LEGACY_KINDS: Record<string, AppKind | undefined> = { vite: "web" };

/** A manifest kind, legacy spellings included, or null when unrecognised. */
export function asAppKind(raw: unknown): AppKind | null {
  if (raw === "skin" || raw === "app" || raw === "web") return raw;
  return typeof raw === "string" ? LEGACY_KINDS[raw] ?? null : null;
}

export interface AppManifest {
  name: string;
  version: string;
  kind: AppKind;
  description?: string;
  /** Display byline shown on the launch picker ("by <author>"). */
  author?: string;
  origin?: "local" | "imported";
  /** Where an imported app came from and what it tracks — powers update
   *  checks. `head` is the remote commit the current copy was taken from;
   *  `contentHash` is the code-tree hash at install/update time (a mismatch
   *  later = locally modified = the update UI warns before resetting). */
  source?: { git: string; ref?: string; head?: string; contentHash?: string };
  /** Where the app's own code lives, for people and for the agent. */
  repository?: string;
  /** Engine versions the app runs on (">=1.2.0", "^1.0.0"). An update
   *  that needs a newer engine is not offered. */
  engine?: string;
}

export interface AppInfo {
  id: string;
  manifest: AppManifest;
  dir: string;
  pluginIds: string[];
  hasData: boolean;
}

export function validateAppManifest(raw: unknown): AppManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<AppManifest>;
  if (typeof m.name !== "string" || !m.name.trim()) return null;
  if (typeof m.version !== "string") return null;
  const kind = asAppKind(m.kind);
  if (!kind) return null;
  const source =
    m.source && typeof m.source === "object" && typeof (m.source as { git?: unknown }).git === "string" &&
      /^https?:\/\/[^\s]+\/[^\s]+$|^git@[^\s]+\/[^\s]+$/.test((m.source as { git: string }).git)
      ? {
          git: (m.source as { git: string }).git,
          ...(typeof (m.source as { ref?: unknown }).ref === "string" ? { ref: (m.source as { ref?: string }).ref } : {}),
          ...(typeof (m.source as { head?: unknown }).head === "string" ? { head: (m.source as { head?: string }).head } : {}),
          ...(typeof (m.source as { contentHash?: unknown }).contentHash === "string" ? { contentHash: (m.source as { contentHash?: string }).contentHash } : {}),
        }
      : undefined;
  return {
    name: m.name,
    version: m.version,
    kind,
    ...(m.description ? { description: m.description } : {}),
    ...(typeof m.author === "string" && m.author.trim() ? { author: m.author.trim() } : {}),
    ...(m.origin === "imported" ? { origin: "imported" } : { origin: "local" }),
    ...(source ? { source } : {}),
    ...(typeof m.repository === "string" && /^https:\/\/[^\s]+$/.test(m.repository) ? { repository: m.repository } : {}),
    ...(typeof m.engine === "string" && m.engine.trim() && m.engine.length <= 64 ? { engine: m.engine.trim() } : {}),
  };
}

export function listApps(appsDir: string): AppInfo[] {
  if (!fs.existsSync(appsDir)) return [];
  const out: AppInfo[] = [];
  for (const id of fs.readdirSync(appsDir)) {
    const info = readApp(appsDir, id);
    if (info) out.push(info);
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export function readApp(appsDir: string, id: string): AppInfo | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) return null;
  const dir = path.join(appsDir, id);
  const manifestFile = path.join(dir, "manifest.json");
  try {
    const manifest = validateAppManifest(JSON.parse(fs.readFileSync(manifestFile, "utf8")));
    if (!manifest) return null;
    const pluginsDir = path.join(dir, "plugins");
    const pluginIds = fs.existsSync(pluginsDir)
      ? fs.readdirSync(pluginsDir).filter((p) => {
          try {
            return fs.statSync(path.join(pluginsDir, p)).isDirectory() && fs.existsSync(path.join(pluginsDir, p, "plugin.js"));
          } catch {
            return false;
          }
        })
      : [];
    return { id, manifest, dir, pluginIds, hasData: fs.existsSync(path.join(dir, "data")) };
  } catch {
    return null;
  }
}

/** Create an app skeleton (agent-friendly). Returns its paths. */
export function createAppSkeleton(
  appsDir: string,
  opts: { id: string; name: string; kind?: AppKind | "vite"; description?: string; author?: string },
): { id: string; dir: string } {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(opts.id)) throw new Error(`invalid app id: ${opts.id}`);
  const dir = path.join(appsDir, opts.id);
  if (fs.existsSync(dir)) throw new Error(`app already exists: ${opts.id}`);
  for (const sub of ["plugins", "data"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const kind = asAppKind(opts.kind ?? "web") ?? "web";
  const manifest: AppManifest = {
    name: opts.name,
    version: "0.1.0",
    kind,
    origin: "local",
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.author?.trim() ? { author: opts.author.trim() } : {}),
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  if (kind === "web") {
    // web-app shape: package.json + index.html + src/. The
    // builder brings the toolchain (esbuild, Tailwind, React Refresh); the
    // app installs ONLY its own deps (installed with lifecycle scripts off,
    // via POST /v1/apps/:id/install).
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify(
        {
          name: opts.id,
          private: true,
          type: "module",
          // React only. Anything else the app turns out to need is one
          // install away; a scaffold that pre-installs a UI stack it
          // never uses just makes the first real dependency harder to spot.
          dependencies: {
            react: "^19.1.0",
            "react-dom": "^19.1.0",
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            jsx: "react-jsx",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            isolatedModules: true,
            allowImportingTsExtensions: true,
            paths: { "@/*": ["./src/*"] },
          },
          include: ["src"],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "index.html"),
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.name}</title>
</head>
<body>
<div id="app"></div>
<script type="module" src="/src/main.tsx"></script>
</body>
</html>
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "src", "main.tsx"),
      `import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./app.css";

// Entry only — keep components in their own modules (e.g. app.tsx) so
// fast-refresh hot-swaps them WITH state on save. Entry edits full-reload.
createRoot(document.getElementById("app")!).render(<App />);
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "src", "app.tsx"),
      `// This app runs sandboxed (no cookies); fetch is bridged to the engine and
// may call this app's own routes: fetch("/v1/apps/${opts.id}/…") hits plugins/.
export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-1.5 p-6 font-sans">
      <h1 className="text-xl font-semibold">${opts.name}</h1>
      <p className="text-sm opacity-60">New app. Ask the agent to build it.</p>
      <p className="text-sm opacity-60">This page is src/app.tsx.</p>
    </main>
  );
}
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "src", "app.css"),
      `@import "tailwindcss";

/* Starter palette: dark page, readable text. Replace freely. */
:root {
  color-scheme: dark;
}

body {
  background: #0c0d10;
  color: #e9eaee;
}
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "README.md"),
      `# ${opts.name}

A Chrysalis app: React + Tailwind. Chrysalis builds it in your browser as you
edit, so there is nothing to install or run locally.

- \`src/\` UI. Entry \`main.tsx\`, page \`app.tsx\`.
- \`plugins/\` backend routes, sandboxed. One folder per plugin: manifest.json + plugin.js.
- \`data/\` app-owned data, kept with the workspace.
- \`manifest.json\` identity. Bump \`version\` when a bundled plugin changes.

Ask the agent in the Chrysalis client to build it out.
`,
      "utf8",
    );
  }
  return { id: opts.id, dir };
}

/** App-bundled plugin dir (namespaced discovery target). */

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  children?: TreeNode[];
}

/** Derived artifacts never belong in a tree view of what the app IS. */
const TREE_EXCLUDE = new Set(["node_modules", "dist", ".git"]);

/** Read-only file tree of an app for launch/overview UIs: the hierarchy a
 *  builder would see, without file contents. Capped so a pathological app
 *  can't produce a megabyte of JSON. */
export function appTree(appsDir: string, appId: string, maxDepth = 8): TreeNode | null {
  const root = path.join(appsDir, appId);
  if (!fs.existsSync(root)) return null;
  const walk = (dir: string, depth: number): TreeNode[] => {
    if (depth > maxDepth) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: TreeNode[] = [];
    for (const e of entries.slice(0, 500)) {
      if (TREE_EXCLUDE.has(e.name)) continue;
      const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join("/");
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: rel, type: "dir", children: walk(path.join(dir, e.name), depth + 1) });
      } else if (e.isFile()) {
        let size: number | undefined;
        try {
          size = fs.statSync(path.join(dir, e.name)).size;
        } catch { /* unstatable — still list it */ }
        nodes.push({ name: e.name, path: rel, type: "file", size });
      }
    }
    // directories first, each run alphabetical — the order a file sidebar shows
    nodes.sort((a, b) =>
      a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
    );
    return nodes;
  };
  return { name: appId, path: "", type: "dir", children: walk(root, 1) };
}

/** App data dir — the fs scope granted to bundled plugins (git-tracked). */
export function appDataDir(appsDir: string, appId: string): string {
  return path.join(appsDir, appId, "data");
}

/** Move an app directory to a new id (rename). False when the source is
 * missing or the target already exists. */
export function renameAppDir(appsDir: string, oldId: string, newId: string): boolean {
  if (!fs.existsSync(path.join(appsDir, oldId))) return false;
  if (fs.existsSync(path.join(appsDir, newId))) return false;
  fs.renameSync(path.join(appsDir, oldId), path.join(appsDir, newId));
  return true;
}

/**
 * Content hash of an app's CODE tree (everything except data/, node_modules/,
 * dist/ — the dirs updates keep or rebuild anyway). Stamped into
 * manifest.source.contentHash at import/update time; a mismatch later means
 * the user (or their agent) modified the app since — the update UI turns
 * that into an explicit "updating resets your changes" warning. data/ is
 * excluded by design: content changes must never mark an app "modified".
 */
const HASH_EXCLUDE = new Set(["data", "node_modules", "dist", ".git"]);

export function hashAppTree(appDir: string): string | null {
  try {
    const hash = crypto.createHash("sha256");
    const walk = (dir: string, rel: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (HASH_EXCLUDE.has(e.name)) continue;
        // the root manifest is provenance metadata (it CARRIES the hash) —
        // hashing it would be circular
        if (!rel && e.name === "manifest.json") continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        hash.update(relPath + "\0");
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, relPath);
        } else if (e.isFile()) {
          hash.update(crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") + "\0");
        }
      }
    };
    walk(appDir, "");
    return hash.digest("hex");
  } catch {
    return null;
  }
}
