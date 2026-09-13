/** WebSocket event bus (SPEC §6): chat deltas, agent events, look_changed.
 *
 *  Runs on the runtime's native sockets. An upgrade is authorized in the HTTP
 *  handler — origin, bearer token, session cookie — before the handshake is
 *  handed over, and an event reaches one user's sockets through a single
 *  pub/sub topic per username. */
import fs from "node:fs";
import path from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { UserService } from "../users.js";
import type { SessionService } from "../sessions.js";
import { ENGINE_VERSION, INSTALL_KIND, resourcesDir } from "../install.js";

export interface WsData {
  username: string;
  /** Heartbeat state: a socket that misses one pong is terminated. */
  alive: boolean;
}

const SESSION_COOKIE = "chrysalis_session";
const HEARTBEAT_MS = 30_000;

/** Browsers send Origin on every websocket handshake and the socket has no
 *  CORS: without this check any page on the same site (another port on
 *  localhost or on the LAN address) opens the bus on the user's cookie and
 *  reads every agent and generation event. Clients without an Origin
 *  (bearer-token tools) pass. */
export function upgradeOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return new URL(origin).host.toLowerCase() === (host ?? "").trim().toLowerCase();
  } catch {
    return false;
  }
}

/** Engine code identity, sent with every hello. Clients compare it across WS
 *  reconnects: a changed stamp means the engine restarted with new code, and
 *  a tab still running the old bundle self-reloads (no-store headers only
 *  help once a page actually reloads — long-lived tabs never do on their own).
 *  The stamp hashes the engine's own source mtimes, NOT the boot time: a
 *  same-code restart must keep the stamp or every open app tab reloads for
 *  nothing. */
const ENGINE_BUILD = ((): string | number => {
  // a packaged build's code only changes with its version
  if (INSTALL_KIND !== "source") return ENGINE_VERSION;
  let h = 0x811c9dc5;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  const root = resourcesDir();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".mjs")) mix(`${path.relative(root, p)}:${fs.statSync(p).mtimeMs}`);
    }
  };
  walk(path.join(root, "src"));
  mix(`package.json:${fs.statSync(path.join(root, "package.json")).mtimeMs}`);
  return h;
})();

export class EventBus {
  private server: Server<WsData> | null = null;
  private users: UserService | null = null;
  private sessions: SessionService | null = null;
  private sockets = new Set<ServerWebSocket<WsData>>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  /** Auth sources for upgrades. Call before serving. */
  attach(users: UserService, sessions?: SessionService): void {
    this.users = users;
    this.sessions = sessions ?? null;
  }

  /** Socket handlers, passed straight to the server constructor. */
  readonly websocket: WebSocketHandler<WsData> = {
    // Every connection overrides this in upgrade(); the placeholder types the
    // handler for the sockets the server creates.
    data: { username: "", alive: true },
    open: (ws: ServerWebSocket<WsData>) => {
      this.sockets.add(ws);
      ws.subscribe(ws.data.username);
      ws.send(JSON.stringify({ type: "hello", username: ws.data.username, build: ENGINE_BUILD }));
      this.armHeartbeat();
    },
    // Server → client only: a client frame is read and dropped.
    message: () => {},
    pong: (ws: ServerWebSocket<WsData>) => {
      ws.data.alive = true;
    },
    close: (ws: ServerWebSocket<WsData>) => {
      this.sockets.delete(ws);
    },
  };

  /** Authorize and upgrade a /v1/ws request. A returned Response is a refused
   *  handshake; undefined means the socket was handed over (or the upgrade
   *  could not be completed, in which case the client sees a 400). */
  upgrade(req: Request, server: Server<WsData>, url: URL): Response | undefined {
    if (!upgradeOriginAllowed(req.headers.get("origin") ?? undefined, req.headers.get("host") ?? undefined)) {
      return new Response("Forbidden", { status: 403 });
    }
    const token = url.searchParams.get("token") ?? "";
    const peer = server.requestIP(req)?.address ?? "ws";
    let user = token ? this.users?.verify(token, peer) ?? null : null;
    if (!user && this.sessions) {
      // web client: session cookie on the upgrade request
      const cookies = req.headers.get("cookie") ?? "";
      const row = cookies.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${SESSION_COOKIE}=`));
      const sess = row ? this.sessions.verify(row.slice(SESSION_COOKIE.length + 1)) : null;
      const bySession = sess ? this.users?.get(sess.username) ?? null : null;
      user = bySession && bySession.enabled !== false ? bySession : null;
    }
    if (!user) return new Response("Unauthorized", { status: 401 });
    const ok = server.upgrade(req, { data: { username: user.username, alive: true } });
    return ok ? undefined : new Response("Upgrade failed", { status: 400 });
  }

  /** Give the bus the listening server it publishes through. */
  bind(server: Server<WsData>): void {
    this.server = server;
  }

  /** Broadcast an event to the owning user's sockets only. */
  emit(username: string, type: string, payload: unknown): void {
    this.server?.publish(username, JSON.stringify({ type, payload }));
  }

  /** Close every live socket so its client reconnects (to a new listener). */
  dropSockets(): void {
    for (const ws of this.sockets) {
      try {
        ws.close(1012, "server moved");
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear();
  }

  dispose(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const ws of this.sockets) {
      try {
        ws.close(1001, "server shutting down");
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear();
    this.server = null;
  }

  private armHeartbeat(): void {
    if (this.heartbeat) return;
    // A tab that vanishes without a close frame (killed process, sleep)
    // leaves a half-open socket the OS holds for keepalive hours. Ping every
    // 30s and terminate after one missed pong so dead clients leave the set
    // and free their fd.
    this.heartbeat = setInterval(() => {
      for (const ws of this.sockets) {
        if (!ws.data.alive) {
          ws.terminate();
          this.sockets.delete(ws);
          continue;
        }
        ws.data.alive = false;
        ws.ping();
      }
    }, HEARTBEAT_MS);
  }
}
