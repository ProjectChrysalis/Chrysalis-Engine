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
    parentWin.postMessage(msg, "*", msg.bodyBuffer instanceof ArrayBuffer ? [msg.bodyBuffer] : []);
  }
  /** websocket URLs serialize ws(s):// while location says http(s)://: same
   *  engine = same host/port and the matching ws/wss scheme. */
  function sameEngine(url) {
    var base = new URL(location.href);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return url.origin === base.origin;
    var want = base.protocol === "https:" ? "wss:" : "ws:";
    return url.protocol === want && url.host === base.host;
  }
  function call(msg, signal) {
    return new Promise(function (resolve, reject) {
      var id = null;
      function cleanup() {
        if (signal) signal.removeEventListener("abort", abort);
      }
      function abort() {
        cleanup();
        if (id !== null) {
          delete pending[id];
          post({ type: "fetch-abort", id: id });
        }
        reject(signal.reason || new DOMException("The operation was aborted", "AbortError"));
      }
      if (signal) {
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
      }
      whenReady(function () {
        // aborted while queued for the handshake: never sent
        if (signal && signal.aborted) return;
        id = nextId++;
        pending[id] = {
          resolve: function (value) { cleanup(); resolve(value); },
          reject: function (error) { cleanup(); reject(error); },
        };
        msg.__chrysalis = 1;
        msg.id = id;
        msg.nonce = nonce;
        parentWin.postMessage(msg, "*", msg.bodyBuffer instanceof ArrayBuffer ? [msg.bodyBuffer] : []);
      });
    });
  }

  window.addEventListener("message", function (e) {
    if (!parentWin || e.source !== parentWin) return;
    var d = e.data;
    if (!d || d.__chrysalis !== 1) return;
    if (d.type === "inspect" && ready && d.nonce === nonce) {
      inspectPage().then(function (result) { post({ type: "inspection", id: d.id, result: result }); });
      return;
    }
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
    if (d.type === "share-result") {
      var job = shares[d.id];
      if (!job) return;
      delete shares[d.id];
      if (d.error) job.reject(new Error(d.error));
      else job.resolve({ sentTo: d.sentTo || null });
      return;
    }
    if (d.type === "download-error") {
      console.error("Download failed: " + d.error);
      return;
    }
    if (d.type === "ws-event") deliverWs(d);
  });

  // Downloads carry app-owned bytes, never a URL for the host to fetch.
  var downloadBlobs = new Map();
  var createObjectURL = URL.createObjectURL.bind(URL);
  var revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (value) {
    var url = createObjectURL(value);
    if (value instanceof Blob) downloadBlobs.set(url, value);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    downloadBlobs.delete(String(url));
    revokeObjectURL(url);
  };
  function downloadAnchor(anchor) {
    if (!parentWin || !anchor.hasAttribute("download")) return false;
    var blob = downloadBlobs.get(anchor.href);
    if (!blob) return false;
    if (blob.size > 64 * 1024 * 1024) throw new Error("File exceeds 64 MiB");
    var filename = anchor.download;
    whenReady(function () { post({ type: "download", blob: blob, filename: filename }); });
    return true;
  }
  var anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!downloadAnchor(this)) return anchorClick.call(this);
  };
  document.addEventListener("click", function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest("a[download]") : null;
    if (anchor && downloadAnchor(anchor)) event.preventDefault();
  }, true);

  // ---------- fetch ----------
  var TOO_BIG = 32 * 1024 * 1024;
  function bridgeFetch(input, init) {
    var req;
    try { req = new Request(input, init); } catch (e) { return Promise.reject(e); }
    if (req.signal.aborted) return Promise.reject(req.signal.reason || new DOMException("The operation was aborted", "AbortError"));
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
        bodyBuffer: isBodyless || buf.byteLength === 0 ? null : buf,
      }, req.signal);
    }).then(function (res) {
      var body = res.bodyBuffer instanceof ArrayBuffer ? new Uint8Array(res.bodyBuffer) : res.body ? b64ToBytes(res.body) : null;
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
    // Not a call(): the host answers with ws-event frames only, so an entry
    // in pending would never be taken out and would keep the socket alive.
    whenReady(function () {
      if (self.readyState !== 0) return;
      post({
        type: "ws-open",
        wsId: self._id,
        url: target.pathname + target.search,
        protocols: Array.isArray(protocols) ? protocols : protocols ? [protocols] : [],
      });
    });
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
    seed[which] = data;
    function pushOp(op, key, value) {
      // A frame reload uses its current URL, not the host's newer storage.
      // Keep that bootstrap snapshot current without adding history entries.
      try {
        var params = new URLSearchParams(location.hash.slice(1));
        params.set("__storage", bytesToB64(new TextEncoder().encode(JSON.stringify(seed))));
        var hash = "#" + params.toString();
        if (hash !== location.hash) {
          try { window.history.replaceState(null, "", hash); }
          catch { location.replace(hash); }
        }
      } catch (e) { console.warn("Could not refresh app storage snapshot", e); }

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

  // ---------- sending an item to another app ----------
  // The user picks the receiving app in the shell; resolves with
  // { sentTo: { id, name } }, or { sentTo: null } when they cancel.
  var shares = {};
  var shareSeq = 1;
  function shareData(data) {
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      if (data.size > TOO_BIG) return Promise.reject(new Error("Item exceeds 32 MiB"));
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(reader.error || new Error("Could not read the item")); };
        reader.readAsDataURL(data);
      });
    }
    try {
      var json = JSON.stringify(data);
      if (json === undefined) throw new Error("Nothing to send");
      if (json.length > TOO_BIG) throw new Error("Item exceeds 32 MiB");
      return Promise.resolve(JSON.parse(json));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  function share(item) {
    if (!parentWin) return Promise.reject(new Error("this app is not running inside Chrysalis"));
    if (!item || typeof item.kind !== "string") return Promise.reject(new TypeError("share needs a kind"));
    return shareData(item.data).then(function (data) {
      return new Promise(function (resolve, reject) {
        whenReady(function () {
          var id = shareSeq++;
          shares[id] = { resolve: resolve, reject: reject };
          post({ type: "share", id: id, kind: item.kind, name: String(item.name || ""), data: data });
        });
      });
    });
  }

  window.ChrysalisApp = {
    setAgentContext: function (selection) { whenReady(function () { post({ type: "agent-context", selection: selection }); }); },
    share: share,
  };

  async function inspectPage() {
    var width = window.innerWidth, height = window.innerHeight;
    var controls = Array.from(document.querySelectorAll("button,input,textarea,select,[role=button],[role=tab]")).filter(function (el) { var box = el.getBoundingClientRect(); return box.width && box.height && box.bottom > 0 && box.top < height; }).slice(0, 100).map(function (el) {
      return { role: el.getAttribute("role") || el.tagName.toLowerCase(), label: el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent || "").trim().slice(0, 160), disabled: !!el.disabled };
    });
    var result = { viewport: { width: width, height: height }, text: (document.body.innerText || "").slice(0, 12000), controls: controls };
    try {
      if (document.querySelectorAll("*").length > 4000) throw new Error("Page is too large for screenshot capture");
      var clone = document.body.cloneNode(true);
      var sourceNodes = [document.body].concat(Array.from(document.body.querySelectorAll("*")));
      var cloneNodes = [clone].concat(Array.from(clone.querySelectorAll("*")));
      for (var i = 0; i < sourceNodes.length; i++) {
        var original = sourceNodes[i], copied = cloneNodes[i];
        if (!copied) continue;
        var computed = getComputedStyle(original);
        for (var j = 0; j < computed.length; j++) { var key = computed[j]; copied.style.setProperty(key, computed.getPropertyValue(key)); }
        copied.style.setProperty("animation", "none");
        copied.style.setProperty("transition", "none");
        if (original instanceof HTMLInputElement || original instanceof HTMLTextAreaElement) {
          copied.value = original.type === "password" ? "" : original.value;
          copied.setAttribute("value", copied.value);
          if (original instanceof HTMLTextAreaElement) copied.textContent = copied.value;
        }
        if (original instanceof HTMLImageElement && original.complete && original.naturalWidth) {
          var imageCanvas = document.createElement("canvas"); imageCanvas.width = original.naturalWidth; imageCanvas.height = original.naturalHeight;
          imageCanvas.getContext("2d").drawImage(original, 0, 0);
          copied.setAttribute("src", imageCanvas.toDataURL("image/png")); copied.removeAttribute("srcset");
        }
        if (original.scrollTop || original.scrollLeft) {
          for (var child of copied.children) child.style.transform = "translate(" + (-original.scrollLeft) + "px," + (-original.scrollTop) + "px) " + (child.style.transform === "none" ? "" : child.style.transform);
        }
      }
      if (Array.from(document.querySelectorAll("iframe,video,audio,canvas")).some(function (el) { var box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < height; })) throw new Error("This view contains media that cannot be captured. Use the reported text and controls.");
      clone.querySelectorAll("script").forEach(function (el) { el.remove(); });
      clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
      clone.style.margin = "0"; clone.style.width = width + "px"; clone.style.height = height + "px";
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><foreignObject width="100%" height="100%">' + new XMLSerializer().serializeToString(clone) + '</foreignObject></svg>';
      var capture = new Image();
      await new Promise(function (resolve, reject) { capture.onload = resolve; capture.onerror = function () { reject(new Error("Screenshot rendering failed")); }; capture.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); });
      var canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      var context = canvas.getContext("2d"); context.fillStyle = getComputedStyle(document.documentElement).backgroundColor; context.fillRect(0, 0, width, height); context.drawImage(capture, 0, 0);
      result.screenshot = { data: canvas.toDataURL("image/png").split(",")[1], mimeType: "image/png" };
    } catch (error) { result.screenshotError = String(error.message || error); }
    return result;
  }

  // ---------- handshake ----------
  // the host may not have registered this frame yet when the script runs, so
  // hello repeats until init lands
  if (parentWin) {
    var documentId = String(Date.now()) + ":" + Math.random().toString(36).slice(2);
    post({ type: "hello", documentId: documentId });
    var helloTimer = setInterval(function () {
      if (ready) { clearInterval(helloTimer); return; }
      post({ type: "hello", documentId: documentId });
    }, 300);
  }
})();
