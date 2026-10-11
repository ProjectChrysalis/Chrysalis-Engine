/**
 * The computer's own firewall, and the one rule Chrysalis needs in it: its
 * port and the ports apps with their own program are framed on, open to the
 * local network.
 *
 * Adding a rule takes the rights of an administrator of the computer, which
 * the engine never has. It starts the system's own password prompt around a
 * fixed command and nothing else, so the person at the computer sees what is
 * asked and may refuse. The rule only ever names private addresses (or, on
 * Windows, the local subnet): turning this on never opens the ports to the
 * internet.
 *
 * Whether the rule is in place cannot be read back without those rights, so
 * a successful run is written down beside the data and trusted until the
 * ports change.
 */
import fs from "node:fs";
import path from "node:path";
import type { InstanceConfig } from "./config.js";
import { SERVICE_PORT_SPAN } from "./apps/service.js";

export type FirewallKind = "ufw" | "firewalld" | "windows" | "macos";

export interface FirewallState {
  /** The firewall that is on, null when there is none this engine knows. */
  kind: FirewallKind | null;
  /** The rule was added for the ports in use now. */
  allowed: boolean;
  /** The system can show its password prompt from here. */
  oneClick: boolean;
  first: number;
  last: number;
  /** The same thing as a command, for when the prompt cannot be shown. */
  command: string;
}

/** What the outside world looks like to this module; tests hand in their own. */
export interface FirewallHost {
  platform: NodeJS.Platform;
  /** A container's firewall is the machine's around it, out of reach. */
  container: boolean;
  /** The program that listens: what a per-program firewall is told about. */
  program: string;
  /** Full path of a program, null when it is not installed. */
  find: (name: string) => string | null;
  read: (file: string) => string | null;
  run: (argv: string[]) => { code: number; out: string };
}

/** Addresses only a local network uses. */
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
const MAC_TOOL = "/usr/libexec/ApplicationFirewall/socketfilterfw";
const RULE_NAME = "Chrysalis";

export function firewallRange(cfg: InstanceConfig): { first: number; last: number } {
  return { first: cfg.port, last: Math.min(65535, cfg.port + SERVICE_PORT_SPAN) };
}

/** Programs a login's PATH often leaves out sit in the sbin folders. */
function findProgram(name: string): string | null {
  const found = Bun.which(name);
  if (found) return found;
  for (const dir of ["/usr/sbin", "/sbin", "/usr/bin", "/bin"]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function systemHost(container: boolean): FirewallHost {
  return {
    platform: process.platform,
    container,
    program: process.execPath,
    find: findProgram,
    read: (file) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    run: (argv) => {
      try {
        const r = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
        return { code: r.exitCode ?? 1, out: r.stdout.toString() + r.stderr.toString() };
      } catch {
        return { code: 1, out: "" };
      }
    },
  };
}

export function detectFirewall(host: FirewallHost): FirewallKind | null {
  if (host.container) return null;
  if (host.platform === "linux") {
    if (host.find("ufw") && /^\s*ENABLED\s*=\s*yes\s*$/im.test(host.read("/etc/ufw/ufw.conf") ?? "")) return "ufw";
    const fc = host.find("firewall-cmd");
    if (fc && host.run([fc, "--state"]).code === 0) return "firewalld";
    return null;
  }
  // on unless someone turned it off, and a rule in a firewall that is off harms nothing
  if (host.platform === "win32") return "windows";
  if (host.platform === "darwin") {
    const m = /State = (\d)/.exec(host.run([MAC_TOOL, "--getglobalstate"]).out);
    return m && m[1] !== "0" ? "macos" : null;
  }
  return null;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The commands that add the rule, each one a line an administrator could run. */
function ruleCommands(kind: FirewallKind, first: number, last: number, host: FirewallHost): string[] {
  if (kind === "ufw") {
    const ufw = host.find("ufw") ?? "ufw";
    const ports = first === last ? String(first) : `${first}:${last}`;
    return PRIVATE_RANGES.map((range) => `${ufw} allow proto tcp from ${range} to any port ${ports} comment ${RULE_NAME}`);
  }
  if (kind === "firewalld") {
    const fc = host.find("firewall-cmd") ?? "firewall-cmd";
    const ports = first === last ? String(first) : `${first}-${last}`;
    // once for the running firewall, once for the next start
    return PRIVATE_RANGES.flatMap((range) => {
      const rule = shellQuote(`rule family="ipv4" source address="${range}" port port="${ports}" protocol="tcp" accept`);
      return [`${fc} --add-rich-rule=${rule}`, `${fc} --permanent --add-rich-rule=${rule}`];
    });
  }
  if (kind === "windows") {
    const ports = first === last ? String(first) : `${first}-${last}`;
    return [`netsh advfirewall firewall add rule name=${RULE_NAME} dir=in action=allow protocol=TCP localport=${ports} remoteip=LocalSubnet`];
  }
  const program = shellQuote(host.program);
  return [`${MAC_TOOL} --add ${program}`, `${MAC_TOOL} --unblockapp ${program}`];
}

/** What the engine starts: the system's password prompt around the commands. */
export function firewallArgv(kind: FirewallKind, first: number, last: number, host: FirewallHost): string[] | null {
  const commands = ruleCommands(kind, first, last, host);
  if (kind === "ufw" || kind === "firewalld") {
    const pkexec = host.find("pkexec");
    return pkexec ? [pkexec, "/bin/sh", "-c", commands.join(" && ")] : null;
  }
  if (kind === "windows") {
    // a rule of this name from other ports goes first, so one rule is left
    const line = `/c netsh advfirewall firewall delete rule name=${RULE_NAME} & ${commands[0]}`;
    const script = `$p = Start-Process -FilePath cmd.exe -ArgumentList '${line}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
    return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script];
  }
  const text = commands.join(" && ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return ["/usr/bin/osascript", "-e", `do shell script "${text}" with administrator privileges`];
}

function firewallCommand(kind: FirewallKind, first: number, last: number, host: FirewallHost): string {
  const commands = ruleCommands(kind, first, last, host);
  return kind === "windows" ? commands[0]! : commands.map((c) => `sudo ${c}`).join(" && ");
}

interface Mark {
  kind: FirewallKind;
  first: number;
  last: number;
  program?: string;
}

const markFile = (dataDir: string) => path.join(dataDir, "firewall.json");

function readMark(dataDir: string): Mark | null {
  try {
    const m = JSON.parse(fs.readFileSync(markFile(dataDir), "utf8")) as Partial<Mark>;
    return typeof m.kind === "string" && typeof m.first === "number" && typeof m.last === "number" ? (m as Mark) : null;
  } catch {
    return null;
  }
}

export function firewallState(cfg: InstanceConfig, dataDir: string, host: FirewallHost): FirewallState {
  const { first, last } = firewallRange(cfg);
  const kind = detectFirewall(host);
  if (!kind) return { kind: null, allowed: false, oneClick: false, first, last, command: "" };
  const mark = readMark(dataDir);
  // a per-program rule follows the program, a per-port rule the ports
  const covers = !!mark && mark.kind === kind && (kind === "macos" ? mark.program === host.program : mark.first <= first && mark.last >= last);
  return { kind, allowed: covers, oneClick: firewallArgv(kind, first, last, host) !== null, first, last, command: firewallCommand(kind, first, last, host) };
}

/** A person may take a while to find and type a password. */
const PROMPT_TIMEOUT_MS = 3 * 60 * 1000;

let running: Promise<FirewallState> | null = null;

/** Ask the computer to add the rule. Rejects with a sentence for the page. */
export function allowFirewall(
  cfg: InstanceConfig,
  dataDir: string,
  host: FirewallHost,
  spawn: (argv: string[]) => Promise<{ code: number; err: string }> = spawnPrompt,
): Promise<FirewallState> {
  if (running) return running;
  running = (async () => {
    const { first, last } = firewallRange(cfg);
    const kind = detectFirewall(host);
    if (!kind) throw new Error("no firewall found on this computer");
    const argv = firewallArgv(kind, first, last, host);
    if (!argv) throw new Error("this computer cannot show a password prompt here; run the command instead");
    const { code, err } = await spawn(argv);
    if (code !== 0) {
      // pkexec: 126 the prompt was closed, 127 nobody could be asked
      if (code === 126 || /cancel/i.test(err)) throw new Error("the password prompt was closed");
      if (code === 127) throw new Error("this computer cannot show a password prompt here; run the command instead");
      throw new Error(err.trim().split("\n").pop() || `the firewall command failed (${code})`);
    }
    const mark: Mark = { kind, first, last, ...(kind === "macos" ? { program: host.program } : {}) };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(markFile(dataDir), JSON.stringify(mark, null, 2) + "\n");
    return firewallState(cfg, dataDir, host);
  })().finally(() => {
    running = null;
  });
  return running;
}

async function spawnPrompt(argv: string[]): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), PROMPT_TIMEOUT_MS);
  try {
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { code, err };
  } finally {
    clearTimeout(timer);
  }
}
