import { expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

it("standalone providers load without external modules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-oauth-"));
  try {
    const entry = path.join(dir, "entry.ts");
    const program = path.join(dir, process.platform === "win32" ? "refresh.exe" : "refresh");
    fs.writeFileSync(entry, `
import ${JSON.stringify(path.resolve(import.meta.dir, "../src/providers/bundled.ts"))};
import { builtinProviders } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/all")))};
import { bedrockConverseStreamApi } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/bedrock-converse-stream.lazy")))};
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  throw new Error("refresh endpoint reached");
};
for (const id of ["anthropic", "openai-codex"]) {
  const provider = builtinProviders().find(p => p.id === id);
  if (!provider?.auth?.oauth) throw new Error("Missing provider: " + id);
  const before = requests;
  try {
    await provider.auth.oauth.refresh({ type: "oauth", access: "expired", refresh: "test", expires: 0 }, new AbortController().signal);
    throw new Error("Expected refresh failure");
  } catch (error) {
    if (!String(error).includes("refresh endpoint reached")) throw error;
  }
  if (requests !== before + 1) throw new Error("Refresh did not reach endpoint: " + id);
}
const model = { input: ["text"], id: "test", api: "bedrock-converse-stream", provider: "amazon-bedrock", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const result = await bedrockConverseStreamApi().stream(model, { messages: [] }, {
  apiKey: "test",
  onPayload: () => { throw new Error("bedrock implementation reached"); },
}).result();
if (!result.errorMessage?.includes("bedrock implementation reached")) throw new Error(JSON.stringify(result));
console.log("ok");
`);
    execFileSync(process.execPath, ["build", "--compile", "--minify", entry, "--outfile", program], { stdio: "pipe" });
    expect(execFileSync(program, [], { cwd: dir, encoding: "utf8", env: { ...process.env, BUN_BE_BUN: undefined } }).trim()).toBe("ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
