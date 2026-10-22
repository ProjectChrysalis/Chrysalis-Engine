import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { UserAgent } from "../src/agent/agent.js";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { defaultInstanceConfig } from "../src/config.js";
import { UserModelService } from "../src/models.js";
import { bootstrapUserDir, userPaths } from "../src/paths.js";
import { recordUsage, usageSummary, type UsageRow } from "../src/usage.js";
import { UserService } from "../src/users.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const row = (t: number, over: Partial<UsageRow> = {}): UsageRow => ({ t, src: "agent", model: "p/m", in: 100, out: 10, cr: 0, cw: 0, cost: 0.01, ...over });

it("totals by local day, model and source", () => {
  const dir = path.join(root, "usage");
  const now = Date.parse("2026-03-01T12:00:00Z");
  // 23:30 UTC on Feb 28 is already March 1 in Tokyo; the ledger spans two month files
  recordUsage(dir, row(Date.parse("2026-02-28T23:30:00Z")));
  recordUsage(dir, row(Date.parse("2026-02-27T10:00:00Z"), { src: "app:roleplay/engine", model: "p/other", cost: null, cr: 300 }));
  recordUsage(dir, row(now - 60_000, { src: "api:/v1/chat/completions", cost: 0.02 }));
  recordUsage(dir, row(Date.parse("2026-01-01T00:00:00Z")));
  recordUsage(dir, row(now, { in: 0, out: 0 }));

  const s = usageSummary(dir, 7, "Asia/Tokyo", now);
  expect(s.to).toBe("2026-03-01");
  expect(s.days).toHaveLength(7);
  expect(s.total.calls).toBe(3);
  expect(s.total.cost).toBeCloseTo(0.03);
  expect(s.total.unpriced).toBe(1);
  expect(s.days.at(-1)!.calls).toBe(2);
  expect(s.days.find((d) => d.date === "2026-02-27")!.cacheRead).toBe(300);
  expect(s.models.map((m) => m.model)).toEqual(["p/m", "p/other"]);
  expect(s.sources.map((x) => x.source).sort()).toEqual(["agent", "api", "app:roleplay"]);

  expect(usageSummary(dir, 7, "UTC", now).days.at(-1)!.calls).toBe(1);
});

it("records each provider turn of an agent run, cache reads included", async () => {
  const users = new UserService(root);
  users.create("alice", "user", { password: "test-password-1" });
  const p = bootstrapUserDir(root, "alice");
  const svc = new UserModelService("alice", p, defaultInstanceConfig());
  const faux = fauxProvider({ models: [{ id: "priced", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }] });
  svc.models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([{ type: "toolCall", id: "a", name: "skill_load", arguments: { name: "chrysalis-docs" } }], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const agent = await UserAgent.create("alice", svc, p, users, defaultInstanceConfig(), { sessionId: "spend" });
  await agent.run("Look something up");
  await Bun.sleep(10);

  const s = usageSummary(p.usage, 1, "UTC");
  expect(s.total.calls).toBe(2);
  expect(s.sources.map((x) => x.source)).toEqual(["agent"]);
  expect(s.total.cacheRead).toBeGreaterThan(0);
  expect(s.total.unpriced).toBe(0);
  const t = s.total;
  expect(t.cost).toBeCloseTo((t.input * 1 + t.output * 2 + t.cacheRead * 0.1 + t.cacheWrite * 1.25) / 1_000_000);
}, 20_000);

it("each account reads only its own spending, with app names", async () => {
  const users = new UserService(root);
  const alice = users.create("alice", "user", { password: "test-password-1" }).token;
  const bob = users.create("bob", "user", { password: "test-password-2" }).token;
  for (const name of ["alice", "bob"]) bootstrapUserDir(root, name);
  const p = userPaths(root, "alice");
  fs.mkdirSync(path.join(p.apps, "studio"), { recursive: true });
  fs.writeFileSync(path.join(p.apps, "studio", "manifest.json"), JSON.stringify({ name: "Story Studio", kind: "web", version: "1.0.0" }));
  recordUsage(p.usage, row(Date.now(), { src: "app:studio/engine" }));
  const app = buildApp({ users, sessions: new SessionService(root), config: defaultInstanceConfig(), dataDir: root, bus: new EventBus() });
  const get = async (token: string) => (await app.request("/v1/account/usage?days=7&tz=Not/AZone", { headers: { authorization: `Bearer ${token}` } })).json() as Promise<{ total: { calls: number }; names: Record<string, string> }>;
  const mine = await get(alice);
  expect(mine.total.calls).toBe(1);
  expect(mine.names).toEqual({ "app:studio": "Story Studio" });
  expect((await get(bob)).total.calls).toBe(0);

  await app.request("/v1/account/usage", { method: "DELETE", headers: { authorization: `Bearer ${alice}` } });
  expect((await get(alice)).total.calls).toBe(0);
});
