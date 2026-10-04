import { expect, it } from "bun:test";

it("stops the first message, settles a steered run, and ignores an old chat's completion", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { useAgent } from "./client-agent/src/store.ts";
    const pending = [];
    let stopCalls = 0;
    let lastStop;
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    globalThis.fetch = async (url, init) => {
      if (url === "/v1/agent") return new Promise(resolve => pending.push({ body: JSON.parse(init.body), resolve }));
      if (url === "/v1/agent/stop") {
        lastStop = JSON.parse(init.body);
        if (++stopCalls === 1) return json({ error: "no active run for this session" }, 409);
        return json({ ok: true });
      }
      if (url === "/v1/agent/steer") return json({ ok: true });
      if (String(url).includes("/sessions/")) return json({ runs: [] });
      return json([]);
    };
    const state = () => useAgent.getState();
    const reply = (request, extra = {}) => request.resolve(json({ sessionId: request.body.sessionId, finalText: "partial", turns: [], toolTrace: [], ...extra }));
    const first = state().send("hello");
    assert.ok(state().sessionId);
    const stop = state().stop();
    assert.equal(state().stopping, true);
    assert.equal(state().banner.text, "Stopping…");
    await stop;
    assert.equal(lastStop.sessionId, pending[0].body.sessionId);
    assert.equal(stopCalls, 2);
    reply(pending[0], { stopped: true });
    await first;
    assert.equal(state().running, false);
    assert.equal(state().banner.text, "Stopped");
    state().newChat();
    const steered = state().send("start");
    await state().send("change direction");
    reply(pending[1], { stopReason: "length" });
    await steered;
    assert.equal(state().running, false);
    assert.equal(state().banner.text, "Response reached the output limit.");
    state().newChat();
    const old = state().send("old");
    state().newChat();
    const current = state().send("current");
    const sid = state().sessionId;
    reply(pending[2], { stopped: true });
    await old;
    assert.equal(state().sessionId, sid);
    assert.equal(state().running, true);
    reply(pending[3]);
    await current;
    assert.equal(state().running, false);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe("");
  expect(exit).toBe(0);
}, 5_000);
