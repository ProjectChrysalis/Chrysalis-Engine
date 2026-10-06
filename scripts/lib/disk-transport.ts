/**
 * A builder transport over the real filesystem, for building the two
 * first-party frontends (client/, client-agent/) the same way apps are built
 * in the browser: the app-scoped file route's rules (no symlinks, nothing
 * above the root, dot-file and .env refusals) applied to a project directory.
 *
 * The one difference from an app is where packages live. The frontends keep
 * their own node_modules when they have one (client-agent does) and otherwise
 * resolve from the repo root, so `node_modules/**` reads cascade: the
 * project's, then the repo's, and the first hit wins.
 */
import path from "node:path";
import type { FsOp, FsResult, FsTransport } from "../../src/builder/fs.js";
import { appFsOps } from "../../src/builder/server.js";

type Root = [appsDir: string, id: string];

const rootOf = (dir: string): Root => [path.dirname(dir), path.basename(dir)];

const isPackagePath = (rel: string): boolean => rel === "node_modules" || rel.startsWith("node_modules/");

export function diskTransport(projectDir: string, repoRoot: string): FsTransport {
  const project = rootOf(path.resolve(projectDir));
  const repo = rootOf(path.resolve(repoRoot));
  const ask = (root: Root, op: FsOp): FsResult => appFsOps(root[0], root[1], [op])[0] ?? { ok: false, error: "no result" };
  return async (ops: FsOp[]): Promise<FsResult[]> =>
    Promise.all(
      ops.map(async (op) => {
        const rel = op.op === "env" ? "" : op.path;
        if (path.basename(projectDir) === "client-agent") {
          if (op.op === "readdir" && rel === "") {
            const result = ask(project, op);
            return result.ok && "entries" in result ? { ...result, entries: [...result.entries, { name: "__shell", kind: "dir" }] } : result;
          }
          if (op.op === "readdir" && rel === "__shell") return { ok: true, entries: [{ name: "i18n", kind: "dir" }, { name: "prefs.ts", kind: "file" }] };

          if ((rel === "__shell/i18n" || rel.startsWith("__shell/i18n/") || rel === "__shell/i18n.ts") || rel === "__shell/prefs.ts") {
            return ask(rootOf(path.join(repoRoot, "client")), { ...op, path: "src/" + rel.slice("__shell/".length) } as FsOp);
          }
          if (op.op === "read" && rel === "tsconfig.json") {
            const result = ask(project, op);
            if (result.ok && "text" in result && typeof result.text === "string") {
              const config = JSON.parse(result.text);
              config.compilerOptions.paths["@shell/*"] = ["__shell/*"];
              return { ...result, text: JSON.stringify(config) };
            }
          }
        }
        if (!isPackagePath(rel)) return ask(project, op);
        const own = ask(project, op);
        return own.ok ? own : ask(repo, op);
      }),
    );
}
