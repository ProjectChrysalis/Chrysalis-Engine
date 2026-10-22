/**
 * Prompt caching: a provider that caches by prefix only helps while every
 * request opens with exactly what the one before it sent. These tests drive
 * the agent through the things that used to rewrite the system prompt and
 * check that each request extends the previous one.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { UserAgent, promptFile } from "../src/agent/agent.js";
import { defaultInstanceConfig } from "../src/config.js";
import { UserModelService } from "../src/models.js";
import { bootstrapUserDir } from "../src/paths.js";
import { UserService } from "../src/users.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-cache-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

type Wire = { role: string; content: unknown; sections?: unknown }[];
/** What reaches the provider, without the bookkeeping it never sees. */
const wire = (messages: readonly { role: string; content?: unknown; sections?: unknown }[]): Wire =>
  messages.map((m) => ({ role: m.role, content: m.content, ...(m.sections ? { sections: m.sections } : {}) }));

function setup(midConversationSystem: boolean) {
  const users = new UserService(root);
  users.create("alice", "user", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice");
  for (const id of ["first", "second"]) {
    fs.mkdirSync(path.join(p.apps, id), { recursive: true });
    fs.writeFileSync(path.join(p.apps, id, "manifest.json"), JSON.stringify({ name: id, kind: "web", version: "1.0.0" }));
    fs.writeFileSync(path.join(p.apps, id, "AGENTS.md"), `${id} contract`);
  }
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "cache-model" }] });
  svc.models.setProvider(midConversationSystem
    ? { ...faux.provider, getModels: () => faux.provider.getModels().map((m) => ({ ...m, compat: { supportsMidConvoSystemMessages: true } })) } as typeof faux.provider
    : faux.provider);
  const requests: Wire[] = [];
  const reply = (make: () => ReturnType<typeof fauxAssistantMessage>) =>
    (context: { messages: readonly { role: string; content?: unknown; sections?: unknown }[] }) => { requests.push(wire(context.messages)); return make(); };
  return { users, p, svc, faux, requests, reply };
}

for (const midConversationSystem of [false, true]) {
  it(`every request extends the one before it (${midConversationSystem ? "system updates in place" : "updates as user turns"})`, async () => {
    const { users, p, svc, faux, requests, reply } = setup(midConversationSystem);
    faux.setResponses([
      reply(() => fauxAssistantMessage([{ type: "toolCall", id: "pick", name: "app_target", arguments: { appId: "first" } }], { stopReason: "toolUse" })),
      reply(() => fauxAssistantMessage("Working on first.")),
    ]);
    const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "cache" });
    await agent.run("Open the first app");

    // the user edits instructions between runs; the agent is rebuilt for it
    fs.writeFileSync(path.join(p.root, "notes", "plan.md"), "# Ship the cache work\n");
    fs.writeFileSync(p.persona, "Answer briefly.");
    fs.writeFileSync(path.join(p.apps, "first", "AGENTS.md"), "first contract, revised");
    faux.setResponses([reply(() => fauxAssistantMessage("Noted."))]);
    const resumed = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "cache" });
    await resumed.run("Anything new?");

    faux.setResponses([reply(() => fauxAssistantMessage("Same as before."))]);
    await resumed.run("And now?");

    expect(requests).toHaveLength(4);
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i]!.slice(0, requests[i - 1]!.length)).toEqual(requests[i - 1]!);
    }
    const sent = JSON.stringify(requests.at(-1));
    // the changes reached the model, once each
    for (const text of ["first contract, revised", "Answer briefly.", "notes/plan.md"]) {
      expect(sent).toContain(text);
      expect(sent.split(text).length).toBe(2);
    }
    // an unchanged context adds nothing
    expect(requests[3]!.length).toBe(requests[2]!.length + 2);
    expect(JSON.stringify(requests[0]![0])).not.toContain("first contract");
    expect(fs.existsSync(promptFile(p, "cache"))).toBe(true);
  }, 20_000);
}

it("a conversation that began in plan mode is told when it ends", async () => {
  const { users, p, svc, faux, requests, reply } = setup(false);
  faux.setResponses([reply(() => fauxAssistantMessage("Here is the plan."))]);
  await (await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "mode", mode: "plan" })).run("Plan it");
  faux.setResponses([reply(() => fauxAssistantMessage("Done."))]);
  await (await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "mode" })).run("Do it");
  const last = JSON.stringify(requests.at(-1));
  expect(last.lastIndexOf("Plan mode is off")).toBeGreaterThan(last.lastIndexOf("[PLAN MODE ACTIVE]"));
}, 20_000);
