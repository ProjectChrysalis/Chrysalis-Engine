// App hot-reload watcher (SPEC-v2 §6 app platform): watches a user's apps/*
// trees and emits `look_changed { app, paths }` on the WS bus so open app
// pages update the moment a file is saved (agent edits, hand edits, engine
// refreshes). A data/ change is hydration the page applies in place; a src/
// change goes to the in-browser builder, which hot-updates open pages.
//
// The event name is the wire contract every client and app already listens
// on, so it keeps its original spelling.
//
// fs.watch(recursive) is the fast path where the platform supports it
// (macOS/Windows always, Linux on the runtimes the engine supports).
// Exotic filesystems fall back to a cheap mtime poll over the
// app trees (node_modules/dist/.git skipped at directory level).
import fs from "node:fs";
import path from "node:path";
import type { EventBus } from "./ws.ts";
import { isBuildSource } from "../builder/server.js";

interface LookWatch {
  appsDir: string;
  close(): void;
}

export interface WatchOpts {
  /** a change to something an app's build reads (see isBuildSource), with
   *  the app-relative paths that changed */
  onBuild?: (app: string, paths: string[]) => void;
}

const active = new Map<string, LookWatch>();

const flush = (username: string, changed: Set<string>, changedBuild: Set<string>, bus: EventBus, opts?: WatchOpts): void => {
  if (changed.size === 0 && changedBuild.size === 0) return;
  const byApp = new Map<string, string[]>();
  for (const rel of changed) {
    const app = rel.split(/[\\/]/)[0];
    if (!app) continue;
    const list = byApp.get(app) ?? [];
    list.push(rel.slice(app.length + 1));
    byApp.set(app, list);
  }
  changed.clear();
  for (const [app, paths] of byApp) bus.emit(username, "look_changed", { app, paths });
  // build sources: hand the changed paths to whoever builds the app
  const buildApps = new Map<string, string[]>();
  for (const rel of changedBuild) {
    const norm = rel.replace(/\\/g, "/");
    const app = norm.split("/")[0];
    if (!app) continue;
    const list = buildApps.get(app) ?? [];
    list.push(norm.slice(app.length + 1));
    buildApps.set(app, list);
  }
  changedBuild.clear();
  for (const [app, paths] of buildApps) opts?.onBuild?.(app, paths);
};

/** Files whose changes apps should hear about as look_changed but which must
 *  NOT trigger a rebuild: per-app data trees (agents and other clients
 *  edit data/...; open app pages re-hydrate on the event). */
const isAppData = (rel: string): boolean => {
  const segs = rel.split(/[\\/]/).filter(Boolean);
  return segs.length >= 2 && segs[1] === "data" && !segs.includes("node_modules");
};

export function ensureLookWatcher(username: string, appsDir: string, bus: EventBus, opts?: WatchOpts): void {
  const cur = active.get(username);
  if (cur && cur.appsDir === appsDir) return;
  if (cur) cur.close(); // workspace moved/renamed or data root changed — re-arm
  if (!fs.existsSync(appsDir)) return;

  const changed = new Set<string>();
  const changedBuild = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  let closed = false;
  let backoff = 2_000;

  const arm = (): void => {
    if (closed || !fs.existsSync(appsDir)) return;
    try {
      watcher = fs.watch(appsDir, { recursive: true }, (_event, filename) => {
        const rel = String(filename ?? "");
        if (isBuildSource(rel)) changedBuild.add(rel);
        else if (isAppData(rel)) changed.add(rel); // data/** → look_changed, no rebuild
        else return;
        clearTimeout(timer);
        timer = setTimeout(() => flush(username, changed, changedBuild, bus, opts), 400);
      });
      watcher.on("error", () => {
        // recursive watchers die when a watched subtree is removed (app
        // installs, plugin dir renames). Retry with backoff — a dead watcher
        // that stays in `active` means hot reload silently never fires again
        try { watcher?.close(); } catch { /* already gone */ }
        watcher = undefined;
        backoff = Math.min(backoff * 2, 30_000);
        retry = setTimeout(arm, backoff);
      });
      backoff = 2_000; // healthy arm — reset the backoff
      return;
    } catch {
      // recursive watch unsupported here — poll mtimes instead
    }
    const scan = (): Map<string, number> => {
      const out = new Map<string, number>();
      let apps: string[] = [];
      try { apps = fs.readdirSync(appsDir); } catch { return out; }
      const skip = new Set(["node_modules", "dist", ".git"]);
      const walk = (dir: string, prefix: string) => {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith(".") || skip.has(e.name)) continue;
          const rel = `${prefix}${e.name}`;
          if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/`);
          else { try { out.set(rel, fs.statSync(path.join(dir, e.name)).mtimeMs); } catch { /* raced */ } }
        }
      };
      for (const app of apps) walk(path.join(appsDir, app), `${app}/`);
      return out;
    };
    let prev = scan();
    poll = setInterval(() => {
      const next = scan();
      const route = (rel: string) => {
        if (isBuildSource(rel)) changedBuild.add(rel);
        else if (isAppData(rel)) changed.add(rel);
      };
      for (const [rel, mtime] of next) {
        if (prev.get(rel) !== mtime) route(rel);
      }
      for (const rel of prev.keys()) if (!next.has(rel)) route(rel); // deletions
      prev = next;
      flush(username, changed, changedBuild, bus, opts);
    }, 700);
  };
  arm();
  active.set(username, {
    appsDir,
    close: () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(retry);
      clearInterval(poll);
      try { watcher?.close(); } catch { /* already gone */ }
    },
  });
}

export function stopLookWatchers(): void {
  for (const w of active.values()) w.close();
  active.clear();
}
