/**
 * Is there a newer Chrysalis? Asked of the project's GitHub releases only
 * when an admin looks (Settings > Server), never in the background, and
 * remembered for an hour so reopening the page does not ask again.
 *
 * Stable copies compare against the latest release. Staging copies follow the
 * rolling staging-latest pre-release instead: it is replaced on every push, so
 * any build other than this one is newer.
 */
import { ENGINE_REPOSITORY, ENGINE_VERSION } from "./install.js";

export interface ReleaseInfo {
  version: string;
  url: string;
  newer: boolean;
}

let cached: { at: number; value: ReleaseInfo | null } | null = null;
const TTL_MS = 60 * 60 * 1000;

/** "1.10.0" > "1.9.2"; a pre-release suffix is ignored. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export const isStagingBuild = (version: string): boolean => version.includes("-staging");

/** The build a staging-latest release carries, read from its title
 *  ("Staging <version>") or failing that from an asset name. */
export function stagingVersionOf(release: { name?: unknown; assets?: unknown }): string | null {
  const title = typeof release.name === "string" ? /^Staging\s+(\S+)$/.exec(release.name.trim())?.[1] : undefined;
  if (title) return title;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  for (const asset of assets) {
    const name = (asset as { name?: unknown })?.name;
    const m = typeof name === "string" ? /^Chrysalis-(.+-staging\.[^-]+)-[a-z0-9]+-[a-z0-9]+\.(?:zip|tar\.gz|apk)$/.exec(name) : null;
    if (m?.[1]) return m[1];
  }
  return null;
}

export async function latestRelease(fetcher: typeof fetch = fetch, current: string = ENGINE_VERSION): Promise<ReleaseInfo | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const slug = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(ENGINE_REPOSITORY ?? "")?.[1];
  if (!slug) return null;
  const staging = isStagingBuild(current);
  let value: ReleaseInfo | null = null;
  try {
    const res = await fetcher(`https://api.github.com/repos/${slug}/releases/${staging ? "tags/staging-latest" : "latest"}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `Chrysalis/${current}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; name?: unknown; assets?: unknown };
      if (typeof body.html_url === "string") {
        if (staging) {
          const version = stagingVersionOf(body);
          if (version) value = { version, url: body.html_url, newer: version !== current };
        } else if (typeof body.tag_name === "string") {
          const version = body.tag_name.replace(/^v/, "");
          value = { version, url: body.html_url, newer: isNewer(version, current) };
        }
      }
    }
  } catch {
    // offline: say nothing rather than something wrong
    return null;
  }
  cached = { at: Date.now(), value };
  return value;
}
