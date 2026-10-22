import { expect, it } from "bun:test";
import { appPluginId, disabledPluginIds, pluginBelongsToApp, userPluginId, validPluginFolder } from "../src/plugins/ids.js";

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
