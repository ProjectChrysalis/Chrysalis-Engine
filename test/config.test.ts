/**
 * Server settings: config.yaml creation and migration, environment and flag
 * overrides, validation warnings, first-run account setup, and changing
 * settings (including the listening socket) while the engine runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ConfigError, SETTINGS, defaultInstanceConfig, envNameOf, flagNameOf, loadConfig, parseFlags, renderConfigFile } from "../src/config.js";
import { buildApp } from "../src/server/app.js";
import { Listener } from "../src/server/listen.js";
import { ServerSettings } from "../src/server/settings.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("config.yaml", () => {
  it("is created with defaults on first run and reads back the same", () => {
    const first = loadConfig(home, { env: {} });
    expect(first.created).toBe(true);
    expect(fs.readFileSync(path.join(home, "config.yaml"), "utf8")).toContain("# Chrysalis server settings.");
    expect(first.config).toEqual(defaultInstanceConfig());
    const again = loadConfig(home, { env: {} });
    expect(again.created).toBe(false);
    expect(again.warnings).toEqual([]);
    expect(again.config).toEqual(defaultInstanceConfig());
  });

  it("renders every setting so the file round-trips", () => {
    const cfg = defaultInstanceConfig();
    cfg.port = 9123;
    cfg.lan = true;
    cfg.allowedHosts = ["chrysalis.home", "laptop.tail1234.ts.net"];
    cfg.ssl = { enabled: true, certPath: "./my cert.pem", keyPath: "./k \"q\".pem" };
    cfg.agent.shell = false;
    cfg.defaultModel = "anthropic/claude-opus-5";
    fs.writeFileSync(path.join(home, "config.yaml"), renderConfigFile(cfg));
    const loaded = loadConfig(home, { env: {} });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config).toEqual(cfg);
  });

  it("moves a legacy data/instance.json into config.yaml", () => {
    fs.mkdirSync(path.join(home, "data"));
    fs.writeFileSync(
      path.join(home, "data", "instance.json"),
      JSON.stringify({ appName: "X", server: { host: "0.0.0.0", port: 9001, allowedHosts: ["box.lan"] }, apps: { packageNetwork: false }, sandbox: { provider: "off", timeoutMs: 60000 }, defaults: { model: null } }),
    );
    const loaded = loadConfig(home, { env: {} });
    expect(loaded.config.port).toBe(9001);
    expect(loaded.config.lan).toBe(true);
    expect(loaded.config.allowedHosts).toEqual(["box.lan"]);
    expect(loaded.config.apps.packageDownloads).toBe(false);
    expect(loaded.config.agent).toEqual({ shell: false, shellTimeoutSeconds: 60 });
    expect(fs.existsSync(path.join(home, "data", "instance.json"))).toBe(false);
    expect(loaded.warnings[0]).toMatch(/moved the settings/);
  });

  it("warns about unknown and invalid settings and keeps safe values", () => {
    fs.writeFileSync(path.join(home, "config.yaml"), "prot: 9000\nport: 99999\nlan: yes please\napps:\n");
    const loaded = loadConfig(home, { env: {} });
    expect(loaded.config.port).toBe(8788);
    expect(loaded.config.lan).toBe(false);
    const text = loaded.warnings.join("\n");
    expect(text).toContain('unknown setting "prot" (did you mean "port"?)');
    expect(text).toMatch(/port must be a whole number/);
    expect(text).toMatch(/lan must be true or false/);
    expect(text).not.toMatch(/"apps"/);
  });

  it("refuses to start on a file that is not YAML", () => {
    fs.writeFileSync(path.join(home, "config.yaml"), "port: [\n");
    expect(() => loadConfig(home, { env: {} })).toThrow(ConfigError);
  });
});

describe("overrides", () => {
  it("names env vars and flags from the setting path", () => {
    expect(envNameOf("port")).toBe("CHRYSALIS_PORT");
    expect(envNameOf("ssl.certPath")).toBe("CHRYSALIS_SSL_CERT_PATH");
    expect(envNameOf("apps.packageDownloads")).toBe("CHRYSALIS_APPS_PACKAGE_DOWNLOADS");
    expect(flagNameOf("openBrowser")).toBe("--open-browser");
    expect(flagNameOf("agent.shellTimeoutSeconds")).toBe("--agent.shell-timeout-seconds");
    expect(new Set(SETTINGS.map((s) => envNameOf(s.key))).size).toBe(SETTINGS.length);
  });

  it("environment variables win over the file and are reported as locked", () => {
    fs.writeFileSync(path.join(home, "config.yaml"), "port: 9000\n");
    const loaded = loadConfig(home, { env: { CHRYSALIS_PORT: "9500", CHRYSALIS_LAN: "true", CHRYSALIS_ALLOWED_HOSTS: "a.lan, b.lan" } });
    expect(loaded.file.port).toBe(9000);
    expect(loaded.config.port).toBe(9500);
    expect(loaded.config.lan).toBe(true);
    expect(loaded.config.allowedHosts).toEqual(["a.lan", "b.lan"]);
    expect(loaded.locked).toEqual({ port: "CHRYSALIS_PORT", lan: "CHRYSALIS_LAN", allowedHosts: "CHRYSALIS_ALLOWED_HOSTS" });
  });

  it("a bad environment value stops the engine instead of being ignored", () => {
    expect(() => loadConfig(home, { env: { CHRYSALIS_LAN: "maybe" } })).toThrow(/CHRYSALIS_LAN must be true or false/);
  });

  it("parses flags, including --no- and = forms", () => {
    const f = parseFlags(["start", "--port", "9100", "--lan", "--no-open-browser", "--agent.shell-timeout-seconds=45", "--home", "/tmp/x", "--bogus"]);
    expect(f.overrides).toEqual({ port: 9100, lan: true, openBrowser: false, "agent.shellTimeoutSeconds": 45 });
    expect(f.home).toBe("/tmp/x");
    expect(f.rest).toEqual(["start", "--bogus"]);
    expect(() => parseFlags(["--port", "http"])).toThrow(/--port must be/);
    expect(() => parseFlags(["--port"])).toThrow(/needs a value/);
  });

  it("flags win over environment variables", () => {
    const loaded = loadConfig(home, { env: { CHRYSALIS_PORT: "9500" }, flags: { port: 9600 } });
    expect(loaded.config.port).toBe(9600);
    expect(loaded.locked.port).toBe("--port");
  });

  it("DATA_DIR still points at a data folder", () => {
    const loaded = loadConfig(home, { env: { DATA_DIR: "/srv/chrysalis" } });
    expect(loaded.config.dataRoot).toBe("/srv/chrysalis");
    expect(loaded.locked.dataRoot).toBe("DATA_DIR");
  });
});

/** A free TCP port on loopback. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe("first-run setup", () => {
  const harness = (setupToken: string | null) => {
    const dataDir = path.join(home, "data");
    fs.mkdirSync(dataDir);
    const users = new UserService(dataDir);
    const app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus(), setupToken });
    const post = (body: unknown) =>
      app.request("/v1/auth/setup", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body) });
    return { app, users, post };
  };

  it("creates the admin account with the setup token and signs in", async () => {
    const { app, users, post } = harness("tok-123456");
    const listed = (await (await app.request("/v1/auth/users", { headers: { host: "localhost" } })).json()) as { setup: boolean };
    expect(listed.setup).toBe(true);
    const res = await post({ token: "tok-123456", username: "mira", password: "hunter22" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("chrysalis_session=");
    expect(users.get("mira")?.role).toBe("admin");
    expect(fs.existsSync(path.join(home, "data", "users", "mira", "settings.json"))).toBe(true);
    // the link works exactly once
    expect((await post({ token: "tok-123456", username: "other", password: "hunter22" })).status).toBe(409);
  });

  it("refuses a wrong token and a weak password", async () => {
    const { users, post } = harness("tok-123456");
    expect((await post({ token: "tok-654321", username: "mira", password: "hunter22" })).status).toBe(403);
    expect((await post({ token: "tok-123456", username: "mira", password: "abc" })).status).toBe(400);
    expect(users.list()).toEqual([]);
  });

  it("is closed when the engine did not start in setup mode", async () => {
    const { post } = harness(null);
    expect((await post({ token: "", username: "mira", password: "hunter22" })).status).toBe(409);
  });
});

describe("server settings at runtime", () => {
  it("saves a change to config.yaml and applies it in place", () => {
    const loaded = loadConfig(home, { env: {} });
    const runtime: string[] = [];
    const settings = new ServerSettings({
      homeDir: home,
      dataDir: path.join(home, "data"),
      loaded,
      applySocket: () => false,
      applyRuntime: (next) => runtime.push(String(next.agent.shell)),
    });
    const shared = loaded.config;
    const r = settings.update({ "agent.shell": false, allowedHosts: ["Box.LAN"] });
    expect("error" in r).toBe(false);
    expect(shared.agent.shell).toBe(false);
    expect(shared.allowedHosts).toEqual(["box.lan"]);
    expect(runtime).toEqual(["false"]);
    expect(loadConfig(home, { env: {} }).file.agent.shell).toBe(false);
    expect(settings.update({ dataRoot: "/elsewhere" })).toEqual({ error: expect.stringMatching(/stopped/) });
    expect(settings.update({ port: "80a" })).toEqual({ error: expect.stringMatching(/port must be/) });
  });

  it("keeps an overridden value for this run but saves the file value", () => {
    const loaded = loadConfig(home, { env: { CHRYSALIS_PORT: "9555" } });
    const settings = new ServerSettings({ homeDir: home, dataDir: home, loaded, applySocket: () => false, applyRuntime: () => {} });
    settings.update({ port: 9777 });
    expect(loaded.config.port).toBe(9555);
    expect(loadConfig(home, { env: {} }).config.port).toBe(9777);
  });

  it("moves the listening socket and puts the old one back when the new port is taken", async () => {
    const [a, b] = [await freePort(), await freePort()];
    const bus = new EventBus();
    const listener = new Listener({ homeDir: home, bus, handle: () => new Response("hi") });
    const cfgA = { ...defaultInstanceConfig(), port: a };
    listener.start(cfgA);
    try {
      expect(await (await fetch(`http://127.0.0.1:${a}/`)).text()).toBe("hi");
      const cfgB = { ...defaultInstanceConfig(), port: b };
      expect(listener.rebind(cfgB, cfgA)).toBe(true);
      expect(await (await fetch(`http://127.0.0.1:${b}/`)).text()).toBe("hi");

      const blocker = Bun.serve({ hostname: "127.0.0.1", port: a, fetch: () => new Response("other") });
      try {
        expect(() => listener.rebind(cfgA, cfgB)).toThrow(/already in use/);
        expect(await (await fetch(`http://127.0.0.1:${b}/`)).text()).toBe("hi");
      } finally {
        blocker.stop(true);
      }
      const noCert = { ...cfgB, ssl: { enabled: true, certPath: "./nope.pem", keyPath: "./nope.key" } };
      expect(() => listener.rebind(noCert, cfgB)).toThrow(/certificate file does not exist/);
      expect(await (await fetch(`http://127.0.0.1:${b}/`)).text()).toBe("hi");
    } finally {
      await listener.stop();
    }
  });
});

describe("server_settings agent tool", () => {
  const setup = () => {
    const loaded = loadConfig(home, { env: {} });
    const settings = new ServerSettings({ homeDir: home, dataDir: path.join(home, "data"), loaded, applySocket: () => false, applyRuntime: () => {} });
    return { loaded, settings };
  };
  const toolWith = async (settings: ServerSettings, ask: ((q: { question: string; options?: string[]; detail?: string }) => Promise<string>) | undefined, readOnly = false) => {
    const { buildAdminTools } = await import("../src/agent/agent.js");
    const tools = buildAdminTools(new UserService(path.join(home, "data")), { settings, ...(ask ? { ask } : {}), readOnly });
    return tools.find((t) => t.name === "server_settings")!;
  };
  const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

  it("reads settings without asking", async () => {
    const { settings } = setup();
    const tool = await toolWith(settings, async () => {
      throw new Error("should not ask");
    });
    expect(textOf(await tool.execute("t1", { action: "read" }))).toContain("config.yaml");
  });

  it("changes nothing until the user approves, in the engine's words", async () => {
    const { loaded, settings } = setup();
    const asked: string[] = [];
    const decline = await toolWith(settings, async (q) => {
      asked.push(`${q.question}\n${q.detail}`);
      return "Don't change";
    });
    expect(textOf(await decline.execute("t2", { action: "change", changes: { lan: true } }))).toMatch(/did not approve/);
    expect(loaded.config.lan).toBe(false);
    expect(asked[0]).toContain("lan: false → true");
    expect(asked[0]).toContain("Other devices on your network will be able to open Chrysalis");

    const approve = await toolWith(settings, async () => "Apply");
    expect(textOf(await approve.execute("t3", { action: "change", changes: { lan: true } }))).toMatch(/Saved/);
    expect(loaded.config.lan).toBe(true);
    expect(loadConfig(home, { env: {} }).file.lan).toBe(true);
  });

  it("plan mode and a missing user leave settings alone", async () => {
    const { loaded, settings } = setup();
    const plan = await toolWith(settings, async () => "Apply", true);
    expect(textOf(await plan.execute("t4", { action: "change", changes: { port: 9999 } }))).toMatch(/read-only/);
    const away = await toolWith(settings, undefined);
    expect(textOf(await away.execute("t5", { action: "change", changes: { port: 9999 } }))).toMatch(/Settings > Server/);
    expect(loaded.config.port).toBe(8788);
  });
});

describe("release check", () => {
  it("compares dotted versions numerically", async () => {
    const { isNewer } = await import("../src/updates.js");
    expect(isNewer("1.10.0", "1.9.2")).toBe(true);
    expect(isNewer("v1.0.1", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("0.9.9", "1.0.0")).toBe(false);
  });
});

describe("admin_create_user agent tool", () => {
  it("creates an account only after the user approves, and sets up its workspace", async () => {
    const { buildAdminTools } = await import("../src/agent/agent.js");
    const dataDir = path.join(home, "data");
    const users = new UserService(dataDir);
    const provisioned: string[] = [];
    const tool = (answer: string) =>
      buildAdminTools(users, { ask: async () => answer, provisionAccount: async (u) => provisioned.push(u), readOnly: false }).find((t) => t.name === "admin_create_user")!;
    const declined = await tool("Don't create").execute("t1", { username: "sneaky", role: "admin", password: "pw-1234" });
    expect(JSON.stringify(declined)).toMatch(/did not approve/);
    expect(users.get("sneaky")).toBeUndefined();
    const made = await tool("Create").execute("t2", { username: "friend" });
    expect(users.get("friend")?.role).toBe("user");
    expect(provisioned).toEqual(["friend"]);
    expect(JSON.stringify(made)).not.toMatch(/[Tt]oken/);
  });
});
