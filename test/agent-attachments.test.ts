import { afterEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { buildApp } from "../src/server/app.js";
import { UserService } from "../src/users.js";
import { SessionService } from "../src/sessions.js";
import { EventBus } from "../src/server/ws.js";
import { defaultInstanceConfig } from "../src/config.js";
import { saveAttachment } from "../src/agent/attachments.js";
import { buildUserTools } from "../src/agent/tools.js";
import { bootstrapUserDir, gitBoundaryIgnored } from "../src/paths.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-files-")); roots.push(dir); return dir; }
export function samplePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 46 >>\nstream\nBT /F1 12 Tf 72 720 Td (Hello document) Tj ET\nendstream",
  ];
  let data = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n ").join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}
it("keeps original documents and makes PDF, Word, and text contents readable by agent tools", async () => {
  const dir = root();
  const p = bootstrapUserDir(dir, "alice");
  const fixtures = [
    { name: "script.lua", bytes: strToU8('print("hello")'), expected: 'print(\"hello\")' },
    { name: "notes.md", bytes: strToU8("Hello document\n日本語"), expected: "日本語" },
    { name: "document.docx", bytes: zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="urn:word"><w:p><w:r><w:t>Hello &amp; document</w:t></w:r></w:p></w:document>') }), expected: "Hello & document" },
    { name: "document.pdf", bytes: samplePdf(), expected: "Hello document" },
  ];
  const read = buildUserTools("alice", p, { dataDir: dir }).find(tool => tool.name === "read_file")!;
  for (const fixture of fixtures) {
    const result = await saveAttachment(p.root, fixture.name, fixture.bytes);
    expect(fs.readFileSync(path.join(p.root, result.path))).toEqual(Buffer.from(fixture.bytes));
    expect(result.notice).toBeUndefined();
    expect(result.readable).toBeDefined();
    const response = await read.execute("test", { path: result.readable! });
    expect(response.content.map(part => part.type === "text" ? part.text : "").join("\n")).toContain(fixture.expected);
    expect(gitBoundaryIgnored(result.path)).toBe(true);
  }
});
it("retains unsupported and malformed files and reports extraction failures", async () => {
  const dir = root();
  const binary = await saveAttachment(dir, "../../file.bin", Uint8Array.from([0, 255, 1]));
  expect(binary.path).toMatch(/^attachments\/[a-f0-9-]+\/file.bin$/);
  expect(binary.readable).toBeUndefined();
  expect(binary.notice).toContain("No text extractor");
  const damaged = await saveAttachment(dir, "bad.pdf", strToU8("not a PDF"));
  expect(damaged.notice).toContain("Text extraction failed");
  expect(fs.existsSync(path.join(dir, damaged.path))).toBe(true);
});
it("refuses an attachment directory that points outside the user's workspace", async () => {
  const dir = root(), outside = root();
  fs.symlinkSync(outside, path.join(dir, "attachments"));
  await expect(saveAttachment(dir, "notes.txt", strToU8("hello"))).rejects.toThrow("outside");
  expect(fs.readdirSync(outside)).toEqual([]);
});

it("uploads, downloads, and removes files only within the authenticated user's workspace", async () => {
  const dir = root();
  const users = new UserService(dir);
  users.create("admin", "admin", { password: "test-admin-1" });
  const alice = users.create("alice", "user", { password: "test-user-1" }).token;
  const bob = users.create("bob", "user", { password: "test-user-2" }).token;
  const app = buildApp({ users, sessions: new SessionService(dir), config: defaultInstanceConfig(), dataDir: dir, bus: new EventBus() });
  const endpoint = "/v1/agent/attachments?name=notes.txt";
  expect((await app.request(endpoint, { method: "POST", body: "notes" })).status).toBe(401);
  expect((await app.request(endpoint, { method: "POST", body: "notes", headers: { authorization: `Bearer ${alice}`, "x-chrysalis-app": "app" } })).status).toBe(403);
  const uploaded = await app.request(endpoint, { method: "POST", body: "notes", headers: { authorization: `Bearer ${alice}` } });
  expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  const file = await uploaded.json() as { id: string; name: string };
  const url = `/v1/agent/attachments/${file.id}/${file.name}`;
  const response = await app.request(url, { headers: { authorization: `Bearer ${alice}` } });
  expect(await response.text()).toBe("notes");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect((await app.request(url, { headers: { authorization: `Bearer ${bob}` } })).status).toBe(404);
  await app.request(`/v1/agent/attachments/${file.id}`, { method: "DELETE", headers: { authorization: `Bearer ${bob}` } });
  expect((await app.request(url, { headers: { authorization: `Bearer ${alice}` } })).status).toBe(200);
  const oversized = await app.request(endpoint, { method: "POST", body: "notes", headers: { authorization: `Bearer ${alice}`, "content-length": String(65 * 1024 ** 2) } });
  expect(oversized.status).toBe(413);
  await app.request(`/v1/agent/attachments/${file.id}`, { method: "DELETE", headers: { authorization: `Bearer ${alice}` } });
  expect((await app.request(url, { headers: { authorization: `Bearer ${alice}` } })).status).toBe(404);
});
