/**
 * A small web app with a backend plugin, for tests that need a real installed
 * app: GET /notes lists the note ids, PUT /notes/:id writes one into the
 * app's data folder.
 */
import fs from "node:fs";
import path from "node:path";
import { createAppSkeleton } from "../../src/apps/manager.js";

export function installNotesApp(appsDir: string, id = "notes"): string {
  const { dir } = createAppSkeleton(appsDir, { id, name: "Notes", author: "Tests" });
  const plugin = path.join(dir, "plugins", "notes");
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, "manifest.json"), JSON.stringify({ name: "Notes", version: "1.0.0", permissions: ["routes", "fs"] }));
  fs.writeFileSync(
    path.join(plugin, "plugin.js"),
    `export function handleRoute(req, host) {
  if (req.method === "GET" && req.path === "/notes") {
    let ids = [];
    try { ids = host.fs.list("notes").map((f) => f.replace(/\\.json$/, "")); } catch { /* none yet */ }
    return { status: 200, json: { notes: ids } };
  }
  const m = /^\\/notes\\/([a-z0-9-]+)$/.exec(req.path);
  if (req.method === "PUT" && m) {
    host.fs.write("notes/" + m[1] + ".json", JSON.stringify(req.body));
    return { status: 200, json: { ok: true } };
  }
  return null;
}`,
  );
  return dir;
}
