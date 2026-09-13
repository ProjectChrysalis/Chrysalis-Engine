/**
 * Server settings at runtime: what config.yaml says, what this run actually
 * uses, and saving an admin's change back to the file.
 *
 * A change is applied before it is saved: a port that cannot be opened or a
 * certificate that does not exist is reported and nothing is written, so the
 * file never describes a server that cannot start.
 */
import { applySettings, saveConfigFile, type InstanceConfig, type LoadedConfig } from "../config.js";
import { ENGINE_VERSION, INSTALL_KIND, IN_CONTAINER, isPortable, type InstallKind } from "../install.js";
import { engineUrls } from "./listen.js";

export interface ServerInfo {
  version: string;
  installKind: InstallKind;
  /** the published container image */
  container: boolean;
  /** config.yaml and data/ live in the program's own folder */
  portable: boolean;
  configPath: string;
  homeDir: string;
  dataDir: string;
  /** config.yaml values */
  file: InstanceConfig;
  /** values in use (file plus this run's overrides) */
  effective: InstanceConfig;
  /** setting → the environment variable or flag overriding it */
  locked: Record<string, string>;
  urls: { local: string; lan: string[] };
}

export interface ServerSettingsOptions {
  homeDir: string;
  dataDir: string;
  loaded: LoadedConfig;
  /** Move the listening socket; returns whether it moved, throws when the
   *  new setting cannot be applied. */
  applySocket: (next: InstanceConfig, previous: InstanceConfig) => boolean;
  /** Push non-socket settings into long-lived services. */
  applyRuntime: (next: InstanceConfig) => void;
}

/** Settings a person may change from Settings > Server. The data folder
 *  moves with the files in it, which only makes sense while stopped. */
const EDITABLE = new Set(["port", "lan", "listenAddress", "allowedHosts", "ssl.enabled", "ssl.certPath", "ssl.keyPath", "openBrowser", "apps.packageDownloads", "agent.shell", "agent.shellTimeoutSeconds", "defaultModel"]);

function getPath(obj: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((cur, seg) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined), obj);
}

export class ServerSettings {
  constructor(private opts: ServerSettingsOptions) {}

  describe(): ServerInfo {
    const { loaded, homeDir, dataDir } = this.opts;
    return {
      version: ENGINE_VERSION,
      installKind: INSTALL_KIND,
      container: IN_CONTAINER,
      portable: isPortable(homeDir),
      configPath: loaded.path,
      homeDir,
      dataDir,
      file: loaded.file,
      effective: loaded.config,
      locked: loaded.locked,
      urls: engineUrls(loaded.config),
    };
  }

  update(changes: Record<string, unknown>): { info: ServerInfo; moved: boolean } | { error: string } {
    const { loaded } = this.opts;
    for (const key of Object.keys(changes)) {
      if (key === "dataRoot") return { error: "the data folder can only be changed in config.yaml while Chrysalis is stopped" };
      if (!EDITABLE.has(key)) return { error: `unknown setting: ${key}` };
    }
    const nextFile = applySettings(loaded.file, changes);
    if ("error" in nextFile) return nextFile;
    const nextEffective = structuredClone(nextFile.config);
    // overridden settings keep this run's value; the file change applies once
    // the override is gone
    for (const key of Object.keys(loaded.locked)) {
      const r = applySettings(nextEffective, { [key]: getPath(loaded.config, key) });
      if (!("error" in r)) Object.assign(nextEffective, r.config);
    }
    let moved: boolean;
    try {
      moved = this.opts.applySocket(nextEffective, loaded.config);
    } catch (e) {
      return { error: (e as Error).message };
    }
    saveConfigFile(loaded.path, nextFile.config);
    loaded.file = nextFile.config;
    // the effective config object is shared by every service: update it in place
    Object.assign(loaded.config, nextEffective);
    this.opts.applyRuntime(loaded.config);
    return { info: this.describe(), moved };
  }
}
