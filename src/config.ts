/**
 * Server settings: <home>/config.yaml.
 *
 * The file is the user's: a commented YAML document they can open in any
 * editor. Settings > Server rewrites it from the same template, so the
 * comments survive a save from the UI. Every setting can also be given for one
 * run as an environment variable (CHRYSALIS_PORT=9000) or a flag
 * (--port 9000); those win over the file and are reported as locked, so the
 * UI never shows a value the engine is not actually using.
 *
 * Nothing here is reachable by agents or app code: the file lives beside the
 * data folder, outside every workspace, and only admin routes write it.
 */
import fs from "node:fs";
import path from "node:path";
import { defaultSandboxConfig, type SandboxConfig } from "./sandbox/index.js";

export interface InstanceConfig {
  /** Accounts, apps and chats. Relative paths start at the home folder. */
  dataRoot: string;
  port: number;
  /** false: this computer only. true: any device that can reach it. */
  lan: boolean;
  /** Interface to bind when lan is on; "auto" = every IPv4 interface. */
  listenAddress: string;
  /** Extra Host-header names to accept (a household DNS name, a tailnet
   *  name). IP addresses and the machine's own name are always accepted. */
  allowedHosts: string[];
  ssl: { enabled: boolean; certPath: string; keyPath: string };
  /** Open the browser when the engine starts on a desktop. */
  openBrowser: boolean;
  apps: {
    /** Apps may download their npm packages (install scripts never run). */
    packageDownloads: boolean;
    /** Where the Store's list of apps comes from; null turns the Store off. */
    store: string | null;
  };
  agent: {
    /** The agent's wasm shell in the user's browser tab. */
    shell: boolean;
    shellTimeoutSeconds: number;
  };
  /** Model the agent uses when a user has not picked one ("provider/model"). */
  defaultModel: string | null;
}

/** Where the Store's list of apps comes from unless config.yaml says otherwise. */
export const DEFAULT_STORE_URL = "https://raw.githubusercontent.com/ProjectChrysalis/app-store/main/apps.json";

export function defaultInstanceConfig(): InstanceConfig {
  const sandbox = defaultSandboxConfig();
  return {
    dataRoot: "./data",
    port: 8788,
    lan: false,
    listenAddress: "auto",
    allowedHosts: [],
    ssl: { enabled: false, certPath: "./certs/cert.pem", keyPath: "./certs/key.pem" },
    openBrowser: true,
    apps: { packageDownloads: true, store: DEFAULT_STORE_URL },
    agent: { shell: sandbox.provider !== "off", shellTimeoutSeconds: sandbox.timeoutMs / 1000 },
    defaultModel: null,
  };
}

/** The address Bun.serve binds. */
export function listenHost(cfg: InstanceConfig): string {
  if (!cfg.lan) return "127.0.0.1";
  return cfg.listenAddress === "auto" || !cfg.listenAddress ? "0.0.0.0" : cfg.listenAddress;
}

export function sandboxConfigOf(cfg: InstanceConfig): SandboxConfig {
  return { provider: cfg.agent.shell ? "browser" : "off", timeoutMs: cfg.agent.shellTimeoutSeconds * 1000 };
}

// ---------- schema ----------

type Kind = "string" | "path" | "port" | "bool" | "hosts" | "seconds" | "model" | "address" | "feed";

interface Setting {
  key: string;
  kind: Kind;
}

/** Every setting, by dotted path. Order is the file's order. */
export const SETTINGS: readonly Setting[] = [
  { key: "dataRoot", kind: "path" },
  { key: "port", kind: "port" },
  { key: "lan", kind: "bool" },
  { key: "listenAddress", kind: "address" },
  { key: "allowedHosts", kind: "hosts" },
  { key: "ssl.enabled", kind: "bool" },
  { key: "ssl.certPath", kind: "path" },
  { key: "ssl.keyPath", kind: "path" },
  { key: "openBrowser", kind: "bool" },
  { key: "apps.packageDownloads", kind: "bool" },
  { key: "apps.store", kind: "feed" },
  { key: "agent.shell", kind: "bool" },
  { key: "agent.shellTimeoutSeconds", kind: "seconds" },
  { key: "defaultModel", kind: "model" },
];

const SETTING_KEYS = new Set(SETTINGS.map((s) => s.key));
const SECTIONS = new Set(SETTINGS.filter((s) => s.key.includes(".")).map((s) => s.key.split(".")[0]!));

/** CHRYSALIS_ plus the dotted path in capitals: ssl.certPath → CHRYSALIS_SSL_CERT_PATH. */
export function envNameOf(key: string): string {
  return "CHRYSALIS_" + key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/\./g, "_").toUpperCase();
}

/** --port, --ssl.cert-path, --apps.package-downloads */
export function flagNameOf(key: string): string {
  return "--" + key.split(".").map((seg) => seg.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()).join(".");
}

function getPath(obj: unknown, key: string): unknown {
  let cur = obj;
  for (const seg of key.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const segs = key.split(".");
  let cur = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!cur[seg] || typeof cur[seg] !== "object") cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const MODEL_RE = /^[^\s/]+\/\S+$/;

/** Coerce one raw value (from YAML, an env var or a flag) to its kind.
 *  Returns an error message instead when it cannot be used. */
function coerce(kind: Kind, raw: unknown, textual: boolean): { value: unknown } | { error: string } {
  const text = typeof raw === "string" ? raw.trim() : raw;
  switch (kind) {
    case "bool": {
      if (typeof text === "boolean") return { value: text };
      if (textual && typeof text === "string") {
        if (/^(true|yes|on|1)$/i.test(text)) return { value: true };
        if (/^(false|no|off|0)$/i.test(text)) return { value: false };
      }
      return { error: "must be true or false" };
    }
    case "port": {
      const n = typeof text === "string" && textual ? Number(text) : text;
      if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535) return { value: n };
      return { error: "must be a whole number from 1 to 65535" };
    }
    case "seconds": {
      const n = typeof text === "string" && textual ? Number(text) : text;
      if (typeof n === "number" && Number.isFinite(n) && n >= 5 && n <= 3600) return { value: Math.floor(n) };
      return { error: "must be a number of seconds from 5 to 3600" };
    }
    case "string":
    case "path":
      if (typeof text === "string" && text.length > 0) return { value: text };
      return { error: "must be a non-empty text value" };
    case "address":
      if (typeof text === "string" && (text === "auto" || /^[0-9a-f.:]+$/i.test(text))) return { value: text };
      return { error: 'must be "auto" or an IP address' };
    case "feed":
      if (text === false || text === null || (textual && typeof text === "string" && /^(false|off|no)$/i.test(text))) return { value: null };
      if (typeof text === "string" && /^https?:\/\/[^\s/]+\/\S*$/.test(text)) return { value: text };
      return { error: "must be an http(s) address or false" };
    case "model":
      if (text === null || text === "" || (textual && text === "null")) return { value: null };
      if (typeof text === "string" && MODEL_RE.test(text)) return { value: text };
      return { error: 'must be "provider/model" or null' };
    case "hosts": {
      const list = textual && typeof text === "string" ? text.split(",").map((h) => h.trim()).filter(Boolean) : text;
      if (text === null) return { value: [] };
      if (!Array.isArray(list)) return { error: "must be a list of host names" };
      const hosts = list.map((h) => (typeof h === "string" ? h.trim().toLowerCase() : ""));
      const bad = hosts.find((h) => !HOST_RE.test(h));
      if (bad !== undefined) return { error: `has an invalid host name: ${JSON.stringify(bad)}` };
      return { value: hosts };
    }
  }
}

/** Closest known setting to a misspelt one, for the warning. */
function suggest(key: string): string | null {
  const dist = (a: string, b: string): number => {
    const d = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0]!;
      d[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = d[j]!;
        d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
        prev = tmp;
      }
    }
    return d[b.length]!;
  };
  let best: string | null = null;
  let bestD = 4;
  for (const k of SETTING_KEYS) {
    const d = dist(key, k);
    if (d < bestD) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

/** Every leaf key in a parsed document, dotted. */
function leafKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !SETTING_KEYS.has(key)) out.push(...leafKeys(v as Record<string, unknown>, key));
    // a section header with nothing under it ("apps:") parses as null
    else if (!(v === null && SECTIONS.has(key))) out.push(key);
  }
  return out;
}

// ---------- the file ----------

const yamlString = (s: string): string => JSON.stringify(s);

export function renderConfigFile(c: InstanceConfig): string {
  const hosts = c.allowedHosts.length ? "\n" + c.allowedHosts.map((h) => `  - ${yamlString(h)}`).join("\n") : " []";
  return `# Chrysalis server settings.
#
# Edit with any text editor, then restart Chrysalis. Admins can change most of
# these in Settings > Server too, which saves back to this file.
#
# Any setting can be set for a single run without editing this file:
#   environment variable   CHRYSALIS_PORT=9000   CHRYSALIS_SSL_ENABLED=true
#   command-line flag      --port 9000   --lan   --no-open-browser

# Folder for accounts, apps, chats and keys. Relative paths start next to
# this file. Move the folder while Chrysalis is stopped.
dataRoot: ${yamlString(c.dataRoot)}

# ---- Network ----

# Port Chrysalis listens on.
port: ${c.port}

# Let other devices (your phone, a tablet, another computer) open Chrysalis.
#   false  only this computer
#   true   any device that can reach this computer; every account still
#          needs its password
lan: ${c.lan}

# Network interface to use when lan is true. "auto" means all of them.
listenAddress: ${yamlString(c.listenAddress)}

# Extra host names that may open Chrysalis, such as a local DNS name or a
# Tailscale machine name. IP addresses and this computer's own name always work.
allowedHosts:${hosts}

# Serve over HTTPS. Phones only allow the microphone, installing as an app
# and some other features over HTTPS. Paths start next to this file.
ssl:
  enabled: ${c.ssl.enabled}
  certPath: ${yamlString(c.ssl.certPath)}
  keyPath: ${yamlString(c.ssl.keyPath)}

# ---- Startup ----

# Open Chrysalis in your browser when it starts (desktop only).
openBrowser: ${c.openBrowser}

# ---- Apps and agent ----

apps:
  # Let apps download their npm packages. Package install scripts never run.
  packageDownloads: ${c.apps.packageDownloads}
  # Where the Store's list of apps comes from. false turns the Store off.
  store: ${c.apps.store === null ? "false" : yamlString(c.apps.store)}

agent:
  # The agent's command shell. It runs inside your browser tab, never on
  # this computer.
  shell: ${c.agent.shell}
  # Longest a single shell command may run, in seconds (5 to 3600).
  shellTimeoutSeconds: ${c.agent.shellTimeoutSeconds}

# Model the agent uses when an account has not chosen one, as
# "provider/model". null picks the first available model.
defaultModel: ${c.defaultModel === null ? "null" : yamlString(c.defaultModel)}
`;
}

export interface LoadedConfig {
  config: InstanceConfig;
  /** Values as written in config.yaml (defaults where the file has none). */
  file: InstanceConfig;
  /** Settings overridden for this run, with where the override came from. */
  locked: Record<string, string>;
  /** Problems worth telling the user about; the engine still starts. */
  warnings: string[];
  /** The config.yaml path. */
  path: string;
  /** config.yaml was just created from defaults or migrated. */
  created: boolean;
}

export class ConfigError extends Error {}

/** Settings from a config file written before config.yaml: data/instance.json. */
function fromInstanceJson(raw: Record<string, unknown>): InstanceConfig {
  const cfg = defaultInstanceConfig();
  const server = (raw.server ?? {}) as { host?: unknown; port?: unknown; allowedHosts?: unknown };
  if (typeof server.port === "number") cfg.port = server.port;
  if (typeof server.host === "string" && server.host !== "127.0.0.1" && server.host !== "localhost") {
    cfg.lan = true;
    if (server.host !== "0.0.0.0") cfg.listenAddress = server.host;
  }
  if (Array.isArray(server.allowedHosts)) cfg.allowedHosts = server.allowedHosts.filter((h): h is string => typeof h === "string");
  const apps = (raw.apps ?? {}) as { packageNetwork?: unknown };
  if (typeof apps.packageNetwork === "boolean") cfg.apps.packageDownloads = apps.packageNetwork;
  const sandbox = (raw.sandbox ?? {}) as { provider?: unknown; timeoutMs?: unknown };
  if (sandbox.provider === "off") cfg.agent.shell = false;
  if (typeof sandbox.timeoutMs === "number") cfg.agent.shellTimeoutSeconds = Math.min(Math.max(Math.floor(sandbox.timeoutMs / 1000), 5), 3600);
  const defaults = (raw.defaults ?? {}) as { model?: unknown };
  if (typeof defaults.model === "string") cfg.defaultModel = defaults.model;
  return cfg;
}

/** Validate a parsed document into a config, collecting warnings. */
function readDocument(doc: Record<string, unknown>, warnings: string[]): InstanceConfig {
  const cfg = defaultInstanceConfig() as unknown as Record<string, unknown>;
  for (const key of leafKeys(doc)) {
    if (SETTING_KEYS.has(key)) continue;
    const near = suggest(key);
    warnings.push(`config.yaml: unknown setting "${key}"${near ? ` (did you mean "${near}"?)` : ""}, ignored`);
  }
  for (const s of SETTINGS) {
    const raw = getPath(doc, s.key);
    if (raw === undefined) continue;
    const r = coerce(s.kind, raw, false);
    if ("error" in r) warnings.push(`config.yaml: ${s.key} ${r.error}; using ${JSON.stringify(getPath(cfg, s.key))}`);
    else setPath(cfg, s.key, r.value);
  }
  return cfg as unknown as InstanceConfig;
}

/** Parse command-line flags into setting overrides. Unknown flags are errors:
 *  a mistyped --lan must not silently start a localhost-only engine. */
export function parseFlags(argv: string[]): { overrides: Record<string, unknown>; home?: string; rest: string[] } {
  const byFlag = new Map(SETTINGS.map((s) => [flagNameOf(s.key), s]));
  const overrides: Record<string, unknown> = {};
  const rest: string[] = [];
  let home: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    let name = eq === -1 ? arg : arg.slice(0, eq);
    let value: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
    if (name === "--home") {
      home = value ?? argv[++i];
      if (!home) throw new ConfigError("--home needs a folder");
      continue;
    }
    let negated = false;
    if (!byFlag.has(name) && name.startsWith("--no-")) {
      negated = true;
      name = "--" + name.slice(5);
    }
    const setting = byFlag.get(name);
    if (!setting) {
      rest.push(arg);
      continue;
    }
    if (setting.kind === "bool") {
      if (negated) value = "false";
      else if (value === undefined) value = "true";
    } else if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new ConfigError(`${name} needs a value`);
    }
    const r = coerce(setting.kind, value, true);
    if ("error" in r) throw new ConfigError(`${name} ${r.error}`);
    overrides[setting.key] = r.value;
  }
  return { overrides, home, rest };
}

/**
 * Read <home>/config.yaml (creating it on first run, or from a legacy
 * data/instance.json), then apply environment and flag overrides.
 */
export function loadConfig(homeDir: string, opts: { env?: NodeJS.ProcessEnv; flags?: Record<string, unknown> } = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const file = path.join(homeDir, "config.yaml");
  const warnings: string[] = [];
  let created = false;
  let fileCfg: InstanceConfig;

  if (fs.existsSync(file)) {
    let doc: unknown;
    try {
      doc = Bun.YAML.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new ConfigError(`${file} is not valid YAML (${(e as Error).message}). Fix the file, or delete it to start over with defaults.`);
    }
    if (doc === null || doc === undefined) doc = {};
    if (typeof doc !== "object" || Array.isArray(doc)) {
      throw new ConfigError(`${file} must be a list of "setting: value" lines. Fix the file, or delete it to start over with defaults.`);
    }
    fileCfg = readDocument(doc as Record<string, unknown>, warnings);
  } else {
    fileCfg = defaultInstanceConfig();
    const legacy = path.join(dataDirOf(homeDir, { ...fileCfg, dataRoot: env.DATA_DIR || fileCfg.dataRoot }), "instance.json");
    let migrated = false;
    if (fs.existsSync(legacy)) {
      try {
        fileCfg = fromInstanceJson(JSON.parse(fs.readFileSync(legacy, "utf8")) as Record<string, unknown>);
        migrated = true;
        warnings.push(`moved the settings in ${legacy} to ${file}`);
      } catch {
        warnings.push(`could not read ${legacy}; started ${file} from defaults`);
      }
    }
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(file, renderConfigFile(fileCfg), "utf8");
    if (migrated) fs.rmSync(legacy);
    created = true;
  }

  const effective = structuredClone(fileCfg) as unknown as Record<string, unknown>;
  const locked: Record<string, string> = {};
  for (const s of SETTINGS) {
    const name = envNameOf(s.key);
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const r = coerce(s.kind, raw, true);
    if ("error" in r) throw new ConfigError(`${name} ${r.error}`);
    setPath(effective, s.key, r.value);
    locked[s.key] = name;
  }
  // DATA_DIR predates config.yaml; it still points the engine at a data folder
  if (env.DATA_DIR && !locked.dataRoot) {
    effective.dataRoot = env.DATA_DIR;
    locked.dataRoot = "DATA_DIR";
  }
  for (const [key, value] of Object.entries(opts.flags ?? {})) {
    setPath(effective, key, value);
    locked[key] = flagNameOf(key);
  }
  return { config: effective as unknown as InstanceConfig, file: fileCfg, locked, warnings, path: file, created };
}

/** The data folder a config points at. */
export function dataDirOf(homeDir: string, cfg: InstanceConfig): string {
  return path.resolve(homeDir, cfg.dataRoot);
}

/** Save settings to config.yaml. Values that are locked for this run are
 *  written as given; they take effect once the override is gone. */
export function saveConfigFile(filePath: string, cfg: InstanceConfig): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, renderConfigFile(cfg), "utf8");
  fs.renameSync(tmp, filePath);
}

/** Apply a partial update (dotted keys) to a config, validating each value. */
export function applySettings(base: InstanceConfig, changes: Record<string, unknown>): { config: InstanceConfig } | { error: string } {
  const next = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [key, raw] of Object.entries(changes)) {
    const setting = SETTINGS.find((s) => s.key === key);
    if (!setting) return { error: `unknown setting: ${key}` };
    const r = coerce(setting.kind, raw, false);
    if ("error" in r) return { error: `${key} ${r.error}` };
    setPath(next, key, r.value);
  }
  return { config: next as unknown as InstanceConfig };
}
