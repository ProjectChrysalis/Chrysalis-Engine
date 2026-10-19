/**
 * Service apps: a program the engine runs beside itself and frames. Nothing
 * starts without an admin's approval of the exact program; the front port
 * passes only the owner's signed-in browser, hides the engine's session from
 * the program, and removes what would stop the shell framing the page.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { buildApp, pageFrameSrc, SESSION_COOKIE, sessionUserOf, type AppEnv } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import { defaultInstanceConfig, type InstanceConfig } from "../src/config.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";
import { validateAppManifest } from "../src/apps/manager.js";
import { ServiceManager, servicePorts } from "../src/apps/service.js";
import { chatCompletions, contextFor, parseChatRequest, textRequest } from "../src/openai-compat.js";
import { buildUserTools } from "../src/agent/tools.js";
import { AgentPolicy } from "../src/agent/policy.js";

const PROGRAM = `
import fs from "node:fs";
const port = Number(process.argv[2]);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    if (u.pathname === "/seen") return Response.json({ cookie: req.headers.get("cookie"), pid: process.pid, port, own: process.env.PORT, spare: process.env.SPARE, data: process.argv[3], secret: process.env.CHRYSALIS_SECRET ?? null, told: process.env.TOLD, models: process.env.MODELS, key: process.env.KEY });
    if (u.pathname === "/echo") return new Response(req.body);
    if (u.pathname === "/type") return new Response(req.headers.get("content-type"));
    if (u.pathname.endsWith(".js")) return new Response(fs.readFileSync("public" + u.pathname), { headers: { "content-type": "text/javascript", etag: "one" } });
    if (u.pathname === "/stream") {
      return new Response(new ReadableStream({
        async start(c) {
          c.enqueue(new TextEncoder().encode("data: one\\n\\n"));
          await Bun.sleep(200);
          c.enqueue(new TextEncoder().encode("data: two\\n\\n"));
          c.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    const headers = new Headers({
      "content-type": "text/html",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    });
    headers.append("set-cookie", "own=1; Path=/");
    headers.append("set-cookie", "${SESSION_COOKIE}=taken; Path=/");
    return new Response(fs.readFileSync("public/index.html"), { headers });
  },
  websocket: { message(ws, m) { ws.send("echo:" + m); } },
});
`;

let dataDir: string;
let app: Hono<AppEnv>;
let services: ServiceManager;
let sessions: SessionService;
let config: InstanceConfig;
let adminToken: string;
let userToken: string;
let appDir: string;

const manifest = (service: Record<string, unknown>) => ({ name: "Side", version: "1.0.0", kind: "service", service });
const SERVICE = {
  command: ["bun", "main.js", "{port}", "{data}"],
  cwd: "server",
  env: { TOLD: "port {port}", MODELS: "{models}", KEY: "{models_key}", SPARE: "{port2}" },
  ready: "/seen",
  reloadOn: ["public"],
  restartOn: ["main.js"],
};

function install(user: string, service: Record<string, unknown> = SERVICE): string {
  const dir = path.join(userPaths(dataDir, user).apps, "side");
  fs.mkdirSync(path.join(dir, "server", "public"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest(service)));
  fs.writeFileSync(path.join(dir, "server", "main.js"), PROGRAM);
  fs.writeFileSync(path.join(dir, "server", "public", "index.html"), "<h1>side</h1>");
  return dir;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-app-"));
  const users = new UserService(dataDir);
  adminToken = users.create("admin", "admin", { password: "admin-pass-1" }).token;
  userToken = users.create("alice", "user", { password: "test-pass-1" }).token;
  bootstrapUserDir(dataDir, "admin");
  bootstrapUserDir(dataDir, "alice");
  sessions = new SessionService(dataDir);
  // a port range of its own, so parallel test files never meet
  config = { ...defaultInstanceConfig(), port: 21000 + Math.floor(Math.random() * 20000) };
  process.env.CHRYSALIS_SECRET = "engine-only";
  services = new ServiceManager({ config, sessionUser: sessionUserOf(sessions, users), sessionCookie: SESSION_COOKIE });
  app = buildApp({ users, sessions, config, dataDir, bus: new EventBus(), services });
  appDir = install("admin");
});
afterEach(async () => {
  await services.stopAll();
  delete process.env.CHRYSALIS_SECRET;
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
});

const h = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const status = async (token = adminToken) =>
  (await (await app.request("/v1/apps/side/service", { headers: h(token) })).json()) as {
    state: string; port: number | null; rev: number; approved: boolean; canApprove: boolean; error: string | null; log: string[];
  };
const act = (action: string, token = adminToken) => app.request(`/v1/apps/side/service/${action}`, { method: "POST", headers: h(token) });
async function until(state: string): Promise<Awaited<ReturnType<typeof status>>> {
  for (let i = 0; i < 200; i++) {
    const s = await status();
    if (s.state === state) return s;
    if (state === "running" && s.state === "failed") throw new Error(`failed: ${s.error}\n${s.log.join("\n")}`);
    await Bun.sleep(50);
  }
  throw new Error(`never reached ${state}`);
}
const cookie = () => `${SESSION_COOKIE}=${sessions.create("admin")}; theirs=kept`;
const front = (port: number, p: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { cookie: cookie(), ...(init.headers as Record<string, string> | undefined) } });

describe("service app manifest", () => {
  it("needs a program, and keeps its folder inside the app", () => {
    expect(validateAppManifest(manifest(SERVICE))?.service?.command).toEqual(SERVICE.command);
    expect(validateAppManifest({ name: "Side", version: "1", kind: "service" })).toBeNull();
    expect(validateAppManifest(manifest({ command: [] }))).toBeNull();
    expect(validateAppManifest(manifest({ command: ["bun", "x.js"], cwd: "../elsewhere" }))).toBeNull();
    expect(validateAppManifest(manifest({ command: ["bun", "x.js"], cwd: "/etc" }))).toBeNull();
    expect(validateAppManifest(manifest({ command: ["bun", "x.js"], restartOn: ["../x"] }))).toBeNull();
    expect(validateAppManifest(manifest({ command: ["bun", "x.js"], patchOn: ["../x"] }))).toBeNull();
    // the block means nothing on any other kind
    expect(validateAppManifest({ name: "Web", version: "1", kind: "web", service: SERVICE })?.service).toBeUndefined();
  });

  it("the shell may frame the service ports on the name it was opened by, and nothing else", () => {
    const src = pageFrameSrc("box.local:8787", false, { ...config, port: 8787 });
    expect(src.split(" ")).toEqual(["'self'", ...servicePorts({ ...config, port: 8787 }).map((p) => `http://box.local:${p}`)]);
    expect(pageFrameSrc("evil.example/ x", false, config)).toBe("'self'");
  });
});

describe("service app", () => {
  it("runs nothing until an admin allows the program", async () => {
    let s = await status();
    expect(s).toMatchObject({ state: "stopped", approved: false, canApprove: true, port: null });
    expect((await act("start")).status).toBe(403);
    expect((await status()).state).toBe("stopped");

    // someone else's account cannot allow it, for themselves or anyone
    install("alice");
    expect((await act("approve", userToken)).status).toBe(403);
    expect((await status(userToken)).approved).toBe(false);

    const allowed = await act("approve");
    expect(allowed.status).toBe(200);
    // the reply the pane swaps in is as complete as the one it polls
    expect((await allowed.json()) as object).toMatchObject({ approved: true, canApprove: true, command: SERVICE.command, cwd: "server", setup: null });
    s = await until("running");
    expect(s.approved).toBe(true);
    expect(servicePorts(config)).toContain(s.port!);
  });

  it("the front port passes the owner's browser only and forwards the program as is", async () => {
    await act("approve");
    const { port } = await until("running");

    // no session, or another account's: nothing of the program is reachable
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(401);
    const alice = `${SESSION_COOKIE}=${sessions.create("alice")}`;
    expect((await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: alice } })).status).toBe(401);

    const page = await front(port!, "/");
    // the one thing added to a page: the script that follows file changes
    expect(await page.text()).toBe('<h1>side</h1><script src="/__chrysalis/ready.js"></script><script src="/__chrysalis/live.js"></script>');
    // what stops a page being framed is gone; the rest of its policy stays
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect(page.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(page.headers.get("content-security-policy")).toBe("default-src 'self'");
    // the program keeps its own cookies and cannot plant the engine's
    expect(page.headers.getSetCookie()).toEqual(["own=1; Path=/"]);

    const seen = (await (await front(port!, "/seen")).json()) as { cookie: string; data: string; secret: string | null; told: string; port: number; own: string; spare: string };
    expect(seen.cookie).toBe("theirs=kept");
    expect(seen.data).toBe(path.join(appDir, "data"));
    expect(seen.secret).toBeNull();
    expect(seen.told).toMatch(/^port \d+$/);
    // the port is also in PORT, and a second free one is there for the asking
    expect(seen.own).toBe(String(seen.port));
    expect(Number(seen.spare)).toBeGreaterThan(0);
    expect(seen.spare).not.toBe(seen.own);

    const echoed = await front(port!, "/echo", { method: "POST", body: "x".repeat(200_000) });
    expect((await echoed.text()).length).toBe(200_000);
  });

  it("streams arrive as they are written, and sockets pass both ways", async () => {
    await act("approve");
    const { port } = await until("running");

    const res = await front(port!, "/stream");
    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstAt = Date.now();
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n");
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toBe("data: two\n\n");
    // the first event was not held back until the stream ended
    expect(Date.now() - firstAt).toBeGreaterThan(100);

    const ws = new (WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket)(
      `ws://127.0.0.1:${port}/ws`, { headers: { cookie: cookie() } },
    );
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send("hi");
      ws.onmessage = (ev) => resolve(String(ev.data));
      ws.onerror = () => reject(new Error("socket failed"));
    });
    ws.close();
    expect(reply).toBe("echo:hi");
  });

  it("a page file changing reloads the page; a program file changing restarts the program", async () => {
    await act("approve");
    const up = await until("running");
    const pidOf = async () => ((await (await front(up.port!, "/seen")).json()) as { pid: number }).pid;
    const pid = await pidOf();

    services.filesChanged("admin", "side", ["server/public/index.html"]);
    expect((await status()).rev).toBe(up.rev + 1);
    expect(await pidOf()).toBe(pid);
    // a file neither list names changes nothing
    services.filesChanged("admin", "side", ["server/notes.txt", "data/x.json"]);
    expect((await status()).rev).toBe(up.rev + 1);

    // an open page that listens is told which files, and decides itself
    const live = await front(up.port!, "/__chrysalis/live");
    const reader = live.body!.getReader();
    const next = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await next()).toBe(": ok\n\n");
    services.filesChanged("admin", "side", ["server/public/look.css"]);
    expect(await next()).toBe('data: {"type":"change","paths":["server/public/look.css"]}\n\n');
    expect((await status()).rev).toBe(up.rev + 1);
    // a save through a second file that is gone again names only the file that stayed
    services.filesChanged("admin", "side", ["server/public/index.html.1234.tmp", "server/public/index.html"]);
    expect(await next()).toBe('data: {"type":"change","paths":["server/public/index.html"]}\n\n');
    await reader.cancel();
    expect(await (await front(up.port!, "/__chrysalis/live.js")).text()).toContain("EventSource");

    services.filesChanged("admin", "side", ["server/main.js"]);
    for (let i = 0; i < 200 && (await status()).rev < up.rev + 2; i++) await Bun.sleep(50);
    const again = await until("running");
    expect(again.port).toBe(up.port);
    expect(await pidOf()).not.toBe(pid);
  });

  it("a function changed in a script the page loads is swapped in the open page", async () => {
    const dir = install("admin", { ...SERVICE, reloadOn: undefined, patchOn: ["public"] });
    const file = path.join(dir, "server", "public", "app.js");
    const first = 'let n = 0;\nexport const made = [];\nexport function add(f) { made.push(f); }\nadd(() => "one " + ++n);\n';
    fs.writeFileSync(file, first);
    await act("approve");
    const { port } = await until("running");
    const liveScript = await (await front(port!, "/__chrysalis/live.js")).text();
    expect(await (await front(port!, "/")).text()).toContain("/__chrysalis/live.js");
    expect(() => new Function(liveScript)).not.toThrow();

    // asked for as anything but a script, the file is passed as it is
    expect(await (await front(port!, "/app.js")).text()).toBe(first);
    const res = await front(port!, "/app.js", { headers: { "sec-fetch-dest": "script", "if-none-match": "one" } });
    const loaded = await res.text();
    // the browser keeps its copy and asks each time; the program's own word on that is not passed on
    const tag = res.headers.get("etag")!;
    expect(tag).not.toBe("one");
    expect((await front(port!, "/app.js", { headers: { "sec-fetch-dest": "script", "if-none-match": tag } })).status).toBe(304);
    expect(loaded.split("\n").length).toBe(first.split("\n").length);

    // run as a page runs it: what was handed out before the save is what runs the newer body
    const table = globalThis as unknown as { __cH?: { s: Record<string, string>; f: Record<string, string> } };
    try {
      fs.writeFileSync(path.join(dataDir, "loaded.mjs"), loaded);
      const page = (await import(path.join(dataDir, "loaded.mjs"))) as { made: (() => string)[] };
      expect(page.made[0]!()).toBe("one 1");
      fs.writeFileSync(file, first.replace('"one "', '"two "'));
      const got = (await (await front(port!, "/app.js", { headers: { "x-chrysalis-hot": table.__cH!.f["/app.js"]! } })).json()) as { key: string; patches: Record<string, string> };
      expect(Object.keys(got.patches)).toHaveLength(1);
      Object.assign(table.__cH!.s, got.patches);
      expect(page.made[0]!()).toBe("two 2");

      // half-written: nothing to do yet. Changed outside every function: the page loads again
      fs.writeFileSync(file, first.replace("++n);", "++n;"));
      expect(await (await front(port!, "/app.js", { headers: { "x-chrysalis-hot": got.key } })).json()).toEqual({ wait: true });
      fs.writeFileSync(file, `${first}add(() => "three");\n`);
      expect(await (await front(port!, "/app.js", { headers: { "x-chrysalis-hot": got.key } })).json()).toEqual({ reload: true });
      expect(await (await front(port!, "/app.js", { headers: { "x-chrysalis-hot": "never-loaded" } })).json()).toEqual({ reload: true });
    } finally {
      delete table.__cH;
    }

    // an open page hears of the save by the file's path
    const watch = await front(port!, "/__chrysalis/live");
    const reader = watch.body!.getReader();
    await reader.read();
    services.filesChanged("admin", "side", ["server/public/app.js"]);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"paths":["server/public/app.js"]');
    await reader.cancel();
  });

  it("the first page says the port was reached and whether the sign-in came with it", async () => {
    await act("approve");
    const { port } = await until("running");
    const signed = await (await front(port!, "/__chrysalis/open")).text();
    expect(signed).toContain('signedIn:true');
    expect(signed).toContain('location.replace("/")');
    const anon = await (await fetch(`http://127.0.0.1:${port}/__chrysalis/open`)).text();
    expect(anon).toContain("signedIn:false");
    expect(anon).not.toContain("location.replace");
    // nothing else of the engine's own paths answers without the sign-in
    expect((await fetch(`http://127.0.0.1:${port}/__chrysalis/live`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/__chrysalis/ready.js`)).status).toBe(401);
  });

  it("a loaded page answers readiness probes after the startup message was missed", async () => {
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify(manifest({ ...SERVICE, reloadOn: [], restartOn: [] })));
    await act("approve");
    const { port } = await until("running");
    const html = await (await front(port!, "/")).text();
    expect(html).toContain('/__chrysalis/ready.js');
    expect(html).not.toContain('/__chrysalis/live.js');
    const script = await (await front(port!, "/__chrysalis/ready.js")).text();
    const reports: unknown[] = [];
    const parent = { postMessage: (message: unknown) => reports.push(message) };
    let listener: ((event: { source: unknown; data: unknown }) => void) | undefined;
    new Function("parent", "addEventListener", script)(parent, (_name: string, handler: typeof listener) => { listener = handler; });
    expect(reports).toEqual([{ chrysalisService: "open" }]);
    reports.length = 0;
    listener!({ source: {}, data: { chrysalisService: "probe" } });
    listener!({ source: parent, data: null });
    expect(reports).toEqual([]);
    listener!({ source: parent, data: { chrysalisService: "probe" } });
    listener!({ source: parent, data: { chrysalisService: "probe" } });
    expect(reports).toEqual([{ chrysalisService: "open" }, { chrysalisService: "open" }]);
  });

  it("the program is handed a key that opens the model routes and nothing else", async () => {
    await act("approve");
    const { port } = await until("running");
    const seen = (await (await front(port!, "/seen")).json()) as { models: string; key: string };
    expect(seen.models).toBe(`http://127.0.0.1:${config.port}/v1/openai`);
    expect(seen.key).toMatch(/^csk_[0-9a-f]{48}$/);
    const byKey = { authorization: `Bearer ${seen.key}`, "content-type": "application/json" };

    const list = await app.request("/v1/openai/models", { headers: byKey });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { data: { id: string }[] }).data[0]?.id).toBe("default");
    expect((await app.request("/v1/apps", { headers: byKey })).status).toBe(401);
    expect((await app.request("/v1/openai/models", { headers: { authorization: "Bearer csk_nope" } })).status).toBe(401);

    const bad = await app.request("/v1/openai/chat/completions", { method: "POST", headers: byKey, body: JSON.stringify({ messages: [] }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toContain("messages");

    // the key is kept across a restart, and dies with the app
    await act("restart");
    await until("running");
    expect(((await (await front(port!, "/seen")).json()) as { key: string }).key).toBe(seen.key);
    await app.request("/v1/apps/side", { method: "DELETE", headers: h(adminToken) });
    expect((await app.request("/v1/openai/models", { headers: byKey })).status).toBe(401);
  });

  it("a chat request in the common shape becomes a turn: images, tools and tool results included", () => {
    const req = parseChatRequest({
      model: "default",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "look", arguments: "{\"zoom\":2}" } }] },
        { role: "tool", tool_call_id: "c1", content: "a cat" },
        { role: "system", content: "stay in character" },
      ],
      tools: [{ type: "function", function: { name: "look", description: "Look closer", parameters: { type: "object", properties: { zoom: { type: "number" } } } } }],
      tool_choice: "required",
      temperature: 0.7, max_tokens: 300, top_p: 0.9, reasoning_effort: "high", stream: true,
    });
    if ("error" in req) throw new Error(req.error);
    expect(req).toMatchObject({ model: null, stream: true, temperature: 0.7, maxTokens: 300, params: { top_p: 0.9 }, reasoning: "high", toolChoice: "required" });

    const built = contextFor(req, { api: "anthropic-messages", provider: "p", id: "m" });
    expect(built.toolChoice).toEqual({ type: "any" });
    expect(built.context.systemPrompt).toBe("be brief");
    expect(built.context.tools?.map((t) => t.name)).toEqual(["look"]);
    const [user, assistant, result, late] = built.context.messages;
    expect(user).toMatchObject({ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", mimeType: "image/png", data: "AAAA" }] });
    expect(assistant).toMatchObject({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "look", arguments: { zoom: 2 } }], stopReason: "toolUse", provider: "p", model: "m" });
    expect(result).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "look", content: [{ type: "text", text: "a cat" }] });
    // a system entry further down keeps its place and speaks as the user
    expect(late).toMatchObject({ role: "user", content: "stay in character" });
    expect(contextFor(req, { api: "openai-completions", provider: "p", id: "m" }).toolChoice).toBe("required");

    // a connection that only takes text gets the words and nothing else
    expect(textRequest(req).messages.map((m) => `${m.role}:${m.content}`)).toEqual(["system:be brief", "user:what is this", "assistant:", "user:a cat", "system:stay in character"]);

    expect(parseChatRequest({ messages: [{ role: "wizard", content: "hi" }] })).toHaveProperty("error");
    // a link would have the engine fetch an address the caller picked
    expect(parseChatRequest({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://169.254.169.254/x.png" } }] }] })).toHaveProperty("error");
  });

  it("a tool call comes back to the caller, streamed or not", async () => {
    const usage = { input: 5, output: 7, cacheRead: 1, cacheWrite: 0 };
    const call = { type: "toolCall", id: "c9", name: "roll", arguments: { sides: 6 } };
    const models = {
      turn: async () => ({
        model: { provider: "p", id: "m", api: "openai-completions" },
        stream: (async function* () {
          yield { type: "thinking_delta", delta: "hm" };
          yield { type: "text_delta", delta: "Rolling" };
          yield { type: "toolcall_end", toolCall: call };
          yield { type: "done", reason: "toolUse", message: { usage } };
        })(),
      }),
    } as unknown as Parameters<typeof chatCompletions>[0];
    const body = { messages: [{ role: "user", content: "roll" }], tools: [{ type: "function", function: { name: "roll" } }] };
    const signal = new AbortController().signal;

    const plain = (await (await chatCompletions(models, body, signal, "test")).json()) as { choices: { message: Record<string, unknown>; finish_reason: string }[]; usage: unknown; model: string };
    expect(plain.model).toBe("p/m");
    expect(plain.choices[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: "Rolling", reasoning_content: "hm", tool_calls: [{ id: "c9", type: "function", function: { name: "roll", arguments: "{\"sides\":6}" } }] },
      finish_reason: "tool_calls",
    } as never);
    expect(plain.usage).toEqual({ prompt_tokens: 6, completion_tokens: 7, total_tokens: 13 });

    const streamed = await chatCompletions(models, { ...body, stream: true, stream_options: { include_usage: true } }, signal, "test");
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const events = (await streamed.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e) as { choices: { delta: Record<string, unknown>; finish_reason: string | null }[]; usage?: unknown });
    expect(chunks.map((c) => c.choices[0]?.delta)).toEqual([
      { role: "assistant", content: "" },
      { reasoning_content: "hm" },
      { content: "Rolling" },
      { tool_calls: [{ index: 0, id: "c9", type: "function", function: { name: "roll", arguments: "{\"sides\":6}" } }] },
      {},
      undefined,
    ]);
    expect(chunks.at(-2)?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 6, completion_tokens: 7, total_tokens: 13 });
  });

  it("an edited program is no longer the one that was allowed", async () => {
    await act("approve");
    const { port } = await until("running");
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify(manifest({ ...SERVICE, command: ["bun", "other.js", "{port}"] })));
    const s = await status();
    expect(s).toMatchObject({ approved: false, state: "stopped" });
    expect(await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: cookie() } }).then((r) => r.status, () => 0)).not.toBe(200);
    expect((await act("start")).status).toBe(403);
    // the lists that only steer reloads are not part of what was allowed
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify(manifest({ ...SERVICE, reloadOn: ["public", "extra"] })));
    expect((await status()).approved).toBe(true);

    // an admin who chose not to be asked again is not, whatever the program becomes
    await app.request("/v1/apps/side/service/approve", { method: "POST", headers: h(adminToken), body: JSON.stringify({ always: true }) });
    await until("running");
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify(manifest({ ...SERVICE, env: { TOLD: "something else" } })));
    expect(await status()).toMatchObject({ approved: true, state: "running" });
    // taking it back is one call
    await act("revoke");
    expect(await status()).toMatchObject({ approved: false, state: "stopped" });
  });

  it("an engine that comes back stops the copy its predecessor left running", async () => {
    await act("approve");
    const { port } = await until("running");
    const pid = ((await (await front(port!, "/seen")).json()) as { pid: number }).pid;

    // a second engine over the same data, as after a restart that stopped nothing
    const users = new UserService(dataDir);
    const next = new ServiceManager({ config: { ...config, port: config.port + 20 }, sessionUser: sessionUserOf(sessions, users), sessionCookie: SESSION_COOKIE });
    try {
      next.start({
        username: "admin", appId: "side", appDir, spec: validateAppManifest(manifest(SERVICE))!.service!,
        approvalsFile: path.join(path.dirname(userPaths(dataDir, "admin").auth), "services-approved.json"),
      });
      for (let i = 0; i < 200 && next.status("admin", "side").state !== "running"; i++) await Bun.sleep(50);
      expect(next.status("admin", "side").state).toBe("running");
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await next.stopAll();
    }
  });

  it("setup runs again when a file it works from changed, and not otherwise", async () => {
    const spec = { ...SERVICE, setup: ["bun", "setup.js"], setupOn: ["needs.txt"] };
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify(manifest(spec)));
    fs.writeFileSync(path.join(appDir, "server", "setup.js"), 'require("node:fs").appendFileSync("ran.txt", "x");');
    fs.writeFileSync(path.join(appDir, "server", "needs.txt"), "one");
    const ran = () => fs.readFileSync(path.join(appDir, "server", "ran.txt"), "utf8");
    const restarted = async () => {
      const { rev } = await status();
      await act("restart");
      for (let i = 0; i < 200 && (await status()).rev === rev; i++) await Bun.sleep(50);
      await until("running");
    };
    await act("approve");
    await until("running");
    expect(ran()).toBe("x");
    await restarted();
    expect(ran()).toBe("x");
    fs.writeFileSync(path.join(appDir, "server", "needs.txt"), "two");
    await restarted();
    expect(ran()).toBe("xx");
    // packages it installed that are gone bring it back too
    fs.writeFileSync(path.join(appDir, "server", "package.json"), "{}");
    await restarted();
    expect(ran()).toBe("xxx");
    fs.mkdirSync(path.join(appDir, "server", "node_modules"));
    await restarted();
    expect(ran()).toBe("xxx");
    expect(validateAppManifest(manifest({ ...SERVICE, setupOn: ["../x"] }))).toBeNull();
  });

  it("setup that failed after leaving packages behind runs again", async () => {
    const spec = { ...SERVICE, setup: ["bun", "setup.js"] };
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify(manifest(spec)));
    fs.writeFileSync(
      path.join(appDir, "server", "setup.js"),
      `const fs = require("node:fs");
if (fs.existsSync("tried")) fs.appendFileSync("ran.txt", "x");
else { fs.mkdirSync("node_modules"); fs.writeFileSync("tried", ""); process.exit(1); }`,
    );
    await act("approve");
    expect((await until("failed")).error).toMatch(/setup ended with code 1/);
    await act("start");
    await until("running");
    expect(fs.readFileSync(path.join(appDir, "server", "ran.txt"), "utf8")).toBe("x");
  });

  it("a stop asked for during setup ends the setup instead of waiting for it", async () => {
    const spec = { ...SERVICE, setup: ["bun", "setup.js"] };
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify(manifest(spec)));
    fs.writeFileSync(path.join(appDir, "server", "setup.js"), "await Bun.sleep(60_000);");
    await act("approve");
    await until("installing");
    const asked = Date.now();
    await act("stop");
    expect((await until("stopped")).state).toBe("stopped");
    expect(Date.now() - asked).toBeLessThan(10_000);
  });

  it("the agent's tool calls the program itself, keeps its cookies and can load open pages again", async () => {
    const p = userPaths(dataDir, "admin");
    const reach = {
      request: (id: string, call: Parameters<ServiceManager["request"]>[2], signal?: AbortSignal) => services.request("admin", id, call, signal),
      reload: (id: string) => services.reloadPages("admin", id),
    };
    const tool = buildUserTools("admin", p, { dataDir: p.root, service: reach }).find((t) => t.name === "app_request")!;
    const call = async (params: Record<string, unknown>) => {
      const res = await tool.execute("call", { id: "side", ...params });
      return (res.content[0] as { text: string }).text;
    };
    await expect(call({ route: "/seen" })).rejects.toThrow("not running");
    await act("approve");
    const up = await until("running");

    expect(await call({ route: "/" })).toContain("<h1>side</h1>");
    // the cookie that page set comes back on the next call
    const seen = await call({ route: "/seen" });
    expect(seen).toStartWith("HTTP 200");
    expect(JSON.parse(seen.slice(seen.indexOf("{"))).cookie).toContain("own=1");
    expect(await call({ route: "/echo", json: { a: 1 } })).toEndWith('{"a":1}');
    fs.writeFileSync(path.join(p.root, "card.txt"), "from the workspace");
    const sent = await call({ route: "/echo", form: { name: "n" }, files: { file: "card.txt" } });
    expect(sent).toContain("from the workspace");
    expect(sent).toContain('filename="card.txt"');
    expect(await call({ route: "/type", form: { name: "n" } })).toMatch(/multipart\/form-data; boundary=\S+$/);
    // a body too long to write out in a call is sent from a file
    fs.writeFileSync(path.join(p.root, "whole.json"), '{"big":true}');
    expect(await call({ route: "/echo", body_file: "whole.json" })).toEndWith('{"big":true}');
    expect(await call({ route: "/type", body_file: "whole.json" })).toEndWith("application/json");
    await expect(call({ route: "/echo", body_file: "none.json" })).rejects.toThrow("File not found");
    await expect(call({ route: "/echo", body_file: "whole.json", json: 1 })).rejects.toThrow("only one");
    await expect(call({ route: "//elsewhere.example/x" })).rejects.toThrow("inside the app");
    await expect(call({ route: "/echo", json: 1, body: "1" })).rejects.toThrow("only one");

    // with no page listening the shell loads the frame again; a listening page is told
    await call({ route: "/echo", body: "x", reload: true });
    expect((await status()).rev).toBe(up.rev + 1);
    const live = await front(up.port!, "/__chrysalis/live");
    const reader = live.body!.getReader();
    await reader.read();
    await call({ route: "/echo", body: "x", reload: true });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {"type":"reload"}\n\n');
    expect((await status()).rev).toBe(up.rev + 1);
    await reader.cancel();

    // looking is free in every mode; plan mode changes nothing
    const plan = new AgentPolicy(p.root, "s", "plan", () => "side");
    await plan.check("app_request", { id: "side", route: "/seen" });
    await expect(plan.check("app_request", { id: "side", route: "/echo", json: {} })).rejects.toThrow("Plan mode");
    await expect(plan.check("app_request", { id: "side", route: "/echo", body_file: "whole.json" })).rejects.toThrow("Plan mode");
    const reader2 = buildUserTools("admin", p, { dataDir: p.root, service: reach, mode: "plan" }).find((t) => t.name === "app_request")!;
    await expect(reader2.execute("call", { id: "side", route: "/echo", method: "post" })).rejects.toThrow("Plan mode");
  });

  it("stopping, a program that dies at once, and deleting the app", async () => {
    await act("approve");
    await until("running");
    expect((await act("stop")).status).toBe(200);
    expect((await status()).state).toBe("stopped");

    fs.writeFileSync(path.join(appDir, "server", "main.js"), "console.error('cannot go on'); process.exit(3);");
    await act("start");
    const failed = await until("failed");
    expect(failed.error).toContain("code 3");
    expect(failed.log.join("\n")).toContain("cannot go on");

    fs.writeFileSync(path.join(appDir, "server", "main.js"), PROGRAM);
    await act("restart");
    const { port } = await until("running");
    expect((await app.request("/v1/apps/side", { method: "DELETE", headers: h(adminToken) })).status).toBe(200);
    expect(fs.existsSync(appDir)).toBe(false);
    expect(await fetch(`http://127.0.0.1:${port}/seen`, { headers: { cookie: cookie() } }).then((r) => r.status, () => 0)).not.toBe(200);
  });
});
