import { expect, it } from "bun:test";

it("restores per-chat targets, waits for selection, and retains model-selected targets", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { useAgent } from "./client-agent/src/store.ts";
    const state = () => useAgent.getState();
    const json = (value) => new Response(JSON.stringify(value));
    let releaseTarget;
    let sent;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/target")) return new Promise((resolve) => { releaseTarget = () => resolve(json({ appId: JSON.parse(init.body).appId })); });
      if (url === "/v1/agent/state?sessionId=one") return json({ running: false, queue: [] });
      if (url === "/v1/agent/sessions/one") return json({ appId: "first", runs: [] });
      if (url === "/v1/agent") { sent = JSON.parse(init.body); return json({ sessionId: sent.sessionId, appId: "third", finalText: "ok", turns: [], toolTrace: [] }); }
      return json({ sessions: [] });
    };
    await state().open("one");
    assert.equal(state().appId, "first");
    const selecting = state().setApp("second");
    const sending = state().send("Read this field");
    assert.equal(sent, undefined);
    releaseTarget();
    await selecting;
    await sending;
    assert.equal(sent.appId, "second");
    assert.equal(state().appId, "third");
    state().newChat();
    assert.equal(state().appId, null);
    await state().setApp("first");
    assert.equal(state().appId, "first");
    await state().open("one");
    const oldSelection = state().setApp("second");
    state().newChat();
    releaseTarget();
    await oldSelection;
    assert.equal(state().appId, null);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe("");
  expect(exit).toBe(0);
}, 5_000);

it("restores interleaved live turns and ignores duplicate stream events after reconnect", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { useAgent, connectWs } from "./client-agent/src/store.ts";
    globalThis.location = { protocol: "http:", host: "localhost", origin: "http://localhost" };
    globalThis.window = { setTimeout, clearTimeout };
    window.parent = window;
    let socket;
    globalThis.WebSocket = class { constructor() { socket = this; } };
    const live = { id: "run", seq: 5, user: "first user", events: [{ type: "text", delta: "first answer" }, { type: "queue_sent", id: "queued", text: "second user" }, { type: "text", delta: "second answer" }] };
    globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes("/state?") ? { running: true, queue: [], live } : { appId: "studio", runs: [] }));
    await useAgent.getState().open("one");
    assert.equal(useAgent.getState().msgs.length, 4);
    connectWs(); socket.onopen();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(useAgent.getState().msgs.length, 4);
    const delta = (seq, text) => socket.onmessage({ data: JSON.stringify({ type: "agent_delta", payload: { sessionId: "one", runId: "run", seq, delta: text } }) });
    delta(5, "duplicate"); delta(6, " new"); delta(6, "duplicate");
    await new Promise(resolve => setTimeout(resolve, 60));
    const messages = JSON.stringify(useAgent.getState().msgs);
    assert(!messages.includes("duplicate"));
    assert(messages.includes("second answer new"));
    assert.equal((messages.match(/first answer/g) || []).length, 1);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(""); expect(exit).toBe(0);
}, 5_000);

it("replaces streamed messages with saved history without creating inaccessible branches", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { ExternalStoreThreadRuntimeCore } from "./client-agent/node_modules/@assistant-ui/core/dist/internal.js";
    import { threadMessageRepository } from "./client-agent/src/thread-messages.ts";
    const message = (id, role, text, streaming = false) => ({ id, role, parts: [{ kind: "text", text }], streaming });
    const adapter = (messages, isRunning = false) => ({ messageRepository: threadMessageRepository(messages), isRunning, onNew: async () => {} });
    const runtime = new ExternalStoreThreadRuntimeCore({ getModelContext: () => ({}) }, adapter([]));
    runtime.__internal_setAdapter(adapter([message("user_live", "user", "high"), message("answer_live", "assistant", "Hi", true)], true));
    runtime.__internal_setAdapter(adapter([message("u100", "user", "high"), message("a100", "assistant", "Hi") ]));
    assert.deepEqual(runtime.messages.map(message => message.id), ["u100", "a100"]);
    assert.equal(runtime.getBranches("u100").length, 1);
    assert.equal(runtime.getBranches("a100").length, 1);
    runtime.__internal_setAdapter(adapter([message("u100", "user", "high"), message("a100", "assistant", "Hi again") ]));
    assert.equal(runtime.getBranches("a100").length, 1);
    assert.equal(runtime.messages.at(-1).content[0].text, "Hi again");
    runtime.__internal_setAdapter(adapter([]));
    assert.equal(runtime.messages.length, 0);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(""); expect(exit).toBe(0);
}, 5_000);

it("sends an attached item once and clears it when the agent changes apps", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { useAgent, connectWs } from "./client-agent/src/store.ts";
    const requests = [];
    globalThis.fetch = async (url, init) => {
      if (url === "/v1/agent") { const body = JSON.parse(init.body); requests.push(body); return Response.json({ sessionId: body.sessionId, appId: "first", finalText: "ok", turns: [], toolTrace: [] }); }
      return Response.json(String(url).includes("/state?") ? { running: false, queue: [] } : { appId: "first", runs: [], sessions: [] });
    };
    useAgent.setState({ appId: "first", selection: { appId: "first", selection: { label: "Preset: Example", presetId: "preset" } } });
    await useAgent.getState().send("Read this preset");
    assert.equal(requests[0].selection.selection.presetId, "preset");
    assert.equal(useAgent.getState().selection, null);
    await useAgent.getState().send("Thanks");
    assert.equal(requests[1].selection, undefined);
    globalThis.location = { protocol: "http:", host: "localhost", origin: "http://localhost" };
    globalThis.window = { setTimeout, clearTimeout }; window.parent = window;
    let socket; globalThis.WebSocket = class { constructor() { socket = this; } };
    useAgent.setState({ selection: { appId: "first", selection: { label: "Old item" } }, availableSelection: { appId: "first", selection: { label: "Old item" } } });
    connectWs();
    socket.onmessage({ data: JSON.stringify({ type: "agent_target", payload: { sessionId: useAgent.getState().sessionId, appId: "second" } }) });
    assert.equal(useAgent.getState().appId, "second");
    assert.equal(useAgent.getState().selection, null);
    assert.equal(useAgent.getState().availableSelection, null);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(""); expect(exit).toBe(0);
}, 5_000);

it("keeps context usage during a run, updates it from events, and restores it after reconnect", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { useAgent, connectWs } from "./client-agent/src/store.ts";
    globalThis.location = { protocol: "http:", host: "localhost" };
    globalThis.window = { setTimeout, clearTimeout };
    window.parent = window;
    let socket;
    globalThis.WebSocket = class { constructor() { socket = this; } };
    const state = () => useAgent.getState();
    const previous = { input: 100, output: 10, cacheRead: 50 };
    const current = { input: 200, output: 20, cacheRead: 80, contextWindow: 10000 };
    let saved = [{ type: "run", at: 1, usage: previous }];
    let live = null;
    let request;
    const json = value => new Response(JSON.stringify(value));
    globalThis.fetch = async (url, init) => {
      if (url === "/v1/agent") return new Promise(resolve => { request = { resolve, body: JSON.parse(init.body) }; });
      if (String(url).includes("/state?")) return json({ running: !!live, queue: [], live });
      if (String(url).includes("/sessions/")) return json({ appId: null, runs: saved });
      return json([]);
    };
    await state().open("one");
    assert.deepEqual(state().usage, previous);
    const run = state().send("continue");
    assert.equal(state().running, true);
    assert.deepEqual(state().usage, previous);
    connectWs();
    const event = (sid, seq, ev) => socket.onmessage({ data: JSON.stringify({ type: "agent_event", payload: { sessionId: sid, runId: "run", seq, ev } }) });
    event("other", 1, { type: "usage", usage: current });
    assert.deepEqual(state().usage, previous);
    event("one", 1, { type: "usage", usage: current });
    assert.equal(state().running, true);
    assert.deepEqual(state().usage, current);
    event("one", 1, { type: "usage", usage: previous });
    assert.deepEqual(state().usage, current);
    saved = [{ type: "run", at: 2, usage: current }];
    request.resolve(json({ sessionId: "one", finalText: "done", turns: [], toolTrace: [], usage: current, contextWindow: 10000 }));
    await run;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(state().usage, current);
    state().newChat();
    assert.equal(state().usage, null);
    live = { id: "restored", seq: 3, user: "working", events: [{ type: "usage", usage: current }] };
    await state().open("one");
    assert.equal(state().running, true);
    assert.deepEqual(state().usage, current);
    event("one", 4, { type: "autocompact" });
    assert.equal(state().usage, null);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(""); expect(exit).toBe(0);
}, 5_000);
