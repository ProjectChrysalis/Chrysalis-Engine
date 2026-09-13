/**
 * Dev server for one frontend, in front of a running engine.
 *
 *   bun run dev:shell     # shell, hot updates, :5173
 *   bun run dev:agent     # agent UI, hot updates, :5174
 *
 * The page itself is bundled and hot-updated by Bun's development server
 * (`development: { hmr, console }`): editing a component or a stylesheet
 * updates the open browser without a reload. Everything the page asks the
 * engine for — /v1, app frames under /app, the builder and sandbox bundles
 * under /client, uploaded assets — is proxied to the engine untouched,
 * websockets included.
 *
 * Proxy detail that keeps the engine's guards happy: the engine checks the
 * request Host against its own names and compares Origin to Host on writes.
 * The proxied request keeps the browser's Host (the dev host) and gets the
 * engine's own Origin, so it reads as a same-origin request from a known host.
 */
import type { HTMLBundle, ServerWebSocket } from "bun";

export interface Frontend {
  /** the imported index.html of the project being served */
  html: HTMLBundle;
  port: number;
  label: string;
}

interface RelayData {
  upstream: WebSocket | null;
  /** the browser's upgrade request headers, replayed upstream */
  headers: Record<string, string>;
  /** the upgrade's query string (?token=…), replayed upstream */
  search: string;
}

const engineUrl = (): URL => new URL(process.env.ENGINE_URL ?? "http://127.0.0.1:8788");

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

async function proxy(req: Request, engine: URL): Promise<Response> {
  const url = new URL(req.url);
  const target = new URL(url.pathname + url.search, engine);
  const headers = new Headers(req.headers);
  // the engine compresses on Accept-Encoding; the dev server reads bodies
  for (const h of [...HOP_BY_HOP, "accept-encoding", "host"]) headers.delete(h);
  headers.set("origin", engine.origin);
  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body;
  const res = await fetch(target, init);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export function serveFrontend({ html, port, label }: Frontend): void {
  const engine = engineUrl();
  const server = Bun.serve({
    port,
    hostname: process.env.HOST ?? "127.0.0.1",
    development: { hmr: true, console: true },
    routes: { "/": html, "/index.html": html },
    websocket: {
      // The shell's event stream (chat deltas, look_changed, app_built) rides
      // /v1/ws. Bun's server accepts the socket here and relays it upstream.
      data: { upstream: null, headers: {}, search: "" } satisfies RelayData,
      open(ws: ServerWebSocket<RelayData>) {
        // SAFETY: Bun's WebSocket client takes a `headers` option of its own;
        // the DOM WebSocket type does not declare it.
        const upstream = new WebSocket(new URL(`/v1/ws${ws.data.search}`, engine), { headers: ws.data.headers } as never);
        ws.data.upstream = upstream;
        // SAFETY: the engine's frames are JSON text; the client receives them
        // as strings on this socket.
        upstream.onmessage = (e) => ws.send(e.data as string);
        upstream.onclose = (e) => ws.close(e.code === 1000 ? 1000 : 1001, e.reason);
        upstream.onerror = () => ws.close(1001, "engine socket failed");
      },
      message(ws: ServerWebSocket<RelayData>, message: string | Buffer) {
        ws.data.upstream?.send(message);
      },
      close(ws: ServerWebSocket<RelayData>) {
        ws.data.upstream?.close();
        ws.data.upstream = null;
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/ws" && (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        const headers: Record<string, string> = {};
        for (const name of ["cookie", "origin", "user-agent", "sec-websocket-protocol"]) {
          const value = req.headers.get(name);
          if (value) headers[name] = value;
        }
        // the upstream handshake must look like it came from this dev host,
        // which is what the engine's origin check compares against
        headers.host = url.host;
        const ok = srv.upgrade(req, { data: { upstream: null, headers, search: url.search } });
        return ok ? undefined : new Response("websocket upgrade failed", { status: 400 });
      }
      return proxy(req, engine);
    },
  });
  console.log(`${label}: http://${server.hostname}:${server.port}  (engine ${engine.origin}, HMR on)`);
}
