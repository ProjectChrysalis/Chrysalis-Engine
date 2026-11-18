/**
 * Stress run: an engine on a throwaway home, the app installed with a large
 * fixture, a fake streaming model, and headless Firefox measuring what a
 * person would feel. Scenarios and limits come from the app's stress/suite.ts.
 *
 *   bun scripts/stress/run.ts --app ../my-app [--only <name>] [--scale 0.2] [--keep] [--headed] [--hold]
 *
 * Exits 1 when a measurement is over its limit. --profile-engine writes the
 * engine's CPU profile to <home>/engine-profile, --profile-browser a Firefox
 * profile to <home>/firefox-profile.json (with --keep to read them). --hold leaves everything
 * running afterwards and takes function bodies to evaluate in the app frame
 * on POST /eval (?shell for the page around it), until Ctrl+C. The run stops
 * when the engine and browser together pass --max-mb (default 6144).
 * --events prints what the engine tells open pages (data changes, builds),
 * with the time each arrived.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { commitAll } from "../../src/git.js";
import { Browser } from "./browser.js";
import { startModel } from "./model.js";
import { createPage } from "./page.js";
import type { StressSuite } from "./types.js";

const { values: args } = parseArgs({
  options: {
    app: { type: "string" },
    only: { type: "string" },
    scale: { type: "string", default: "1" },
    keep: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    hold: { type: "boolean", default: false },
    "profile-engine": { type: "boolean", default: false },
    "profile-browser": { type: "boolean", default: false },
    events: { type: "boolean", default: false },
    out: { type: "string" },
    "max-mb": { type: "string", default: "6144" },
  },
});
if (!args.app) {
  console.error("usage: bun scripts/stress/run.ts --app <app folder> [--only <name>] [--scale <n>] [--keep] [--headed] [--hold] [--out <file.json>]");
  process.exit(2);
}
const appDir = path.resolve(args.app);
const suite = (await import(path.join(appDir, "stress", "suite.ts"))).default as StressSuite;
const engineRoot = path.resolve(import.meta.dir, "..", "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-stress-"));
const user = "stress";
const children: ChildProcess[] = [];
let browser: Browser | null = null;
const model = { deltas: 1500, delayMs: 20 };
const llm = startModel(model);

/** Resident memory of a process and everything it started, in MB (0 where /proc is missing). */
function treeMb(root: number | undefined): number {
  if (!root) return 0;
  const kids = new Map<number, number[]>();
  const rss = new Map<number, number>();
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return 0;
  }
  for (const p of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${p}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(f[1]);
      kids.set(ppid, [...(kids.get(ppid) ?? []), Number(p)]);
      rss.set(Number(p), Number(f[21]) * 4096);
    } catch { /* exited while listing */ }
  }
  let total = 0;
  const walk = [root];
  while (walk.length) {
    const p = walk.pop()!;
    total += rss.get(p) ?? 0;
    walk.push(...(kids.get(p) ?? []));
  }
  return Math.round(total / 1048576);
}
const peak = { engineMb: 0, browserMb: 0 };
const maxMb = Number(args["max-mb"]);
const sampler = setInterval(() => {
  const engineMb = children.filter((c) => c.exitCode === null).reduce((a, c) => a + treeMb(c.pid), 0);
  const browserMb = treeMb(browser?.proc.pid);
  peak.engineMb = Math.max(peak.engineMb, engineMb);
  peak.browserMb = Math.max(peak.browserMb, browserMb);
  if (engineMb + browserMb > maxMb) {
    clearInterval(sampler);
    console.error(`stopped: engine ${engineMb} MB + browser ${browserMb} MB is over --max-mb ${maxMb}`);
    void cleanup().finally(() => process.exit(1));
  }
}, 1000);

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const token = crypto.randomBytes(18).toString("base64url");

async function startEngine(): Promise<ChildProcess> {
  const prof = args["profile-engine"] ? ["--cpu-prof", "--cpu-prof-dir", path.join(home, "engine-profile")] : [];
  const child = spawn(process.execPath, [...prof, "src/index.ts", "start", "--home", home, "--port", String(port)], {
    cwd: engineRoot,
    env: { ...process.env, CHRYSALIS_SETUP_TOKEN: token, CHRYSALIS_OPEN_BROWSER: "false" },
    stdio: ["ignore", fs.openSync(path.join(home, "engine.log"), "a"), fs.openSync(path.join(home, "engine.log"), "a")],
  });
  children.push(child);
  for (let i = 0; i < 300; i++) {
    if (await fetch(`${base}/v1/health`).then((r) => r.ok, () => false)) return child;
    await Bun.sleep(100);
  }
  throw new Error(`engine did not start; see ${path.join(home, "engine.log")}`);
}

async function stopEngine(child: ChildProcess): Promise<void> {
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
}

async function cleanup(): Promise<void> {
  clearInterval(sampler);
  await browser?.close();
  await Promise.all(children.filter((c) => c.exitCode === null).map((c) => stopEngine(c)));
  llm.stop();
  if (!args.keep) fs.rmSync(home, { recursive: true, force: true });
  else console.log(`kept ${home}`);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });
}

let failed = false;
try {
  const t0 = performance.now();
  let engine = await startEngine();
  const setup = await fetch(`${base}/v1/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, username: user, password: crypto.randomBytes(12).toString("hex") }),
  });
  if (!setup.ok) throw new Error(`setup failed: ${await setup.text()}`);
  const cookie = /chrysalis_session=([^;]+)/.exec(setup.headers.get("set-cookie") ?? "")?.[1];
  if (!cookie) throw new Error("setup returned no session");
  const conn = await fetch(`${base}/v1/settings/connections`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `chrysalis_session=${cookie}` },
    body: JSON.stringify({ name: "Stress", api: "openai-completions", baseUrl: `http://127.0.0.1:${llm.port}/v1`, models: [{ id: "stress-model", contextWindow: 128000, maxTokens: 8000 }] }),
  });
  if (!conn.ok) throw new Error(`connection failed: ${await conn.text()}`);
  const connId = ((await conn.json()) as { connection: { id: string } }).connection.id;

  // plugins register when the engine starts, so the app goes in while it is down
  await stopEngine(engine);
  const installed = path.join(home, "data", "users", user, "apps", suite.app);
  const skip = new Set(["data", "dist", ".git", "stress"]);
  fs.cpSync(appDir, installed, { recursive: true, filter: (src) => !skip.has(path.relative(appDir, src).split(path.sep)[0] ?? "") });
  const dataDir = path.join(installed, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  await suite.fixture?.({ dataDir, model: `${connId}/stress-model`, scale: Number(args.scale) });
  // a library a person built up is already in their history
  await commitAll(path.join(home, "data", "users", user), user, "stress: fixture");
  console.log(`fixture ready in ${Math.round((performance.now() - t0) / 1000)} s (${home})`);
  engine = await startEngine();

  if (args.events) {
    const events = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { cookie: `chrysalis_session=${cookie}` } } as unknown as string[]);
    events.onmessage = (e) => {
      const frame = JSON.parse(String(e.data)) as { type?: string; payload?: unknown };
      if (frame.type !== "app_stream") console.log(`  event at ${Date.now()}: ${frame.type} ${JSON.stringify(frame.payload ?? {}).slice(0, 300)}`);
    };
  }
  browser = await Browser.launch({
    profileDir: path.join(home, "firefox"),
    port: await freePort(),
    headed: args.headed,
    ...(args["profile-browser"] ? { profileTo: path.join(home, "firefox-profile.json") } : {}),
  });
  await browser.send("storage.setCookie", { cookie: { name: "chrysalis_session", value: { type: "string", value: cookie }, domain: "127.0.0.1", path: "/", httpOnly: true } });
  await browser.send("browsingContext.setViewport", { context: browser.top, viewport: { width: 1280, height: 860 } });
  await browser.send("browsingContext.navigate", { context: browser.top, url: `${base}/`, wait: "complete" });
  const appPath = `/app/${user}/${suite.app}/`;
  const page = createPage(browser, appPath, suite.ready, model);
  const opened = performance.now();
  // the shell's build card says what the first open is waiting on
  await page.open(600_000, (status) => console.log(`  ${Math.round((performance.now() - opened) / 1000)} s  ${status.slice(0, 100)}`));
  console.log(`first build and load: ${Math.round((performance.now() - opened) / 1000)} s\n`);

  const results: Array<{ scenario: string; metric: string; value: number; limit?: number; ok: boolean }> = [];
  for (const sc of suite.scenarios) {
    if (args.only && !sc.name.includes(args.only)) continue;
    let measured: Record<string, number>;
    if (args["profile-browser"] || args.events) console.log(`  ${sc.name} starts at ${Date.now()}`);
    try {
      measured = await sc.run(page);
    } catch (e) {
      failed = true;
      const shot = path.join(args.out ? path.dirname(path.resolve(args.out)) : home, `failed-${sc.name.replace(/\W+/g, "-")}.png`);
      await page.screenshot(shot).catch(() => undefined);
      console.log(`✗ ${sc.name}: ${(e as Error).message} (screenshot ${shot})`);
      results.push({ scenario: sc.name, metric: "error", value: 1, ok: false });
      continue;
    }
    const line: string[] = [];
    let ok = true;
    for (const [metric, value] of Object.entries(measured)) {
      const limit = sc.limits[metric];
      const pass = limit === undefined || value <= limit;
      if (!pass) ok = false;
      results.push({ scenario: sc.name, metric, value, ...(limit !== undefined ? { limit } : {}), ok: pass });
      line.push(`${metric} ${value}${limit !== undefined ? `/${limit}` : ""}${pass ? "" : " ✗"}`);
    }
    if (!ok) failed = true;
    console.log(`${ok ? "✓" : "✗"} ${sc.name}: ${line.join(", ")}`);
  }
  console.log(`memory peak: engine ${peak.engineMb} MB, browser ${peak.browserMb} MB`);
  if (args.out) fs.writeFileSync(args.out, JSON.stringify({ at: new Date().toISOString(), scale: Number(args.scale), peak, results }, null, 2));
  console.log(failed ? "\nover the limit: see ✗ above" : "\nall within limits");
  if (args.hold) {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      async fetch(req) {
        const body = await req.text();
        const shell = new URL(req.url).searchParams.has("shell");
        try {
          return Response.json(await (shell ? page.shell(body) : page.eval(body)));
        } catch (e) {
          return new Response(`${(e as Error).message}\n`, { status: 500 });
        }
      },
    });
    console.log(`holding: ${base} (cookie chrysalis_session=${cookie}); eval at http://127.0.0.1:${server.port}/eval`);
    await new Promise(() => {});
  }
} catch (e) {
  failed = true;
  console.error((e as Error).stack ?? e);
} finally {
  await cleanup();
}
process.exit(failed ? 1 : 0);
