/**
 * Starts a packaged Chrysalis from an empty folder and walks the first run:
 * health, both frontends, account setup, and installing Roleplay from the
 * Store (this needs the network: the Store list and the app are on GitHub).
 *
 *   bun run scripts/smoke.ts out/dist/Chrysalis-1.0.0-linux-x64/chrysalis
 *   bun run scripts/smoke.ts bun out/dist/npm/chrysalis.js
 *
 * The expected version is CHRYSALIS_VERSION when set, else package.json's.
 * Used by CI on every OS the downloads target. Exits non-zero on the first
 * failed check and prints the engine's output.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: bun run scripts/smoke.ts <chrysalis executable> [args...]");
  process.exit(2);
}
const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
const expected = process.env.CHRYSALIS_VERSION || pkg.version;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-smoke-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;

let output = "";
const collect = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
};

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(what);
  console.log(`ok  ${what}`);
}

const version = Bun.spawnSync([...command, "--version"], { stdout: "pipe", stderr: "pipe" });
check(version.stdout.toString().includes(expected), `--version prints ${expected}`);

const engine = Bun.spawn([...command, "start", "--home", home, "--port", String(port)], {
  env: { ...process.env, CHRYSALIS_OPEN_BROWSER: "false", CHRYSALIS_APPS_PACKAGE_DOWNLOADS: "false" },
  stdout: "pipe",
  stderr: "pipe",
});
void collect(engine.stdout);
void collect(engine.stderr);

let failed = false;
try {
  const deadline = Date.now() + 60_000;
  let health: { ok?: boolean; version?: string } | null = null;
  while (!health && Date.now() < deadline) {
    if (engine.exitCode !== null) throw new Error(`engine exited with code ${engine.exitCode}`);
    health = await fetch(`${base}/v1/health`).then((r) => r.json() as Promise<typeof health>).catch(() => null);
    if (!health) await Bun.sleep(250);
  }
  check(health?.ok && health.version === expected, `/v1/health reports ${expected}`);

  for (const page of ["/", "/agent"]) {
    const res = await fetch(`${base}${page}`);
    check(res.ok && (await res.text()).includes("<script"), `${page} serves its frontend`);
  }

  const token = /#setup=([^\s]+)/.exec(output)?.[1];
  check(token, "startup prints a setup link");
  const logFile = path.join(home, "data", "logs", "chrysalis.log");
  check(fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes(token), "the setup link is in the log file");

  const setup = await fetch(`${base}/v1/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, username: "smoke", password: "smoke-test" }),
  });
  const cookie = setup.headers.get("set-cookie")?.split(";")[0];
  check(setup.ok && cookie, `setup creates the admin account (${setup.status})`);

  const json = { cookie: cookie!, "content-type": "application/json" };
  const launch = (await fetch(`${base}/v1/launch`, { headers: json }).then((r) => r.json())) as { apps?: unknown[] };
  check(launch.apps?.length === 0, "a new account starts with no apps");

  const store = (await fetch(`${base}/v1/store`, { headers: json }).then((r) => r.json())) as {
    apps?: { id: string; repository: string; ref?: string; official: boolean }[];
    error?: string;
  };
  const roleplay = store.apps?.find((a) => a.id === "roleplay");
  check(roleplay?.official, `the Store lists Roleplay as official${store.error ? ` (${store.error})` : ""}`);

  const importApp = (body: Record<string, unknown>) =>
    fetch(`${base}/v1/apps/import`, { method: "POST", headers: json, body: JSON.stringify({ gitUrl: roleplay.repository, ...(roleplay.ref ? { ref: roleplay.ref } : {}), ...body }) })
      .then(async (r) => ({ status: r.status, body: (await r.json()) as { head?: string; slug?: string; id?: string; error?: string } }));
  const preview = await importApp({});
  check(preview.body.head && preview.body.slug, `the Store app previews (${preview.status} ${preview.body.error ?? ""})`);
  const installed = await importApp({ confirm: preview.body.slug, head: preview.body.head });
  check(installed.body.id === "roleplay", `Roleplay installs (${installed.status} ${installed.body.error ?? ""})`);

  const after = (await fetch(`${base}/v1/launch`, { headers: json }).then((r) => r.json())) as { apps?: { id: string; official: boolean }[] };
  check(after.apps?.find((a) => a.id === "roleplay")?.official, "the installed Roleplay is official");

  const plugins = await fetch(`${base}/v1/apps/roleplay/plugins`, { headers: json });
  check(plugins.ok, "the roleplay app's plugins load");

  check(fs.existsSync(path.join(home, "config.yaml")), "config.yaml is created");
} catch (e) {
  failed = true;
  console.error(`\nFAIL ${(e as Error).message}\n\n--- engine output ---\n${output}`);
} finally {
  engine.kill();
  await Promise.race([engine.exited, Bun.sleep(10_000)]);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
if (failed) process.exit(1);
console.log("\nsmoke test passed");
