/**
 * Guided provider sign-ins: Vertex AI, Amazon Bedrock and Cloudflare walk a
 * prompt sequence over the OAuth flow API, and the credential the flow
 * returns lands in auth.json for the model layer.
 */
import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppEnv } from "../src/server/app.js";
import type { Hono } from "hono";
import { buildApp } from "../src/server/app.js";
import { EventBus } from "../src/server/ws.js";
import { SessionService } from "../src/sessions.js";
import { UserService } from "../src/users.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir } from "../src/paths.js";

interface PromptStep {
  id: number;
  type: string;
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}
interface FlowSnapshot {
  providerId: string;
  status: "pending" | "connected" | "error";
  prompt?: PromptStep;
  error?: string;
}
interface StoredCredential {
  type: string;
  key?: string;
  env?: Record<string, string>;
}

describe("guided provider sign-ins", () => {
  let dataDir: string;
  let token: string;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "signin-"));
    const users = new UserService(dataDir);
    users.create("admin", "admin", { password: "admin-pass-1" });
    token = users.create("alice", "user", { password: "test-pass-1" }).token;
    bootstrapUserDir(dataDir, "alice");
    app = buildApp({ users, sessions: new SessionService(dataDir), config: defaultInstanceConfig(), dataDir, bus: new EventBus() });
  });

  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
  });

  const h = () => ({ authorization: `Bearer ${token}` });
  const post = (p: string, body: { id?: number; value?: string } = {}) =>
    app.request(p, {
      method: "POST",
      headers: { ...h(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const authFile = (): Record<string, StoredCredential> =>
    JSON.parse(fs.readFileSync(path.join(dataDir, "credentials", "alice", "auth.json"), "utf8")) as Record<string, StoredCredential>;

  const currentFlow = async (): Promise<FlowSnapshot | null> => {
    const res = await app.request("/v1/settings/oauth", { headers: h() });
    return ((await res.json()) as { flow: FlowSnapshot | null }).flow;
  };

  const waitPrompt = async (providerId: string, ready: (p: PromptStep) => boolean): Promise<PromptStep> => {
    for (let i = 0; i < 100; i++) {
      const flow = await currentFlow();
      const prompt = flow?.providerId === providerId ? flow.prompt : undefined;
      if (prompt && ready(prompt)) return prompt;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no prompt appeared for ${providerId}`);
  };

  const waitConnected = async (providerId: string): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      const flow = await currentFlow();
      if (flow?.providerId === providerId && flow.status === "connected") return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${providerId} never connected`);
  };

  it("lists guided credential sign-ins apart from OAuth subscriptions", async () => {
    const res = await app.request("/v1/settings/providers", { headers: h() });
    const { providers } = (await res.json()) as { providers: Array<{ id: string; oauth: boolean; signIn: boolean; signInLabel: string | null }> };
    expect(providers.find((p) => p.id === "google-vertex")).toMatchObject({ signIn: true, oauth: false, signInLabel: "Google Cloud credentials" });
    expect(providers.find((p) => p.id === "amazon-bedrock")).toMatchObject({ signIn: true, oauth: false, signInLabel: "AWS credentials or bearer token" });
    expect(providers.find((p) => p.id === "anthropic")).toMatchObject({ signIn: true, oauth: true });
    expect(providers.find((p) => p.id === "deepseek")?.signIn).toBe(false);
    const signIns = await app.request("/v1/settings/oauth", { headers: h() });
    const listed = ((await signIns.json()) as { providers: Array<{ id: string; subscription: boolean; configured: boolean }> }).providers;
    expect(listed.find((p) => p.id === "google-vertex")).toMatchObject({ subscription: false, configured: false });
    expect(listed.find((p) => p.id === "anthropic")?.subscription).toBe(true);
  });

  it("walks Vertex ADC: method, project, location, then stores the credential", async () => {
    expect((await post("/v1/settings/oauth/google-vertex/start")).status).toBe(200);
    const method = await waitPrompt("google-vertex", (p) => p.type === "select");
    expect(method.options?.map((o) => o.id)).toEqual(["api-key", "adc", "service-account"]);
    // while a prompt is parked the flow is exclusive; stale and unknown answers bounce
    expect((await post("/v1/settings/oauth/google-vertex/start")).status).toBe(409);
    expect((await post("/v1/settings/oauth/google-vertex/answer", { id: method.id, value: "not-a-method" })).status).toBe(400);
    expect((await post("/v1/settings/oauth/google-vertex/answer", { id: method.id - 1, value: "adc" })).status).toBe(409);
    expect((await post("/v1/settings/oauth/google-vertex/answer", { id: method.id, value: "adc" })).status).toBe(200);

    const project = await waitPrompt("google-vertex", (p) => p.id > method.id && p.type === "text");
    expect(project.message).toContain("project");
    // a blank answer never advances the flow
    expect((await post("/v1/settings/oauth/google-vertex/answer", { id: project.id, value: "   " })).status).toBe(400);
    await post("/v1/settings/oauth/google-vertex/answer", { id: project.id, value: "my-project" });

    const location = await waitPrompt("google-vertex", (p) => p.id > project.id);
    expect(location.message).toContain("location");
    await post("/v1/settings/oauth/google-vertex/answer", { id: location.id, value: "us-central1" });
    await waitConnected("google-vertex");

    expect(authFile()["google-vertex"]).toEqual({
      type: "api_key",
      env: { GOOGLE_CLOUD_PROJECT: "my-project", GOOGLE_CLOUD_LOCATION: "us-central1" },
    });
    // teardown removes the stored credential, not just OAuth ones
    expect((await app.request("/v1/settings/oauth/google-vertex", { method: "DELETE", headers: h() })).status).toBe(200);
    expect(authFile()["google-vertex"]).toBeUndefined();
  });

  it("walks the AWS bearer-token setup and stores the token", async () => {
    expect((await post("/v1/settings/oauth/amazon-bedrock/start")).status).toBe(200);
    const method = await waitPrompt("amazon-bedrock", (p) => p.type === "select");
    expect(method.options?.map((o) => o.id)).toEqual(["bearer-token", "aws-profile", "credential-chain"]);
    await post("/v1/settings/oauth/amazon-bedrock/answer", { id: method.id, value: "bearer-token" });
    const tokenStep = await waitPrompt("amazon-bedrock", (p) => p.id > method.id && p.type === "secret");
    await post("/v1/settings/oauth/amazon-bedrock/answer", { id: tokenStep.id, value: "aws-bearer-123" });
    await waitConnected("amazon-bedrock");
    expect(authFile()["amazon-bedrock"]).toEqual({ type: "api_key", key: "aws-bearer-123" });
  });

  it("cancelling a pending flow frees the slot for the next sign-in", async () => {
    expect((await post("/v1/settings/oauth/google-vertex/start")).status).toBe(200);
    await waitPrompt("google-vertex", () => true);
    expect((await post("/v1/settings/oauth/google-vertex/cancel")).status).toBe(200);
    expect(await currentFlow()).toBeNull();
    // idempotent, and another provider can start right away
    expect((await post("/v1/settings/oauth/google-vertex/cancel")).status).toBe(200);
    expect((await post("/v1/settings/oauth/amazon-bedrock/start")).status).toBe(200);
    await waitPrompt("amazon-bedrock", () => true);
    // the abandoned flow stored nothing (auth.json was never even created)
    const auth = fs.existsSync(path.join(dataDir, "credentials", "alice", "auth.json")) ? authFile() : {};
    expect(auth["google-vertex"]).toBeUndefined();
    expect((await post("/v1/settings/oauth/amazon-bedrock/cancel")).status).toBe(200);
    expect(await currentFlow()).toBeNull();
  });

  it("answers bounce when no flow is running", async () => {
    expect((await post("/v1/settings/oauth/google-vertex/answer", { id: 1, value: "adc" })).status).toBe(409);
    expect((await post("/v1/settings/oauth/google-vertex/start")).status).toBe(200);
    await waitPrompt("google-vertex", () => true);
    expect((await post("/v1/settings/oauth/cloudflare-workers-ai/answer", { id: 1, value: "x" })).status).toBe(409);
  });
});
