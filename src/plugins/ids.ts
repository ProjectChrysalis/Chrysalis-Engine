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
