/**
 * Internet access for the agent sandbox. The sandbox frame is opaque-origin,
 * so it cannot carry the user's session and most sites would refuse its
 * cross-origin requests anyway. Its fetches come here instead: the frame
 * holds a capability token, and the engine makes the request itself.
 *
 * What the proxy will not do is reach this machine or its network. Every
 * address a name resolves to is checked at connect time (so a name cannot
 * resolve publicly for a check and privately for the request), and every
 * redirect hop is checked again.
 */
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import type { HttpClient } from "isomorphic-git";
import { isPrivateAddress } from "../net-guard.js";

export interface SandboxSettings {
  /** The agent's shell may reach the internet (curl, wget, pip). */
  internet: boolean;
}

const DEFAULTS: SandboxSettings = { internet: true };

export function readSandboxSettings(file: string): SandboxSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SandboxSettings>;
    return { internet: typeof raw.internet === "boolean" ? raw.internet : DEFAULTS.internet };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSandboxSettings(file: string, settings: SandboxSettings): void {
  // leaving the epoch in the stored file (not the public settings shape)
  const epoch = readSandboxEpoch(file);
  const tokenEpoch = settings.internet ? epoch : epoch + 1;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...settings, tokenEpoch }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

/**
 * Signing key for the frame's net tokens, created on first use under the data
 * dir (0600). Persisted on purpose: an in-memory token map died with the
 * process, so every engine restart silently cut the sandbox's internet off
 * until the frame was rebuilt.
 */
let netKey: Buffer | null = null;

export function initNetTokens(dataDir: string): void {
  const file = path.join(dataDir, "sandbox-net-key");
  try {
    const raw = fs.readFileSync(file);
    if (raw.length >= 32) {
      netKey = raw;
      return;
    }
  } catch { /* first run */ }
  netKey = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, netKey, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

/** A signed username + epoch: any engine instance holding the key accepts it,
 *  so restarts are invisible to a live sandbox frame. */
function netSignature(username: string, epoch: number): string {
  return crypto.createHmac("sha256", netKey!).update(`sandbox-net:${username}:${epoch}`).digest("base64url");
}

/** A token the user's sandbox frame presents instead of a session. */
export function issueNetToken(username: string, epoch: number): string {
  const payload = Buffer.from(JSON.stringify({ u: username, e: epoch }), "utf8").toString("base64url");
  return `${payload}.${netSignature(username, epoch)}`;
}

export function netTokenUser(token: string | undefined): { username: string; epoch: number } | null {
  if (!token || !netKey) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token.slice(0, dot), "base64url").toString("utf8")) as { u?: unknown; e?: unknown };
    if (typeof parsed.u !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(parsed.u)) return null;
    const epoch = typeof parsed.e === "number" && Number.isInteger(parsed.e) ? parsed.e : 0;
    const expected = Buffer.from(netSignature(parsed.u, epoch));
    const given = Buffer.from(token.slice(dot + 1));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return { username: parsed.u, epoch };
  } catch {
    return null;
  }
}

/** Turn counter for the capability: switching internet off bumps it, which
 *  invalidates tokens issued before the switch. */
export function readSandboxEpoch(file: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { tokenEpoch?: unknown };
    return typeof raw.tokenEpoch === "number" && Number.isInteger(raw.tokenEpoch) && raw.tokenEpoch >= 0 ? raw.tokenEpoch : 0;
  } catch {
    return 0;
  }
}

const MAX_REDIRECTS = 10;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/** Headers the proxy sets itself, or that describe the hop rather than the
 *  request. */
const DROP_REQUEST = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding", "keep-alive", "upgrade", "proxy-authorization", "te", "trailer"]);
const DROP_RESPONSE = new Set(["connection", "content-length", "transfer-encoding", "keep-alive", "content-encoding", "set-cookie", "alt-svc", "strict-transport-security"]);

const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as unknown as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || list.length === 0) {
      return callback(new Error(`${hostname} is a local network address, which the sandbox may not reach`), "", 4);
    }
    if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

function checkTarget(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("the sandbox may not reach this machine");
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error(`${host} is a local network address, which the sandbox may not reach`);
}

interface Hop {
  url: URL;
  method: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
}

function request(url: URL, method: string, headers: Record<string, string>, body: Uint8Array | null, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method, headers: { ...headers, "accept-encoding": "identity" }, lookup: guardedLookup, signal }, (res) =>
      resolve({ url, method, status: res.statusCode ?? 502, headers: res.headers, body: res }),
    );
    req.on("error", reject);
    req.end(body && body.byteLength ? Buffer.from(body) : undefined);
  });
}

/** A request to a public address, following redirects and checking every
 *  hop. Throws with a message a command can print. */
async function guardedRequest(url: URL, method: string, headers: Record<string, string>, body: Uint8Array | null, signal: AbortSignal): Promise<Hop> {
  checkTarget(url);
  let hop = await request(url, method, headers, body, signal);
  for (let n = 0; hop.status >= 300 && hop.status < 400 && typeof hop.headers.location === "string"; n++) {
    hop.body.resume();
    if (n >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
    const next = new URL(hop.headers.location, url);
    checkTarget(next);
    // a redirect that changes the method drops the body with it
    if (hop.status === 303 || ((hop.status === 301 || hop.status === 302) && method === "POST")) {
      method = method === "HEAD" ? "HEAD" : "GET";
      body = null;
      delete headers["content-type"];
    }
    if (next.origin !== url.origin) {
      delete headers.authorization;
      delete headers.cookie;
    }
    url = next;
    hop = await request(url, method, headers, body, signal);
  }
  return hop;
}

export interface ProxyInput {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | null;
}

/** Make the sandbox's request, following redirects. Errors (a refused
 *  address, a timeout) come back as a 502 whose body says why, which is what
 *  the command in the sandbox prints. */
export async function proxySandboxRequest(input: ProxyInput): Promise<Response> {
  const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
  const fail = (message: string) => new Response(`sandbox network: ${message}\n`, { status: 502, headers: { ...cors, "content-type": "text/plain; charset=utf-8" } });
  let url: URL;
  try {
    url = new URL(input.url);
  } catch (e) {
    return fail((e as Error).message);
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of input.headers) {
    const name = k.toLowerCase();
    if (!DROP_REQUEST.has(name) && /^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) headers[name] = v;
  }
  // the sandbox's HTTP runs through XHR, which cannot set a User-Agent, and
  // many sites refuse a request without one
  headers["user-agent"] ??= "chrysalis-sandbox/1.0";
  const method = /^[A-Z]{1,16}$/.test(input.method) ? input.method : "GET";

  let hop: Hop;
  try {
    hop = await guardedRequest(url, method, headers, method === "GET" || method === "HEAD" ? null : input.body, AbortSignal.timeout(TIMEOUT_MS));
  } catch (e) {
    return fail((e as Error).message);
  }

  const out = new Headers(cors);
  for (const [k, v] of Object.entries(hop.headers)) {
    if (DROP_RESPONSE.has(k) || v === undefined) continue;
    out.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  out.set("x-sandbox-final-url", hop.url.href);
  const status = hop.status < 200 || hop.status > 599 ? 502 : hop.status;
  if (hop.method === "HEAD" || status === 204 || status === 205 || status === 304) {
    hop.body.resume();
    return new Response(null, { status, headers: out });
  }
  const source = hop.body;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      source.on("data", (chunk: Buffer) => {
        sent += chunk.byteLength;
        if (sent > MAX_RESPONSE_BYTES) {
          controller.error(new Error(`response larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`));
          source.destroy();
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      });
      source.on("end", () => controller.close());
      source.on("error", (e) => controller.error(e));
    },
    cancel() {
      source.destroy();
    },
  });
  return new Response(stream, { status, headers: out });
}

/** Largest single response a clone reads (the pack arrives as one). */
const MAX_CLONE_RESPONSE_BYTES = 512 * 1024 * 1024;
const CLONE_TIMEOUT_MS = 5 * 60_000;

/** The HTTP client the agent's git clone uses: the same reach as the
 *  sandbox's curl, so a repository address cannot point it at this machine
 *  or its network. */
export const guardedGitHttp: HttpClient = {
  async request({ url, method = "GET", headers = {}, body }) {
    const chunks: Uint8Array[] = [];
    if (body) for await (const chunk of body) chunks.push(chunk);
    const hop = await guardedRequest(new URL(url), method, { ...headers, "user-agent": "git/chrysalis" }, chunks.length ? Buffer.concat(chunks) : null, AbortSignal.timeout(CLONE_TIMEOUT_MS));
    const source = hop.body;
    async function* capped(): AsyncGenerator<Uint8Array> {
      let read = 0;
      for await (const chunk of source as AsyncIterable<Buffer>) {
        read += chunk.byteLength;
        if (read > MAX_CLONE_RESPONSE_BYTES) {
          source.destroy();
          throw new Error(`the repository is larger than ${MAX_CLONE_RESPONSE_BYTES / 1024 / 1024} MB`);
        }
        yield new Uint8Array(chunk);
      }
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(hop.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
    return { url: hop.url.href, method: hop.method, statusCode: hop.status, statusMessage: source.statusMessage ?? "", headers: out, body: capped() };
  },
};

/** The git arguments a sandbox shell request carries: one base64 line per
 *  argument (see SHELL_PRELUDE). */
export function decodeGitArgs(body: string): string[] {
  const lines = body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => Buffer.from(line.trim(), "base64").toString("utf8"));
}
