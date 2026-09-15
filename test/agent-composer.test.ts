/**
 * The composer's "@" file picker. Both of these were wrong on the first cut
 * and only showed up when someone used it: the popover opened as an empty
 * sliver, and picking a file put the mention markup into the message.
 */
import fs from "node:fs";
import { describe, expect, it } from "bun:test";
import { fileTriggerAdapter, filePathDirective, fileTriggerItem } from "../client-agent/src/file-mentions.js";

describe("the @ file picker", () => {
  it("puts the path in the message, not the mention markup", () => {
    const item = fileTriggerItem("plugins/sniffer/plugin.js");
    expect(filePathDirective.serialize(item)).toBe("@plugins/sniffer/plugin.js");
    // the stock formatter's shape, which is what leaked into the chat
    expect(filePathDirective.serialize(item)).not.toContain(":file[");
    expect(filePathDirective.serialize(item)).not.toContain("{name=");
  });

  it("leaves the composer text alone when reading it back", () => {
    const text = "look at @plugins/sniffer/plugin.js and tell me why";
    expect(filePathDirective.parse(text)).toEqual([{ kind: "text", text }]);
  });

  it("shows files as soon as @ is typed, with no category to drill into", () => {
    const files = ["plugins/sniffer/plugin.js", "notes/plan.md"];
    const adapter = fileTriggerAdapter(files, () => {});
    // a category would leave the popover empty until something is typed
    expect(adapter.categories()).toEqual([]);
    expect(adapter.search!("").map((i) => i.id)).toEqual(files);
  });

  it("matches anywhere in the path, case-insensitively", () => {
    const adapter = fileTriggerAdapter(["plugins/sniffer/plugin.js", "notes/plan.md"], () => {});
    expect(adapter.search!("SNIFF").map((i) => i.id)).toEqual(["plugins/sniffer/plugin.js"]);
    expect(adapter.search!("plan").map((i) => i.id)).toEqual(["notes/plan.md"]);
    expect(adapter.search!("nothing here").map((i) => i.id)).toEqual([]);
  });

  it("asks the engine for what was just typed", () => {
    const asked: string[] = [];
    const adapter = fileTriggerAdapter([], (q) => asked.push(q));
    adapter.search!("Plugin");
    expect(asked).toEqual(["plugin"]);
  });

  it("shows the file name, with the path underneath it", () => {
    const item = fileTriggerItem("apps/roleplay/src/lib/store.ts");
    expect(item.label).toBe("store.ts");
    expect(item.description).toBe("apps/roleplay/src/lib/store.ts");
  });
});

/**
 * "@path" in a message means the person is pointing at a file. Reading it
 * before the turn saves the model going to find out what they meant.
 */
describe("files named with @ reach the model", () => {
  const src = fs.readFileSync(new URL("../src/server/app.ts", import.meta.url), "utf8");

  it("reads them through the same guard the file tools use", () => {
    const fn = src.slice(src.indexOf("const readMentionedFiles"), src.indexOf("const readMentionedFiles") + 1400);
    expect(fn).toContain("agentReadDenied");
    expect(fn).toContain("safeResolve");
  });

  it("caps how much one message can drag in", () => {
    const fn = src.slice(src.indexOf("const readMentionedFiles"), src.indexOf("const readMentionedFiles") + 1400);
    expect(src).toContain("MENTION_BYTES = 64 * 1024");
    expect(fn).toContain("out.length >= 10");
  });

  it("skips binaries, which are noise rather than context", () => {
    const fn = src.slice(src.indexOf("const readMentionedFiles"), src.indexOf("const readMentionedFiles") + 1400);
    expect(fn).toContain("includes(0)");
  });

  it("keeps the typed message in the transcript, not the file's contents", () => {
    const agentSrc = fs.readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
    // markStarted records what was typed; only the prompt carries the files
    expect(agentSrc).toContain("this.markStarted(userMessage)");
    expect(agentSrc).toContain("this.agent.prompt(promptText");
  });
});
