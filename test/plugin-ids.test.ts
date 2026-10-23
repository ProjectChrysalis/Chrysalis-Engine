import { expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appPluginId, disabledPluginIds, migrateLegacyPluginIds, pluginBelongsToApp, userPluginId, validPluginFolder } from "../src/plugins/ids.js";

it("plugin identities keep app, folder and standalone scopes distinct", () => {
  const apps = ["a", "a_", "a__", "a__b", "a-b", "user"];
  const folders = ["c", "_c", "__c", "b__c", "c_", "c__", "a-b", "a___c"];
  const owners = new Map<string, string>();
  for (const app of apps) {
    for (const folder of folders) {
      const id = appPluginId(app, folder);
      expect(owners.has(id), `${app}/${folder} shares ${id} with ${owners.get(id)}`).toBe(false);
      owners.set(id, `${app}/${folder}`);
      for (const candidate of apps) expect(pluginBelongsToApp(id, candidate)).toBe(candidate === app);
    }
  }
  for (const folder of [...folders, ...owners.keys()].filter(validPluginFolder)) {
    const id = userPluginId(folder);
    expect(owners.has(id), folder).toBe(false);
    for (const app of apps) expect(pluginBelongsToApp(id, app)).toBe(false);
  }
  expect(appPluginId("normal", "engine")).toBe("normal.engine");
  expect(pluginBelongsToApp("normal__engine", "normal")).toBe(false);
  expect(pluginBelongsToApp("a__b__c", "a")).toBe(false);
  expect(pluginBelongsToApp("a__b__c", "a__b")).toBe(false);
  for (const invalid of ["../c", "a/b", "a.b", "", "a\\b", "a:b"]) expect(validPluginFolder(invalid)).toBe(false);
});

it("old disabled identities keep every possible owner disabled", () => {
  const disabled = disabledPluginIds(["a__b__c", "x___y", "normal__engine", "_timer", "plain", "current.plugin"]);
  for (const id of [appPluginId("a", "b__c"), appPluginId("a__b", "c"), appPluginId("x_", "y"), appPluginId("x", "_y"), appPluginId("normal", "engine"), userPluginId("normal__engine"), userPluginId("_timer"), "plain", "current.plugin"]) {
    expect(disabled.has(id), id).toBe(true);
  }
  expect(disabled.has("a__b__c")).toBe(false);
  disabled.delete(appPluginId("a", "b__c"));
  expect(disabledPluginIds([...disabled]).has(appPluginId("a", "b__c"))).toBe(false);
  expect(disabledPluginIds([...disabled]).has(appPluginId("a__b", "c"))).toBe(true);
});

it("old grants and stores move to the one plugin that could own them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-ids-"));
  const p = { settings: path.join(root, "settings.json"), apps: path.join(root, "apps"), plugins: path.join(root, "plugins"), store: path.join(root, "store") };
  const plugin = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), "{}");
  };
  plugin(path.join(p.apps, "roleplay", "plugins", "engine"));
  plugin(path.join(p.apps, "a", "plugins", "b__c"));
  plugin(path.join(p.apps, "a__b", "plugins", "c"));
  fs.mkdirSync(p.store);
  fs.writeFileSync(path.join(p.store, "roleplay__engine.json"), '{"k":1}');
  fs.writeFileSync(path.join(p.store, "a__b__c.json"), '{"k":2}');
  fs.writeFileSync(p.settings, JSON.stringify({ pluginGrants: { roleplay__engine: ["routes"], a__b__c: ["routes"], plain: ["store"] } }));
  expect(migrateLegacyPluginIds(p)).toEqual(["roleplay__engine -> roleplay.engine"]);
  const grants = (JSON.parse(fs.readFileSync(p.settings, "utf8")) as { pluginGrants: Record<string, string[]> }).pluginGrants;
  expect(grants).toEqual({ a__b__c: ["routes"], plain: ["store"], "roleplay.engine": ["routes"] });
  expect(fs.readFileSync(path.join(p.store, "roleplay.engine.json"), "utf8")).toBe('{"k":1}');
  expect(fs.existsSync(path.join(p.store, "a__b__c.json"))).toBe(true);
  expect(migrateLegacyPluginIds(p)).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});
