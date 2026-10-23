import fs from "node:fs";
import path from "node:path";

export const validPluginFolder = (id: string): boolean => /^[a-z0-9_-]+$/i.test(id);

/** Dots cannot appear in app or plugin folders, so each pair has one identity. */
export function appPluginId(appId: string, folder: string): string {
  return `${appId}.${folder}`;
}

/** Standalone plugins cannot occupy the namespace of an app's plugin. */
export function userPluginId(folder: string): string {
  return folder.includes("__") || !/^[a-z0-9]/i.test(folder) ? `user.${folder}.plugin` : folder;
}

export function pluginBelongsToApp(id: string, appId: string): boolean {
  const dot = id.indexOf(".");
  if (dot < 0 || id.slice(0, dot) !== appId) return false;
  const folder = id.slice(dot + 1);
  return validPluginFolder(folder) && appPluginId(appId, folder) === id;
}

/** An ambiguous old disable applies to every possible owner, never a grant. */
export function disabledPluginIds(ids: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const id of ids) {
    if (id.includes(".")) {
      result.add(id);
      continue;
    }
    result.add(userPluginId(id));
    for (let i = 1; i < id.length - 2; i++) {
      if (id.slice(i, i + 2) !== "__") continue;
      const app = id.slice(0, i);
      const folder = id.slice(i + 2);
      if (/^[a-z0-9][a-z0-9_-]*$/i.test(app) && validPluginFolder(folder)) result.add(appPluginId(app, folder));
    }
  }
  return result;
}

/** Plugins that could have owned an id from before dotted identities. */
function legacyOwners(id: string, appsDir: string, pluginsDir: string): string[] {
  const owners: string[] = [];
  if (validPluginFolder(id) && userPluginId(id) !== id && fs.existsSync(path.join(pluginsDir, id, "manifest.json"))) owners.push(userPluginId(id));
  for (let i = 1; i < id.length - 2; i++) {
    if (id.slice(i, i + 2) !== "__") continue;
    const app = id.slice(0, i);
    const folder = id.slice(i + 2);
    if (validPluginFolder(app) && validPluginFolder(folder) && fs.existsSync(path.join(appsDir, app, "plugins", folder, "manifest.json"))) {
      owners.push(appPluginId(app, folder));
    }
  }
  return owners;
}

/** Moves old grants and stores to the identity of the one installed plugin
 *  that could have held them. An id more than one installed plugin could
 *  claim stays where it is, so a crafted name never inherits a grant. */
export function migrateLegacyPluginIds(p: { settings: string; apps: string; plugins: string; store: string }): string[] {
  let settings: { pluginGrants?: Record<string, unknown> };
  try {
    settings = JSON.parse(fs.readFileSync(p.settings, "utf8")) as typeof settings;
  } catch {
    settings = {};
  }
  const grants = settings.pluginGrants ?? {};
  const ids = new Set(Object.keys(grants).filter((id) => !id.includes(".")));
  try {
    for (const f of fs.readdirSync(p.store)) if (f.endsWith(".json") && !f.slice(0, -5).includes(".")) ids.add(f.slice(0, -5));
  } catch { /* no store */ }
  const moved: string[] = [];
  let touched = false;
  for (const id of ids) {
    const owners = legacyOwners(id, p.apps, p.plugins);
    if (owners.length !== 1) continue;
    const owner = owners[0]!;
    if (id in grants) {
      grants[owner] ??= grants[id];
      delete grants[id];
      touched = true;
    }
    const from = path.join(p.store, `${id}.json`);
    const to = path.join(p.store, `${owner}.json`);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    moved.push(`${id} -> ${owner}`);
  }
  if (touched) {
    settings.pluginGrants = grants;
    fs.writeFileSync(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
  return moved;
}
