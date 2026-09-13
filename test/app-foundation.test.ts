/**
 * App foundation tests: package shelf (specifier parsing, hash-locked cache,
 * offline policy, import maps),
 * @credential: MCP env resolution, and the /app/<id> page + routes over HTTP.
 */
import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppEnv } from "../src/server/app.js";
import type { Hono } from "hono";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir } from "../src/paths.js";
import { installNotesApp } from "./fixtures/notes-app.js";
import { resolveMcpEnv } from "../src/mcp/registry.js";




describe("MCP @credential: env resolution", () => {
  it("passes plain values through; resolves credential refs; missing → empty", () => {
    const creds = { exa: { type: "api_key", key: "sk-exa" }, dead: { type: "api_key" } };
    const env = resolveMcpEnv({ EXA_API_KEY: "@credential:exa", NOPE: "@credential:missing", DEBUG: "1" }, () => creds);
    expect(env).toEqual({ EXA_API_KEY: "sk-exa", NOPE: "", DEBUG: "1" });
    expect(resolveMcpEnv(undefined, () => ({}))).toBeUndefined();
  });
});

describe("app foundation over HTTP", () => {
  let dataDir: string;
  let token: string;
  let app: Hono<AppEnv>;
  let bus: EventBus;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "appf-"));
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    token = users.create("alice", "user", { password: "test-pass-1" }).token;
    bootstrapUserDir(dataDir, "alice");
    installNotesApp(path.join(dataDir, "users", "alice", "apps"));
    bus = new EventBus();
    app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus });
  });

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
});

  const h = () => ({ authorization: `Bearer ${token}` });

  it("app frames are cookieless and sandboxed: fallback page, bridge, PWA manifest, opaque CSP", async () => {
    // legacy path redirects to the user-scoped frame surface
    const legacy = await app.request("/app/notes/", { headers: h() });
    expect(legacy.status).toBe(302);
    expect(legacy.headers.get("location")).toBe("/app/alice/notes/");
    // the frame surface needs NO auth (the sandboxed frame sends no cookies)
    const res = await app.request("/app/alice/notes/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("has not been built yet");
    expect(html).toContain("app-bridge.js");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors http://localhost");
    // response-level sandbox: the document is opaque-origin even if the URL is
    // opened top-level (bookmark, PWA window, popup), so it can never read
    // shell storage or spend the session cookie on engine routes
    expect(csp).toContain("sandbox allow-scripts allow-popups allow-downloads allow-forms");
    expect(csp).not.toContain("allow-same-origin");
    // WebRTC is blocked through the platform header (Chromium enforces it
    // from Chrome 152; the CSP directive above is ignored there)
    expect(res.headers.get("connection-allowlist")).toContain("webrtc=block");
    expect(res.headers.get("connection-allowlist")).toContain("response-origin");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // a frame path for another user is just as public, but unknown apps 404
    expect((await app.request("/app/bob/notes/")).status).toBe(404);
    const wm = await app.request("/app/alice/notes/manifest.webmanifest", { headers: h() });
    expect(wm.status).toBe(200);
    const manifest = (await wm.json()) as { start_url: string; display: string };
    expect(manifest.start_url).toBe("/app/alice/notes/");
    expect(manifest.display).toBe("standalone");
  });

  it("plugin text responses cannot become active pages on the engine origin", async () => {
    const appDir = path.join(dataDir, "users", "alice", "apps", "evil");
    fs.mkdirSync(path.join(appDir, "plugins", "pages"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify({ name: "Evil", version: "1", kind: "app" }));
    fs.writeFileSync(path.join(appDir, "plugins", "pages", "manifest.json"), JSON.stringify({ name: "Pages", version: "1", permissions: ["routes"] }));
    fs.writeFileSync(
      path.join(appDir, "plugins", "pages", "plugin.js"),
      `export function handleRoute(req) {
        if (req.path === "/html") return { status: 200, text: "<script>fetch('/v1/me')</script>", contentType: "text/html" };
        if (req.path === "/svg") return { status: 200, text: "<svg onload=\\"alert(1)\\"></svg>", contentType: "image/svg+xml" };
        if (req.path === "/plain") return { status: 200, text: "hello" };
        if (req.path === "/padded") return { status: 200, text: "<script>fetch('/v1/me')</script>", contentType: " text/html" };
        if (req.path === "/feed") return { status: 200, text: "<x><script xmlns='http://www.w3.org/1999/xhtml'>1</script></x>", contentType: "application/rss+xml" };
        return null;
      }`,
    );
    const html = await app.request("/v1/apps/evil/html", { headers: h() });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    // a navigable active response is opaque-origin with scripts off
    const csp = html.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox");
    expect(csp).not.toContain("allow-scripts");
    expect((await app.request("/v1/apps/evil/svg", { headers: h() })).headers.get("content-security-policy")).toContain("sandbox");
    // a plain text response gets an explicit non-active type, never a sniffable body
    const plain = await app.request("/v1/apps/evil/plain", { headers: h() });
    expect(plain.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    // a type the browser renders as a document however it is spelled: leading
    // whitespace (dropped on the wire) and any +xml type
    for (const route of ["/padded", "/feed"]) {
      const res = await app.request(`/v1/apps/evil${route}`, { headers: h() });
      const policy = res.headers.get("content-security-policy") ?? "";
      expect(policy, route).toContain("sandbox");
      expect(policy, route).not.toContain("allow-scripts");
    }
  });

  it("official status comes from the engine's install record, never from the workspace manifest", async () => {
    const { userPaths } = await import("../src/paths.js");
    const { writeInstallSource } = await import("../src/apps/update.js");
    const p = userPaths(dataDir, "alice");
    const official = async (id: string) =>
      ((await (await app.request("/v1/launch", { headers: h() })).json()) as { apps: { id: string; official: boolean }[] }).apps.find((a) => a.id === id)?.official;
    const mk = (id: string, manifest: Record<string, unknown>) => {
      fs.mkdirSync(path.join(p.apps, id), { recursive: true });
      fs.writeFileSync(path.join(p.apps, id, "manifest.json"), JSON.stringify(manifest));
    };
    // a manifest claiming it (agent shell, non-admin shell, repo), with or
    // without a source that looks official
    mk("claims", { name: "C", version: "1", kind: "web", official: true, source: { git: "https://github.com/ProjectChrysalis/Roleplay" } });
    expect(await official("claims")).toBe(false);
    // installed by the engine from a maintainers' repository
    mk("real", { name: "R", version: "1", kind: "web" });
    writeInstallSource(p.appUpstream, "real", { git: "https://github.com/projectchrysalis/Roleplay.git", ref: "HEAD" });
    expect(await official("real")).toBe(true);
    // installed from anywhere else, including look-alike owners and paths
    for (const git of ["https://github.com/ProjectChrysalisX/app", "https://github.com/someone/ProjectChrysalis", "https://github.com/ProjectChrysalis/a/b", "https://evil.example/ProjectChrysalis/app"]) {
      writeInstallSource(p.appUpstream, "real", { git, ref: "HEAD" });
      expect(await official("real"), git).toBe(false);
    }
  });

  it("app page arms the source watcher: a source edit becomes build_needed with its path", async () => {
    const seen: Array<{ type: string; payload: unknown }> = [];
    const origEmit = bus.emit.bind(bus);
    bus.emit = (username: string, type: string, payload: unknown) => {
      seen.push({ type, payload });
      return origEmit(username, type, payload);
    };
    const page = await app.request("/app/alice/notes/");
    expect(page.status).toBe(200);
    // touching src/ goes to the in-browser builder as build_needed (the
    // engine builds nothing itself), never as a data look_changed
    const src = path.join(dataDir, "users", "alice", "apps", "notes", "src", "main.tsx");
    fs.writeFileSync(src, fs.readFileSync(src, "utf8") + "\n/* probe */\n");
    await new Promise((r) => setTimeout(r, 1200));
    bus.emit = origEmit;
    expect(seen.filter((e) => e.type === "look_changed")).toHaveLength(0);
    const needed = seen.filter((e) => e.type === "build_needed");
    expect(needed.length).toBeGreaterThan(0);
    expect(needed[0]!.payload).toMatchObject({ app: "notes", paths: ["src/main.tsx"] });
  });

  it("isBuildSource: whatever a build reads, never data, plugins, output or deps", async () => {
    const { isBuildSource } = await import("../src/builder/server.js");
    for (const yes of ["demo/src/main.tsx", "demo/index.html", "demo/package.json", "demo/tsconfig.json", "demo/public/logo.svg", "demo/lib/util.ts", "demo/.env", "demo/.env.production"]) {
      expect(isBuildSource(yes), yes).toBe(true);
    }
    for (const no of ["demo/node_modules/preact/package.json", "demo/dist/index.html", "demo/data/chats/a.json", "notes/plugins/x.js", "demo/.git/HEAD", "demo/.dist-next-1/index.html", "demo"]) {
      expect(isBuildSource(no), no).toBe(false);
    }
  });

  it("connection mutations warm the rebuilt catalog, then broadcast connections_changed", async () => {
    const seen: Array<{ type: string; payload: unknown }> = [];
    const origEmit = bus.emit.bind(bus);
    bus.emit = (username: string, type: string, payload: unknown) => {
      seen.push({ type, payload });
      return origEmit(username, type, payload);
    };
    try {
      const post = await app.request("/v1/settings/connections", {
        method: "POST",
        headers: { ...h(), "content-type": "application/json" },
        body: JSON.stringify({ name: "stub", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "stub-1" }], key: "sk-stub" }),
      });
      expect(post.status).toBe(201);
      const { connection } = (await post.json()) as { connection: { id: string } };
      await new Promise((r) => setTimeout(r, 200));
      const events = seen.filter((e) => e.type === "connections_changed");
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({ id: connection.id });
      // the broadcast lands after the rebuilt catalog is warm: the next list
      // request already serves the new connection's model
      const models = await app.request("/v1/models", { headers: h() });
      const list = ((await models.json()) as { models: Array<{ provider: string; modelId: string }> }).models;
      expect(list.some((m) => m.provider === connection.id && m.modelId === "stub-1")).toBe(true);
      // deletion broadcasts too
      const del = await app.request(`/v1/settings/connections/${connection.id}`, { method: "DELETE", headers: h() });
      expect(del.status).toBe(200);
      await new Promise((r) => setTimeout(r, 200));
      expect(seen.filter((e) => e.type === "connections_changed")).toHaveLength(2);
    } finally {
      bus.emit = origEmit;
    }
  });

  it("app image proxy: allowlisted plugin hosts only, images only, redirect hops re-validated", async () => {
    const realFetch = globalThis.fetch;
    const hops: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const target = String(input);
        hops.push(target);
        if (target.includes("/hop1")) {
          return new Response(null, { status: 302, headers: { location: "https://avatars.charhub.io/final.webp" } });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/webp" } });
      },
      { preconnect: (): void => {} },
    ) as typeof fetch;
    try {
      // a plugin in the app allowlists the image host
      const plugin = path.join(dataDir, "users", "alice", "apps", "notes", "plugins", "art");
      fs.mkdirSync(plugin, { recursive: true });
      fs.writeFileSync(path.join(plugin, "manifest.json"), JSON.stringify({ name: "Art", version: "1.0.0", permissions: ["routes", "network"], networkHosts: ["avatars.charhub.io"] }));
      fs.writeFileSync(path.join(plugin, "plugin.js"), "export function handleRoute() { return null; }");
      const ok = await app.request(`/v1/apps/notes/img?url=${encodeURIComponent("https://avatars.charhub.io/avatars/u/b/avatar.webp")}`, { headers: h() });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/webp");
      expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      // allowlisted hop → redirects are followed onto a still-allowlisted host
      const via = await app.request(`/v1/apps/notes/img?url=${encodeURIComponent("https://avatars.charhub.io/hop1")}`, { headers: h() });
      expect(via.status).toBe(200);
      expect(hops.at(-1)).toBe("https://avatars.charhub.io/final.webp");
      // host no plugin declared → refused; plain http too
      const denied = await app.request(`/v1/apps/notes/img?url=${encodeURIComponent("https://evil.example.com/x.png")}`, { headers: h() });
      expect(denied.status).toBe(403);
      const http = await app.request(`/v1/apps/notes/img?url=${encodeURIComponent("http://avatars.charhub.io/x.png")}`, { headers: h() });
      expect(http.status).toBe(400);
      // non-image content-type is refused even from an allowlisted host
      globalThis.fetch = Object.assign(async () => new Response("nope", { status: 200, headers: { "content-type": "text/html" } }), { preconnect: (): void => {} }) as typeof fetch;
      const html = await app.request(`/v1/apps/notes/img?url=${encodeURIComponent("https://avatars.charhub.io/x")}`, { headers: h() });
      expect(html.status).toBe(415);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("built dist takes the app frame; install refuses apps without a package.json", async () => {    const dist = path.join(dataDir, "users", "alice", "apps", "notes", "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>BUILT</title>");
    const page = await app.request("/app/alice/notes/");
    expect(page.status).toBe(200);
    const built = await page.text();
    expect(built).toContain("<title>BUILT</title>");
    // the bridge is injected so it runs before any app script
    expect(built).toContain("app-bridge.js");
    fs.rmSync(dist, { recursive: true, force: true });
    // the placeholder is back once dist is gone
    const page2 = await app.request("/app/alice/notes/");
    expect(await page2.text()).toContain("has not been built yet");
    // install refuses an app with no package.json (bare dir app)
    fs.mkdirSync(path.join(dataDir, "users", "alice", "apps", "bare", "data"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "users", "alice", "apps", "bare", "manifest.json"), JSON.stringify({ name: "Bare", version: "0.1.0", kind: "app" }));
    const res = await app.request("/v1/apps/bare/install", { method: "POST", headers: { ...h(), "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
    // nothing to build without an index.html
    const bare = (await (await app.request("/v1/apps/bare/build", { headers: h() })).json()) as { buildable: boolean; needsBuild: boolean };
    expect(bare).toMatchObject({ buildable: false, needsBuild: false });
  });

  it("build routes: status, one lease holder, output lands in dist and is announced", async () => {
    const base = "/v1/apps/notes/build";
    const json = { ...h(), "content-type": "application/json" };
    const st = (await (await app.request(base, { headers: h() })).json()) as { buildable: boolean; needsBuild: boolean; rev: string };
    expect(st).toMatchObject({ buildable: true, needsBuild: true });
    // one tab at a time
    const lease = async (holder: string, body: Record<string, unknown> = {}) => (await app.request(`${base}/lease`, { method: "POST", headers: json, body: JSON.stringify({ holder, ...body }) })).json();
    // a build in flight is exclusive: both tabs say they are mid-build
    expect(await lease("tabaaaaaaaa1", { busy: true })).toEqual({ granted: true });
    expect(await lease("tabbbbbbbbb2", { busy: true })).toEqual({ granted: false });
    // a holder that goes idle protects nothing (a page that is only open must
    // not park the app), so a waiting tab takes over at once
    expect(await lease("tabaaaaaaaa1")).toEqual({ granted: true });
    expect(await lease("tabbbbbbbbb2", { busy: true })).toEqual({ granted: true });
    // and even a busy holder yields to a forced takeover
    expect(await lease("tabaaaaaaaa1", { force: true })).toEqual({ granted: true });
    // only the holder may write
    const { builderVersion } = await import("../src/builder/assets.js");
    const builder = await builderVersion();
    const output = { ok: true, mode: "production", files: [{ path: "index.html", contents: "<!doctype html><title>FROM-BUILDER</title>" }], copies: [], errors: [], warnings: [] };
    const put = (holder: string, out: unknown = output) => app.request(`${base}/output`, { method: "PUT", headers: json, body: JSON.stringify({ holder, rev: st.rev, builder, output: out }) });
    expect((await put("tabbbbbbbbb2")).status).toBe(409);
    const seen: Array<{ type: string; payload: unknown }> = [];
    const origEmit = bus.emit.bind(bus);
    bus.emit = (username: string, type: string, payload: unknown) => {
      seen.push({ type, payload });
      return origEmit(username, type, payload);
    };
    try {
      expect((await put("tabaaaaaaaa1")).status).toBe(200);
    } finally {
      bus.emit = origEmit;
    }
    expect(seen.find((e) => e.type === "app_built")?.payload).toMatchObject({ app: "notes", kind: "full", ok: true });
    expect(await (await app.request("/app/alice/notes/")).text()).toContain("FROM-BUILDER");
    const after = (await (await app.request(base, { headers: h() })).json()) as { needsBuild: boolean; status: { ok: boolean } };
    expect(after.needsBuild).toBe(false);
    // the builder's bookkeeping is not served
    expect((await app.request("/app/alice/notes/.chrysalis-build.json")).status).toBe(404);
    // a failed build keeps dist and records why
    const failed = { ...output, ok: false, files: [], errors: [{ text: "Expected \";\"", file: "src/app.tsx", line: 3 }] };
    expect((await put("tabaaaaaaaa1", failed)).status).toBe(200);
    expect(await (await app.request("/app/alice/notes/")).text()).toContain("FROM-BUILDER");
    const bad = (await (await app.request(base, { headers: h() })).json()) as { status: { ok: boolean; errors: Array<{ file: string }> } };
    expect(bad.status.ok).toBe(false);
    expect(bad.status.errors[0]!.file).toBe("src/app.tsx");
    fs.rmSync(path.join(dataDir, "users", "alice", "apps", "notes", "dist"), { recursive: true, force: true });
    await lease("tabaaaaaaaa1");
    await app.request(`${base}/lease`, { method: "POST", headers: json, body: JSON.stringify({ holder: "tabaaaaaaaa1", release: true }) });
  });

  it("a dev dist whose snapshot is gone reports unbuilt instead of adopting dead meta", async () => {
    const base = "/v1/apps/notes/build";
    const json = { ...h(), "content-type": "application/json" };
    const holder = "tabdev0000001";
    const st = (await (await app.request(base, { headers: h() })).json()) as { rev: string };
    await app.request(`${base}/lease`, { method: "POST", headers: json, body: JSON.stringify({ holder, busy: true }) });
    const meta = { format: 3, depsKey: "test", depsJs: "dev/deps-test.js", depsCss: null, snapshot: "dev/app-test.js", hot: [], seq: 0, retired: [] };
    const output = {
      ok: true,
      mode: "development",
      files: [
        { path: "index.html", contents: "<!doctype html><title>DEV</title>" },
        { path: "dev/deps-test.js", contents: "// deps" },
        { path: "dev/app-test.js", contents: "// app" },
        { path: "dev/meta.json", contents: JSON.stringify(meta) },
      ],
      copies: [],
      errors: [],
      warnings: [],
      full: false,
      hot: null,
    };
    const { builderVersion } = await import("../src/builder/assets.js");
    expect((await app.request(`${base}/output`, { method: "PUT", headers: json, body: JSON.stringify({ holder, rev: st.rev, builder: await builderVersion(), output }) })).status).toBe(200);
    const ok = (await (await app.request(base, { headers: h() })).json()) as { needsBuild: boolean; dev: unknown };
    expect(ok.needsBuild).toBe(false);
    expect(ok.dev).not.toBeNull();
    // the snapshot vanishes: the meta must not be adopted, and a full build
    // has to replace it rather than a later hot update referencing the hole
    fs.rmSync(path.join(dataDir, "users", "alice", "apps", "notes", "dist", "dev", "app-test.js"));
    const lost = (await (await app.request(base, { headers: h() })).json()) as { needsBuild: boolean; dev: unknown };
    expect(lost.dev).toBeNull();
    expect(lost.needsBuild).toBe(true);
  });

  it("app tier: createAppSkeleton kind web writes the standard app shape", async () => {
    const { createAppSkeleton, readApp } = await import("../src/apps/manager.js");
    const r = createAppSkeleton(path.join(dataDir, "users", "alice", "apps"), { id: "demo", name: "Demo", kind: "web" });
    expect(fs.existsSync(path.join(r.dir, "package.json"))).toBe(true);
    // the builder brings the toolchain: no bundler config, a tsconfig for editors and paths
    expect(fs.existsSync(path.join(r.dir, "vite.config.ts"))).toBe(false);
    expect(fs.existsSync(path.join(r.dir, "tsconfig.json"))).toBe(true);
    expect(fs.existsSync(path.join(r.dir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(r.dir, "src", "main.tsx"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, "manifest.json"), "utf8")).kind).toBe("web");

    // manifests written before the rename still read as a web app
    const legacy = createAppSkeleton(path.join(dataDir, "users", "alice", "apps"), { id: "old", name: "Old", kind: "vite" });
    expect(readApp(path.join(dataDir, "users", "alice", "apps"), "old")?.manifest.kind).toBe("web");
    fs.writeFileSync(path.join(legacy.dir, "manifest.json"), JSON.stringify({ name: "Old", version: "0.1.0", kind: "vite" }));
    expect(readApp(path.join(dataDir, "users", "alice", "apps"), "old")?.manifest.kind).toBe("web");

    // the scaffold must actually build: every dependency the starter sources
    // import has to be in package.json, and nothing is scaffolded that isn't
    const pkg = JSON.parse(fs.readFileSync(path.join(r.dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies ?? {})]);
    const sources = ["src/main.tsx", "src/app.tsx"];
    for (const rel of sources) {
      const text = fs.readFileSync(path.join(r.dir, rel), "utf8");
      for (const m of text.matchAll(/from "([^".][^"]*)"/g)) {
        const spec = m[1]!;
        const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        expect(deps.has(pkgName), `${rel} imports ${pkgName}, which package.json does not install`).toBe(true);
      }
    }
    expect(fs.existsSync(path.join(r.dir, "src", "components"))).toBe(false);
  });

  it("git boundary covers vite artifacts (node_modules/dist never staged)", async () => {
    const { gitBoundaryIgnored } = await import("../src/paths.js");
    expect(gitBoundaryIgnored("demo/node_modules/preact/index.js")).toBe(true);
    expect(gitBoundaryIgnored("demo/dist/index.html")).toBe(true);
    expect(gitBoundaryIgnored("demo/src/main.tsx")).toBe(false);
    expect(gitBoundaryIgnored("apps/demo/dist/assets/x.js")).toBe(true);
  });

  it("route sweep commits out-of-band edits under their own label, not the route's", async () => {
    const { log, changedPaths, commitAll } = await import("../src/git.js");
    const root = path.join(dataDir, "users", "alice");
    // baseline: a committed workspace (boot commits the seeded tree), so the
    // only pending edit below is the out-of-band one
    await commitAll(root, "alice", "base: seeded workspace");
    // an out-of-band edit (agent/shell) pending BEFORE any route fires
    fs.writeFileSync(path.join(root, "todo.md"), "left pending by the agent\n");
    expect(await changedPaths(root)).toContain("todo.md");
    // a route that writes its own file
    const put = await app.request("/v1/apps/notes/notes/p1", {
      method: "PUT",
      headers: { ...h(), "content-type": "application/json" },
      body: JSON.stringify({ text: "sweep test" }),
    });
    expect(put.status).toBe(200);
    expect(await changedPaths(root)).toEqual([]); // everything committed
    const commits = await log(root, 5);
    expect(commits[0]!.message).toBe("app(notes): PUT /notes/p1");
    const oob = commits[1]!;
    expect(oob.message).toBe("out-of-band: todo.md");
    // file membership: the route commit must NOT contain the out-of-band file
    const isomorphicGit = (await import("isomorphic-git")).default;
    const filesOf = async (oid: string): Promise<string[]> => {
      const treeOid = (await isomorphicGit.readCommit({ fs, dir: root, oid })).commit.tree;
      const out: string[] = [];
      const walk = async (t: string, prefix: string): Promise<void> => {
        const { tree } = await isomorphicGit.readTree({ fs, dir: root, oid: t });
        for (const e of tree) {
          if (e.type === "tree") await walk(e.oid, prefix + e.path + "/");
          else out.push(prefix + e.path);
        }
      };
      await walk(treeOid, "");
      return out;
    };
    const routeFiles = await filesOf(commits[0]!.oid);
    const oobFiles = await filesOf(commits[1]!.oid);
    // trees are full snapshots — the commit's actual content is the diff
    // against its parent. The out-of-band commit adds exactly todo.md; the
    // route commit adds exactly its own write.
    const addedByRoute = routeFiles.filter((f) => !oobFiles.includes(f));
    expect(addedByRoute).toEqual(["apps/notes/data/notes/p1.json"]);
    expect(oobFiles).toContain("todo.md");
  });
});
