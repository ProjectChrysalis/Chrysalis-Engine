/**
 * The code that runs in the sandbox worker before wasmsh loads. Python can
 * reach raw JS (ctypes + emscripten_run_script_string), so the
 * worker's network and code-evaluation primitives are locked down before
 * wasmsh loads. Every construction path is covered: the globals AND the
 * prototype copies (WorkerGlobalScope exposes fetch twice), and the wrapped
 * constructors' prototypes no longer expose the originals.
 *
 * With `net` set, http(s) requests to anywhere but the runtime's own assets
 * go to the engine's sandbox proxy instead, carrying the token.
 */
export function workerLockdown(workerUrl: string, net: { token: string; url: string } | null): string {
  return `
;(function () {
  var BASE = ${JSON.stringify(workerUrl)};
  var PREFIX = new URL("/client/sandbox/wasmsh/", BASE).href;
  function allowed(u) {
    try {
      var s = typeof u === "string" ? u : (u && (u.url || u.href)) || "";
      var abs = new URL(s, BASE).href;
      return abs.indexOf(PREFIX) === 0;
    } catch (_) { return false; }
  }
  function deny() { throw new DOMException("sandbox: network is disabled", "SecurityError"); }
  // internet on: any other http(s) URL becomes a request to the engine's
  // proxy, which makes it on the sandbox's behalf
  var NET = ${JSON.stringify(net)};
  function external(u) {
    try {
      var abs = new URL(typeof u === "string" ? u : (u && (u.url || u.href)) || "", BASE);
      return NET && (abs.protocol === "http:" || abs.protocol === "https:") ? abs.href : null;
    } catch (_) { return null; }
  }
  function netHeaders(url, method, pairs) {
    return {
      "x-sandbox-token": NET.token,
      "x-sandbox-url": url,
      "x-sandbox-method": method,
      "x-sandbox-headers": encodeURIComponent(JSON.stringify(pairs)),
    };
  }
  var proto = Object.getPrototypeOf(self);
  function own(name, value) {
    try { if (name in self) Object.defineProperty(self, name, { value: value, writable: true, configurable: true }); } catch (_) {}
    try { if (proto && name in proto) Object.defineProperty(proto, name, { value: value, writable: true, configurable: true }); } catch (_) {}
  }
  var origFetch = self.fetch && self.fetch.bind(self);
  var guardedFetch = function (input, init) {
    if (allowed(input)) return origFetch(input, init);
    var target = external(input);
    if (!target) return Promise.reject(new TypeError("sandbox: network is disabled"));
    var req = new Request(input, init);
    var pairs = [];
    req.headers.forEach(function (v, k) { pairs.push([k, v]); });
    var bodied = req.method !== "GET" && req.method !== "HEAD";
    return (bodied ? req.arrayBuffer() : Promise.resolve(null)).then(function (body) {
      return origFetch(NET.url, { method: "POST", headers: netHeaders(target, req.method, pairs), body: body, signal: init && init.signal });
    });
  };
  own("fetch", guardedFetch);

  var RealXHR = self.XMLHttpRequest;
  if (RealXHR) {
    var realOpen = RealXHR.prototype.open;
    var realSetHeader = RealXHR.prototype.setRequestHeader;
    var realSend = RealXHR.prototype.send;
    var pending = new WeakMap();
    RealXHR.prototype.open = function (method, url) {
      pending.delete(this);
      if (allowed(url)) return realOpen.apply(this, arguments);
      var target = external(url);
      if (!target) throw new DOMException("sandbox: network is disabled", "NetworkError");
      pending.set(this, { url: target, method: String(method).toUpperCase(), headers: [] });
      return realOpen.call(this, "POST", NET.url, arguments.length > 2 ? arguments[2] : true);
    };
    RealXHR.prototype.setRequestHeader = function (name, value) {
      var p = pending.get(this);
      if (!p) return realSetHeader.apply(this, arguments);
      p.headers.push([String(name), String(value)]);
    };
    RealXHR.prototype.send = function (body) {
      var p = pending.get(this);
      if (!p) return realSend.apply(this, arguments);
      var h = netHeaders(p.url, p.method, p.headers);
      for (var k in h) realSetHeader.call(this, k, h[k]);
      return realSend.call(this, p.method === "GET" || p.method === "HEAD" ? null : body);
    };
    // the original constructor must not be reachable through its prototype
    try { RealXHR.prototype.constructor = deny; } catch (_) {}
    var WrappedXHR = function () { return new RealXHR(); };
    WrappedXHR.prototype = RealXHR.prototype;
    own("XMLHttpRequest", WrappedXHR);
  }

  var realImport = self.importScripts && self.importScripts.bind(self);
  var guardedImport = function () {
    for (var i = 0; i < arguments.length; i++) if (!allowed(String(arguments[i]))) deny();
    return realImport.apply(null, arguments);
  };
  if (realImport) own("importScripts", guardedImport);

  function guardTimer(real) {
    if (!real) return real;
    return function (handler) {
      if (typeof handler === "string") deny();
      return real.apply(self, arguments);
    };
  }
  own("setTimeout", guardTimer(self.setTimeout));
  own("setInterval", guardTimer(self.setInterval));

  own("WebSocket", deny);
  own("EventSource", deny);
  own("Worker", deny);
  own("SharedWorker", deny);
  own("RTCPeerConnection", deny);
  own("webkitRTCPeerConnection", deny);
  own("WebTransport", deny);
  if (self.navigator && self.navigator.sendBeacon) self.navigator.sendBeacon = deny;

  // After boot nothing needs to evaluate code from strings: lock eval and the
  // whole Function family so the pyodide bridge cannot compile its way around
  // the guards (emscripten_run_script_string goes through global eval).
  self.__sandboxLockEval = function () {
    var locked = function () { throw new DOMException("sandbox: code evaluation is disabled", "SecurityError"); };
    // the real prototype stays reachable as Function.prototype (callers use
    // Function.prototype.apply), and its constructor is what gets locked
    var FunctionProto = Function.prototype;
    locked.prototype = FunctionProto;
    try { self.eval = locked; } catch (_) {}
    try { self.Function = locked; } catch (_) {}
    try { Object.defineProperty(FunctionProto, "constructor", { value: locked, writable: true, configurable: true }); } catch (_) {}
    try { Object.getPrototypeOf(async function () {}).constructor.prototype.constructor = locked; } catch (_) {}
    try { Object.getPrototypeOf(function* () {}).constructor.prototype.constructor = locked; } catch (_) {}
    try { Object.getPrototypeOf(async function* () {}).constructor.prototype.constructor = locked; } catch (_) {}
  };
})();
`;
}
