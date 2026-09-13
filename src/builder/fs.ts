/**
 * The builder's only window onto an app: a batched, cached client over the
 * engine's per-app file route (POST /v1/apps/:id/build/fs). Paths are
 * app-relative POSIX ("src/main.tsx", "node_modules/react/index.js"). The
 * engine answers for that one app and nothing else, so whatever the builder
 * asks for, it can only ever see the app it is building.
 *
 * Isomorphic: the builder frame wires it to postMessage, tests wire it
 * straight to the route handler.
 */

export interface FsStat {
  kind: "file" | "dir";
  size: number;
}

export type FsOp =
  | { op: "stat"; path: string }
  | { op: "read"; path: string; binary?: boolean }
  | { op: "readdir"; path: string }
  | { op: "hash"; path: string }
  | { op: "env"; mode: string };

export type FsResult =
  | { ok: true; stat?: FsStat | null; text?: string; b64?: string; entries?: Array<{ name: string; kind: "file" | "dir" }>; hash?: string; env?: Record<string, string> }
  | { ok: false; error: string };

export type FsTransport = (ops: FsOp[]) => Promise<FsResult[]>;

/** Normalise an app-relative path; throws when it climbs above the app. */
export function normPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) throw new Error(`"${p}" is outside the app`);
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

export function joinPath(...parts: string[]): string {
  return normPath(parts.filter((x) => x !== "").join("/"));
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i).toLowerCase();
}

/** `to` as seen from directory `fromDir`, always starting with ./ or ../ */
export function relativePath(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to ? to.split("/") : [];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.length - i;
  const rest = b.slice(i).join("/");
  if (up === 0) return "./" + rest;
  return "../".repeat(up) + rest;
}

interface Pending {
  op: FsOp;
  resolve: (r: FsResult) => void;
  reject: (e: unknown) => void;
}

export class BuildFs {
  private stats = new Map<string, Promise<FsStat | null>>();
  private texts = new Map<string, Promise<string>>();
  private dirs = new Map<string, Promise<Array<{ name: string; kind: "file" | "dir" }> | null>>();
  private hashes = new Map<string, Promise<string>>();
  private queue: Pending[] = [];
  private scheduled = false;
  /** Bytes read so far; the host enforces the real budget. */
  bytesRead = 0;

  constructor(private transport: FsTransport, private maxBatch = 400) {}

  private call(op: FsOp): Promise<FsResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ op, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        // a macrotask, not a microtask: esbuild's plugin callbacks for one
        // file's imports arrive over several turns, and one round trip for
        // all of them is the difference between seconds and minutes
        setTimeout(() => this.flush(), 0);
      }
    });
  }

  private flush(): void {
    this.scheduled = false;
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.maxBatch);
      this.transport(batch.map((b) => b.op)).then(
        (results) => batch.forEach((b, i) => b.resolve(results[i] ?? { ok: false, error: "no result" })),
        (e) => batch.forEach((b) => b.reject(e)),
      );
    }
  }

  /** Existence and kind, answered from the parent's listing: one readdir
   *  settles every sibling the resolver will probe (x.tsx, x.ts, x/index…),
   *  which turns thousands of round trips into one per directory. */
  stat(path: string): Promise<FsStat | null> {
    if (path === "") return Promise.resolve({ kind: "dir", size: 0 });
    let got = this.stats.get(path);
    if (!got) {
      got = this.readdir(dirname(path)).then((entries) => {
        const name = basename(path);
        const e = entries?.find((x) => x.name === name);
        return e ? { kind: e.kind, size: 0 } : null;
      });
      this.stats.set(path, got);
    }
    return got;
  }

  async isFile(path: string): Promise<boolean> {
    return (await this.stat(path))?.kind === "file";
  }

  async isDir(path: string): Promise<boolean> {
    return (await this.stat(path))?.kind === "dir";
  }

  readText(path: string): Promise<string> {
    let got = this.texts.get(path);
    if (!got) {
      got = this.call({ op: "read", path }).then((r) => {
        if (!r.ok) throw new Error(`${path}: ${r.error}`);
        const text = r.text ?? "";
        this.bytesRead += text.length;
        return text;
      });
      this.texts.set(path, got);
      got.catch(() => this.texts.delete(path));
    }
    return got;
  }

  async readBase64(path: string): Promise<string> {
    const r = await this.call({ op: "read", path, binary: true });
    if (!r.ok) throw new Error(`${path}: ${r.error}`);
    this.bytesRead += (r.b64 ?? "").length;
    return r.b64 ?? "";
  }

  readdir(path: string): Promise<Array<{ name: string; kind: "file" | "dir" }> | null> {
    let got = this.dirs.get(path);
    if (!got) {
      got = this.call({ op: "readdir", path }).then((r) => (r.ok ? (r.entries ?? null) : null));
      this.dirs.set(path, got);
    }
    return got;
  }

  /** Content hash (hex) — names emitted assets so caches bust on change. */
  hash(path: string): Promise<string> {
    let got = this.hashes.get(path);
    if (!got) {
      got = this.call({ op: "hash", path }).then((r) => {
        if (!r.ok || !r.hash) throw new Error(`${path}: ${r.ok ? "no hash" : r.error}`);
        return r.hash;
      });
      this.hashes.set(path, got);
      got.catch(() => this.hashes.delete(path));
    }
    return got;
  }

  async env(mode: string): Promise<Record<string, string>> {
    const r = await this.call({ op: "env", mode });
    return r.ok ? (r.env ?? {}) : {};
  }

  /** Forget what we know about these paths (a file changed on disk). */
  invalidate(paths: string[] | "all"): void {
    if (paths === "all") {
      this.stats.clear();
      this.texts.clear();
      this.dirs.clear();
      this.hashes.clear();
      return;
    }
    for (const p of paths) {
      this.stats.delete(p);
      this.texts.delete(p);
      this.hashes.delete(p);
      this.dirs.delete(p);
      // a created or deleted file changes its directory's listing, and any
      // ancestor may have been created with it
      let d = dirname(p);
      for (;;) {
        this.dirs.delete(d);
        this.stats.delete(d);
        if (d === "") break;
        d = dirname(d);
      }
    }
  }
}
