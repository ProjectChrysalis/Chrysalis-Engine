/**
 * Regex + preset assembly semantics — the studio replace pipeline
 * ({{match}}/groups/trims/macros), scope filtering and ordering, world-info
 * placement, edit-time rewriting, and the preset-section gates
 * (forbid overrides, generation triggers). Driven through the engine plugin
 * with the same mock-host harness as the studio suite.
 */
import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const engineUrl = new URL("../apps/roleplay/plugins/engine/plugin.js", import.meta.url).href;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rpregex-"));
  for (const d of ["characters", "personas", "presets", "regex", "groups", "lorebooks", "chats"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, "presets", "default.json"),
    JSON.stringify({ id: "default", name: "Default", prompts: [], prompt_order: [], temperature: 0.8, top_p: 0.95, openai_max_tokens: 512, openai_max_context: 8192 }),
  );
  fs.mkdirSync(path.join(root, "characters", "aria"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "characters", "aria", "card.json"),
    JSON.stringify({
      spec: "chara_card_v2", name: "Aria",
      description: "A barista.", personality: "dry", scenario: "night",
      first_mes: "Welcome in, [System: noise] traveler.", mes_example: "",
    }),
  );
  fs.writeFileSync(path.join(root, "personas", "you.json"), JSON.stringify({ id: "you", name: "You", description: "" }));
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ model: null, personaId: "you" }));
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* watcher races */ }
});

function mockHost() {
  const results: Record<string, unknown> = {};
  const requests: { key: string; req: Record<string, unknown> }[] = [];
  const resolve = () => {
    for (const { key } of requests) {
      results[key] = { text: "MOCK-REPLY", model: "mock/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0 } };
    }
  };
  const host = {
    fs: {
      root,
      read: (rel: string) => fs.readFileSync(path.resolve(root, rel), "utf8"),
      write: (rel: string, content: string) => {
        const full = path.resolve(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
      },
      list: (rel = ".") => fs.readdirSync(path.resolve(root, rel)).sort(),
      remove: (rel: string) => fs.rmSync(path.resolve(root, rel), { recursive: true, force: true }),
    },
    store: { get: () => null, put: () => {}, delete: () => {}, keys: () => [] },
    llm: {
      request: (key: string, req: Record<string, unknown>) => { requests.push({ key, req }); },
      results,
      embed: () => {},
      embedResults: {},
    },
    net: { request: () => {}, results: {} },
    zip: { entries: () => { throw new Error("no zip"); }, list: () => 0 },
    log: () => {},
  };
  return { host, requests, resolve };
}

async function drive(
  req: { method: string; path: string; body?: unknown },
  mock: ReturnType<typeof mockHost>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const mod = (await import(engineUrl)) as { handleRoute: Function };
  const results = mock.host.llm.results as Record<string, unknown>;
  for (const k of Object.keys(results)) delete results[k];
  const qIdx = req.path.indexOf("?");
  const query: Record<string, string> = {};
  let pathOnly = req.path;
  if (qIdx >= 0) {
    pathOnly = req.path.slice(0, qIdx);
    for (const [k, v] of new URLSearchParams(req.path.slice(qIdx + 1))) query[k] = v;
  }
  const call = { method: req.method, path: pathOnly, query, body: req.body };
  let out = mod.handleRoute(call, mock.host) as { status?: number; json?: Record<string, unknown>; __llmPending?: boolean; stash?: Record<string, unknown> };
  for (let pass = 0; out && out.__llmPending && pass < 3; pass++) {
    if (out.stash && typeof out.stash === "object") (call as { stash?: unknown }).stash = out.stash;
    mock.resolve();
    out = mod.handleRoute(call, mock.host) as typeof out;
  }
  return { status: out?.status ?? 200, json: (out?.json ?? {}) as Record<string, unknown> };
}

let rxSeq = 0;
/** write a regex script the way the client PUTs it */
function writeRegex(fields: Record<string, unknown>, name = "script") {
  const id = `rx${String(++rxSeq).padStart(3, "0")}`;
  fs.writeFileSync(path.join(root, "regex", `${id}.json`), JSON.stringify({ id, scriptName: name, ...fields }));
  return id;
}

async function newChat(mock: ReturnType<typeof mockHost>) {
  const r = await drive({ method: "POST", path: "/chats", body: { characterId: "aria" } }, mock);
  expect([200, 201]).toContain(r.status);
  return (r.json.meta as Record<string, unknown>).id as string;
}

/** send a user turn (two-phase) and return the joined llm request contents */
async function sendAndCapture(mock: ReturnType<typeof mockHost>, chatId: string, text: string) {
  const r = await drive({ method: "POST", path: `/chats/${chatId}/send`, body: { text } }, mock);
  expect(r.status).toBe(200);
  const req = mock.requests[0]!.req as { messages?: { role: string; content: string }[] };
  return (req.messages ?? []).map((m) => m.content).join("\n");
}

describe("regex replace semantics", () => {
  it("{{match}} carries the trimmed whole match, $n the trimmed group, missing groups vanish", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    writeRegex({
      // trims strip the wrapper from the whole match and each captured group
      findRegex: "\\[(System): (noise)\\]", replaceString: "<<{{match}}|$1-$2|$3>>",
      trimStrings: ["[System: ", "]"], placement: ["ai_output"], flags: "g",
    });
    const out = await sendAndCapture(m, chatId, "hello");
    // {{match}} = the whole match with trims applied ("[System: noise]" →
    // "noise"), $1/$2 the trimmed groups, $3 doesn't exist and vanishes
    // instead of leaking the match offset
    expect(out).toContain("<<noise|System-noise|>>");
    expect(out).not.toContain("[System:");
  });

  it("macroMode raw substitutes macros into the find pattern", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    await drive({ method: "PATCH", path: `/chats/${chatId}`, body: { userName: "Bob" } }, m);
    writeRegex({ findRegex: "^Bob: ", replaceString: "", placement: ["user_input"], flags: "g", macroMode: "raw" });
    const out = await sendAndCapture(m, chatId, "Bob: hi there");
    expect(out).toContain("hi there");
    expect(out).not.toContain("Bob: hi there");
  });

  it("macroMode escaped treats the substituted value as a literal", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    fs.writeFileSync(path.join(root, "personas", "you.json"), JSON.stringify({ id: "you", name: "B.b", description: "" }));
    // escaped: "B.b" matches only the literal dot, not "Bxb"
    writeRegex({ findRegex: "speaking as {{user}}", replaceString: "NAME", placement: ["user_input"], flags: "g", macroMode: "escaped" });
    const out = await sendAndCapture(m, chatId, "speaking as B.b and speaking as Bxb");
    expect(out).toContain("NAME and speaking as Bxb");
  });

  it("macros substitute in the replacement", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    writeRegex({ findRegex: "traveler", replaceString: "traveler (welcome from {{char}})", placement: ["ai_output"], flags: "g" });
    const out = await sendAndCapture(m, chatId, "hello");
    expect(out).toContain("traveler (welcome from Aria)");
  });
});

describe("regex scoping", () => {
  it("preset-scoped scripts fire only on that preset's chats", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    writeRegex({ findRegex: "traveler", replaceString: "WANDERER", placement: ["ai_output"], flags: "g", scope: "preset", scopeTargetId: "default" }, "on-preset");
    writeRegex({ findRegex: "Welcome", replaceString: "Greetings", placement: ["ai_output"], flags: "g", scope: "preset", scopeTargetId: "other" }, "off-preset");
    const out = await sendAndCapture(m, chatId, "hello");
    expect(out).toContain("WANDERER");
    expect(out).toContain("Welcome");
  });

  it("runs global before preset-scoped regardless of file order, then by order field", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    // only ONE execution order produces "P()": global(order 0) turns
    // "traveler" into MARK, global(order 1) turns MARK into CLASS, and the
    // preset script (whose file sorts FIRST) wraps it last
    writeRegex({ findRegex: "CLASS", replaceString: "P()", placement: ["ai_output"], flags: "g", scope: "preset", scopeTargetId: "default" }, "aaa-preset");
    writeRegex({ findRegex: "MARK", replaceString: "CLASS", placement: ["ai_output"], flags: "g", order: 1 }, "zzz-global");
    writeRegex({ findRegex: "traveler", replaceString: "MARK", placement: ["ai_output"], flags: "g", order: 0 }, "zzz-global-2");
    const out = await sendAndCapture(m, chatId, "hello");
    expect(out).toContain("P()");
    expect(out).not.toContain("CLASS");
    expect(out).not.toContain("MARK");
  });
});

describe("regex placements", () => {
  it("world-info scripts (placement wi) transform lorebook entry content", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    fs.writeFileSync(path.join(root, "lorebooks", "book.json"), JSON.stringify({
      id: "book", name: "Book", entries: [{ id: "e1", keys: ["welcome"], content: "SECRET-ENTRY text", enabled: true, constant: false }],
    }));
    await drive({ method: "PATCH", path: `/chats/${chatId}`, body: { lorebookIds: ["book"] } }, m);
    writeRegex({ findRegex: "SECRET", replaceString: "CLEAN", placement: ["wi"], flags: "g" });
    const out = await sendAndCapture(m, chatId, "welcome friend");
    expect(out).toContain("CLEAN-ENTRY");
    expect(out).not.toContain("SECRET");
  });

  it("prompt-placement scripts still cover world info", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    fs.writeFileSync(path.join(root, "lorebooks", "book.json"), JSON.stringify({
      id: "book", name: "Book", entries: [{ id: "e1", keys: ["welcome"], content: "SECRET-ENTRY text", enabled: true, constant: false }],
    }));
    await drive({ method: "PATCH", path: `/chats/${chatId}`, body: { lorebookIds: ["book"] } }, m);
    writeRegex({ findRegex: "SECRET", replaceString: "CLEAN", placement: ["prompt"], flags: "g" });
    const out = await sendAndCapture(m, chatId, "welcome friend");
    expect(out).toContain("CLEAN-ENTRY");
  });

  it("a user_input script leaves ai text alone and vice versa", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    writeRegex({ findRegex: "hello", replaceString: "HELLO-USER", placement: ["user_input"], flags: "g" });
    const out = await sendAndCapture(m, chatId, "hello");
    expect(out).toContain("HELLO-USER");
    expect(out).toContain("Welcome in"); // untouched ai text
  });
});

describe("edit-time rewriting (run on edit)", () => {
  it("rewrites the stored text for scripts opted into edits only", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    writeRegex({ findRegex: "\\[System: noise\\] ?", replaceString: "", placement: ["ai_output"], markdownOnly: false, promptOnly: false, flags: "g", runOnEdit: true }, "on-edit");
    writeRegex({ findRegex: "Welcome", replaceString: "NEVER", placement: ["ai_output"], markdownOnly: false, promptOnly: false, flags: "g" }, "no-edit");
    const chat = await drive({ method: "GET", path: `/chats/${chatId}` }, m);
    const greetingId = ((chat.json.messages as Record<string, unknown>[])[0]!.id) as string;
    const r = await drive({ method: "PATCH", path: `/chats/${chatId}/messages/${greetingId}`, body: { text: "Edited [System: noise] body" } }, m);
    expect(r.status).toBe(200);
    expect((r.json.message as Record<string, unknown>).text).toBe("Edited body");
  });
});

describe("regex stages (when a script applies)", () => {
  const stored = async (m: ReturnType<typeof mockHost>, chatId: string) =>
    ((await drive({ method: "GET", path: `/chats/${chatId}` }, m)).json.messages as { role: string; text: string }[]);

  it("a script with neither only-flag rewrites the saved reply and user turn", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    writeRegex({ findRegex: "MOCK", replaceString: "BAKED", placement: ["ai_output"], markdownOnly: false, promptOnly: false, flags: "g" });
    writeRegex({ findRegex: "hi", replaceString: "HELLO", placement: ["user_input"], markdownOnly: false, promptOnly: false, flags: "g" });
    await drive({ method: "POST", path: `/chats/${chatId}/send`, body: { text: "hi" } }, m);
    const msgs = await stored(m, chatId);
    expect(msgs.at(-1)!.text).toBe("BAKED-REPLY");
    expect(msgs.at(-2)!.text).toBe("HELLO");
    // the model already read the rewritten user turn
    const sent = (m.requests[0]!.req as { messages: { content: string }[] }).messages.map((x) => x.content).join("\n");
    expect(sent).toContain("HELLO");
  });

  it("a greeting is saved through the same scripts", async () => {
    const m = mockHost();
    writeRegex({ findRegex: "\\[System: noise\\] ", replaceString: "", placement: ["ai_output"], markdownOnly: false, promptOnly: false, flags: "g" });
    const chatId = await newChat(m);
    expect((await stored(m, chatId))[0]!.text).toBe("Welcome in, traveler.");
  });

  it("display-only scripts never reach the prompt or the saved text", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    writeRegex({ findRegex: "traveler", replaceString: "SHOWN", placement: ["ai_output"], markdownOnly: true, promptOnly: false, flags: "g" });
    const out = await sendAndCapture(m, chatId, "hello");
    expect(out).toContain("traveler");
    expect(out).not.toContain("SHOWN");
    expect((await stored(m, chatId))[0]!.text).toContain("traveler");
  });

  it("prompt-only scripts change what the model reads, not the saved text", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    writeRegex({ findRegex: "traveler", replaceString: "READ", placement: ["ai_output"], markdownOnly: false, promptOnly: true, flags: "g" });
    const out = await sendAndCapture(m, chatId, "hello");
    expect(out).toContain("READ");
    expect((await stored(m, chatId))[0]!.text).toContain("traveler");
  });

  it("world info is only rewritten by prompt-only scripts", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    fs.writeFileSync(path.join(root, "lorebooks", "book.json"), JSON.stringify({
      id: "book", name: "Book", entries: [{ id: "e1", keys: ["welcome"], content: "SECRET-ENTRY FOO text", enabled: true, constant: false }],
    }));
    await drive({ method: "PATCH", path: `/chats/${chatId}`, body: { lorebookIds: ["book"] } }, m);
    writeRegex({ findRegex: "SECRET", replaceString: "CLEAN", placement: ["wi"], markdownOnly: false, promptOnly: true, flags: "g" });
    writeRegex({ findRegex: "FOO", replaceString: "BAR", placement: ["wi"], markdownOnly: false, promptOnly: false, flags: "g" });
    const out = await sendAndCapture(m, chatId, "welcome friend");
    expect(out).toContain("CLEAN-ENTRY FOO");
  });

  it("scripts saved before the flags keep doing what they did (display + prompt, never saved)", async () => {
    const m = mockHost();
    const chatId = await newChat(m);
    writeRegex({ findRegex: "traveler", replaceString: "LEGACY", placement: ["ai_output", "display"], flags: "g" });
    const out = await sendAndCapture(m, chatId, "hello");
    expect(out).toContain("LEGACY");
    expect((await stored(m, chatId))[0]!.text).toContain("traveler");
  });
});

describe("preset section gates", () => {
  function writeGatedPreset(fields: { forbidOverrides?: boolean; triggers?: string[] }) {
    const sections = [
      { id: "main", name: "Main", role: "system", marker: "main", content: "PRESET-MAIN", enabled: true },
      { id: "gated", name: "Gated", role: "system", marker: null, content: "GATED-TEXT", enabled: true },
      { id: "chatHistory", name: "Chat History", role: "system", marker: "chatHistory", content: "", enabled: true },
    ];
    fs.writeFileSync(
      path.join(root, "presets", "default.json"),
      JSON.stringify({
        id: "default", name: "Default",
        prompts: sections.map((s) => ({ identifier: s.id, name: s.name, role: s.role, marker: !!s.marker, content: s.content })),
        prompt_order: [{ character_id: 100001, order: sections.map((s) => ({ identifier: s.id, enabled: s.enabled })) }],
        studio: {
          sections: [
            { id: "main", ...(fields.forbidOverrides ? { forbidOverrides: true } : {}) },
            { id: "gated", ...(fields.triggers ? { injectionTriggers: fields.triggers } : {}) },
          ],
        },
      }),
    );
  }

  it("the card's system prompt wins over the preset main unless it forbids overrides", async () => {
    fs.writeFileSync(
      path.join(root, "characters", "aria", "card.json"),
      JSON.stringify({ spec: "chara_card_v2", name: "Aria", description: "A barista.", first_mes: "Welcome in, traveler." , system_prompt: "CARD-SYS" }),
    );
    const m = mockHost();
    const chatId = await newChat(m);
    writeGatedPreset({});
    let out = await sendAndCapture(m, chatId, "hello");
    expect(out).toContain("CARD-SYS");
    expect(out).not.toContain("PRESET-MAIN");

    const m2 = mockHost();
    const chatId2 = await newChat(m2);
    writeGatedPreset({ forbidOverrides: true });
    out = await sendAndCapture(m2, chatId2, "hello");
    expect(out).toContain("PRESET-MAIN");
    expect(out).not.toContain("CARD-SYS");
  });

  it("a section gated to continue only appears on continue, not on send", async () => {
    writeGatedPreset({ triggers: ["continue"] });
    const m = mockHost();
    const chatId = await newChat(m);
    const out = await sendAndCapture(m, chatId, "hello");
    expect(out).not.toContain("GATED-TEXT");

    const m2 = mockHost();
    const chatId2 = await newChat(m2);
    const r = await drive({ method: "POST", path: `/chats/${chatId2}/continue`, body: {} }, m2);
    expect(r.status).toBe(200);
    const req = m2.requests[0]!.req as { messages?: { content: string }[] };
    const joined = (req.messages ?? []).map((x) => x.content).join("\n");
    expect(joined).toContain("GATED-TEXT");
  });

  it("a section with no trigger list always appears", async () => {
    writeGatedPreset({});
    const m = mockHost();
    const chatId = await newChat(m);
    const out = await sendAndCapture(m, chatId, "hello");
    expect(out).toContain("GATED-TEXT");
  });
});
