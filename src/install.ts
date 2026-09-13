/**
 * Where this copy of Chrysalis lives: how it was installed, where its shipped
 * files are, and which folder holds the user's config.yaml and data.
 *
 *   source   `bun src/index.ts` in a checkout. Shipped files and the home
 *            folder are both the checkout root.
 *   binary   a compiled executable. Shipped files sit in resources/ next to
 *            it; home is the OS app-data folder, or the executable's own
 *            folder when a config.yaml is already there (portable copy).
 *   npm      the bundled chrysalis.js run by the user's own Bun. Shipped
 *            files sit in resources/ next to the bundle; home as for binary.
 *   android  the compiled server inside the Android launcher, which passes
 *            both folders in the environment.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type InstallKind = "source" | "binary" | "npm" | "android";

declare const CHRYSALIS_BUILD: { version: string; repository: string | null; kind: Exclude<InstallKind, "source"> } | undefined;

const built = typeof CHRYSALIS_BUILD === "undefined" ? null : CHRYSALIS_BUILD;

export const INSTALL_KIND: InstallKind = built?.kind ?? "source";

/** The checkout root when running from source. */
const SOURCE_ROOT = path.resolve(import.meta.dir, "..");

/** Engine files that ship with this copy: client/dist, client-agent/dist,
 *  apps/, and for packaged builds the prebuilt browser bundles and runtime
 *  assets under prebuilt/. */
export function resourcesDir(): string {
  if (process.env.CHRYSALIS_RESOURCES) return path.resolve(process.env.CHRYSALIS_RESOURCES);
  if (INSTALL_KIND === "source") return SOURCE_ROOT;
  if (INSTALL_KIND === "npm") return path.join(import.meta.dir, "resources");
  return path.join(path.dirname(process.execPath), "resources");
}

const sourcePackage = ((): { version?: unknown; repository?: unknown } => {
  if (built) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8")) as { version?: unknown; repository?: unknown };
  } catch {
    return {};
  }
})();

export const ENGINE_VERSION: string = built?.version ?? (typeof sourcePackage.version === "string" ? sourcePackage.version : "dev");

/** The engine's source repository (https URL), for the launcher footer and
 *  update checks. */
export const ENGINE_REPOSITORY: string | null = built ? built.repository : typeof sourcePackage.repository === "string" ? sourcePackage.repository : null;

/** The per-user app-data folder the OS expects programs to write to. */
export function osAppDataDir(): string {
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Chrysalis");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Chrysalis");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "chrysalis");
}

/** The folder holding config.yaml (and, by default, data/). An explicit
 *  choice wins; a packaged copy with a config.yaml beside it runs portable. */
export function resolveHomeDir(explicit?: string): string {
  const chosen = explicit ?? process.env.CHRYSALIS_HOME;
  if (chosen) return path.resolve(chosen);
  if (INSTALL_KIND === "source") return SOURCE_ROOT;
  const besideProgram = INSTALL_KIND === "npm" ? import.meta.dir : path.dirname(process.execPath);
  if (fs.existsSync(path.join(besideProgram, "config.yaml"))) return besideProgram;
  return osAppDataDir();
}

/** Running in the published container image, which says so in its
 *  environment. A container is updated by pulling a new image. */
export const IN_CONTAINER = process.env.CHRYSALIS_CONTAINER === "1";

/** A portable copy keeps config.yaml and data/ in the program's own folder,
 *  so replacing that folder would take them with it. */
export function isPortable(homeDir: string): boolean {
  if (INSTALL_KIND === "source" || INSTALL_KIND === "android") return false;
  const besideProgram = INSTALL_KIND === "npm" ? import.meta.dir : path.dirname(process.execPath);
  return path.resolve(homeDir) === path.resolve(besideProgram);
}
