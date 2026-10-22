/**
 * Newer model data for the built-in providers, between engine releases.
 *
 * The model client publishes its catalog (ids, prices, context windows) as
 * JSON inside each npm release. Once a day the engine reads the latest
 * release of the same major version, checks the tarball against the
 * registry's sha512, and keeps only those JSON files. Nothing from it runs.
 *
 * What the data may change, so a bad file cannot send a key elsewhere or
 * reach a transport this build lacks:
 *  · a new model joins a provider only on an api + baseUrl pair the shipped
 *    catalog already uses, and takes its headers from a shipped model there;
 *  · a shipped model takes only a new name, price, context window and
 *    output limit.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import piPackage from "../node_modules/@earendil-works/pi-ai/package.json" with { type: "json" };
import { log } from "./logger.js";

type Provider = ReturnType<typeof builtinProviders>[number];
type AnyModel = Model<Api> & { type?: string; headers?: Record<string, string> };

const PACKAGE = "@earendil-works/pi-ai";
const REGISTRY = "https://registry.npmjs.org";
const DAY = 24 * 60 * 60 * 1000;
const MAX_TARBALL = 40 * 1024 * 1024;
const DATA_PREFIX = "package/dist/providers/data/";
/** Kinds of model the engine can use; anything else in the data is ignored. */
const TYPES = new Set(["chat", "image"]);

/** The shipped client library's version. */
export const BUNDLED_CATALOG_VERSION: string = piPackage.version;

export interface CatalogFile {
  version: string;
  fetchedAt: string;
  /** provider id → api → "type:id" → model, as the release ships it */
  providers: Record<string, Record<string, Record<string, unknown>>>;
}

export interface CatalogStatus {
  enabled: boolean;
  bundled: string;
  /** The release the newer data came from; null while only shipped data is in use. */
  version: string | null;
  checkedAt: string | null;
  /** Models the newer data added, across all providers. */
  added: number;
  error: string | null;
}

let current: { file: CatalogFile; added: Map<string, AnyModel[]>; updated: Map<string, Map<string, Partial<AnyModel>>> } | null = null;

const major = (v: string) => Number(v.split(".")[0]);

/** -1, 0 or 1, for plain x.y.z versions; prerelease suffixes sort first. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < 3; i++) {
    const d = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return pa.length === pb.length ? 0 : pa.length > pb.length ? -1 : 1;
}

/** Files under DATA_PREFIX in a gzipped tarball, by file name. */
export function dataFilesOf(tgz: Uint8Array): Map<string, string> {
  const tar = gunzipSync(tgz);
  const out = new Map<string, string>();
  let at = 0;
  let longName: string | null = null;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 48);
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const body = tar.subarray(at + 512, at + 512 + size);
    if (type === "x") {
      const m = /\d+ path=([^\n]+)\n/.exec(body.toString("utf8"));
      if (m) longName = m[1]!;
    } else if ((type === "0" || type === "\0") && name.startsWith(DATA_PREFIX) && name.endsWith(".json")) {
      name = name.slice(DATA_PREFIX.length);
      if (!name.includes("/")) out.set(name.slice(0, -5), body.toString("utf8"));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const isNum = (v: unknown, min = 0) => typeof v === "number" && Number.isFinite(v) && v >= min;
const isCost = (v: unknown) => !!v && typeof v === "object" && ["input", "output"].every((k) => isNum((v as Record<string, unknown>)[k]));

function plausible(m: Record<string, unknown>, provider: string): boolean {
  return (
    typeof m.id === "string" && m.id.length > 0 && m.id.length <= 200 &&
    typeof m.name === "string" &&
    typeof m.api === "string" &&
    typeof m.baseUrl === "string" &&
    m.provider === provider &&
    TYPES.has(typeof m.type === "string" ? m.type : "chat") &&
    isNum(m.contextWindow, 1) &&
    isNum(m.maxTokens, 1) &&
    Array.isArray(m.input) &&
    isCost(m.cost)
  );
}

/** Work out what newer data adds to and changes in each shipped provider. */
function overlay(file: CatalogFile, providers: readonly Provider[]): NonNullable<typeof current> {
  const added = new Map<string, AnyModel[]>();
  const updated = new Map<string, Map<string, Partial<AnyModel>>>();
  for (const provider of providers) {
    const groups = file.providers[provider.id];
    if (!groups) continue;
    const shipped = (provider.getAllModels?.() ?? provider.getModels()) as readonly AnyModel[];
    const byKey = new Map(shipped.map((m) => [`${m.type ?? "chat"}:${m.id}`, m]));
    const routes = new Map<string, AnyModel>();
    for (const m of shipped) routes.set(`${m.api} ${m.baseUrl}`, m);
    const extra: AnyModel[] = [];
    const changes = new Map<string, Partial<AnyModel>>();
    for (const group of Object.values(groups)) {
      if (!group || typeof group !== "object") continue;
      for (const raw of Object.values(group)) {
        if (!raw || typeof raw !== "object") continue;
        const m = raw as Record<string, unknown>;
        if (!plausible(m, provider.id)) continue;
        const type = typeof m.type === "string" ? m.type : "chat";
        const known = byKey.get(`${type}:${m.id}`);
        if (known) {
          const change: Partial<AnyModel> = {};
          if (m.name !== known.name) change.name = m.name as string;
          if (JSON.stringify(m.cost) !== JSON.stringify(known.cost)) change.cost = m.cost as AnyModel["cost"];
          if (m.contextWindow !== known.contextWindow) change.contextWindow = m.contextWindow as number;
          if (m.maxTokens !== known.maxTokens) change.maxTokens = m.maxTokens as number;
          if (Object.keys(change).length) changes.set(`${type}:${m.id}`, change);
          continue;
        }
        const sibling = routes.get(`${m.api} ${m.baseUrl}`);
        if (!sibling) continue;
        const { headers: _ignored, ...rest } = m;
        extra.push({ ...rest, type, ...(sibling.headers ? { headers: sibling.headers } : {}) } as unknown as AnyModel);
      }
    }
    if (extra.length) added.set(provider.id, extra);
    if (changes.size) updated.set(provider.id, changes);
  }
  return { file, added, updated };
}

/** A shipped provider with the newer data folded into its catalog. */
export function withCatalogUpdates(provider: Provider): Provider {
  const merge = (models: readonly AnyModel[], types: "chat" | "all"): AnyModel[] => {
    if (!current) return [...models];
    const changes = current.updated.get(provider.id);
    const out = models.map((m) => {
      const change = changes?.get(`${m.type ?? "chat"}:${m.id}`);
      return change ? { ...m, ...change } : m;
    });
    for (const m of current.added.get(provider.id) ?? []) if (types === "all" || m.type === "chat") out.push(m);
    return out;
  };
  return {
    ...provider,
    getModels: () => merge(provider.getModels() as readonly AnyModel[], "chat") as never,
    ...(provider.getAllModels ? { getAllModels: () => merge(provider.getAllModels!() as readonly AnyModel[], "all") as never } : {}),
  } as Provider;
}

/** The shipped providers, each with the newer data folded in. */
export function catalogProviders(): Provider[] {
  return builtinProviders().map(withCatalogUpdates);
}

export class ModelCatalog {
  private checkedAt: string | null = null;
  private error: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private readonly fetch: typeof fetch;
  private readonly registry: string;

  constructor(private readonly opts: { dataDir: string; enabled: () => boolean; fetch?: typeof fetch; registry?: string; bundled?: string }) {
    this.fetch = opts.fetch ?? fetch;
    this.registry = opts.registry ?? REGISTRY;
    this.load();
  }

  private get bundled(): string {
    return this.opts.bundled ?? BUNDLED_CATALOG_VERSION;
  }

  private get file(): string {
    return path.join(this.opts.dataDir, "catalog", "models.json");
  }

  private load(): void {
    try {
      const file = JSON.parse(fs.readFileSync(this.file, "utf8")) as CatalogFile;
      this.checkedAt = file.fetchedAt;
      this.apply(file);
    } catch { /* nothing fetched yet */ }
  }

  private apply(file: CatalogFile | null): void {
    current =
      file && this.opts.enabled() && major(file.version) === major(this.bundled) && compareVersions(file.version, this.bundled) > 0
        ? overlay(file, builtinProviders())
        : null;
  }

  status(): CatalogStatus {
    let added = 0;
    for (const list of current?.added.values() ?? []) added += list.length;
    return { enabled: this.opts.enabled(), bundled: this.bundled, version: current?.file.version ?? null, checkedAt: this.checkedAt, added, error: this.error };
  }

  /** Check now, then once a day while the setting is on. */
  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (!this.opts.enabled()) return;
      const due = !this.checkedAt || Date.now() - Date.parse(this.checkedAt) > DAY - 60_000;
      if (due) void this.refresh().catch(() => undefined);
    };
    setTimeout(tick, 20_000).unref?.();
    this.timer = setInterval(tick, 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Turn the newer data on or off after the setting changed. */
  settingChanged(): void {
    try {
      this.apply(JSON.parse(fs.readFileSync(this.file, "utf8")) as CatalogFile);
    } catch {
      this.apply(null);
    }
    if (this.opts.enabled() && !this.checkedAt) void this.refresh().catch(() => undefined);
  }

  refresh(): Promise<void> {
    this.running ??= this.check().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async check(): Promise<void> {
    try {
      const res = await this.fetch(`${this.registry}/${PACKAGE.replace("/", "%2f")}`, {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`the package registry answered ${res.status}`);
      const meta = (await res.json()) as { versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }> };
      const versions = Object.keys(meta.versions ?? {}).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && major(v) === major(this.bundled));
      const latest = versions.sort(compareVersions).at(-1);
      const have = current?.file.version ?? this.bundled;
      if (latest && compareVersions(latest, have) > 0) {
        const dist = meta.versions![latest]!.dist;
        if (!dist?.tarball || !dist.integrity?.startsWith("sha512-")) throw new Error(`release ${latest} has no sha512 to check against`);
        if (!/^https:\/\//.test(dist.tarball) && !dist.tarball.startsWith(this.registry)) throw new Error("the release download is not https");
        const got = await this.fetch(dist.tarball, { signal: AbortSignal.timeout(120_000) });
        if (!got.ok) throw new Error(`downloading release ${latest} failed (${got.status})`);
        const tgz = new Uint8Array(await got.arrayBuffer());
        if (tgz.length > MAX_TARBALL) throw new Error("the release is larger than expected");
        const sum = `sha512-${crypto.createHash("sha512").update(tgz).digest("base64")}`;
        if (sum !== dist.integrity) throw new Error(`release ${latest} does not match its checksum`);
        const providers: CatalogFile["providers"] = {};
        for (const [id, text] of dataFilesOf(tgz)) {
          try {
            providers[id] = JSON.parse(text) as CatalogFile["providers"][string];
          } catch { /* one unreadable provider leaves the rest */ }
        }
        if (!Object.keys(providers).length) throw new Error(`release ${latest} carries no model data`);
        const file: CatalogFile = { version: latest, fetchedAt: new Date().toISOString(), providers };
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(file));
        fs.renameSync(tmp, this.file);
        this.apply(file);
        log.info(`[models] model list updated from ${latest}: ${this.status().added} new models`);
      } else if (current) {
        const file = { ...current.file, fetchedAt: new Date().toISOString() };
        fs.writeFileSync(this.file, JSON.stringify(file));
        current.file = file;
      }
      this.checkedAt = new Date().toISOString();
      this.error = null;
    } catch (e) {
      this.checkedAt = new Date().toISOString();
      this.error = (e as Error).message;
      log.warn(`[models] model list check failed: ${this.error}`);
      throw e;
    }
  }
}
