/**
 * Phase 3 agent tests: tools (grep/edit/app mgmt), full agent loop with a
 * scripted faux provider (toolUse → final), session persistence + resume.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import isomorphicGit from "isomorphic-git";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { WRITE_TOOLS, buildUserTools } from "../src/agent/tools.js";
import { UserAgent, archiveSession, listSessions, renameSession, sessionFile, type AgentStreamEvent } from "../src/agent/agent.js";
import { UserModelService } from "../src/models.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";
import { UserService } from "../src/users.js";
import { invalidatePluginCache } from "../src/plugins/runtime.js";
import { defaultSandboxConfig, type SandboxRunner } from "../src/sandbox/index.js";

/** Commands run in the browser sandbox; tests only need a canned runner. */
function testSandbox(): SandboxRunner {
  return {
    config: defaultSandboxConfig(),
    enabled: true,
    status: () => ({ provider: "browser", available: true, reason: "test", running: 0, unsafe: false, isolation: "wasm" }),
    run: async (_username, _root, input) => ({
      exitCode: 0,
      stdout: `${input.command}\n`,
      stderr: "",
      timedOut: false,
      truncated: false,
      provider: "browser",
    }),
  };
}

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent3-"));
});
afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
  invalidatePluginCache();
});

describe("agent tools", () => {
  it("accept mode: bash waits for approval — decline blocks, approval runs", async () => {
    const p = bootstrapUserDir(dataDir, "alice");
    const asked: Array<{ question: string; options?: string[]; detail?: string }> = [];
    let reply = "Skip";
    const tools = buildUserTools("alice", p, {
      dataDir: p.root,
      acceptShell: true,
      sandbox: testSandbox(),
      ask: async (q) => {
        asked.push(q);
        return reply;
      },
    });
    const bash = tools.find((t) => t.name === "bash")!;
    // declined: the command never runs and the model sees a refusal, not an error
    const declined = (await bash.execute("t1", { command: "echo should-not-run" })) as { content: { text: string }[]; isError?: boolean };
    expect(declined.content[0]!.text).toContain("declined");
    expect(declined.isError).toBeFalsy();
    // approved: the command runs for real
    reply = "Run it";
    const approved = (await bash.execute("t2", { command: "echo approved-time" })) as { content: { text: string }[] };
    expect(approved.content[0]!.text).toContain("approved-time");
    // the question carried the command and the quick-pick options
    expect(asked).toHaveLength(2);
    expect(asked[0]!.question).toContain("Run this shell command?");
    expect(asked[0]!.options).toEqual(["Run it", "Skip"]);
    expect(asked[0]!.detail).toContain("should-not-run");
  });

  it("grep finds text in app data, skips .git and binaries", async () => {
    const p = bootstrapUserDir(dataDir, "alice");
    fs.mkdirSync(path.join(p.apps, "roleplay", "data", "characters"), { recursive: true });
    fs.writeFileSync(path.join(p.apps, "roleplay", "data", "characters", "serena.json"), JSON.stringify({ name: "Serena", secret: "dragon-scroll" }));
    fs.mkdirSync(path.join(p.root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(p.root, ".git", "config"), "dragon-scroll");
    const tools = buildUserTools("alice", p, { dataDir: p.root });
    const grep = tools.find((t) => t.name === "grep")!;
    const r = await grep.execute("t", { pattern: "dragon-scroll" });
    const text = JSON.stringify(r);
    expect(text).toContain("characters/serena.json");
    expect(text).not.toContain(".git");
  });

  it("grep never surfaces credentials from auth.json", async () => {
    const p = bootstrapUserDir(dataDir, "alice");
    // credentials live OUTSIDE the workspace now — the defense that must hold
    // is skip-by-name: a stray auth.json inside the workspace is never walked
    fs.writeFileSync(path.join(p.root, "auth.json"), JSON.stringify({ deepseek: "sk-live-dragon-scroll" }));
    fs.mkdirSync(path.join(p.apps, "roleplay"), { recursive: true });
    fs.writeFileSync(path.join(p.apps, "roleplay", "card.json"), "mentions sk-live-dragon-scroll too");
    const tools = buildUserTools("alice", p, { dataDir: p.root });
    const grep = tools.find((t) => t.name === "grep")!;
    const r = await grep.execute("t", { pattern: "sk-live-dragon-scroll" });
    const text = JSON.stringify(r);
    expect(text).toContain("apps/roleplay/card.json");
    expect(text).not.toContain("auth.json");
  });

  it("edit_file: unique replacement works, ambiguous refuses", async () => {
    const p = bootstrapUserDir(dataDir, "alice");
    fs.mkdirSync(path.join(p.apps, "roleplay", "data"), { recursive: true });
    const f = path.join(p.apps, "roleplay", "data", "card.json");
    fs.writeFileSync(f, '{"name":"Serena","personality":"dry"}');
    const tools = buildUserTools("alice", p, { dataDir: p.root });
    const edit = tools.find((t) => t.name === "edit_file")!;
    const r1 = await edit.execute("t1", { path: "apps/roleplay/data/card.json", oldText: '"dry"', newText: '"razor-sharp sarcasm"' });
    expect(JSON.stringify(r1)).toContain("Edited");
    expect(fs.readFileSync(f, "utf8")).toContain("razor-sharp");
    fs.writeFileSync(f, "same same");
    await expect(edit.execute("t2", { path: "apps/roleplay/data/card.json", oldText: "same", newText: "x" }))
      .rejects.toThrow(/matches 2 times/);
  });

  it("write_file commits immediately as the agent author; read_file missing → error", async () => {
    const p = bootstrapUserDir(dataDir, "alice");
    const tools = buildUserTools("alice", p, { dataDir: p.root });
    const write = tools.find((t) => t.name === "write_file")!;
    const r = (await write.execute("t1", { path: "apps/roleplay/data/note.json", content: '{"a":1}' })) as {
      content: { text: string }[];
    };
    expect(r.content[0]!.text).toMatch(/committed [0-9a-f]{8}/);
    const commits = await isomorphicGit.log({ fs, dir: p.root, depth: 1 });
    expect(commits[0]!.commit.author.name).toBe("alice (via agent)");
    expect(commits[0]!.commit.message.trim()).toBe("agent: write apps/roleplay/data/note.json");
    const read = tools.find((t) => t.name === "read_file")!;
    await expect(read.execute("t2", { path: "apps/roleplay/data/nope.json" })).rejects.toThrow(/File not found/);
  });

  it("file tools report a diff with real line numbers; a no-op write reports none", async () => {
    const p = bootstrapUserDir(dataDir, "alice");
    const tools = buildUserTools("alice", p, { dataDir: p.root });
    const write = tools.find((t) => t.name === "write_file")!;
    const edit = tools.find((t) => t.name === "edit_file")!;
    const rel = "apps/roleplay/data/note.txt";
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

    const created = (await write.execute("t1", { path: rel, content: `${lines}\n` })) as { details: { diff?: string } };
    // a fresh file is all additions — nothing on the "before" side to keep
    expect(created.details.diff).toMatch(/^@@ -0,0 \+1,12 @@$/m);

    // the write commits before the result lands, so a diff taken from git
    // afterwards would be empty; the tool diffs what it actually replaced
    const edited = (await edit.execute("t2", { path: rel, oldText: "line 7", newText: "line seven" })) as {
      details: { diff?: string };
    };
    expect(edited.details.diff).toContain("-line 7");
    expect(edited.details.diff).toContain("+line seven");
    expect(edited.details.diff).toMatch(/^@@ -4,7 \+4,7 @@$/m);

    // rewriting identical bytes changes nothing — no diff, so the transcript
    // shows "no changes" instead of an empty card counting +0 −0
    const same = (await write.execute("t3", { path: rel, content: fs.readFileSync(path.join(p.root, rel), "utf8") })) as {
      details: { diff?: string };
    };
    expect(same.details.diff).toBeUndefined();
  });

  it("app_deps: gated, validated, and install signals a rebuild for open pages", async () => {
    const p = bootstrapUserDir(dataDir, "alice");
    expect(WRITE_TOOLS.has("app_deps")).toBe(true);
    expect(WRITE_TOOLS.has("app_install")).toBe(false); // folded in
    expect(WRITE_TOOLS.has("git_commit")).toBe(false); // folded into the git tool

    const off = buildUserTools("alice", p, { dataDir: p.root });
    await off.find((t) => t.name === "app_create")!.execute("t1", { id: "vn", name: "VN" });
    await expect(off.find((t) => t.name === "app_deps")!.execute("t2", { id: "vn" })).rejects.toThrow(/downloads are off/);
    await expect(off.find((t) => t.name === "app_deps")!.execute("t3", { id: "vn", remove: ["left-pad"] }))
      .rejects.toThrow(/downloads are off/);

    const events: Array<{ type: string; payload: unknown }> = [];
    const on = buildUserTools("alice", p, {
      dataDir: p.root,
      packageDownloads: () => true,
      notify: (type, payload) => events.push({ type, payload }),
    });
    await expect(on.find((t) => t.name === "app_deps")!.execute("t4", { id: "missing" })).rejects.toThrow(/not found/i);
    // a backend app carries no package.json
    await on.find((t) => t.name === "app_create")!.execute("t5", { id: "backend", name: "Backend", kind: "app" });
    await expect(on.find((t) => t.name === "app_deps")!.execute("t6", { id: "backend" })).rejects.toThrow(/no package\.json/);
    await expect(on.find((t) => t.name === "app_deps")!.execute("t7", { id: "vn", remove: ["--force"] }))
      .rejects.toThrow(/Invalid package name/);

    // dependency-free: installs offline in milliseconds, then tells pages to rebuild
    fs.writeFileSync(path.join(p.apps, "vn", "package.json"), JSON.stringify({ name: "vn", private: true }));
    const r = await on.find((t) => t.name === "app_deps")!.execute("t8", { id: "vn" });
    expect(JSON.stringify(r)).toContain("Install ok");
    expect(events).toContainEqual({ type: "build_needed", payload: { app: "vn", paths: ["package.json"] } });
  });

  it("app_check reports carried build errors and distrusts an old builder's status", async () => {
    const p = bootstrapUserDir(dataDir, "alice");
    const events: Array<{ type: string; payload: unknown }> = [];
    const tools = buildUserTools("alice", p, {
      dataDir: p.root,
      notify: (type, payload) => events.push({ type, payload }),
    });
    await tools.find((t) => t.name === "app_create")!.execute("t0", { id: "vn", name: "VN" });
    const { sourceRev } = await import("../src/builder/server.js");
    const { builderVersion } = await import("../src/builder/assets.js");
    const dir = path.join(p.apps, "vn");
    const status = path.join(dir, "dist", ".chrysalis-build.json");
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(
      status,
      JSON.stringify({
        // dev builds stay ok:true while carrying errors; app_check must
        // still report the failure
        rev: sourceRev(dir),
        ok: true,
        mode: "development",
        errors: [{ text: 'Could not resolve "nanoid" from src/app.tsx', file: "src/app.tsx", line: 2 }],
        warnings: 0,
        at: Date.now(),
        builder: await builderVersion(),
      }),
    );
    const r = await tools.find((t) => t.name === "app_check")!.execute("t1", { id: "vn" });
    expect(JSON.stringify(r)).toContain("Build FAILED");
    expect(JSON.stringify(r)).toContain("Could not resolve");

    // a status with no builder stamp (an older open page) is not trusted:
    // the check asks for a rebuild instead of reporting a stale ok
    fs.writeFileSync(status, JSON.stringify({ rev: sourceRev(dir), ok: true, mode: "development", errors: [], warnings: 0, at: Date.now() }));
    const stale = await tools.find((t) => t.name === "app_check")!.execute("t2", { id: "vn", wait_ms: 1 });
    expect(JSON.stringify(stale)).toContain("No build landed");
    expect(events).toContainEqual({ type: "build_requested", payload: { app: "vn", force: true } });

    await tools.find((t) => t.name === "app_create")!.execute("t3", { id: "backend", name: "Backend", kind: "app" });
    await expect(tools.find((t) => t.name === "app_check")!.execute("t4", { id: "backend" })).rejects.toThrow(/nothing to build/);
  });

  it("app_rebuild forces a build even when the current status is fresh", async () => {
    const p = bootstrapUserDir(dataDir, "alice");
    const events: Array<{ type: string; payload: unknown }> = [];
    const tools = buildUserTools("alice", p, {
      dataDir: p.root,
      notify: (type, payload) => events.push({ type, payload }),
    });
    await tools.find((t) => t.name === "app_create")!.execute("t0", { id: "fresh", name: "Fresh" });
    const { sourceRev } = await import("../src/builder/server.js");
    const { builderVersion } = await import("../src/builder/assets.js");
    const dir = path.join(p.apps, "fresh");
    const status = path.join(dir, "dist", ".chrysalis-build.json");
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    const builder = await builderVersion();
    const stamp = (at: number) => JSON.stringify({ rev: sourceRev(dir), ok: true, mode: "development", errors: [], warnings: 0, at, builder });
    fs.writeFileSync(status, stamp(Date.now() - 60_000));

    // app_check would answer from this fresh status; rebuild must force one
    const pending = tools.find((t) => t.name === "app_rebuild")!.execute("t1", { id: "fresh", wait_ms: 5000 }) as Promise<unknown>;
    await new Promise((r) => setTimeout(r, 700));
    expect(events).toContainEqual({ type: "build_requested", payload: { app: "fresh", force: true } });
    // the browser builder lands a newer status while the tool waits
    fs.writeFileSync(status, stamp(Date.now()));
    const out = await pending;
    expect(JSON.stringify(out)).toContain("Build ok for apps/fresh");
    expect(JSON.stringify(out)).toContain('"rebuilt":true');
  });

  it("app_console reads prints and caught errors newest-last, with level filtering", async () => {
    const p = bootstrapUserDir(dataDir, "alice");
    const tools = buildUserTools("alice", p, { dataDir: p.root });
    await tools.find((t) => t.name === "app_create")!.execute("t0", { id: "logs", name: "Logs" });
    const { sourceRev, writeClientErrors, writeClientLogs } = await import("../src/builder/server.js");
    const dir = path.join(p.apps, "logs");
    const rev = sourceRev(dir);
    writeClientLogs(dir, [
      { kind: "log", text: "boot", at: 1000, rev },
      { kind: "warn", text: "careful", at: 2000, rev },
      { kind: "log", text: "later", at: 3000, rev },
    ]);
    writeClientErrors(dir, [{ kind: "console", text: "boom", stack: "Error: boom\n  at App (src/app.tsx:1:1)", at: 2500, rev }]);
    const consoleTool = tools.find((t) => t.name === "app_console")!;
    const all = JSON.stringify(await consoleTool.execute("t1", { id: "logs" }));
    expect(all).toContain("boot");
    expect(all).toContain("later");
    expect(all).toContain("boom");
    expect(all.indexOf("careful")).toBeLessThan(all.indexOf("boom"));

    const errors = JSON.stringify(await consoleTool.execute("t2", { id: "logs", level: "error" }));
    expect(errors).toContain("boom");
    expect(errors).not.toContain("careful");
    const warns = JSON.stringify(await consoleTool.execute("t3", { id: "logs", level: "warn" }));
    expect(warns).toContain("careful");
    expect(warns).toContain("boom");
    expect(warns).not.toContain("later");

    const none = JSON.stringify(await consoleTool.execute("t4", { id: "logs", level: "all", limit: 1 }));
    expect(none).toContain("later");
    expect(none).not.toContain("boot");

    // an absurd stored timestamp (hand-planted or from an older build) must
    // not crash the tool: the clock falls back, the line still reads
    writeClientLogs(dir, [{ kind: "log", text: "ancient", at: 1e300, rev }]);
    const weird = JSON.stringify(await consoleTool.execute("t5", { id: "logs", level: "all", limit: 1 }));
    expect(weird).toContain("ancient");
    expect(weird).toContain("--:--:--");
  });

  it("git tool takes command-line arguments; plan mode keeps reads but refuses writes", async () => {
    const p = bootstrapUserDir(dataDir, "alice");
    const tools = buildUserTools("alice", p, { dataDir: p.root });
    const git = tools.find((t) => t.name === "git")!;
    await tools.find((t) => t.name === "write_file")!.execute("t1", { path: "apps/roleplay/data/note.txt", content: "hi" });
    expect(JSON.stringify(await git.execute("t2", { args: "log --oneline -n 5" }))).toContain("agent: write");

    const plan = buildUserTools("alice", p, { dataDir: p.root, mode: "plan" });
    const gitPlan = plan.find((t) => t.name === "git")!;
    expect(JSON.stringify(await gitPlan.execute("t3", { args: "git show HEAD --stat" }))).toContain("apps/roleplay/data/note.txt");
    await expect(gitPlan.execute("t4", { args: "commit -m x" })).rejects.toThrow(/Plan mode/);
    await expect(gitPlan.execute("t5", { args: "restore --source HEAD -- apps/roleplay/data/note.txt" })).rejects.toThrow(/Plan mode/);
  });
});

describe("session titles", () => {
  it("auto-derived from the first message; rename overrides and survives; ids stay unique", () => {
    const p = bootstrapUserDir(dataDir, "alice");
    fs.mkdirSync(path.dirname(sessionFile(p, "abc123")), { recursive: true });
    fs.writeFileSync(
      sessionFile(p, "abc123"),
      JSON.stringify({ type: "run", at: 1, user: "make the look darker please", assistant: "done", tools: [] }) + "\n",
    );
    let sessions = listSessions(p);
    expect(sessions[0]!.title).toBe("make the look darker please");

    // long first messages truncate to a sidebar-friendly title
    fs.writeFileSync(
      sessionFile(p, "long1"),
      JSON.stringify({ type: "run", at: 2, user: "word ".repeat(40), assistant: "y", tools: [] }) + "\n",
    );
    const long = listSessions(p).find((s) => s.sessionId === "long1")!;
    expect(long.title!.length).toBeLessThanOrEqual(61);
    expect(long.title!.endsWith("…")).toBe(true);

    // rename: sanitized, overrides the auto title, and is metadata only
    const title = renameSession(p, "abc123", "  Look\n restyle \t session  ");
    expect(title).toBe("Look restyle session");
    sessions = listSessions(p);
    expect(sessions.find((s) => s.sessionId === "abc123")!.title).toBe("Look restyle session");
    // the rename record never leaks into the run records clients replay
    const types = fs
      .readFileSync(sessionFile(p, "abc123"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l).type);
    expect(types).toEqual(["run", "rename"]);
    expect(() => renameSession(p, "missing1", "nope")).toThrow(/not found/);
  });

  it("archive toggles by last record and never reorders the list", () => {
    const p = bootstrapUserDir(dataDir, "arch");
    fs.mkdirSync(path.dirname(sessionFile(p, "old1")), { recursive: true });
    fs.writeFileSync(sessionFile(p, "old1"), JSON.stringify({ type: "run", at: 1, user: "old", assistant: "a", tools: [] }) + "\n");
    fs.writeFileSync(sessionFile(p, "new1"), JSON.stringify({ type: "run", at: 2, user: "new", assistant: "b", tools: [] }) + "\n");
    expect(listSessions(p).map((s) => s.archived)).toEqual([false, false]);

    archiveSession(p, "old1", true);
    let rows = listSessions(p);
    expect(rows.map((s) => s.sessionId)).toEqual(["new1", "old1"]);
    expect(rows.find((s) => s.sessionId === "old1")!.archived).toBe(true);

    archiveSession(p, "old1", false);
    rows = listSessions(p);
    expect(rows.find((s) => s.sessionId === "old1")!.archived).toBe(false);
    expect(() => archiveSession(p, "missing1", true)).toThrow(/not found/);
  });
});

describe("agent loop + sessions (faux provider)", () => {
  function makeSvc(username: string): UserModelService {
    const p = bootstrapUserDir(dataDir, username);
    return new UserModelService(username, p, defaultInstanceConfig());
  }

  it("toolUse → tool executes → final text; session file written; resume loads dialogue", async () => {
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    users.create("alice", "user", { password: "test-pass-1" });
    const svc = makeSvc("alice");
    const handle = fauxProvider({ models: [{ id: "faux-agent" }] });
    const toolCall = fauxAssistantMessage(
      [{ type: "toolCall", id: "tc1", name: "write_file", arguments: { path: "apps/roleplay/data/characters/bee/card.json", content: '{"name":"Bee"}' } }],
      { stopReason: "toolUse" },
    );
    handle.setResponses([toolCall, fauxAssistantMessage("Created Bee and committed.")]);
    svc.models.setProvider(handle.provider);

    const p = userPaths(dataDir, "alice");
    const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig());
    const result = await agent.run("create a character named Bee");
    expect(result.finalText).toContain("Created Bee");
    expect(result.toolTrace.map((t) => t.name)).toContain("write_file");
    expect(fs.readFileSync(path.join(p.root, "apps/roleplay/data/characters/bee/card.json"), "utf8")).toContain("Bee");

    // session persisted
    const sessions = listSessions(p);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.runs).toBe(1);
    const sf = sessionFile(p, sessions[0]!.sessionId);
    const recs = fs.readFileSync(sf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; user?: string; assistant?: string });
    // the run opens the file before calling the model, then appends the result
    expect(recs[0]!.type).toBe("start");
    const rec = recs.find((r) => r.type === "run")!;
    expect(rec.user).toContain("Bee");
    expect(rec.assistant).toContain("Created Bee");

    // resume: fresh agent with same session gets prior dialogue
    const resumed = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: sessions[0]!.sessionId });
    void resumed;
    // verify via a second run continuing the conversation
    handle.setResponses([fauxAssistantMessage("Bee it is.")]);
    const r2 = await resumed.run("what did we make?");
    expect(r2.finalText).toContain("Bee it is.");
    expect(listSessions(p)[0]!.runs).toBe(2);
  }, 30_000);

  it("an empty model completion is surfaced instead of a silent turn", async () => {
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    users.create("erin", "user", { password: "test-pass-1" });
    const svc = makeSvc("erin");
    const handle = fauxProvider({ models: [{ id: "faux-agent" }] });
    handle.setResponses([fauxAssistantMessage("")]);
    svc.models.setProvider(handle.provider);
    const p = userPaths(dataDir, "erin");
    const agent = await UserAgent.create("erin", svc, p, users, defaultInstanceConfig());
    const result = await agent.run("hello?");
    expect(result.finalText).toContain("empty response");
    // display only: the session keeps the empty reply so the note never
    // becomes context for the next model call
    const sf = sessionFile(p, listSessions(p)[0]!.sessionId);
    const rec = fs.readFileSync(sf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; assistant?: string }).find((r) => r.type === "run")!;
    expect(rec.assistant).toBe("");
  }, 30_000);

  it("attached images are recorded on the run so the message keeps them", async () => {
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    users.create("ivy", "user", { password: "test-pass-1" });
    const svc = makeSvc("ivy");
    const handle = fauxProvider({ models: [{ id: "faux-agent" }] });
    handle.setResponses([fauxAssistantMessage("it is a chart")]);
    svc.models.setProvider(handle.provider);

    const p = userPaths(dataDir, "ivy");
    const agent = await UserAgent.create("ivy", svc, p, users, defaultInstanceConfig());
    await agent.run("what is this", { imageUrls: ["/v1/assets/abc123"] });

    const sf = sessionFile(p, listSessions(p)[0]!.sessionId);
    const recs = fs.readFileSync(sf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; images?: string[] });
    expect(recs.find((r) => r.type === "run")?.images).toEqual(["/v1/assets/abc123"]);
  }, 30_000);

  it("a tool call is announced with its arguments before it runs; the reader gets the whole output, history replays the summary", async () => {
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    users.create("dana", "user", { password: "test-pass-1" });
    const svc = makeSvc("dana");
    const handle = fauxProvider({ models: [{ id: "faux-agent" }] });
    const p = userPaths(dataDir, "dana");
    const long = "x".repeat(1200);
    fs.writeFileSync(path.join(p.root, "long.txt"), long);
    handle.setResponses([
      fauxAssistantMessage([{ type: "toolCall", id: "tc1", name: "read_file", arguments: { path: "long.txt" } }], { stopReason: "toolUse" }),
      fauxAssistantMessage("read it"),
    ]);
    svc.models.setProvider(handle.provider);

    const agent = await UserAgent.create("dana", svc, p, users, defaultInstanceConfig());
    const events: AgentStreamEvent[] = [];
    const result = await agent.run("read long.txt", { onEvent: (ev) => events.push(ev) });

    const firstEnd = events.findIndex((e) => e.type === "tool_end");
    const announced = events.findIndex((e) => e.type === "tool_start" && e.id === "tc1" && e.args.path === "long.txt");
    expect(announced).toBeGreaterThanOrEqual(0);
    expect(announced).toBeLessThan(firstEnd);
    const end = events[firstEnd] as Extract<AgentStreamEvent, { type: "tool_end" }>;
    expect(end.summary.length).toBe(300);
    expect(end.output).toContain(long);

    const tool = result.turns[0]!.tools[0]!;
    expect(tool.summary.length).toBe(300);
    expect(tool.output).toContain(long);
    const rec = fs
      .readFileSync(sessionFile(p, agent.sessionId), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; turns?: { tools: { summary?: string; output?: string }[] }[] })
      .find((r) => r.type === "run")!;
    expect(rec.turns![0]!.tools[0]!.output).toContain(long);
    expect(rec.turns![0]!.tools[0]!.summary!.length).toBe(300);
  }, 30_000);

  it("the context window auto-compaction measures against is the user's override, and unknown stays unknown", async () => {
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    users.create("erin", "user", { password: "test-pass-1" });
    const svc = makeSvc("erin");
    const handle = fauxProvider({ models: [{ id: "faux-agent", contextWindow: 0 }] });
    svc.models.setProvider(handle.provider);
    const p = userPaths(dataDir, "erin");

    handle.setResponses([fauxAssistantMessage("hi")]);
    const unknown = await (await UserAgent.create("erin", svc, p, users, defaultInstanceConfig())).run("hello");
    expect(unknown.contextWindow).toBeUndefined();

    svc.setContextOverride(`${handle.provider.id}/faux-agent`, 400_000);
    handle.setResponses([fauxAssistantMessage("hi")]);
    const overridden = await (await UserAgent.create("erin", svc, p, users, defaultInstanceConfig())).run("hello");
    expect(overridden.contextWindow).toBe(400_000);
  }, 30_000);

  it("a brand-new session is listed while its first run is still going", async () => {
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    users.create("carol", "user", { password: "test-pass-1" });
    const svc = makeSvc("carol");
    const handle = fauxProvider({ models: [{ id: "faux-agent" }] });
    svc.models.setProvider(handle.provider);
    const p = userPaths(dataDir, "carol");
    const agent = await UserAgent.create("carol", svc, p, users, defaultInstanceConfig());

    // the sidebar reads listSessions; before the run there is nothing to list
    expect(listSessions(p)).toEqual([]);

    let listedMidRun: ReturnType<typeof listSessions> = [];
    handle.setResponses([fauxAssistantMessage("done")]);
    const runPromise = agent.run("first message of a fresh chat");
    // the marker is written synchronously at the top of run(), before the
    // model call — the session must already be listed, and titled
    listedMidRun = listSessions(p);
    await runPromise;

    expect(listedMidRun.length).toBe(1);
    expect(listedMidRun[0]!.title).toBe("first message of a fresh chat");
    expect(listedMidRun[0]!.runs).toBe(0); // no finished run yet
    expect(listSessions(p)[0]!.runs).toBe(1);
  }, 30_000);

  it("denied write surfaces refusal to the model, run still completes", async () => {
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    users.create("mallory", "user", { password: "test-pass-1" });
    const svc = makeSvc("mallory");
    const handle = fauxProvider({ models: [{ id: "faux-agent" }] });
    const toolCall = fauxAssistantMessage(
      [{ type: "toolCall", id: "tc1", name: "write_file", arguments: { path: "auth.json", content: "{}" } }],
      { stopReason: "toolUse" },
    );
    handle.setResponses([toolCall, fauxAssistantMessage("I was refused.")]);
    svc.models.setProvider(handle.provider);
    const p = userPaths(dataDir, "mallory");
    const agent = await UserAgent.create("mallory", svc, p, users, defaultInstanceConfig());
    const r = await agent.run("overwrite auth.json");
    expect(r.toolTrace[0]!.summary).toContain("Refused");
    // auth.json untouched (may not exist for a fresh user — either way no overwrite)
    const auth = p.auth;
    if (fs.existsSync(auth)) expect(fs.readFileSync(auth, "utf8")).not.toContain("{}");
    expect(r.finalText.toLowerCase()).toContain("refus");
  }, 30_000);
});
