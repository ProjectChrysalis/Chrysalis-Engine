import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/server/app.js";
import { defaultInstanceConfig } from "../src/config.js";
import { allowFirewall, detectFirewall, firewallArgv, firewallState, type FirewallHost } from "../src/firewall.js";
import { UserService } from "../src/users.js";
import { SessionService } from "../src/sessions.js";
import { EventBus } from "../src/server/ws.js";

let dataDir: string;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "firewall-")); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

function host(over: Partial<FirewallHost> & { programs?: Record<string, string>; files?: Record<string, string> } = {}): FirewallHost {
  const programs = over.programs ?? {};
  const files = over.files ?? {};
  return {
    platform: "linux",
    container: false,
    program: "/opt/chrysalis/chrysalis",
    find: (name) => programs[name] ?? null,
    read: (file) => files[file] ?? null,
    run: () => ({ code: 1, out: "" }),
    ...over,
  };
}

const ufwHost = (extra: Record<string, string> = { pkexec: "/usr/bin/pkexec" }) =>
  host({ programs: { ufw: "/usr/sbin/ufw", ...extra }, files: { "/etc/ufw/ufw.conf": "# comment\nENABLED=yes\nLOGLEVEL=low\n" } });

it("finds the firewall that is on, and none where none is", () => {
  expect(detectFirewall(ufwHost())).toBe("ufw");
  expect(detectFirewall(host({ programs: { ufw: "/usr/sbin/ufw" }, files: { "/etc/ufw/ufw.conf": "ENABLED=no\n" } }))).toBe(null);
  expect(detectFirewall(host({ programs: { "firewall-cmd": "/usr/bin/firewall-cmd" }, run: (argv) => ({ code: argv[1] === "--state" ? 0 : 1, out: "running" }) }))).toBe("firewalld");
  expect(detectFirewall(host())).toBe(null);
  expect(detectFirewall(host({ platform: "win32" }))).toBe("windows");
  expect(detectFirewall(host({ platform: "darwin", run: () => ({ code: 0, out: "Firewall is enabled. (State = 1)" }) }))).toBe("macos");
  expect(detectFirewall(host({ platform: "darwin", run: () => ({ code: 0, out: "Firewall is disabled. (State = 0)" }) }))).toBe(null);
  // a container cannot reach the firewall of the machine around it
  expect(detectFirewall({ ...ufwHost(), container: true })).toBe(null);
});

it("asks for the engine's port and the app ports, from private addresses only", () => {
  const argv = firewallArgv("ufw", 8788, 8804, ufwHost())!;
  expect(argv.slice(0, 3)).toEqual(["/usr/bin/pkexec", "/bin/sh", "-c"]);
  expect(argv[3]!.split(" && ")).toEqual([
    "/usr/sbin/ufw allow proto tcp from 10.0.0.0/8 to any port 8788:8804 comment Chrysalis",
    "/usr/sbin/ufw allow proto tcp from 172.16.0.0/12 to any port 8788:8804 comment Chrysalis",
    "/usr/sbin/ufw allow proto tcp from 192.168.0.0/16 to any port 8788:8804 comment Chrysalis",
  ]);

  const fd = firewallArgv("firewalld", 9000, 9016, host({ programs: { pkexec: "/usr/bin/pkexec", "firewall-cmd": "/usr/bin/firewall-cmd" } }))![3]!.split(" && ");
  expect(fd).toHaveLength(6);
  expect(fd[0]).toBe(`/usr/bin/firewall-cmd --add-rich-rule='rule family="ipv4" source address="10.0.0.0/8" port port="9000-9016" protocol="tcp" accept'`);
  expect(fd[1]).toBe(`/usr/bin/firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.0.0.0/8" port port="9000-9016" protocol="tcp" accept'`);

  const win = firewallArgv("windows", 8788, 8804, host({ platform: "win32" }))!;
  expect(win[0]).toBe("powershell.exe");
  expect(win.at(-1)).toContain("-Verb RunAs");
  expect(win.at(-1)).toContain("add rule name=Chrysalis dir=in action=allow protocol=TCP localport=8788-8804 remoteip=LocalSubnet");

  const mac = firewallArgv("macos", 8788, 8804, host({ platform: "darwin", program: `/Users/o'neil/My "Apps"/chrysalis` }))!;
  expect(mac.slice(0, 2)).toEqual(["/usr/bin/osascript", "-e"]);
  expect(mac[2]).toBe(
    `do shell script "/usr/libexec/ApplicationFirewall/socketfilterfw --add '/Users/o'\\\\''neil/My \\"Apps\\"/chrysalis' && ` +
      `/usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp '/Users/o'\\\\''neil/My \\"Apps\\"/chrysalis'" with administrator privileges`,
  );
});

it("without a way to ask for the password there is only the command", () => {
  const h = ufwHost({});
  expect(firewallArgv("ufw", 8788, 8804, h)).toBe(null);
  const s = firewallState(defaultInstanceConfig(), dataDir, h);
  expect([s.kind, s.oneClick, s.allowed]).toEqual(["ufw", false, false]);
  expect(s.command).toStartWith("sudo /usr/sbin/ufw allow proto tcp from 10.0.0.0/8 to any port 8788:8804");
});

it("a rule that was added is remembered until the ports move", async () => {
  const config = defaultInstanceConfig();
  const h = ufwHost();
  const ran: string[][] = [];
  const ok = async (argv: string[]) => { ran.push(argv); return { code: 0, err: "" }; };
  expect(firewallState(config, dataDir, h).allowed).toBe(false);
  const after = await allowFirewall(config, dataDir, h, ok);
  expect(after.allowed).toBe(true);
  expect(ran).toEqual([firewallArgv("ufw", config.port, config.port + 16, h)!]);
  expect(firewallState(config, dataDir, h).allowed).toBe(true);
  config.port += 100;
  expect(firewallState(config, dataDir, h).allowed).toBe(false);
});

it("a refused or failed prompt adds nothing and says why", async () => {
  const config = defaultInstanceConfig();
  const h = ufwHost();
  const fails = (code: number, err = "") => allowFirewall(config, dataDir, h, async () => ({ code, err })).then(() => "", (e: Error) => e.message);
  expect(await fails(126)).toBe("the password prompt was closed");
  expect(await fails(127)).toContain("cannot show a password prompt");
  expect(await fails(1, "ERROR: Bad port\n")).toBe("ERROR: Bad port");
  expect(firewallState(config, dataDir, h).allowed).toBe(false);
  expect(fs.existsSync(path.join(dataDir, "firewall.json"))).toBe(false);
});

it("only an admin reads or changes the firewall", async () => {
  const users = new UserService(dataDir);
  const admin = users.create("root", "admin", { password: "secret-pw" });
  const plain = users.create("guest", "user", { password: "secret-pw" });
  const ran: string[][] = [];
  const app = buildApp({
    users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus(),
    firewall: { host: ufwHost(), spawn: async (argv) => { ran.push(argv); return { code: 0, err: "" }; } },
  });
  const call = (method: string, token?: string) =>
    app.request("/v1/admin/server/firewall", { method, headers: { host: "localhost:8788", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  expect((await call("GET")).status).toBe(401);
  expect((await call("GET", plain.token)).status).toBe(403);
  expect((await call("POST", plain.token)).status).toBe(403);
  expect(ran).toEqual([]);
  expect(await (await call("GET", admin.token)).json()).toMatchObject({ kind: "ufw", allowed: false, oneClick: true, first: 8788, last: 8804 });
  expect(await (await call("POST", admin.token)).json()).toMatchObject({ kind: "ufw", allowed: true });
  expect(ran).toHaveLength(1);
});
