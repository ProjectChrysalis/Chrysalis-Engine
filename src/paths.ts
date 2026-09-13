/** Data-root layout + per-user directory bootstrap. See SPEC §4. */
import fs from "node:fs";
import path from "node:path";
import { WEB_SEARCH_PRESET, isLegacyWebSearchPreset, type McpServerConfig } from "./mcp/registry.js";

export interface UserPaths {
  root: string;
  persona: string;
  settings: string;
  auth: string;
  mcp: string;
  /** Named model connections (name + endpoint; keys live in auth.json). */
  connections: string;
  /** Speech/TTS endpoints (keys live in auth.json). */
  speech: string;
  /** Baseline copies of installed apps, one per app: the version each was
   *  installed or last updated from. Updates merge against them. */
  appUpstream: string;
  /** The agent sandbox's settings (internet access). */
  sandbox: string;
  apps: string;
  plugins: string;
  assetsStore: string;
  store: string;
  gitDir: string;
}

export function userDir(dataDir: string, username: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(username)) {
    throw new Error(`invalid username: ${username}`);
  }
  return path.join(dataDir, "users", username);
}

/**
 * Paths agents must never write (SPEC-v2 §9). ANCHORED to the user root —
 * app data (apps/<app>/data/**) is deliberately writable: chats, characters
 * and all RP entities are app files the agent edits like code (SPEC-v2 §1).
 */
export const AGENT_WRITE_DENYLIST: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^auth\.json$/i, reason: "credentials are never agent-editable" },
  // the real file lives outside the workspace; refuse the name here rather
  // than let a write land as a silent no-op
  { pattern: /^mcp\.json$/i, reason: "MCP servers are configured by the user in Settings; mcp.json lives outside the workspace" },
  { pattern: /^settings\.json$/i, reason: "settings are the user's (Settings UI); agents do not edit them" },
  { pattern: /^\.git(\/|$)/, reason: "git internals are managed by the server" },
  { pattern: /^assets-store(\/|$)/i, reason: "asset store is content-addressed (use asset APIs)" },
  { pattern: /^store(\/|$)/i, reason: "plugin store is runtime state managed by services (use store APIs)" },
];

export function agentWriteDenied(relPath: string): string | null {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const { pattern, reason } of AGENT_WRITE_DENYLIST) {
    if (pattern.test(norm)) return reason;
  }
  return null;
}

/**
 * Paths the agent's own file tools must not READ either. Root-anchored, so an
 * app's own data/settings.json (roleplay's UI settings) stays the agent's to
 * edit; only the workspace root copy is off-limits.
 */
export const AGENT_READ_DENYLIST: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^settings\.json$/i, reason: "settings.json is the user's (Settings UI)" },
];

export function agentReadDenied(relPath: string): string | null {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const { pattern, reason } of AGENT_READ_DENYLIST) {
    if (pattern.test(norm)) return reason;
  }
  return null;
}

/**
 * Git boundary (SPEC-v2 §12): paths that must NEVER be tracked in a user's
 * repo — credentials, agent chat logs, runtime state. Enforced BOTH via
 * .gitignore AND in code (git.ts filters), so a hand-edited .gitignore can't
 * resurface them into history.
 */
export function gitBoundaryIgnored(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const segs = norm.split("/");
  const first = segs[0] ?? "";
  // node_modules/dist are derived artifacts of vite-tier apps — never staged
  return (
    /^auth\.json$/i.test(norm) ||
    // a workspace copy from before mcp.json moved out: untracked on next boot
    /^mcp\.json$/i.test(norm) ||
    // same for the connection/speech definitions that now live with the keys
    /^connections\.json$/i.test(norm) ||
    /^speech\.json$/i.test(norm) ||
    ["agent", "assets-store", "store"].includes(first.toLowerCase()) ||
    segs.includes("node_modules") ||
    segs.includes("dist")
  );
}

/** Ensure the user's .gitignore covers every git-boundary path (idempotent,
 * appends missing entries — upgrades repos created before a boundary path
 * existed, e.g. agent session logs). */
export function ensureGitignoreEntries(root: string): boolean {
  const gi = path.join(root, ".gitignore");
  let cur = "";
  try {
    cur = fs.readFileSync(gi, "utf8");
  } catch {
    cur = "";
  }
  const lines = cur.split("\n").map((l) => l.trim());
  const needs = ["auth.json", "mcp.json", "agent/", "assets-store/", "store/", "node_modules/", "dist/", "/connections.json", "/speech.json"].filter((e) => !lines.includes(e));
  if (needs.length === 0) return false;
  const head = cur ? cur.replace(/\n*$/, "\n") : "# runtime state + credentials never enter git\n";
  fs.writeFileSync(gi, head + needs.join("\n") + "\n", "utf8");
  return true;
}

export function userPaths(dataDir: string, username: string): UserPaths {
  const root = userDir(dataDir, username);
  return {
    root,
    persona: path.join(root, "persona.md"),
    settings: path.join(root, "settings.json"),
    // Credentials live OUTSIDE the workspace (data-root credentials dir, 0600):
    // file tools and any shell the agent runs in the workspace can never see
    // them — the credential invariant holds by location, not by cooperation.
    auth: path.join(dataDir, "credentials", username, "auth.json"),
    // MCP config sits beside the credentials and its own approval file, OUTSIDE
    // the workspace. A stdio entry is a command the engine runs on the host and
    // an http entry is unrestricted egress, so no agent, shell or imported app
    // may author one. Enforced by LOCATION, not by a flag: a flag has to be
    // rechecked at every write path, and one of them was missed.
    mcp: path.join(dataDir, "credentials", username, "mcp.json"),
    // Connection and speech definitions are user-owned config the Settings UI
    // writes; nothing in the workspace reads them, so they live on the same
    // boundary as the credentials their keys sit in (no agent, shell or app
    // page can read or rewrite them).
    connections: path.join(dataDir, "credentials", username, "connections.json"),
    speech: path.join(dataDir, "credentials", username, "speech.json"),
    // Outside the workspace for the same reason: a baseline rewritten to match
    // the user's edits would make the next update replace them without asking.
    appUpstream: path.join(dataDir, "credentials", username, "app-upstream"),
    // The agent could otherwise switch its own internet access back on.
    sandbox: path.join(dataDir, "credentials", username, "sandbox.json"),
    apps: path.join(root, "apps"),
    plugins: path.join(root, "plugins"),
    assetsStore: path.join(root, "assets-store"),
    store: path.join(root, "store"),
    gitDir: path.join(root, ".git"),
  };
}

const STARTER_SETTINGS = {
  activeApp: null as string | null,
  pluginGrants: {} as Record<string, string[]>,
};

/** Default MCP servers for new users. The web-search preset ships DISABLED:
 * paste an Exa API key (Settings → MCP) and it comes online. The key lives in
 * the credential store (outside git) and is only ever sent to Exa's host. */
const STARTER_MCP = {
  servers: {
    "web-search": { ...WEB_SEARCH_PRESET, enabled: false },
  },
};

const USER_GITIGNORE = `# credentials, MCP, connection and speech config never enter git (they live outside the workspace)
auth.json
mcp.json
/connections.json
/speech.json
# runtime state + agent chat logs live outside the repo (SPEC-v2 git boundary)
agent/
assets-store/
store/
`;

/**
 * Workspace-level AGENTS.md — read by ANY coding agent pointed at this dir
 * (Chrysalis's built-in agent, Claude Code, Zcode, …). No secrets:
 * the file is git-tracked. Its job: teach the file-first contract + how to
 * drive the engine.
 */
const USER_AGENTS_MD = `<!-- chrysalis-workspace-agents: 10 -->
# Chrysalis workspace

Everything here is files you can edit like code — this user's whole Chrysalis world. The engine hot-reloads as you save.

## Git (who commits what)
- The repo is preconfigured (identity, reflog): an agent running on the host uses plain \`git add/commit/log/reflog\`; the built-in agent's browser sandbox has no git binary, so it commits through its git tools (git_status/git_log/git_commit/git_restore) on this same repo.
- Writes made through app HTTP routes auto-commit with the route in the message.
- Your own direct edits stay pending until you commit them (\`git add -A && git commit\`); if an app request fires first, the engine commits them under an honest \`out-of-band: <files>\` label — nothing is lost, check \`git log\`.

## Layout
- \`apps/<id>/\` — installed apps: a React + tailwind web project with vite conventions (\`index.html\`, \`src/\`, \`package.json\`; built in the browser, \`vite.config.*\` is not run) + \`plugins/<id>/\` (backend ES modules) + \`data/\` (whatever the app stores). \`node_modules/\`/\`dist/\` are derived (outside git). Dependencies install and uninstall engine-side with lifecycle scripts disabled (the built-in agent's \`app_deps\` tool); the sandbox itself has no node or npm.
- An app is free to be anything: a chat studio, a visual novel, a game, a tool. Each carries its own \`AGENTS.md\` and \`data/README.md\` (its field-shape map) — read those before editing that app.
- \`plugins/<id>/\` — top-level always-on plugins (same format as app plugins).
- \`providers.json\` — custom model endpoints. \`settings.json\` — activeApp etc. (the Settings UI owns it; agents do not read or edit it).
- In app \`data/\` trees, files starting with \`_\` are AI-only templates (never shown in the UI): copy \`_example.json\` to a real name to create the entity with the right shape.
- NOT here (never reachable): credentials, \`mcp.json\`, \`connections.json\` and \`speech.json\` — all live outside the workspace in the engine's credentials dir. MCP servers, model connections and speech endpoints are the user's to configure in Settings; an MCP entry runs a command on the host or opens unrestricted egress, so nothing in this workspace can author one.

## Driving the engine (optional — files alone cover most work)
The local engine also exposes HTTP:
- API base: \`<the address Chrysalis prints at start>/v1\`, by default \`http://127.0.0.1:8788/v1\` (auth: the user's bearer token / session). The port is set in the engine's config.yaml, which lives outside this workspace.

## Rules
- Never touch anything outside this workspace: the engine's credentials store, other users' directories, and the Chrysalis engine's own install (source, deps, git repo) are off-limits — the user updates the engine themselves.
- Prefer relative paths from the workspace root; this directory is your whole world.
- Plugin files are ES modules (export function handleRoute(req, host) {…}) — never CommonJS.
- After editing plugins/manifests, the engine hot-reloads; if unsure, ask the user to refresh.
`;

export function bootstrapUserDir(dataDir: string, username: string): UserPaths {
  const p = userPaths(dataDir, username);
  for (const dir of [p.plugins, p.apps, p.assetsStore, p.store, path.dirname(p.auth)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(p.settings)) {
    fs.writeFileSync(p.settings, JSON.stringify(STARTER_SETTINGS, null, 2) + "\n", "utf8");
  }
  if (!fs.existsSync(p.mcp)) {
    fs.mkdirSync(path.dirname(p.mcp), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.mcp, JSON.stringify(STARTER_MCP, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  }
  const gi = path.join(p.root, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, USER_GITIGNORE, "utf8");
  const am = path.join(p.root, "AGENTS.md");
  if (!fs.existsSync(am)) fs.writeFileSync(am, USER_AGENTS_MD, "utf8");
  return p;
}

/**
 * Seed/refresh the workspace AGENTS.md. The HTML comment marker versions the
 * template: engine-written copies refresh on boot when the version changes;
 * a file WITHOUT any marker was edited by the user (or their agent) and is
 * never overwritten.
 */
export function ensureWorkspaceAgentsMd(dataDir: string, username: string): boolean {
  const p = userPaths(dataDir, username);
  const am = path.join(p.root, "AGENTS.md");
  const MARKER = "chrysalis-workspace-agents:";
  const CURRENT = "chrysalis-workspace-agents: 10";
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(am, "utf8");
  } catch {
    /* missing → seed below */
  }
  if (existing !== null) {
    if (!existing.includes(MARKER)) return false; // user-edited — hands off
    if (existing.includes(CURRENT)) return false; // already current
  }
  fs.writeFileSync(am, USER_AGENTS_MD, "utf8");
  return true;
}

/**
 * One-time migration: credentials used to live at <userDir>/auth.json (inside
 * the workspace). Moves any surviving file to the data-root credentials dir
 * (content untouched, 0600) so nothing in the workspace can reach it.
 */
export function migrateCredentialsIntoDataRoot(dataDir: string, username: string): boolean {
  const p = userPaths(dataDir, username);
  const legacy = path.join(p.root, "auth.json");
  if (!fs.existsSync(legacy)) return false;
  fs.mkdirSync(path.dirname(p.auth), { recursive: true, mode: 0o700 });
  if (fs.existsSync(p.auth)) {
    // both exist (shouldn't happen): keep the data-root copy, drop the legacy
    fs.rmSync(legacy);
    return false;
  }
  fs.renameSync(legacy, p.auth);
  try {
    fs.chmodSync(p.auth, 0o600);
  } catch { /* best effort */ }
  return true;
}

/**
 * One-time migration: mcp.json used to live in the workspace, where the agent's
 * file tools, its shell and any account's own shell could author a stdio entry
 * the engine then ran on the host. Moves it beside the credentials (0600). A
 * workspace copy that survives is removed — it is no longer read, and leaving
 * it would suggest edits there still do something.
 */
export function migrateMcpIntoDataRoot(dataDir: string, username: string): boolean {
  const p = userPaths(dataDir, username);
  const legacy = path.join(p.root, "mcp.json");
  if (!fs.existsSync(legacy)) return false;
  fs.mkdirSync(path.dirname(p.mcp), { recursive: true, mode: 0o700 });
  if (fs.existsSync(p.mcp)) {
    // both exist: the one outside the workspace is authoritative
    fs.rmSync(legacy);
    return false;
  }
  fs.renameSync(legacy, p.mcp);
  try {
    fs.chmodSync(p.mcp, 0o600);
  } catch { /* best effort */ }
  return true;
}

/** Move a workspace-root file to its credentials-dir home; the outside copy
 *  wins when both exist. Shared by the config migrations below. */
function migrateRootFileIntoCredentials(p: UserPaths, legacyName: string, dest: string): boolean {
  const legacy = path.join(p.root, legacyName);
  if (!fs.existsSync(legacy)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  if (fs.existsSync(dest)) {
    fs.rmSync(legacy);
    return false;
  }
  fs.renameSync(legacy, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch { /* best effort */ }
  return true;
}

/**
 * One-time migration: connections.json used to live in the workspace, where
 * the agent's file tools and its shell could read (and rewrite) the user's
 * connection names and endpoints. Moves it beside the credentials; the
 * Settings UI is the only writer from here on.
 */
export function migrateConnectionsIntoDataRoot(dataDir: string, username: string): boolean {
  const p = userPaths(dataDir, username);
  return migrateRootFileIntoCredentials(p, "connections.json", p.connections);
}

/**
 * One-time migration: speech.json used to live in the workspace. Same rule as
 * connections: it is user config plus key endpoints, so it moves next to the
 * credentials rather than staying agent-readable.
 */
export function migrateSpeechIntoDataRoot(dataDir: string, username: string): boolean {
  const p = userPaths(dataDir, username);
  return migrateRootFileIntoCredentials(p, "speech.json", p.speech);
}

/**
 * One-time migration: the web-search preset used to run `npx exa-mcp-server`
 * on the host, which needs Node installed and an admin's approval. The same
 * tools come from Exa's hosted server; an untouched preset moves there,
 * keeping whether it was on.
 */
export function migrateWebSearchPreset(dataDir: string, username: string): boolean {
  const p = userPaths(dataDir, username);
  let cfg: { servers?: Record<string, McpServerConfig> };
  try {
    cfg = JSON.parse(fs.readFileSync(p.mcp, "utf8")) as { servers?: Record<string, McpServerConfig> };
  } catch {
    return false;
  }
  const current = cfg.servers?.["web-search"];
  if (!cfg.servers || !isLegacyWebSearchPreset(current)) return false;
  cfg.servers["web-search"] = { ...WEB_SEARCH_PRESET, enabled: current?.enabled !== false, ...(current?.share ? { share: current.share } : {}) };
  fs.writeFileSync(p.mcp, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return true;
}

/** Resolve a relPath inside a base dir safely (no escape). Throws on traversal. */
export function safeResolve(base: string, relPath: string): string {
  const full = path.resolve(base, relPath);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`path escapes user directory: ${relPath}`);
  }
  return full;
}
