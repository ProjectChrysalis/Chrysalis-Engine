/**
 * Plugin store service (SPEC §5.4): namespaced key-value persistence for
 * plugins, under the user's store/ dir (outside git). JSON-file backed in v1;
 * libSQL/vector upgrade lands with the services roadmap item.
 */
import fs from "node:fs";
import path from "node:path";

export class PluginStoreService {
  constructor(private storeDir: string) {}

  private fileFor(pluginId: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(pluginId)) throw new Error(`invalid plugin id: ${pluginId}`);
    return path.join(this.storeDir, `${pluginId}.json`);
  }

  private read(pluginId: string): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(this.fileFor(pluginId), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private write(pluginId: string, data: Record<string, unknown>): void {
    const file = this.fileFor(pluginId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  namespace(pluginId: string) {
    return {
      get: (key: string): unknown => this.read(pluginId)[key],
      put: (key: string, value: unknown): void => {
        const data = this.read(pluginId);
        data[key] = value ?? null;
        this.write(pluginId, data);
      },
      delete: (key: string): void => {
        const data = this.read(pluginId);
        delete data[key];
        this.write(pluginId, data);
      },
      keys: (): string[] => Object.keys(this.read(pluginId)),
    };
  }
}
