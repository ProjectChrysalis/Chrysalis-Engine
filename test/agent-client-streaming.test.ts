import { describe, expect, it } from "bun:test";
import {
  createStreamDeltaBatcher,
  type DeltaFlushScheduler,
  type StreamDeltaEvent,
  type StreamEvent,
} from "../client-agent/src/streaming.js";
import { applyStreamEvent, partsFromTurns, visibleParts, type PartData } from "../client-agent/src/runs.js";

function manualScheduler() {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  const scheduler: DeltaFlushScheduler = {
    schedule: (callback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      callbacks.delete(handle);
    },
  };
  return {
    scheduler,
    pending: () => callbacks.size,
    tick: () => {
      const scheduled = [...callbacks.values()];
      callbacks.clear();
      for (const callback of scheduled) callback();
    },
  };
}

describe("agent stream delta batching", () => {
  it("commits a fast reasoning stream once per scheduled flush without losing text", () => {
    const commits: StreamDeltaEvent[][] = [];
    const clock = manualScheduler();
    const batcher = createStreamDeltaBatcher((events) => commits.push(events), clock.scheduler);
    const expected = "abcdefghijklmnopqrstuvwxyz".repeat(200);

    for (const delta of expected) batcher.enqueue({ type: "thinking", delta });

    expect(commits).toHaveLength(0);
    expect(clock.pending()).toBe(1);
    clock.tick();
    expect(commits).toEqual([[{ type: "thinking", delta: expected }]]);
  });

  it("coalesces adjacent deltas while preserving phase order", () => {
    const commits: StreamDeltaEvent[][] = [];
    const clock = manualScheduler();
    const batcher = createStreamDeltaBatcher((events) => commits.push(events), clock.scheduler);

    batcher.enqueue({ type: "thinking", delta: "plan " });
    batcher.enqueue({ type: "thinking", delta: "first" });
    batcher.enqueue({ type: "text", delta: "answer" });
    batcher.enqueue({ type: "thinking", delta: "second thought" });
    batcher.flush();

    expect(clock.pending()).toBe(0);
    expect(commits).toEqual([[
      { type: "thinking", delta: "plan first" },
      { type: "text", delta: "answer" },
      { type: "thinking", delta: "second thought" },
    ]]);
    clock.tick();
    expect(commits).toHaveLength(1);
  });

  it("drops a pending frame when the open thread changes", () => {
    const commits: StreamDeltaEvent[][] = [];
    const clock = manualScheduler();
    const batcher = createStreamDeltaBatcher((events) => commits.push(events), clock.scheduler);

    batcher.enqueue({ type: "thinking", delta: "old thread" });
    batcher.reset();
    clock.tick();

    expect(commits).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });
});

describe("agent steps: live stream and saved run lay out the same", () => {
  const stream: StreamEvent[] = [
    { type: "thinking", delta: "look first" },
    { type: "thinking_end", ms: 400 },
    { type: "text", delta: "Checking." },
    // announced as the model writes it, again with arguments, again as it runs
    { type: "tool_start", id: "c1", name: "read_file", args: {} },
    { type: "tool_start", id: "c1", name: "read_file", args: { path: "a.txt" } },
    { type: "tool_start", id: "c1", name: "read_file", args: { path: "a.txt" } },
    { type: "tool_end", id: "c1", ok: true, summary: "abc", output: "abc…full" },
    { type: "thinking", delta: "now answer" },
    { type: "thinking_end", ms: 900 },
    { type: "text", delta: "Done." },
  ];

  it("a thinking phase after a tool call stays after it, and one call is one step", () => {
    const live = stream.reduce<PartData[]>((parts, ev) => applyStreamEvent(parts, ev), []);
    expect(live.map((p) => p.kind)).toEqual(["think", "text", "tool", "think", "text"]);
    expect(live[0]).toMatchObject({ text: "look first", ms: 400, done: true });
    expect(live[2]).toMatchObject({ name: "read_file", args: { path: "a.txt" }, state: "ok", output: "abc…full" });
    expect(live[3]).toMatchObject({ text: "now answer", ms: 900 });

    const saved = partsFromTurns([
      { thinking: "look first", thinkingMs: 400, text: "Checking.", tools: [{ name: "read_file", ok: true, summary: "abc", output: "abc…full", args: { path: "a.txt" } }] },
      { thinking: "now answer", thinkingMs: 900, text: "Done.", tools: [] },
    ]);
    const shape = (parts: PartData[]) => parts.map((p) => (p.kind === "tool" ? { ...p, callId: "" } : p));
    expect(shape(saved)).toEqual(shape(live));
  });

  it("a blank thinking fragment is not a step", () => {
    const msg = { id: "m", role: "assistant" as const, parts: applyStreamEvent([], { type: "thinking", delta: " \n" }) };
    expect(visibleParts(msg)).toEqual([]);
  });
});
