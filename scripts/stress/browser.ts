/** Headless Firefox driven over WebDriver BiDi. */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type Json = Record<string, unknown>;

const PREFS = [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.reporting.enabled", false);',
  'user_pref("browser.aboutwelcome.enabled", false);',
];

export class Browser {
  private ws!: WebSocket;
  private seq = 0;
  private waiting = new Map<number, (m: Json) => void>();
  proc!: ChildProcess;
  top = "";

  static async launch(opts: { profileDir: string; port: number; headed: boolean; profileTo?: string }): Promise<Browser> {
    const b = new Browser();
    fs.mkdirSync(opts.profileDir, { recursive: true });
    fs.writeFileSync(path.join(opts.profileDir, "user.js"), PREFS.join("\n") + "\n");
    const bin = process.env.STRESS_FIREFOX || "firefox";
    const args = ["--no-remote", "--profile", opts.profileDir, `--remote-debugging-port=${opts.port}`, "about:blank"];
    if (!opts.headed) args.unshift("--headless");
    // the Gecko profiler records from startup and writes when the browser closes
    const env = opts.profileTo
      ? { ...process.env, MOZ_PROFILER_STARTUP: "1", MOZ_PROFILER_SHUTDOWN: opts.profileTo, MOZ_PROFILER_STARTUP_ENTRIES: "16777216", MOZ_PROFILER_STARTUP_FEATURES: "js,stackwalk,cpu" }
      : process.env;
    b.proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], env });
    let log = "";
    b.proc.stderr?.on("data", (d: Buffer) => { log += d.toString(); });
    for (let i = 0; i < 300 && !log.includes("WebDriver BiDi listening"); i++) await Bun.sleep(100);
    if (!log.includes("WebDriver BiDi listening")) throw new Error(`Firefox did not start:\n${log.slice(-2000)}`);
    b.ws = new WebSocket(`ws://127.0.0.1:${opts.port}/session`);
    b.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Json & { id?: number };
      if (m.id !== undefined) {
        b.waiting.get(m.id)?.(m);
        b.waiting.delete(m.id);
      }
    };
    await new Promise((r, j) => {
      b.ws.onopen = r;
      b.ws.onerror = j;
    });
    await b.send("session.new", { capabilities: {} });
    const tree = (await b.send("browsingContext.getTree", {})) as { contexts: Array<{ context: string }> };
    b.top = tree.contexts[0]!.context;
    return b;
  }

  send(method: string, params: Json): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.waiting.set(id, (m) => {
        if (m.type === "error") reject(new Error(`${method}: ${String(m.error)} ${String(m.message)}`));
        else resolve(m.result as Json);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** The browsing context whose URL contains `part` (frames included). */
  async frame(part: string): Promise<string | null> {
    return (await this.contexts()).find((c) => c.url.includes(part))?.context ?? null;
  }

  /** Every browsing context, frames included, depth first. */
  async contexts(): Promise<Array<{ context: string; url: string }>> {
    type Ctx = { context: string; url: string; children?: Ctx[] };
    const tree = (await this.send("browsingContext.getTree", {})) as { contexts: Ctx[] };
    const out: Array<{ context: string; url: string }> = [];
    const walk = (cs: Ctx[]) => {
      for (const c of cs) {
        out.push({ context: c.context, url: c.url });
        walk(c.children ?? []);
      }
    };
    walk(tree.contexts);
    return out;
  }

  /** Evaluate a function body in `context`; a thrown error comes back as an exception. */
  async run<T>(context: string, body: string): Promise<T> {
    const r = (await this.send("script.evaluate", {
      expression: `(async () => { ${body} })().then((v) => JSON.stringify(v === undefined ? null : v))`,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    })) as { type: string; result?: { value?: string }; exceptionDetails?: { text?: string } };
    if (r.type === "exception") throw new Error(`in page: ${r.exceptionDetails?.text ?? "exception"}`);
    return JSON.parse(r.result?.value ?? "null") as T;
  }

  /** Quit cleanly (so a startup profile gets written), killing it if that stalls. */
  async close(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise((r) => this.proc.once("exit", r));
    this.send("browser.close", {}).catch(() => undefined);
    if (await Promise.race([exited.then(() => true), Bun.sleep(30_000).then(() => false)])) return;
    this.proc.kill();
    await exited;
  }
}
