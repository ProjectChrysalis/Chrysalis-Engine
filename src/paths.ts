/** Data-root layout + per-user directory bootstrap. See SPEC §4. */
import crypto from "node:crypto";
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
    // repos/: repositories the agent cloned to read, not the user's history
    ["agent", "assets-store", "store", "repos"].includes(first.toLowerCase()) ||
    // app imports and updates unpack a repository here before it is reviewed
    (first.toLowerCase() === "apps" && segs[1] === ".staging") ||
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
  const needs = ["auth.json", "mcp.json", "agent/", "assets-store/", "store/", "node_modules/", "dist/", "/connections.json", "/speech.json", "apps/.staging/", "/repos/"].filter((e) => !lines.includes(e));
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
# app imports and updates unpack a repository here before it is reviewed
apps/.staging/
`;

/**
 * Workspace-level AGENTS.md — read by ANY coding agent pointed at this dir
 * (Chrysalis's built-in agent, Claude Code, Zcode, …), and put in front of
 * the built-in agent directly. No secrets: the file is git-tracked. Its job:
 * teach the file-first contract + how to drive the engine.
 */
const AGENTS_MD_VERSION = 12;
const USER_AGENTS_MD_BODY = `# Chrysalis workspace

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
- \`commands/\` — reusable prompts, one markdown file each. \`review.md\` is \`/review\` in the composer, and the first line is its description. Yours; the engine never writes here.
- \`notes/\` — plans, specs and reference material, yours to create and keep. The engine never writes here and never deletes anything in it. Every file is listed for the agent by name and first line, so write one per topic with a first line that says what it covers, and read the relevant note before starting work in that area.
- \`persona.md\` — standing instructions that apply to EVERY request. Always in the agent's context (Settings > the agent instructions box writes it). Keep it short; put anything task-shaped in \`notes/\` instead.
- In app \`data/\` trees, files starting with \`_\` are AI-only templates (never shown in the UI): copy \`_example.json\` to a real name to create the entity with the right shape.
- NOT here (never reachable): credentials, \`mcp.json\`, \`connections.json\` and \`speech.json\` — all live outside the workspace in the engine's credentials dir. MCP servers, model connections and speech endpoints are the user's to configure in Settings; an MCP entry runs a command on the host or opens unrestricted egress, so nothing in this workspace can author one.

## Driving the engine (optional — files alone cover most work)
The local engine also exposes HTTP:
- API base: \`<the address Chrysalis prints at start>/v1\`, by default \`http://127.0.0.1:8788/v1\` (auth: the user's bearer token / session). The port is set in the engine's config.yaml, which lives outside this workspace.

## Where a change goes
Pick the lightest place that can carry the change. All three are supported and all three survive an app update — an update is a three-way merge against the version the app was installed from, so your edits are kept and only an edit that overlaps the same lines as the update conflicts (and then nothing is written until the user picks how to settle it). App \`data/\` is never part of an update at all.
1. \`apps/<id>/data/\` — content, settings, entities. No rebuild, open clients pick it up in about a second, and it can never conflict with an update. Most requests end here.
2. \`apps/<id>/plugins/<your-id>/\` — backend behavior: routes, tools, scheduled work. Prefer a NEW plugin folder of your own over editing one that shipped with the app: a file only you added has no upstream version to disagree with, so it can never conflict.
3. \`apps/<id>/src/\` — the UI. Editing it is normal and expected; it is how the app changes shape. It rebuilds in the user's browser (call app_check afterwards) and puts that file into the merge path on the next update.
Read the app's own AGENTS.md before deciding: it says which of its behavior is already data-driven, and reaching for \`src/\` for something a data file already controls is the one wrong answer here.

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
  if (!fs.existsSync(am)) fs.writeFileSync(am, workspaceAgentsMd(), "utf8");
  for (const [name, readme] of [["notes", NOTES_README], ["commands", COMMANDS_README]] as const) {
    const dir = path.join(p.root, name);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), readme, "utf8");
  }
  return p;
}

/** The marker line an engine-written AGENTS.md carries: the template version,
 *  plus a digest of the body the engine wrote. */
const AGENTS_MD_MARKER = /^<!--\s*chrysalis-workspace-agents:\s*(\d+)(?:\s+sha256:([0-9a-f]{16}))?\s*-->\r?\n/;

const agentsMdDigest = (body: string): string =>
  crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);

function workspaceAgentsMd(): string {
  return `<!-- chrysalis-workspace-agents: ${AGENTS_MD_VERSION} sha256:${agentsMdDigest(USER_AGENTS_MD_BODY)} -->\n${USER_AGENTS_MD_BODY}`;
}

/**
 * Seed/refresh the workspace AGENTS.md. The marker versions the template so
 * engine-written copies refresh on boot, and carries a digest of the body the
 * engine wrote so an edited one is left alone. Checking only for the marker's
 * presence meant a file someone edited in place — the obvious thing to do
 * with a file full of instructions — was silently replaced on the next boot
 * that changed the version.
 */
export function ensureWorkspaceAgentsMd(dataDir: string, username: string): boolean {
  const p = userPaths(dataDir, username);
  const am = path.join(p.root, "AGENTS.md");
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(am, "utf8");
  } catch {
    /* missing → seed below */
  }
  if (existing !== null) {
    const m = AGENTS_MD_MARKER.exec(existing);
    if (!m) return false; // no marker: theirs, hands off
    if (Number(m[1]) >= AGENTS_MD_VERSION) return false; // already current
    // A digest only appears on copies this version of the engine wrote. An
    // older marker has none, and those were being overwritten already, so
    // refreshing them once more is no new loss — and it stamps a digest that
    // protects every edit made from here on.
    if (m[2] && agentsMdDigest(existing.slice(m[0].length)) !== m[2]) return false;
  }
  fs.writeFileSync(am, workspaceAgentsMd(), "utf8");
  return true;
}

/** `notes/` and `commands/` are the user's: plans and specs in one, reusable
 *  prompts in the other. The engine seeds a README so each directory exists
 *  and says what it is for, then never writes there again. */
export function ensureNotesDir(dataDir: string, username: string): boolean {
  const p = userPaths(dataDir, username);
  let seeded = false;
  for (const [name, readme] of [["notes", NOTES_README], ["commands", COMMANDS_README]] as const) {
    const dir = path.join(p.root, name);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), readme, "utf8");
    seeded = true;
  }
  return seeded;
}

const NOTES_README = `# Notes

Plans, specs and reference material for your agent. This directory is yours —
Chrysalis seeds this one file and never writes here again.

Your agent sees every file in here listed by name and first line on every
request, and reads the ones that matter before it starts work. So:

- One file per topic, named for the topic (\`roleplay-memory-rework.md\`).
- Make the first line say what the file covers. That line is what your agent
  reads in the list, and it is how it decides which file to open.
- Anything that should apply to *every* request, however small, belongs in
  Settings under the agent instructions box instead (it writes \`persona.md\`,
  which is always in full).

Delete this README once you have notes of your own.
`;

const COMMANDS_README = `# Commands

Prompts you run again and again, one markdown file each. Every file here shows
up in the agent's composer as \`/<filename>\`, and picking it drops the file's
text into the box for you to add to before sending.

\`review.md\` becomes \`/review\`. The first line is the description shown beside
the name in the menu, so make it say what the command does.

A command is just text — whatever you would have typed. There is nothing to
learn:

    Check the diff for anything that would break a chat that is already open,
    then tell me what you found. Do not change anything yet.

Chrysalis seeds this one file and never writes here again. Delete it once you
have commands of your own.
`;

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
