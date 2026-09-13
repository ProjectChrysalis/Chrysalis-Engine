/**
 * Chrysalis app bridge — runs FIRST in every app page, inside the shell's
 * sandboxed iframe. The frame has an opaque origin: no cookies, no storage,
 * no parent access, and its CSP says connect-src 'none'. Every interaction
 * with the engine goes through this script, which posts a request to the
 * host page; the host validates it against the app allowlist and performs it
 * with the user's session.
 *
 * Shims: fetch, WebSocket, localStorage, sessionStorage, document.cookie,
 * plus a rewriter that turns /v1 asset URLs into blob: URLs fetched over the
 * bridge (plain <img>/style loads cannot carry the session).
 */
(function () {
  "use strict";
  if (window.__chrysalisBridge) return;
  window.__chrysalisBridge = true;

  var parentWin = window.parent !== window ? window.parent : null;
  var nonce = "";
  var ready = false;
  var initQueue = [];
  var pending = {};
  var nextId = 1;
  var wsSeq = 1;

  function whenReady(fn) {
    if (ready) fn();
    else initQueue.push(fn);
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64ToText(b64) {
    try { return new TextDecoder().decode(b64ToBytes(b64)); } catch { return ""; }
  }

  function post(msg) {
    if (!parentWin) return;
    msg.__chrysalis = 1;
    msg.nonce = nonce;
    parentWin.postMessage(msg, "*");
  }
  /** websocket URLs serialize ws(s):// while location says http(s)://: same
   *  engine = same host/port and the matching ws/wss scheme. */
  function sameEngine(url) {
    var base = new URL(location.href);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return url.origin === base.origin;
    var want = base.protocol === "https:" ? "wss:" : "ws:";
    return url.protocol === want && url.host === base.host;
  }
  function call(msg) {
    return new Promise(function (resolve, reject) {
      whenReady(function () {
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        msg.__chrysalis = 1;
        msg.id = id;
        msg.nonce = nonce;
        parentWin.postMessage(msg, "*");
      });
    });
  }

  window.addEventListener("message", function (e) {
    if (!parentWin || e.source !== parentWin) return;
    var d = e.data;
    if (!d || d.__chrysalis !== 1) return;
    if (d.type === "init") {
      nonce = d.nonce;
      ready = true;
      var q = initQueue;
      initQueue = [];
      for (var i = 0; i < q.length; i++) q[i]();
      return;
    }
    if (d.type === "fetch-result" || d.type === "fetch-error") {
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      if (d.type === "fetch-error") p.reject(new Error(d.error || "bridge fetch failed"));
      else p.resolve(d);
      return;
    }
    if (d.type === "ws-event") deliverWs(d);
  });

  // ---------- fetch ----------
  var TOO_BIG = 32 * 1024 * 1024;
  function bridgeFetch(input, init) {
    var req;
    try { req = new Request(input, init); } catch (e) { return Promise.reject(e); }
    var url;
    try { url = new URL(req.url, location.href); } catch { return Promise.reject(new TypeError("bad url")); }
    if (!parentWin) return Promise.reject(new TypeError("this app is not running inside Chrysalis"));
    if (url.origin !== new URL(location.href).origin) {
      return Promise.reject(new TypeError("blocked by the app sandbox: the bridge only reaches this engine"));
    }
    var isBodyless = req.method === "GET" || req.method === "HEAD";
    return req.arrayBuffer().then(function (buf) {
      if (buf.byteLength > TOO_BIG) throw new Error("request body too large for the bridge");
      var headers = [];
      req.headers.forEach(function (v, k) { headers.push([k, v]); });
      return call({
        type: "fetch",
        method: req.method,
        url: url.pathname + url.search,
        headers: headers,
        body: isBodyless || buf.byteLength === 0 ? null : bytesToB64(new Uint8Array(buf)),
      });
    }).then(function (res) {
      var body = res.body ? b64ToBytes(res.body) : null;
      var status = res.status || 200;
      var bodyless = status === 204 || status === 205 || status === 304;
      var out = bodyless || !body || body.byteLength === 0 ? null : body;
      try {
        return new Response(out, { status: status, statusText: res.statusText || "", headers: res.headers || [] });
      } catch {
        return new Response(out, { status: 200, headers: res.headers || [] });
      }
    });
  }
  try { window.fetch = bridgeFetch; } catch { /* frozen window */ }

  // ---------- WebSocket ----------
  var sockets = {};
  function BridgeWebSocket(url, protocols) {
    var self = this;
    this.url = String(url);
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.extensions = "";
    this.protocol = Array.isArray(protocols) ? (protocols[0] || "") : (protocols || "");
    this.binaryType = "blob";
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._id = wsSeq++;
    this._listeners = { open: [], message: [], error: [], close: [] };
    sockets[this._id] = this;
    var target;
    try { target = new URL(this.url, location.href); } catch { target = null; }
    if (!parentWin || !target || !sameEngine(target)) {
      setTimeout(function () { self._fail(); }, 0);
      return;
    }
    call({
      type: "ws-open",
      wsId: this._id,
      url: target.pathname + target.search,
      protocols: Array.isArray(protocols) ? protocols : protocols ? [protocols] : [],
    }).catch(function () { self._fail(); });
  }
  BridgeWebSocket.CONNECTING = 0;
  BridgeWebSocket.OPEN = 1;
  BridgeWebSocket.CLOSING = 2;
  BridgeWebSocket.CLOSED = 3;
  BridgeWebSocket.prototype.CONNECTING = 0;
  BridgeWebSocket.prototype.OPEN = 1;
  BridgeWebSocket.prototype.CLOSING = 2;
  BridgeWebSocket.prototype.CLOSED = 3;
  BridgeWebSocket.prototype.addEventListener = function (type, fn) {
    if (this._listeners[type]) this._listeners[type].push(fn);
  };
  BridgeWebSocket.prototype.removeEventListener = function (type, fn) {
    var l = this._listeners[type];
    if (!l) return;
    var i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  BridgeWebSocket.prototype._emit = function (type, ev) {
    var handler = this["on" + type];
    if (typeof handler === "function") handler.call(this, ev);
    var l = this._listeners[type] || [];
    for (var i = 0; i < l.length; i++) l[i].call(this, ev);
  };
  BridgeWebSocket.prototype._fail = function () {
    this.readyState = 3;
    delete sockets[this._id];
    this._emit("error", { type: "error" });
    this._emit("close", { type: "close", code: 1006, reason: "bridge closed", wasClean: false });
  };
  BridgeWebSocket.prototype.send = function (data) {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    var binary = typeof data !== "string";
    var payload = data;
    if (binary) {
      if (data instanceof ArrayBuffer) payload = bytesToB64(new Uint8Array(data));
      else if (data && data.buffer) payload = bytesToB64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      else if (typeof Blob !== "undefined" && data instanceof Blob) {
        var self = this;
        data.arrayBuffer().then(function (b) { post({ type: "ws-send", wsId: self._id, data: bytesToB64(new Uint8Array(b)), binary: true }); });
        return;
      } else payload = String(data);
    }
    post({ type: "ws-send", wsId: this._id, data: payload, binary: binary });
  };
  BridgeWebSocket.prototype.close = function (code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 2;
    post({ type: "ws-close", wsId: this._id, code: code || 1000, reason: reason || "" });
    delete sockets[this._id];
    var self = this;
    setTimeout(function () {
      if (self.readyState === 2) {
        self.readyState = 3;
        self._emit("close", { type: "close", code: code || 1000, reason: reason || "", wasClean: true });
      }
    }, 0);
  };
  function deliverWs(d) {
    var ws = sockets[d.wsId];
    if (!ws) return;
    if (d.event === "open") {
      ws.readyState = 1;
      ws.protocol = d.protocol || ws.protocol;
      ws._emit("open", { type: "open" });
      return;
    }
    if (d.event === "message") {
      var data = d.binary ? b64ToBytes(d.data) : d.data;
      ws._emit("message", { type: "message", data: data });
      return;
    }
    if (d.event === "close") {
      ws.readyState = 3;
      delete sockets[d.wsId];
      ws._emit("close", { type: "close", code: d.code || 1000, reason: d.reason || "", wasClean: true });
      return;
    }
    ws._fail();
  }
  try { window.WebSocket = BridgeWebSocket; } catch { /* frozen window */ }

  // Apps never need peer connections; drop the constructor here. The engine
  // also sends Connection-Allowlist (`webrtc=block`) with the frame, which
  // browsers enforce where implemented.
  try { Object.defineProperty(window, "RTCPeerConnection", { value: undefined, configurable: true }); } catch { /* frozen */ }
  try { Object.defineProperty(window, "webkitRTCPeerConnection", { value: undefined, configurable: true }); } catch { /* frozen */ }

  // ---------- storage ----------
  function snapshot() {
    var seed = { local: {}, session: {} };
    try {
      var raw = new URLSearchParams(location.hash.slice(1)).get("__storage");
      if (raw) seed = JSON.parse(b64ToText(decodeURIComponent(raw))) || seed;
    } catch { /* empty */ }
    if (!seed || typeof seed !== "object") seed = { local: {}, session: {} };
    if (!seed.local) seed.local = {};
    if (!seed.session) seed.session = {};
    return seed;
  }
  var seed = snapshot();
  function makeStorage(which, initial) {
    var data = {};
    Object.keys(initial || {}).forEach(function (k) { data[k] = String(initial[k]); });
    function pushOp(op, key, value) {
      // posted even before the handshake: a write followed immediately by a
      // reload used to sit in a queue that died with the frame, losing the
      // write (and looping any reload guard built on it). The host accepts
      // storage before the nonce for this reason.
      post({ type: "storage", which: which, op: op, key: key, value: value });
    }
    var methods = {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { k = String(k); data[k] = String(v); pushOp("set", k, data[k]); },
      removeItem: function (k) { k = String(k); delete data[k]; pushOp("remove", k, null); },
      clear: function () { Object.keys(data).forEach(function (k) { delete data[k]; }); pushOp("clear", null, null); },
      key: function (i) { return Object.keys(data)[i] || null; },
    };
    return new Proxy(data, {
      get: function (t, p) {
        if (p === "length") return Object.keys(t).length;
        if (typeof p === "string" && methods[p]) return methods[p];
        if (typeof p === "symbol") return t[p];
        return Object.prototype.hasOwnProperty.call(t, p) ? t[p] : undefined;
      },
      set: function (t, p, v) {
        if (typeof p !== "string" || methods[p]) return true;
        t[p] = String(v);
        pushOp("set", p, t[p]);
        return true;
      },
      deleteProperty: function (t, p) {
        delete t[p];
        pushOp("remove", String(p), null);
        return true;
      },
      has: function (t, p) { return p in t || (typeof p === "string" && !!methods[p]); },
    });
  }
  try { Object.defineProperty(window, "localStorage", { value: makeStorage("local", seed.local), configurable: true }); } catch { /* frozen */ }
  try { Object.defineProperty(window, "sessionStorage", { value: makeStorage("session", seed.session), configurable: true }); } catch { /* frozen */ }
  try {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: function () { return ""; },
      set: function () { /* cookies do not exist in the sandbox */ },
    });
  } catch { /* frozen */ }

  // ---------- /v1 asset URLs -> blob: (plain subresource loads carry no session) ----------
  var blobUrls = {};
  var blobJobs = {};
  function isAssetUrl(u) {
    return typeof u === "string" && u.indexOf("/v1/") === 0;
  }
  function assetUrl(path) {
    if (blobUrls[path]) return Promise.resolve(blobUrls[path]);
    if (!blobJobs[path]) {
      blobJobs[path] = bridgeFetch(path).then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.blob();
      }).then(function (b) {
        var u = URL.createObjectURL(b);
        blobUrls[path] = u;
        return u;
      }).catch(function () {
        return null;
      }).then(function (v) {
        delete blobJobs[path];
        return v;
      });
    }
    return blobJobs[path];
  }
  function rewriteValue(el, attr, value) {
    var path = value;
    var m = /^([^?#]*)([?#].*)?$/.exec(value);
    if (m) path = new URL(value, location.href).pathname + (new URL(value, location.href).search || "");
    assetUrl(path).then(function (blob) {
      if (blob && el.getAttribute(attr) === value) el.setAttribute(attr, blob);
    });
  }
  function rewriteSrcset(el, value) {
    var parts = value.split(",");
    var changed = false;
    parts.forEach(function (part) {
      var bits = part.trim().split(/\s+/);
      if (bits[0] && isAssetUrl(bits[0])) {
        var src = bits[0];
        changed = true;
        assetUrl(new URL(src, location.href).pathname).then(function (blob) {
          if (blob) el.setAttribute("srcset", el.getAttribute("srcset").split(src).join(blob));
        });
      }
    });
    return changed;
  }
  function rewriteCss(text) {
    return text.replace(/url\((['"]?)(\/v1\/[^)'"]*)\1\)/g, function (all, q, path) {
      var full = path;
      assetUrl(full).then(function (blob) {
        if (!blob) return;
        document.querySelectorAll("[style*='" + path + "']").forEach(function (el) {
          el.setAttribute("style", el.getAttribute("style").split(full).join(blob));
        });
        document.querySelectorAll("style").forEach(function (tag) {
          if (tag.textContent && tag.textContent.indexOf(full) >= 0) tag.textContent = tag.textContent.split(full).join(blob);
        });
      });
      return all;
    });
  }
  function rewriteElement(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.hasAttribute("src") && isAssetUrl(el.getAttribute("src"))) rewriteValue(el, "src", el.getAttribute("src"));
    if (el.hasAttribute("poster") && isAssetUrl(el.getAttribute("poster"))) rewriteValue(el, "poster", el.getAttribute("poster"));
    if (el.hasAttribute("srcset")) rewriteSrcset(el, el.getAttribute("srcset"));
    if (el.hasAttribute("style") && el.getAttribute("style").indexOf("/v1/") >= 0) rewriteCss(el.getAttribute("style"));
    if (el.tagName === "STYLE" && el.textContent && el.textContent.indexOf("/v1/") >= 0) rewriteCss(el.textContent);
  }
  function scanTree(root) {
    if (!root || root.nodeType !== 1) return;
    rewriteElement(root);
    if (root.querySelectorAll) {
      root.querySelectorAll("img,source,video,audio,[style],[poster],style").forEach(rewriteElement);
    }
  }
  try {
    scanTree(document.documentElement);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === "attributes") rewriteElement(r.target);
        else if (r.type === "childList") {
          for (var j = 0; j < r.addedNodes.length; j++) scanTree(r.addedNodes[j]);
        }
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "style", "poster"],
    });
  } catch { /* no observer */ }

  // ---------- handshake ----------
  // the host may not have registered this frame yet when the script runs, so
  // hello repeats until init lands
  if (parentWin) {
    post({ type: "hello" });
    var helloTimer = setInterval(function () {
      if (ready) { clearInterval(helloTimer); return; }
      post({ type: "hello" });
    }, 300);
  }
})();
