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
        if (!isPackagePath(rel)) return ask(project, op);
        const own = ask(project, op);
        return own.ok ? own : ask(repo, op);
      }),
    );
}
