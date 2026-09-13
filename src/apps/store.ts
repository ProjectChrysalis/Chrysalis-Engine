/**
 * The app store: a list of apps anyone can install, and which install sources
 * count as official.
 *
 * The list is one JSON file (apps.json, see the app-store repository) fetched
 * from config `apps.store`. Every entry is a git repository, and installing
 * one is the normal git import with its preview of what the app bundles.
 * Entries are untrusted text from the network: nothing in them grants
 * anything.
 *
 * Official status comes from where this engine installed an app from, never
 * from a manifest or the list. The install source is recorded outside the
 * workspace (see readInstallSource), because the workspace is writable by the
 * agent, the apps and a non-admin account's shell.
 */
import fs from "node:fs";
import path from "node:path";
import { isValidGitUrl } from "./git.js";
import { readApp } from "./manager.js";
import { readBaseline, readInstallSource, writeInstallSource } from "./update.js";

/** Repository owners whose apps are official: the Chrysalis maintainers. */
export const OFFICIAL_SOURCES: readonly string[] = ["https://github.com/ProjectChrysalis/"];

/** Apps earlier engines shipped inside the download, by id, with the
 *  repository each one lives in now. An install the engine seeded from its
 *  own copy keeps its official status and updates from there. */
export const FORMERLY_SHIPPED: Readonly<Record<string, string>> = {
  roleplay: "https://github.com/ProjectChrysalis/Roleplay-Chrysalis",
};

/** Record where formerly shipped apps now come from, so an install an earlier
 *  engine seeded keeps updating and stays official. Only an install the
 *  engine made has a baseline, so an app someone later created under the
 *  same id is not adopted. Returns the ids adopted. */
export function adoptFormerlyShipped(p: { apps: string; appUpstream: string }): { id: string; repository: string }[] {
  const adopted: { id: string; repository: string }[] = [];
  for (const [id, repository] of Object.entries(FORMERLY_SHIPPED)) {
    const info = readApp(p.apps, id);
    if (!info || info.manifest.source?.git || readInstallSource(p.appUpstream, id) || !readBaseline(p.appUpstream, id)) continue;
    writeInstallSource(p.appUpstream, id, { git: repository, ref: "HEAD" });
    const manifestPath = path.join(info.dir, "manifest.json");
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    delete raw.official;
    fs.writeFileSync(manifestPath, JSON.stringify({ ...raw, origin: "imported", source: { git: repository, ref: "HEAD" } }, null, 2) + "\n", "utf8");
    adopted.push({ id, repository });
  }
  return adopted;
}

/** One spelling per repository: no trailing slash or .git, case-folded
 *  (git hosts treat owner and repository names case-insensitively). */
export function normalizeGitUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

/** A repository directly under one of the official owners. */
export function isOfficialSource(gitUrl: string, sources: readonly string[] = OFFICIAL_SOURCES): boolean {
  const url = normalizeGitUrl(gitUrl);
  return sources.some((owner) => {
    const prefix = owner.toLowerCase().replace(/\/*$/, "/");
    if (!url.startsWith(prefix)) return false;
    const repo = url.slice(prefix.length);
    return /^[a-z0-9._-]+$/.test(repo) && !/^\.+$/.test(repo);
  });
}

export interface StoreEntry {
  /** Stable key for the entry (what "seen" and "new" are tracked by). */
  id: string;
  name: string;
  description: string;
  author: string;
  repository: string;
  /** Branch or tag to install; the repository's default branch when absent. */
  ref?: string;
  tags: string[];
  /** Day the entry was added, YYYY-MM-DD. */
  added: string;
}

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null;

/** The valid entries of a parsed apps.json. A malformed entry is skipped,
 *  not fatal: one bad pull request must not empty everyone's Store. */
export function parseCatalog(raw: unknown): StoreEntry[] {
  const list = raw && typeof raw === "object" ? (raw as { apps?: unknown }).apps : null;
  if (!Array.isArray(list)) return [];
  const out: StoreEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const id = typeof e.id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(e.id) ? e.id : null;
    const name = text(e.name, 80);
    const description = text(e.description, 500);
    const author = text(e.author, 80);
    const repository = typeof e.repository === "string" && /^https:\/\//.test(e.repository) && isValidGitUrl(e.repository) ? e.repository : null;
    const added = typeof e.added === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.added) ? e.added : null;
    if (!id || !name || !description || !author || !repository || !added || seen.has(id)) continue;
    const ref = typeof e.ref === "string" && /^[\w./-]{1,100}$/.test(e.ref) && !e.ref.includes("..") ? e.ref : undefined;
    const tags = Array.isArray(e.tags)
      ? e.tags.filter((t): t is string => typeof t === "string" && /^[a-z0-9][a-z0-9 -]{0,31}$/.test(t)).slice(0, 8)
      : [];
    seen.add(id);
    out.push({ id, name, description, author, repository, ...(ref ? { ref } : {}), tags, added });
  }
  return out;
}

export interface CatalogResult {
  apps: StoreEntry[];
  /** When the list was last fetched successfully (ms), null if never. */
  fetchedAt: number | null;
  /** Why the latest fetch failed; the last good list is still returned. */
  error?: string;
}

const TTL_MS = 10 * 60 * 1000;
/** After a failed fetch, how soon the next request tries again. */
const RETRY_MS = 60 * 1000;
const MAX_BYTES = 1024 * 1024;

/** The Store list, fetched on demand and kept for ten minutes. The last good
 *  copy is also kept on disk, so a restart while offline still shows it. */
export function createCatalog(opts: { url: string; cacheFile: string; fetcher?: typeof fetch; userAgent: string }) {
  const fetcher = opts.fetcher ?? fetch;
  let memo: { checkedAt: number; result: CatalogResult } | null = null;
  let inflight: Promise<CatalogResult> | null = null;

  const fromDisk = (): CatalogResult | null => {
    try {
      const cached = JSON.parse(fs.readFileSync(opts.cacheFile, "utf8")) as { url?: unknown; at?: unknown; catalog?: unknown };
      if (cached.url !== opts.url || typeof cached.at !== "number") return null;
      return { apps: parseCatalog(cached.catalog), fetchedAt: cached.at };
    } catch {
      return null;
    }
  };

  const refresh = async (): Promise<CatalogResult> => {
    let result: CatalogResult;
    try {
      const res = await fetcher(opts.url, {
        headers: { accept: "application/json", "user-agent": opts.userAgent },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`the list answered ${res.status}`);
      const body = await res.text();
      if (body.length > MAX_BYTES) throw new Error("the list is too large");
      const catalog = JSON.parse(body) as unknown;
      result = { apps: parseCatalog(catalog), fetchedAt: Date.now() };
      try {
        fs.writeFileSync(opts.cacheFile, JSON.stringify({ url: opts.url, at: result.fetchedAt, catalog }) + "\n", "utf8");
      } catch { /* the in-memory copy still serves */ }
    } catch (e) {
      const last = memo?.result.fetchedAt ? memo.result : fromDisk();
      const reason = e instanceof SyntaxError ? "the list is not valid JSON" : (e as Error).message;
      result = { apps: last?.apps ?? [], fetchedAt: last?.fetchedAt ?? null, error: `Couldn't reach the Store: ${reason}` };
    }
    memo = { checkedAt: Date.now(), result };
    return result;
  };

  return {
    get(req: { fresh?: boolean } = {}): Promise<CatalogResult> {
      const fresh = memo && Date.now() - memo.checkedAt < (memo.result.error ? RETRY_MS : TTL_MS);
      if (!req.fresh && fresh) return Promise.resolve(memo!.result);
      inflight ??= refresh().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
