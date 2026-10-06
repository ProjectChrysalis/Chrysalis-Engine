import { afterEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { zipSync, strToU8 } from "fflate";
import { buildApp } from "../src/server/app.js";
import { createAppSkeleton } from "../src/apps/manager.js";
import { bootstrapUserDir } from "../src/paths.js";
import { UserService } from "../src/users.js";
import { SessionService } from "../src/sessions.js";
import { EventBus } from "../src/server/ws.js";
import { defaultInstanceConfig } from "../src/config.js";
import { invalidatePluginCache } from "../src/plugins/runtime.js";
interface FixtureResponse {
  id: string; status: string; files: number; cursor: number; counts: Record<string, number>;
  characters: { id: string; name: string; avatar: string; description: string }[];
  items: { linkedCharacterIds: string[] }[];
  chats: { characterId: string }[];
}
const roots: string[] = [];
afterEach(() => { invalidatePluginCache(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-http-")); roots.push(root);
  const users = new UserService(root); users.create("admin", "admin", { password: "test-admin-1" });
  const token = users.create("alice", "user", { password: "test-user-1" }).token;
  const p = bootstrapUserDir(root, "alice");
  const { dir } = createAppSkeleton(p.apps, { id: "roleplay", name: "Library" });
  const plugin = path.join(dir, "plugins", "library");
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, "manifest.json"), JSON.stringify({ name: "Library", version: "1.0.0", permissions: ["routes", "fs", "zip"] }));
  fs.writeFileSync(path.join(plugin, "plugin.js"), `
export function handleRoute(req, host) {
  const fs = host.fs;
  const readAll = (folder) => { try { return fs.list(folder).map(name => JSON.parse(fs.read(folder + "/" + name))); } catch { return []; } };
  if (req.path === "/characters") return { status: 200, json: { characters: readAll("characters") } };
  if (req.path === "/lorebooks") return { status: 200, json: { items: readAll("books") } };
  if (req.path === "/chats") return { status: 200, json: { chats: readAll("chats") } };
  if (req.path === "/import/finish") { fs.remove("__lookup/" + req.body.importId); return { status: 200, json: { ok: true } }; }
  const result = { characters: [], books: [], chats: [], errors: [] };
  for (const [name, value] of Object.entries(host.zip.entries())) {
    if (name.includes("/characters/")) {
      if (!value.__image__ || value.base64) throw new Error("image bytes exposed to guest");
      const image = host.zip.image(name);
      const card = JSON.parse(image.metadata.chara);
      card.id = card.name.replaceAll(" ", "-"); card.avatar = image.url;
      fs.write("characters/" + card.id + ".json", JSON.stringify(card));
      fs.lookup(req.body.importId, card.name, card.id); result.characters.push(card.id);
    } else if (name.includes("/worlds/")) {
      const book = JSON.parse(value);
      book.linkedCharacterIds = book._studio._linkedNames.map(name => fs.lookup(req.body.importId, name));
      fs.write("books/place.json", JSON.stringify(book)); result.books.push("place");
    } else if (name.includes("/chats/")) {
      const header = JSON.parse(value.split("\\n")[0]);
      fs.write("chats/chat.json", JSON.stringify({ characterId: fs.lookup(req.body.importId, header.character_name) })); result.chats.push("chat");
    }
  }
  return { status: 200, json: result };
}`);
  const app = buildApp({ users, sessions: new SessionService(root), config: defaultInstanceConfig(), dataDir: root, bus: new EventBus() });
  const request = async (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await app.request("/v1/apps/roleplay" + url, { method, headers: { authorization: `Bearer ${token}`, "x-chrysalis-app": "roleplay", "content-type": body instanceof Uint8Array ? "application/octet-stream" : "application/json" }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
    const result = await response.json() as FixtureResponse;
    expect(response.status, JSON.stringify(result)).toBe(200);
    return result;
  };
  return { root, p, dir, app, token, request };
}
const png = (name: string) => {
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcbkAAAAASUVORK5CYII=", "base64");
  const text = Buffer.from("chara\0" + JSON.stringify({ name, description: "Keep metadata", studio: { importedAt: 123, favorite: true } }));
  const chunk = Buffer.alloc(text.length + 12); chunk.writeUInt32BE(text.length); chunk.write("tEXt", 4); text.copy(chunk, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([image.subarray(0, -12), chunk, image.subarray(-12)]);
};
it("imports through the HTTP bridge namespace, preserves cross-batch links, and serves deduplicated images", async () => {
  const { p, app, token, request } = fixture();
  const files: Record<string, Uint8Array> = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`wrapped/characters/hero-${i}.png`, png("Hero " + i)]));
  files["wrapped/worlds/place.json"] = strToU8(JSON.stringify({ name: "Place", entries: { "0": { uid: 0, key: ["Place"], content: "A place" } }, _studio: { _linkedNames: ["Hero 0"] } }));
  files["wrapped/chats/Hero 0/chat.jsonl"] = strToU8('{"user_name":"You","character_name":"Hero 0"}\n{"mes":"hello","is_user":true,"name":"You"}\n');
  const archive = zipSync(files);
  const state = await request("/__imports/new", { name: "library.zip", size: archive.length, collections: ["characters/", "worlds/", "chats/"] });
  await request(`/__imports/${state.id}?offset=0`, archive, "PUT");
  let indexed = state;
  for (let n = 0; n < 100; n++) { indexed = await request(`/__imports/${state.id}`); if (indexed.status !== "indexing") break; await Bun.sleep(10); }
  expect(indexed.status).toBe("ready");
  let cursor = 0, last = state;
  while (cursor < indexed.files) {
    const body = { cursor, route: "/import/zip" };
    last = await request(`/__imports/${state.id}/batch`, body);
    expect(await request(`/__imports/${state.id}/batch`, body)).toEqual(last);
    cursor = last.cursor;
  }
  expect(last.counts.characters).toBe(65);
  expect(last.counts.chats).toBe(1);
  const cards = await request("/characters");
  const hero = cards.characters.find((card: { name: string }) => card.name === "Hero 0")!;
  expect(hero.avatar).toMatch(/^\/v1\/apps\/roleplay\/__media\//);
  expect(hero.description).toBe("Keep metadata");
  const books = await request("/lorebooks");
  expect(books.items[0]?.linkedCharacterIds).toEqual([hero.id]);
  const chats = await request("/chats"); expect(chats.chats[0]?.characterId).toBe(hero.id);
  const media = path.join(p.apps, "roleplay", "data", "__media"); expect(fs.readdirSync(media).length).toBe(1);
  expect(fs.readFileSync(path.join(media, fs.readdirSync(media)[0]!)).includes(Buffer.from("chara"))).toBe(false);
  const image = await app.request(hero.avatar, { headers: { authorization: `Bearer ${token}`, "x-chrysalis-app": "roleplay" } }); expect(image.status).toBe(200); expect(image.headers.get("content-type")).toBe("image/png");
  const denied = await app.request(hero.avatar, { headers: { authorization: `Bearer ${token}`, "x-chrysalis-app": "another-app" } }); expect(denied.status).toBe(403);
  await request(`/__imports/${state.id}/finish`, { route: "/import/finish" });
  await request(`/__imports/${state.id}`, undefined, "DELETE");
}, 60_000);
