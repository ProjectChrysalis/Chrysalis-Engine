/**
 * Model data kept current between releases, against a stand-in package
 * registry: only a same-major release whose tarball matches its sha512 is
 * used, new models only join routes the shipped catalog already has, and a
 * shipped model takes only a new name, price and limits.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { BUNDLED_CATALOG_VERSION, ModelCatalog, catalogProviders, compareVersions, dataFilesOf } from "../src/model-catalog.js";

const major = Number(BUNDLED_CATALOG_VERSION.split(".")[0]);
const NEXT = `${major}.99.0`;

function tarball(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    header.write("ustar\0", 257);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const openai = () => builtinProviders().find((p) => p.id === "openai")!;

function release(): Uint8Array {
  const shipped = (openai().getAllModels?.() ?? openai().getModels()) as unknown as Record<string, any>[];
  const known = shipped.find((m) => (m.type ?? "chat") === "chat")!;
  const group: Record<string, unknown> = {};
  group[`chat:${known.id}`] = { ...known, cost: { ...known.cost, input: 123 }, api: "something-else", baseUrl: "https://evil.example" };
  group["chat:brand-new"] = { ...known, id: "brand-new", name: "Brand New", headers: { "x-leak": "1" } };
  group["chat:elsewhere"] = { ...known, id: "elsewhere", name: "Elsewhere", baseUrl: "https://evil.example/v1" };
  group["chat:broken"] = { ...known, id: "broken", contextWindow: -1 };
  return tarball({
    "package/package.json": "{}",
    [`package/dist/providers/data/openai.json`]: JSON.stringify({ [known.api]: group }),
    "package/dist/index.js": "throw new Error('never runs')",
  });
}

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let tgz: Uint8Array;
let integrity: string;
let enabled: boolean;
let catalog: ModelCatalog;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
  tgz = release();
  integrity = `sha512-${crypto.createHash("sha512").update(tgz).digest("base64")}`;
  enabled = true;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/release.tgz") return new Response(tgz);
      const dist = { tarball: `${url.origin}/release.tgz`, integrity };
      return Response.json({ versions: { [BUNDLED_CATALOG_VERSION]: {}, [NEXT]: { dist }, [`${major + 1}.0.0`]: { dist: { tarball: "https://x/y.tgz", integrity: "sha512-x" } } } });
    },
  });
  catalog = new ModelCatalog({ dataDir: dir, enabled: () => enabled, registry: `http://127.0.0.1:${server.port}` });
});
afterEach(() => {
  enabled = false;
  catalog.settingChanged();
  server.stop(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

it("reads data files out of a release and orders versions", () => {
  expect([...dataFilesOf(release()).keys()]).toEqual(["openai"]);
  expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
  expect(compareVersions("2.0.0-beta.1", "2.0.0")).toBe(-1);
});

it("adds models on known routes and updates prices of shipped ones", async () => {
  const before = openai().getModels() as unknown as Record<string, any>[];
  const known = before[0]!;
  await catalog.refresh();
  expect(catalog.status()).toMatchObject({ version: NEXT, added: 1, error: null });

  const after = catalogProviders().find((p) => p.id === "openai")!.getModels() as unknown as Record<string, any>[];
  const added = after.find((m) => m.id === "brand-new")!;
  expect(added.baseUrl).toBe(known.baseUrl);
  expect(added.headers?.["x-leak"]).toBeUndefined();
  expect(after.some((m) => m.id === "elsewhere" || m.id === "broken")).toBe(false);
  const updated = after.find((m) => m.id === known.id)!;
  expect(updated.cost.input).toBe(123);
  expect(updated.api).toBe(known.api);
  expect(updated.baseUrl).toBe(known.baseUrl);

  // kept on disk for the next start, and dropped when the setting is off
  const again = new ModelCatalog({ dataDir: dir, enabled: () => enabled, registry: "http://127.0.0.1:1" });
  expect(again.status().version).toBe(NEXT);
  enabled = false;
  again.settingChanged();
  expect(catalogProviders().find((p) => p.id === "openai")!.getModels().some((m) => m.id === "brand-new")).toBe(false);
});

it("refuses a release that does not match its checksum", async () => {
  integrity = `sha512-${crypto.createHash("sha512").update("other").digest("base64")}`;
  await expect(catalog.refresh()).rejects.toThrow("does not match its checksum");
  expect(catalog.status()).toMatchObject({ version: null, added: 0 });
  expect(catalog.status().error).toContain("checksum");
  expect(fs.existsSync(path.join(dir, "catalog", "models.json"))).toBe(false);
});
