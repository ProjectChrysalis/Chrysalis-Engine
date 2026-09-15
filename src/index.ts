/**
 * Entrypoint: `chrysalis [command] [--setting value ...]`.
 *
 *   start (default)          run the engine
 *   reset-password <user>    set a new password for an account
 *   paths                    print where config and data live
 *
 * Settings come from <home>/config.yaml, then CHRYSALIS_* environment
 * variables, then flags (see src/config.ts).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { hasPackages, installApp } from "./apps/packages.js";
import { ConfigError, dataDirOf, envNameOf, flagNameOf, loadConfig, parseFlags, sandboxConfigOf, SETTINGS, type LoadedConfig } from "./config.js";
import { ENGINE_VERSION, INSTALL_KIND, resolveHomeDir } from "./install.js";
import { UserService } from "./users.js";
import { SessionService } from "./sessions.js";
import { bootstrapUserDir, ensureGitignoreEntries, ensureNotesDir, ensureWorkspaceAgentsMd, migrateConnectionsIntoDataRoot, migrateCredentialsIntoDataRoot, migrateMcpIntoDataRoot, migrateSpeechIntoDataRoot, migrateWebSearchPreset, userPaths } from "./paths.js";
import { initRepo, untrackBoundary, commitAll as gitCommitAll, commitPaths as gitCommitPaths } from "./git.js";
import { renameAppDir } from "./apps/manager.js";
import { gcRepoIfChunky } from "./apps/git.js";
import { adoptFormerlyShipped } from "./apps/store.js";
import { buildApp } from "./server/app.js";
import { EventBus } from "./server/ws.js";
import { engineUrls, Listener, selfUrl } from "./server/listen.js";
import { ServerSettings } from "./server/settings.js";
import { stopSchedules } from "./plugins/runtime.js";
import { stopLookWatchers } from "./server/look-watch.js";
import { createSandbox } from "./sandbox/index.js";
import { log, logToFile } from "./logger.js";
import { writeStdioApproval, type McpServerConfig } from "./mcp/registry.js";
import { bindLegacyKeys } from "./connections.js";
import { readLock, releaseLock, runningEngine, writeLock } from "./lock.js";
import { cleanUpAfterUpdate, dropEngineFiles, runReplacement, updateState } from "./self-update.js";
import { dataFormatProblem, recordDataFormat } from "./data-format.js";

// The engine runs unsupervised — an unhandled socket error must not take the
// user's app dark. Network-grade errors (a client vanished mid-read, a
// refused hop) are logged and survived; anything else still crashes, because
// swallowing a real bug leaves a lying process behind.
const TRANSIENT = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ECONNREFUSED", "EAI_AGAIN"]);
for (const evt of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(evt, (err: NodeJS.ErrnoException) => {
    if (err && TRANSIENT.has(String(err.code))) {
      log.warn(`${evt}: transient network error (${err.code}): ${err.message}`);
      return;
    }
    log.error(`${evt}: ${err?.stack ?? String(err)}`);
    process.exit(1);
  });
}

const runCmd = promisify(execFile);

const HELP = `Chrysalis ${ENGINE_VERSION}

Usage: chrysalis [command] [options]

Commands:
  start                    Run Chrysalis (the default)
  reset-password <user>    Give an account a new password (Chrysalis must be stopped)
  paths                    Show where the config file and data folder are
  workspace [--user <u>]   Print what a coding agent needs: the workspace folder,
                           the API address, and the apps installed in it
  api <METHOD> <path> [json]
                           Call the running engine's API as that account, so a
                           coding agent can do anything the built-in one can
                           (body from the argument or stdin; --user picks the
                           account when there is more than one)
  install-cli              Put chrysalis on your PATH so the two commands above
                           work from anywhere (uninstall-cli undoes it)

Options:
  --home <folder>          Folder holding config.yaml (default: ${INSTALL_KIND === "source" ? "this checkout" : "your app-data folder"})
${SETTINGS.map((s) => `  ${flagNameOf(s.key).padEnd(24)} ${envNameOf(s.key)}`).join("\n")}
  --version                Print the version
  --help                   Print this help

Every option is also a setting in config.yaml. Options and environment
variables apply to one run only.`;

function fail(message: string): never {
  console.error(`chrysalis: ${message}`);
  // a double-clicked chrysalis.exe gets its own console window, which closes
  // the moment the process ends: hold it open so the reason can be read
  if (process.platform === "win32" && INSTALL_KIND === "binary" && process.stdin.isTTY) prompt("Press Enter to close.");
  process.exit(1);
}

async function main(): Promise<void> {
  let flags: ReturnType<typeof parseFlags>;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (e) {
    fail((e as Error).message);
  }
  if (flags.rest.includes("--help") || flags.rest.includes("-h") || flags.rest[0] === "help") {
    console.log(HELP);
    return;
  }
  if (flags.rest.includes("--version") || flags.rest.includes("-v") || flags.rest[0] === "version") {
    console.log(ENGINE_VERSION);
    return;
  }
  // --user names the account for the host-side commands; it is not a setting,
  // so it is lifted out before the unknown-option check below
  let asUser: string | undefined;
  for (let i = 0; i < flags.rest.length; i++) {
    const a = flags.rest[i]!;
    if (a !== "--user" && !a.startsWith("--user=")) continue;
    asUser = a.startsWith("--user=") ? a.slice(7) : flags.rest[i + 1];
    if (!asUser) fail("--user needs an account name");
    flags.rest.splice(i, a.startsWith("--user=") ? 1 : 2);
    break;
  }
  const unknown = flags.rest.find((a) => a.startsWith("-"));
  if (unknown) fail(`unknown option ${unknown} (see chrysalis --help)`);
  const [command = "start", ...args] = flags.rest;

  const homeDir = resolveHomeDir(flags.home);
  let loaded: LoadedConfig;
  try {
    loaded = loadConfig(homeDir, { flags: flags.overrides });
  } catch (e) {
    if (e instanceof ConfigError) fail(e.message);
    throw e;
  }
  const dataDir = dataDirOf(homeDir, loaded.config);

  switch (command) {
    case "start":
      return start(homeDir, dataDir, loaded);
    case "paths":
      console.log(`config: ${loaded.path}\ndata:   ${dataDir}\nlog:    ${path.join(dataDir, "logs", "chrysalis.log")}`);
      return;
    case "reset-password":
      return resetPassword(dataDir, args[0]);
    case "workspace":
      return printWorkspace(dataDir, asUser);
    case "api":
      return callApi(dataDir, args, asUser);
    case "install-cli":
      return installCli(dataDir, false);
    case "uninstall-cli":
      return installCli(dataDir, true);
    default:
      fail(`unknown command "${command}" (see chrysalis --help)`);
  }
}

/** The account a host-side command acts as. One account needs no saying; more
 *  than one has to be named, because guessing would touch the wrong world. */
function pickUser(dataDir: string, asked: unknown): string {
  const users = new UserService(dataDir);
  const all = users.list().filter((u) => u.enabled !== false);
  if (typeof asked === "string" && asked) {
    const found = users.getFolded(asked);
    if (!found) fail(`no account named "${asked}". Accounts: ${all.map((u) => u.username).join(", ") || "none yet"}`);
    return found.username;
  }
  if (!all.length) fail("no accounts yet — start Chrysalis and create one first");
  if (all.length > 1) fail(`more than one account here: ${all.map((u) => u.username).join(", ")}. Say which with --user <name>.`);
  return all[0]!.username;
}

/**
 * Put `chrysalis` on the PATH, so the workspace and api commands are usable
 * from wherever someone's editor or agent happens to be working — a download
 * is a folder you unpacked, and typing its name in a terminal does nothing.
 *
 * On macOS and Linux that is a symlink in ~/.local/bin, which is on the PATH
 * of every current shell and needs no privileges. On Windows it is a small
 * .cmd next to this program's data, in a folder added to the account's PATH
 * through the registry — never `setx`, which silently truncates a PATH over
 * 1024 characters and has eaten many.
 *
 * Both point at this program where it stands, so an update (which replaces the
 * file in place) keeps working, and moving the folder means running this again.
 */
async function installCli(dataDir: string, remove: boolean): Promise<void> {
  if (INSTALL_KIND === "npm") {
    console.log("Installed with bun/npm — `chrysalis` is already on your PATH.");
    return;
  }
  if (INSTALL_KIND === "source") {
    console.log("Running from a checkout — use `bun run src/index.ts <command>` here.");
    return;
  }
  if (INSTALL_KIND === "android") {
    console.log("The Android app has no terminal to put anything on.");
    return;
  }
  const exe = process.execPath;
  if (process.platform === "win32") {
    const binDir = path.join(dataDir, "bin");
    const shim = path.join(binDir, "chrysalis.cmd");
    if (remove) {
      fs.rmSync(shim, { force: true });
      console.log(`Removed ${shim}.\nThe folder stays on your PATH; nothing is in it.`);
      return;
    }
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(shim, `@echo off\r\n"${exe}" %*\r\n`, "utf8");
    // read-modify-write the account's PATH through the registry
    const ps = `$d='${binDir.replace(/'/g, "''")}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';') + ';' + $d).TrimStart(';')), 'User'); 'added' } else { 'already' }`;
    try {
      const { stdout } = await runCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
      console.log(`Wrote ${shim}.`);
      console.log(stdout.includes("added")
        ? "Added its folder to your PATH. Open a NEW terminal, then `chrysalis workspace` works anywhere."
        : "Its folder was already on your PATH. `chrysalis workspace` works in a new terminal.");
    } catch (e) {
      console.log(`Wrote ${shim}, but could not change your PATH: ${(e as Error).message}`);
      console.log(`Add this folder to your PATH by hand: ${binDir}`);
    }
    return;
  }
  const binDir = path.join(os.homedir(), ".local", "bin");
  const link = path.join(binDir, "chrysalis");
  if (remove) {
    try {
      // only ours: never remove something else that answers to the name
      if (fs.readlinkSync(link) !== exe) {
        console.log(`${link} points somewhere else — leaving it alone.`);
        return;
      }
    } catch {
      console.log(`Nothing of ours at ${link}.`);
      return;
    }
    fs.rmSync(link, { force: true });
    console.log(`Removed ${link}.`);
    return;
  }
  fs.mkdirSync(binDir, { recursive: true });
  fs.rmSync(link, { force: true });
  fs.symlinkSync(exe, link);
  console.log(`Linked ${link} -> ${exe}`);
  const onPath = (process.env.PATH ?? "").split(":").includes(binDir);
  console.log(onPath
    ? "It is on your PATH: `chrysalis workspace` works anywhere."
    : `Your PATH does not include ${binDir} yet. Add this to your shell's startup file:\n\n  export PATH="$HOME/.local/bin:$PATH"`);
}

/**
 * How to run this program again, as the person reading actually can. A
 * downloaded build is not on PATH — typing `chrysalis` in a terminal only
 * works for the npm install — so the examples name the program by its own
 * path, ready to paste, instead of a command that would not be recognized.
 */
const exeDir = (): string => path.dirname(process.execPath);
const onPath = (dir: string): boolean =>
  (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").includes(dir);

function selfCommand(): string {
  if (INSTALL_KIND === "npm") return "chrysalis";
  if (INSTALL_KIND === "source") return "bun run src/index.ts";
  const exe = process.execPath;
  // a path with a space has to survive being pasted into a shell
  return /\s/.test(exe) ? `"${exe}"` : exe;
}

/**
 * Everything a coding agent needs to work on this Chrysalis, in one command.
 *
 * The workspace is the same plain files and the same git repository on every
 * install — a downloaded build keeps it in the app-data folder rather than
 * beside the program, which is the only reason it is hard to find. Nothing
 * here is particular to running from source.
 */
function printWorkspace(dataDir: string, asUser: string | undefined): void {
  const username = pickUser(dataDir, asUser);
  const p = userPaths(dataDir, username);
  // the folders below are named as though they are there; on a workspace the
  // new engine has not booted on yet they would not be. Both are idempotent.
  try { ensureNotesDir(dataDir, username); } catch { /* read-only home: the listing is still useful */ }
  const lock = readLock(dataDir);
  const lines = [
    `account:   ${username}`,
    `workspace: ${p.root}`,
    `contract:  ${path.join(p.root, "AGENTS.md")}`,
    `engine:    ${lock ? `${lock.url}  (running)` : "not running — start Chrysalis to use `chrysalis api`"}`,
  ];
  let apps: { id: string; name: string }[] = [];
  try {
    apps = fs.readdirSync(p.apps, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => {
        let name = e.name;
        try {
          name = (JSON.parse(fs.readFileSync(path.join(p.apps, e.name, "manifest.json"), "utf8")) as { name?: string }).name ?? e.name;
        } catch { /* unreadable manifest: the folder name will do */ }
        return { id: e.name, name };
      });
  } catch { /* no apps yet */ }
  let active = "";
  try {
    active = (JSON.parse(fs.readFileSync(p.settings, "utf8")) as { activeApp?: string }).activeApp ?? "";
  } catch { /* no settings yet */ }
  lines.push(`apps:      ${apps.length ? apps.map((a) => `${a.id}${a.id === active ? " (open)" : ""}`).join(", ") : "none"}`);
  console.log(lines.join("\n"));
  const me = selfCommand();
  console.log(`
Point your editor or coding agent at the workspace folder. It is a git
repository of plain files: apps/<id>/{src,plugins,data}, plugins/, notes/,
commands/. AGENTS.md there explains the layout and what belongs where — it is
written for whatever agent reads it, not just the built-in one. Saves reach
open pages on their own; app source rebuilds in the browser.

For the parts that are not files — whether an app built, what its page logged,
which models are connected — call the API of the Chrysalis running here:

  ${me} api GET  /v1/apps
  ${me} api GET  /v1/apps/${apps[0]?.id ?? "<app>"}/build
  ${me} api POST /v1/apps/${apps[0]?.id ?? "<app>"}/build '{}'
${INSTALL_KIND === "binary" && !onPath(exeDir()) ? `
That is this program's own path, because a downloaded Chrysalis is not on your
PATH — plain \`chrysalis\` would not be recognized. To fix that once:

  ${me} install-cli` : ""}`);
}

/**
 * One verb, the whole local API. A coding agent on this machine already has
 * the files; what it cannot do is talk to the engine, and that gap is why it
 * could not check a build or read an app's console the way the built-in agent
 * can. Authenticates by minting a session against the data folder it can
 * already read, so it grants nothing that running this command did not.
 */
async function callApi(dataDir: string, args: string[], asUser: string | undefined): Promise<void> {
  const [rawMethod, rawPath, ...rest] = args;
  if (!rawMethod || !rawPath) {
    fail("usage: chrysalis api <METHOD> <path> [json]\n       chrysalis api GET /v1/apps");
  }
  const method = rawMethod.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
    fail(`"${rawMethod}" is not an HTTP method. Try: chrysalis api GET /v1/apps`);
  }
  const apiPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const live = await runningEngine(dataDir);
  if (!live) fail("Chrysalis is not running. Start it, then run this again.");
  // a body on the command line, or piped in
  let body = rest.join(" ").trim();
  if (!body && !process.stdin.isTTY && method !== "GET" && method !== "HEAD") {
    body = await new Response(process.stdin as unknown as ReadableStream).text().catch(() => "");
  }
  const username = pickUser(dataDir, asUser);
  const sessions = new SessionService(dataDir);
  const token = sessions.create(username);
  try {
    const res = await fetch(`${live.url}${apiPath}`, {
      method,
      headers: {
        cookie: `chrysalis_session=${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      // a LAN engine serves its own certificate
      ...({ tls: { rejectUnauthorized: false } } as Record<string, unknown>),
    });
    const text = await res.text();
    // pretty-print json so a person reading over the agent's shoulder can
    process.stdout.write(text && res.headers.get("content-type")?.includes("json")
      ? `${JSON.stringify(JSON.parse(text), null, 2)}\n`
      : text.endsWith("\n") || !text ? text : `${text}\n`);
    if (!res.ok) process.exitCode = 1;
  } catch (e) {
    fail(`could not reach ${live.url}: ${(e as Error).message}`);
  } finally {
    sessions.destroy(token);
  }
}

async function resetPassword(dataDir: string, username: string | undefined): Promise<void> {
  if (!username) fail("usage: chrysalis reset-password <user>");
  const live = await runningEngine(dataDir);
  if (live) fail(`Chrysalis is running (${live.url}). Stop it first, then run this again.`);
  const newer = dataFormatProblem(dataDir);
  if (newer) fail(newer);
  const users = new UserService(dataDir);
  const user = users.getFolded(username);
  if (!user) fail(`no account named "${username}". Accounts: ${users.list().map((u) => u.username).join(", ") || "none yet"}`);
  const password = crypto.randomBytes(9).toString("base64url");
  users.setPassword(user.username, password);
  new SessionService(dataDir).destroyUser(user.username);
  console.log(`New password for ${user.username}: ${password}\nSign in with it, then change it in Settings.`);
}

/** Open a URL in the desktop's browser. Packaged copies only: a source
 *  checkout restarts on every save under --watch. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] :
    process.platform === "darwin" ? ["open", [url]] :
    ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => log.info(`open ${url} in your browser`));
    child.unref();
  } catch {
    log.info(`open ${url} in your browser`);
  }
}

/** Per-account boot work: directory shape, one-time migrations, git. */
async function prepareAccounts(users: UserService, dataDir: string): Promise<void> {
  for (const u of users.list()) {
    const p = bootstrapUserDir(dataDir, u.username);
    // credentials move OUT of the workspace (data-root credentials dir):
    // nothing the agent can run or read inside the workspace reaches them
    if (migrateCredentialsIntoDataRoot(dataDir, u.username)) {
      log.info(`moved credentials for ${u.username} out of the workspace (credentials now live in <data>/credentials/)`);
    }
    // MCP config joins them: a stdio entry runs a host command and an http
    // entry is unrestricted egress, so it is the user's to write, not the
    // agent's or any shell's
    if (migrateMcpIntoDataRoot(dataDir, u.username)) {
      log.info(`moved mcp.json for ${u.username} out of the workspace (MCP servers are configured in Settings)`);
    }
    // connection and speech definitions join the credentials: the Settings UI
    // owns them, so the agent and its shell have no reason to read them
    if (migrateConnectionsIntoDataRoot(dataDir, u.username)) {
      log.info(`moved connections.json for ${u.username} out of the workspace (Settings owns model connections)`);
    }
    if (migrateSpeechIntoDataRoot(dataDir, u.username)) {
      log.info(`moved speech.json for ${u.username} out of the workspace (Settings owns speech endpoints)`);
    }
    if (migrateWebSearchPreset(dataDir, u.username)) {
      log.info(`[mcp] ${u.username}: web search now uses Exa's hosted server (no local process)`);
    }
    // keys saved before endpoint binding bind to the URL they serve today;
    // from here on a workspace edit of that URL cannot take the key along
    for (const b of bindLegacyKeys(p)) log.info(`[keys] ${u.username}: bound ${b}`);
    // stdio MCP servers now need an approval record outside the workspace.
    // The first boot with that rule adopts an admin's existing servers once
    // (listed here so the owner can check them); other accounts could never
    // add stdio through the API, so theirs stay off.
    const approvals = path.join(path.dirname(p.auth), "mcp-approved.json");
    if (!fs.existsSync(approvals)) {
      let servers: Record<string, McpServerConfig> = {};
      try {
        servers = (JSON.parse(fs.readFileSync(p.mcp, "utf8")) as { servers?: Record<string, McpServerConfig> }).servers ?? {};
      } catch { /* no mcp.json */ }
      writeStdioApproval(approvals, "", null);
      for (const [id, cfg] of Object.entries(servers)) {
        if (cfg?.type !== "stdio") continue;
        if (u.role === "admin") {
          writeStdioApproval(approvals, id, cfg);
          log.info(`[mcp] ${u.username}: kept stdio server "${id}" (${[cfg.command, ...(cfg.args ?? [])].join(" ")})`);
        } else {
          log.warn(`[mcp] ${u.username}: stdio server "${id}" stays off (only admins may run host commands)`);
        }
      }
    }
    // git boundary: ignore creds/chat logs/runtime state, and untrack any that
    // older builds leaked into history (files stay on disk, index-only removal)
    // committed on its own: left pending, it reads to the agent as an edit
    // nobody made
    if (ensureGitignoreEntries(p.root)) {
      await gitCommitPaths(p.root, u.username, "chore: ignore file covers runtime state and staged imports", [".gitignore"]);
    }
    // workspace AGENTS.md teaches the file contract — to the built-in agent,
    // which is handed it, and to any coding agent pointed at this directory
    if (ensureWorkspaceAgentsMd(dataDir, u.username)) {
      await gitCommitAll(p.root, u.username, "docs: workspace AGENTS.md");
    }
    // notes/: the user's own plans and specs, listed for the agent every run
    if (ensureNotesDir(dataDir, u.username)) {
      await gitCommitAll(p.root, u.username, "docs: notes/ for plans and specs");
    }
    await initRepo(p.root);
    await untrackBoundary(p.root, u.username);
    // one-time: the builtin app was renamed rp → roleplay; user data moves with it
    if (renameAppDir(p.apps, "rp", "roleplay")) {
      const s = JSON.parse(fs.readFileSync(p.settings, "utf8")) as { activeApp?: string | null };
      if (s.activeApp === "rp") {
        s.activeApp = "roleplay";
        fs.writeFileSync(p.settings, JSON.stringify(s, null, 2) + "\n", "utf8");
      }
      await gitCommitAll(p.root, u.username, "app: rp → roleplay (builtin app renamed)");
      log.info(`renamed app rp → roleplay for ${u.username}`);
    }
    // apps an earlier engine shipped now live in their own repositories
    for (const { id, repository } of adoptFormerlyShipped(p)) {
      await gitCommitAll(p.root, u.username, `app(${id}): updates now come from ${repository}`);
      log.info(`${u.username}/${id} now updates from ${repository}`);
    }
    // abandoned import previews: a cancelled two-phase import leaves its
    // staging clone on disk forever. Drop any older than a week (a live
    // preview is minutes old, so nothing in-flight can be hit)
    try {
      const stagingDir = path.join(p.apps, ".staging");
      const staleBefore = Date.now() - 7 * 24 * 3600_000;
      for (const entry of fs.readdirSync(stagingDir)) {
        const dir = path.join(stagingDir, entry);
        try {
          if (fs.statSync(dir).mtimeMs < staleBefore) fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* keep going */ }
      }
    } catch { /* no staging dir */ }
  }
}

async function start(homeDir: string, dataDir: string, loaded: LoadedConfig): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = logToFile(dataDir);
  const { config } = loaded;

  const live = await runningEngine(dataDir);
  if (live) fail(`Chrysalis is already running with this data folder: ${live.url} (pid ${live.pid})`);
  const newer = dataFormatProblem(dataDir);
  if (newer) fail(newer);

  log.info(`Chrysalis ${ENGINE_VERSION} (${INSTALL_KIND})`);
  // the first run after an update keeps what undoing it needs until the
  // parent has seen this version serve; every other start drops leftovers
  const firstRunAfterUpdate = process.env.CHRYSALIS_UPDATED === "1";
  const cameBackFromUpdate = updateState().phase === "failed";
  try {
    cleanUpAfterUpdate();
    if (!firstRunAfterUpdate) dropEngineFiles(dataDir);
  } catch { /* best effort */ }
  for (const w of loaded.warnings) log.warn(w);

  const users = new UserService(dataDir);
  // accounts from before mandatory passwords get one minted at boot, shown
  // exactly once here (forgotten afterwards → the reset code flow)
  const minted = users.ensurePasswords();
  if (minted.length) {
    log.info("==========================================================");
    log.info("Passwords set for existing accounts (shown ONCE):");
    for (const m of minted) log.info(`  ${m.username}: ${m.password}`);
    log.info("==========================================================");
  }
  await prepareAccounts(users, dataDir);
  recordDataFormat(dataDir, ENGINE_VERSION);

  // first run: no account exists yet. The first visitor holding this token
  // creates the admin account in the browser. A launcher that opens the
  // browser itself passes its own token so it can build the link.
  const setupToken = users.list().length === 0 ? (process.env.CHRYSALIS_SETUP_TOKEN || crypto.randomBytes(18).toString("base64url")) : null;

  const instance = crypto.randomUUID();
  const bus = new EventBus();
  const sessions = new SessionService(dataDir);
  const sandbox = createSandbox(sandboxConfigOf(config), bus);
  let listener: Listener | null = null;
  const settings = new ServerSettings({
    homeDir,
    dataDir,
    loaded,
    applySocket: (next, previous) => {
      const moved = listener!.rebind(next, previous);
      if (moved) writeLock(dataDir, { pid: process.pid, instance, url: selfUrl(next), startedAt: Date.now() });
      return moved;
    },
    applyRuntime: (next) => Object.assign(sandbox.config, sandboxConfigOf(next)),
  });
  // declared before the app so an installed update can stop serving first
  let stopping = false;
  const stopServing = async () => {
    stopping = true;
    // stop plugin schedules + look watchers so nothing fires mid-teardown
    stopSchedules();
    stopLookWatchers();
    bus.dispose();
    releaseLock(dataDir, instance);
    await listener?.stop();
  };
  const restart = async () => {
    // let the reply that started the update reach the browser
    await new Promise((r) => setTimeout(r, 1500));
    log.info("restarting into the new version");
    await stopServing();
    runReplacement({ dataDir });
  };
  const app = buildApp({ users, sessions, config, dataDir, bus, sandbox, instance, setupToken, settings, restart });
  bus.attach(users, sessions);

  listener = new Listener({ homeDir, bus, handle: (req, peerAddress) => app.fetch(req, { peerAddress }) });
  try {
    listener.start(config);
  } catch (e) {
    fail(`could not start: ${(e as Error).message}\nChange it in ${loaded.path}`);
  }

  const urls = engineUrls(config);
  writeLock(dataDir, { pid: process.pid, instance, url: selfUrl(config), startedAt: Date.now() });
  const setupLink = setupToken ? `${urls.local}/#setup=${setupToken}` : null;
  log.info("----------------------------------------------------------");
  log.info(`Open Chrysalis:  ${setupLink ?? urls.local}`);
  for (const u of urls.lan) log.info(`On your network: ${u}`);
  if (!config.lan) log.info("Other devices:   off (set lan: true in config.yaml)");
  log.info(`Config file:     ${loaded.path}`);
  log.info(`Data folder:     ${dataDir}`);
  log.info(`Log file:        ${logFile}`);
  if (setupLink) log.info("First run: open the link above to create your account.");
  log.info("----------------------------------------------------------");
  // after an update the browser is already open, waiting for this start
  const updated = firstRunAfterUpdate || cameBackFromUpdate;
  delete process.env.CHRYSALIS_UPDATED;
  if (firstRunAfterUpdate) log.info(`Updated to Chrysalis ${ENGINE_VERSION}`);
  if (config.openBrowser && !updated && (INSTALL_KIND === "binary" || INSTALL_KIND === "npm") && !process.env.container) {
    openBrowser(setupLink ?? urls.local);
  }

  // app dependencies (async, boot never blocks on the install): install once
  // for any app with a package.json and no node_modules. Builds happen in the
  // browser when an app is opened.
  void (async () => {
    if (!config.apps.packageDownloads) return;
    for (const name of users.list().map((u) => u.username)) {
      const appsDir = userPaths(dataDir, name).apps;
      let ids: string[] = [];
      try { ids = fs.readdirSync(appsDir); } catch { continue; }
      for (const id of ids) {
        const dir = path.join(appsDir, id);
        if (!hasPackages(dir) || fs.existsSync(path.join(dir, "node_modules"))) continue;
        const r = await installApp(dir);
        if (r.ok) log.info(`[apps] installed packages for ${name}/${id} (${r.ms}ms)`);
        else log.warn(`[apps] package install failed for ${name}/${id}: ${r.log.split("\n").slice(-3).join(" ")}`);
      }
    }
  })();

  // Workspace repos grow loose objects forever (isomorphic-git has no gc:
  // every app-route commit mints new blobs). Pack chunky ones in the
  // background once per boot.
  void (async () => {
    for (const u of users.list()) {
      try {
        if (await gcRepoIfChunky(userPaths(dataDir, u.username).root)) {
          log.info(`[git] packed loose objects in ${u.username}'s workspace`);
        }
      } catch { /* best effort */ }
    }
  })();

  const shutdown = () => {
    if (stopping) return;
    log.info("shutting down");
    void stopServing().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // a launcher closing our stdin pipe means it has gone away
  if (process.env.CHRYSALIS_EXIT_ON_STDIN_CLOSE === "1") {
    process.stdin.on("end", shutdown);
    process.stdin.resume();
  }
}

main().catch((e) => {
  log.error("fatal:", e);
  process.exit(1);
});
