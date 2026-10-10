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
