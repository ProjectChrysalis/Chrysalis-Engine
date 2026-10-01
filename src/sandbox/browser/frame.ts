/**
 * The sandbox frame (/client/sandbox/frame.html): an opaque-origin document
 * with no cookies and no storage. It hosts the runtime's worker and relays
 * messages between it and the page's host (host.ts) over a MessagePort the
 * host hands over once. Nothing here reads or writes the workspace: the
 * runtime fetches file contents with the host's token, and changes go back
 * to the host, which writes them.
 */
const script = document.currentScript as HTMLScriptElement | null;
const entry = new URL(script?.dataset.runtime ?? "", location.href).href;

let port: MessagePort | null = null;
let worker: Worker | null = null;

const transfers = (data: { writes?: [string, Uint8Array][] }): Transferable[] =>
  Array.isArray(data?.writes) ? data.writes.map(([, bytes]) => bytes.buffer as ArrayBuffer) : [];

function start(): void {
  // An opaque origin can start neither a worker from the engine's URL nor a
  // module worker from a blob; a classic blob worker can, and it loads the
  // runtime with import(), which still resolves the runtime's own files
  // against the engine.
  const loader = `import(${JSON.stringify(entry)}).catch((e) => postMessage({ type: "fatal", error: "the sandbox runtime did not load: " + ((e && e.message) || e) }));`;
  const w = new Worker(URL.createObjectURL(new Blob([loader], { type: "text/javascript" })));
  w.onmessage = (event: MessageEvent) => port?.postMessage(event.data, transfers(event.data));
  w.onerror = (event: ErrorEvent) => {
    event.preventDefault();
    port?.postMessage({ type: "fatal", error: event.message || "the sandbox runtime did not load" });
  };
  worker = w;
}

addEventListener("message", (event: MessageEvent) => {
  if (event.source !== parent || port) return;
  const d = event.data as { __chrysalisSandbox?: number; t?: string } | null;
  if (d?.__chrysalisSandbox !== 1 || d.t !== "init" || !event.ports[0]) return;
  port = event.ports[0];
  port.onmessage = (m: MessageEvent) => worker?.postMessage(m.data);
  start();
});

parent.postMessage({ __chrysalisSandbox: 1, t: "loaded" }, "*");
