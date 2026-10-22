import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { UserAgent } from "../src/agent/agent.js";
import { defaultInstanceConfig } from "../src/config.js";
import { UserModelService } from "../src/models.js";
import { bootstrapUserDir } from "../src/paths.js";
import { UserService } from "../src/users.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "helpers-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

type Sent = { messages: { role: string; content?: unknown; toolsAdded?: { name: string }[] }[] };

function setup(helpers: boolean) {
  const users = new UserService(root);
  users.create("alice", "user", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice");
  fs.writeFileSync(p.settings, JSON.stringify({ helpers }));
  fs.writeFileSync(path.join(p.root, "notes", "cards.md"), "# Cards\nEmber has the tag fire.\n");
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "m" }] });
  svc.models.setProvider(faux.provider);
  return { users, p, svc, faux };
}

const toolNames = (sent: Sent) => (sent.messages[0]?.toolsAdded ?? []).map((t) => t.name);

it("is offered only when switched on", async () => {
  for (const on of [false, true]) {
    const { users, p, svc, faux } = setup(on);
    let sent: Sent | undefined;
    faux.setResponses([(c) => { sent = c as Sent; return fauxAssistantMessage("ok"); }]);
    await (await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: `s${on}` })).run("hi");
    expect(toolNames(sent!).includes("helper")).toBe(on);
    fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), "helpers-"));
  }
}, 20_000);

it("runs a read-only helper on its own context and returns only its answer", async () => {
  const { users, p, svc, faux } = setup(true);
  const sent: Sent[] = [];
  const record = (make: () => ReturnType<typeof fauxAssistantMessage>) => (c: unknown) => { sent.push(c as Sent); return make(); };
  faux.setResponses([
    record(() => fauxAssistantMessage([{ type: "toolCall", id: "h", name: "helper", arguments: { job: "Which tag does Ember have? Report the tag." } }], { stopReason: "toolUse" })),
    record(() => fauxAssistantMessage([{ type: "toolCall", id: "r", name: "read_file", arguments: { path: "notes/cards.md" } }], { stopReason: "toolUse" })),
    record(() => fauxAssistantMessage("Ember: fire (notes/cards.md:2)")),
    record(() => fauxAssistantMessage("Ember is a fire card.")),
  ]);
  const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "help" });
  await agent.run("Look up Ember's tag");

  const [, helperFirst, helperSecond, parentLast] = sent;
  // the helper starts fresh: its prompt, read tools, and the job, nothing of the chat
  expect(toolNames(helperFirst!).sort()).toEqual(["app_console", "app_inspect", "grep", "read_file", "skill_inspect", "skill_read", "tool_output"]);
  expect(JSON.stringify(helperFirst!.messages)).not.toContain("Look up Ember's tag");
  expect(JSON.stringify(helperSecond!.messages)).toContain("Ember has the tag fire.");
  // the conversation sees the answer, not the reading
  const parent = JSON.stringify(parentLast!.messages);
  expect(parent).toContain("Ember: fire (notes/cards.md:2)");
  expect(parent).not.toContain("Ember has the tag fire.");
}, 20_000);
