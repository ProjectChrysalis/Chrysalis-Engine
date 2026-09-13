/**
 * The engine's listening socket. Port, LAN access and HTTPS are the only
 * settings that live on the socket rather than in request handling, so the
 * listener can be rebuilt in place when an admin changes them: no restart,
 * and a setting that cannot be applied (port taken, certificate missing)
 * leaves the old socket serving.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "bun";
import { listenHost, type InstanceConfig } from "../config.js";
import { BACKUP_MAX_BYTES } from "../apps/backup.js";
import type { EventBus, WsData } from "./ws.js";

export interface ListenerOptions {
  homeDir: string;
  bus: EventBus;
  handle: (req: Request, peerAddress: string) => Response | Promise<Response>;
}

/** The subset of the config the socket depends on. */
function socketKey(cfg: InstanceConfig): string {
  return JSON.stringify([listenHost(cfg), cfg.port, cfg.ssl.enabled, cfg.ssl.enabled ? [cfg.ssl.certPath, cfg.ssl.keyPath] : null]);
}

function readTls(cfg: InstanceConfig, homeDir: string): { cert: string; key: string } | undefined {
  if (!cfg.ssl.enabled) return undefined;
  const cert = path.resolve(homeDir, cfg.ssl.certPath);
  const key = path.resolve(homeDir, cfg.ssl.keyPath);
  for (const [label, file] of [["certificate", cert], ["private key", key]] as const) {
    if (!fs.existsSync(file)) throw new Error(`HTTPS is on but the ${label} file does not exist: ${file}`);
  }
  return { cert: fs.readFileSync(cert, "utf8"), key: fs.readFileSync(key, "utf8") };
}

function bindError(e: unknown, cfg: InstanceConfig): Error {
  const err = e as NodeJS.ErrnoException;
  if (err.code === "EADDRINUSE" || /in use/i.test(err.message)) {
    return new Error(`port ${cfg.port} is already in use by another program. Pick another port.`);
  }
  if (err.code === "EACCES") return new Error(`this account may not use port ${cfg.port}. Pick a port above 1024.`);
  if (err.code === "EADDRNOTAVAIL") return new Error(`this computer has no network address ${cfg.listenAddress}.`);
  return err instanceof Error ? err : new Error(String(e));
}

export class Listener {
  private server: Server<WsData> | null = null;
  private key = "";

  constructor(private opts: ListenerOptions) {}

  private serve(cfg: InstanceConfig): Server<WsData> {
    const { bus, handle } = this.opts;
    return Bun.serve<WsData>({
      hostname: listenHost(cfg),
      port: cfg.port,
      tls: readTls(cfg, this.opts.homeDir),
      // Keep-alive: browsers pool sockets far longer than a short server idle
      // timeout; a POST dispatched onto a socket the server just FIN'd hangs
      // forever (the client retries idempotent GETs, never POSTs). Outlive
      // browser pools so the CLIENT always closes first and the race becomes a
      // normal client-side reconnect. The 30s websocket heartbeat keeps live
      // sockets active well inside this window.
      idleTimeout: 65,
      // an app backup can be this large; every other route keeps a lower
      // limit of its own (see buildApp)
      maxRequestBodySize: BACKUP_MAX_BYTES + 1024 * 1024,
      websocket: bus.websocket,
      fetch: (req, srv) => {
        const url = new URL(req.url);
        // App pages have no sockets of their own (their event stream rides the
        // shell bridge on /v1/ws): only that path is ever upgraded, every other
        // request is an ordinary HTTP request (including other upgrade
        // attempts, which get a plain 404 instead of a dangling handshake in
        // the browser's per-host socket pool).
        if (url.pathname === "/v1/ws") return bus.upgrade(req, srv, url);
        // The peer address reaches handlers as `peerAddress` (the router has
        // no socket of its own to read); rate-limit buckets key off it.
        return handle(req, srv.requestIP(req)?.address ?? "");
      },
    });
  }

  start(cfg: InstanceConfig): void {
    try {
      this.server = this.serve(cfg);
    } catch (e) {
      throw bindError(e, cfg);
    }
    this.key = socketKey(cfg);
    this.opts.bus.bind(this.server);
  }

  /** Move the socket to a new port/interface/TLS setting. Returns false when
   *  nothing about the socket changes. Throws with a readable reason, having
   *  put the previous socket back, when the new one cannot be opened. */
  rebind(next: InstanceConfig, previous: InstanceConfig): boolean {
    if (socketKey(next) === this.key) return false;
    // validate the certificate before giving up the working socket
    readTls(next, this.opts.homeDir);
    const old = this.server;
    // stop accepting on the old socket; requests already in flight (including
    // the one asking for this change) still get their responses
    old?.stop(false);
    try {
      this.server = this.serve(next);
    } catch (e) {
      this.server = this.serve(previous);
      this.opts.bus.bind(this.server);
      throw bindError(e, next);
    }
    this.key = socketKey(next);
    this.opts.bus.bind(this.server);
    // live sockets belong to the old server and would miss every event the
    // new one publishes: close them so clients reconnect
    this.opts.bus.dropSockets();
    return true;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }
}

/** Where this computer itself reaches the engine. */
export function selfUrl(cfg: InstanceConfig): string {
  const host = listenHost(cfg);
  const addr = host === "0.0.0.0" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `${cfg.ssl.enabled ? "https" : "http"}://${addr}:${cfg.port}`;
}

/** Addresses other devices can use to reach this computer. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  let interfaces: ReturnType<typeof os.networkInterfaces>;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    // Android refuses interface listing to some apps
    return out;
  }
  for (const [name, addrs] of Object.entries(interfaces)) {
    // container bridges and VPN tunnels other than Tailscale are rarely what
    // a phone on the same Wi-Fi can reach
    if (/^(docker|br-|veth|virbr|vmnet|vboxnet)/.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== "IPv4") continue;
      out.push(a.address);
    }
  }
  return out;
}

/** The URLs a person would type: this computer, then every LAN address when
 *  LAN access is on. */
export function engineUrls(cfg: InstanceConfig): { local: string; lan: string[] } {
  const scheme = cfg.ssl.enabled ? "https" : "http";
  const host = listenHost(cfg);
  const local = host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host;
  const lan = cfg.lan ? (host === "0.0.0.0" ? lanAddresses() : [host]) : [];
  return {
    local: `${scheme}://${local}:${cfg.port}`,
    lan: lan.map((a) => `${scheme}://${a.includes(":") ? `[${a}]` : a}:${cfg.port}`),
  };
}
