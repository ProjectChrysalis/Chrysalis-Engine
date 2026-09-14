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
import { spawn } from "node:child_process";
import { hasPackages, installApp } from "./apps/packages.js";
import { ConfigError, dataDirOf, envNameOf, flagNameOf, loadConfig, parseFlags, sandboxConfigOf, SETTINGS, type LoadedConfig } from "./config.js";
import { ENGINE_VERSION, INSTALL_KIND, resolveHomeDir } from "./install.js";
import { UserService } from "./users.js";
import { SessionService } from "./sessions.js";
import { bootstrapUserDir, ensureGitignoreEntries, ensureWorkspaceAgentsMd, migrateConnectionsIntoDataRoot, migrateCredentialsIntoDataRoot, migrateMcpIntoDataRoot, migrateSpeechIntoDataRoot, migrateWebSearchPreset, userPaths } from "./paths.js";
import { initRepo, untrackBoundary, commitAll as gitCommitAll } from "./git.js";
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
import { releaseLock, runningEngine, writeLock } from "./lock.js";
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

const HELP = `Chrysalis ${ENGINE_VERSION}

Usage: chrysalis [command] [options]

Commands:
  start                    Run Chrysalis (the default)
  reset-password <user>    Give an account a new password (Chrysalis must be stopped)
  paths                    Show where the config file and data folder are

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
    default:
      fail(`unknown command "${command}" (see chrysalis --help)`);
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
    ensureGitignoreEntries(p.root);
    // workspace AGENTS.md teaches external coding agents the file contract
    if (ensureWorkspaceAgentsMd(dataDir, u.username)) {
      await gitCommitAll(p.root, u.username, "docs: workspace AGENTS.md (external coding agents)");
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
