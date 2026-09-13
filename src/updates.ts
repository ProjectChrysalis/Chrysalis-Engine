/**
 * Is there a newer Chrysalis? Asked of the project's GitHub releases only
 * when an admin looks (Settings > Server), never in the background, and
 * remembered for an hour so reopening the page does not ask again.
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

export async function latestRelease(fetcher: typeof fetch = fetch): Promise<ReleaseInfo | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const slug = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(ENGINE_REPOSITORY ?? "")?.[1];
  if (!slug) return null;
  let value: ReleaseInfo | null = null;
  try {
    const res = await fetcher(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `Chrysalis/${ENGINE_VERSION}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
      if (typeof body.tag_name === "string" && typeof body.html_url === "string") {
        const version = body.tag_name.replace(/^v/, "");
        value = { version, url: body.html_url, newer: isNewer(version, ENGINE_VERSION) };
      }
    }
  } catch {
    // offline: say nothing rather than something wrong
    return null;
  }
  cached = { at: Date.now(), value };
  return value;
}
