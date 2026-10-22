/**
 * Chrysalis app bridge host — runs in the shell (and the standalone app
 * page). Owns the session, embeds app iframes as `sandbox="allow-scripts ..."`
 * (opaque origin), and answers their bridge messages. Every request is
 * validated here: an app may reach its own API and a fixed set of product
 * surfaces, never the agent, the shell, settings control, MCP control or
 * admin routes.
 */
(function () {
  "use strict";
  var CH = (window.ChrysalisBridgeHost = window.ChrysalisBridgeHost || {});

  var frames = new Map(); // contentWindow -> { appId, username, nonce }
  var inspections = new Map();
  var MAX_BODY = 64 * 1024 * 1024;

  function closeSockets(record) {
    var sockets = Array.from(record.sockets.values());
    record.sockets.clear();
    sockets.forEach(function (ws) { try { ws.close(); } catch { /* already closed */ } });
  }

  function closeFetches(record) {
    record.fetches.forEach(function (controller) { controller.abort(); });
    record.fetches.clear();
  }

  function randomNonce() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }
  function bytesToB64(bytes) {
    var s = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function textToB64(text) { return bytesToB64(new TextEncoder().encode(text)); }

  /** What an app may ask for. Everything else 403s here, before any fetch.
   *  `trusted` = an app the engine itself ships; only it may WRITE engine-wide
   *  model settings (the studio surfaces context/pricing/embedding config in
   *  its own settings UI). Everything else is read-only or generation. */
  function allowedRequest(appId, method, path, trusted) {
    var own = "/v1/apps/" + appId;
    if (path.indexOf(own + "/") === 0) {
      // the app's own API — but never the engine's management of the app.
      // The router decodes %xx before matching, so %74ree IS tree: compare
      // the decoded segments, and refuse one that does not decode.
      var segments;
      try { segments = decodeURIComponent(path.slice((own + "/").length)).split("/").filter(Boolean); } catch { return false; }
      var head = segments[0];
      // Management is blocked by its exact shape, plus the two whole
      // subtrees (plugins/, build/). An app route that merely shares a first
      // segment — /export/backup — is the app's own API, not the engine's.
      var subtree = head === "plugins" || head === "build";
      if (MANAGEMENT_HEADS.has(head) && (subtree || segments.length === 1)) return false;
      // which engine MCP servers an app may call is the user's decision; an
      // imported app switching them on for itself would hand itself tools
      if (head === "mcp" && method !== "GET" && trusted !== true) return false;
      return true;
    }
    if (method === "GET") {
      if (path === "/v1/models" || path.indexOf("/v1/models/") === 0) return true;
      if (path === "/v1/images/models") return true;
      if (path === "/v1/embeddings/config") return true;
      if (path === "/v1/audio/voices") return true;
      // TTS endpoint LISTING only; management (where a stored key could be
      // redirected) is shell settings business
      if (path === "/v1/audio/speech/endpoints") return true;
      // read-only catalogs the app renders (no keys, no control)
      if (path === "/v1/settings/connections" || path === "/v1/settings/providers" || path === "/v1/plugins") return true;
      if (path === "/v1/assets" || path.indexOf("/v1/assets/") === 0) return true;
    }
    // generation the app makes on the user's behalf, and its own asset uploads
    // paid generation (images, speech) is open to every app by design: it
    // rides the user's own provider connection and there is no per-app budget
    if (method === "POST" && (path === "/v1/images" || path === "/v1/audio/speech")) return true;
    if (method === "PUT" && (path === "/v1/assets" || path.indexOf("/v1/assets/") === 0)) return true;
    // engine-wide settings writes: shipped apps only
    if (trusted === true) {
      if (method === "PUT" && (path === "/v1/models/context" || path === "/v1/models/pricing" || path === "/v1/embeddings/config")) return true;
      if (method === "POST" && path === "/v1/embeddings/probe") return true;
    }
    return false;
  }
  var MANAGEMENT_HEADS = new Set(["tree", "plugins", "rev", "updates", "update", "install", "dev", "build", "activate", "rename", "export", "exports"]);

  /** Bus events a frame may receive. The engine broadcasts every user-scope
   *  event on /v1/ws; without this filter an app would read the agent's
   *  stream, other apps' generations and cross-app data-change pings. Frames
   *  get their own app's events plus hello (its build stamp reloads stale
   *  tabs); model-catalog pings only reach the shipped app that renders it. */
  function eventAllowed(appId, trusted, raw) {
    var frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!frame || typeof frame.type !== "string") return false;
    if (frame.type === "hello") return true;
    var payload = frame.payload || {};
    // app_built drives the dev runtime's hot updates (src/builder/browser/runtime.ts);
    // plugin_event carries what the app's own timers returned
    if (frame.type === "look_changed" || frame.type === "app_stream" || frame.type === "app_changed" || frame.type === "app_built" || frame.type === "plugin_event") {
      return payload.app === appId;
    }
    if (frame.type === "connections_changed") return trusted === true;
    return false;
  }

  var FORWARD_HEADERS = new Set(["content-type", "accept", "accept-language", "range", "cache-control", "if-none-match"]);

  function send(source, msg) {
    try { source.postMessage(msg, "*", msg.bodyBuffer instanceof ArrayBuffer ? [msg.bodyBuffer] : []); } catch { /* frame gone */ }
  }

  var pendingDownload = null;
  var downloadStyles = false;
  function handleDownload(record, source, d) {
    if (!(d.blob instanceof Blob) || d.blob.size > MAX_BODY || typeof d.filename !== "string" || d.filename.length > 255) {
      send(source, { __chrysalis: 1, type: "download-error", error: "invalid file or file exceeds 64 MiB" });
      return;
    }
    if (pendingDownload) {
      send(source, { __chrysalis: 1, type: "download-error", error: "save or cancel the pending file first" });
      return;
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Filenames cannot contain control characters.
    var filename = d.filename.replace(/[\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "_") || "download";
    var blob = d.blob;
    if (!downloadStyles) {
      var sheet = document.createElement("link");
      sheet.rel = "stylesheet";
      sheet.href = "/client/app-download.css";
      document.head.appendChild(sheet);
      downloadStyles = true;
    }
    var panel = document.createElement("dialog");
    panel.className = "chrysalis-download";
    panel.setAttribute("aria-label", "Download from " + record.appId);
    var title = document.createElement("strong");
    title.textContent = "Download from " + record.appId;
    var name = document.createElement("p");
    name.textContent = filename;
    var save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save file";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    function close() {
      blob = null;
      panel.close();
      panel.remove();
      if (pendingDownload && pendingDownload.panel === panel) pendingDownload = null;
    }
    save.addEventListener("click", function (event) {
      // An app cannot synthesize a click in the shell to approve its file.
      if (!event.isTrusted || !blob) return;
      var url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
      var anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60_000);
      close();
    });
    cancel.addEventListener("click", close);
    panel.addEventListener("cancel", close);
    panel.append(title, name, save, cancel);
    document.body.appendChild(panel);
    pendingDownload = { record: record, panel: panel, close: close };
    panel.show();
  }

  var pendingShare = null;
  function shareReply(source, id, result) {
    send(source, Object.assign({ __chrysalis: 1, type: "share-result", id: id }, result));
  }
  /** An app hands over an item; the user picks which app gets it. The engine
   *  delivers it (POST /v1/share), so the sending app never reaches the
   *  receiving app's routes, and nothing moves without a real click here. */
  function handleShare(record, source, d) {
    var SHARE_KIND = /^[a-z0-9][a-z0-9._+-]{0,63}$/i;
    if (typeof d.kind !== "string" || !SHARE_KIND.test(d.kind) || typeof d.name !== "string" || d.name.length > 200 || d.data === undefined) {
      shareReply(source, d.id, { error: "invalid item" });
      return;
    }
    if (pendingShare) {
      shareReply(source, d.id, { error: "send or cancel the pending item first" });
      return;
    }
    var label = d.name || d.kind;
    var panel = document.createElement("dialog");
    panel.className = "chrysalis-download";
    panel.setAttribute("aria-label", "Send " + label);
    var title = document.createElement("strong");
    title.textContent = "Send " + label;
    var note = document.createElement("p");
    note.textContent = "Loading apps…";
    var targets = document.createElement("div");
    targets.className = "chrysalis-share-targets";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    var done = false;
    function close(result) {
      if (done) return;
      done = true;
      panel.close();
      panel.remove();
      if (pendingShare && pendingShare.panel === panel) pendingShare = null;
      shareReply(source, d.id, result);
    }
    cancel.addEventListener("click", function () { close({ sentTo: null }); });
    panel.addEventListener("cancel", function () { close({ sentTo: null }); });
    panel.append(title, note, targets, cancel);
    if (!downloadStyles) {
      var sheet = document.createElement("link");
      sheet.rel = "stylesheet";
      sheet.href = "/client/app-download.css";
      document.head.appendChild(sheet);
      downloadStyles = true;
    }
    document.body.appendChild(panel);
    pendingShare = { record: record, panel: panel, close: close };
    panel.show();

    var query = "?kind=" + encodeURIComponent(d.kind) + "&from=" + encodeURIComponent(record.appId);
    fetch("/v1/share/targets" + query, { credentials: "same-origin" }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || "Could not list apps");
        return body.apps || [];
      });
    }).then(function (apps) {
      if (done) return;
      if (!apps.length) {
        note.textContent = "No installed app takes this.";
        return;
      }
      note.textContent = "Send to";
      apps.forEach(function (app) {
        var pick = document.createElement("button");
        pick.type = "button";
        pick.textContent = app.name;
        pick.addEventListener("click", function (event) {
          // an app cannot synthesize a click in the shell to pick the target
          if (!event.isTrusted || done) return;
          targets.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
          note.textContent = "Sending…";
          fetch("/v1/share", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ from: record.appId, to: app.id, kind: d.kind, name: d.name, data: d.data }),
          }).then(function (res) {
            return res.json().then(function (body) {
              if (!res.ok) throw new Error(body.error || "Could not send");
              close({ sentTo: body.to });
              window.dispatchEvent(new CustomEvent("chrysalis:open-app", { detail: { appId: body.to.id } }));
            });
          }).catch(function (e) {
            if (done) return;
            note.textContent = String((e && e.message) || e);
            targets.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
          });
        });
        targets.appendChild(pick);
      });
    }).catch(function (e) {
      if (!done) note.textContent = String((e && e.message) || e);
    });
  }

  function handleFetch(record, source, d) {
    var method = typeof d.method === "string" ? d.method.toUpperCase() : "GET";
    var url;
    try { url = new URL(d.url, location.origin); } catch { url = null; }
    if (!url || url.origin !== location.origin || !allowedRequest(record.appId, method, url.pathname, record.trusted)) {
      send(source, { __chrysalis: 1, type: "fetch-error", id: d.id, error: "blocked by the app sandbox: " + String(d.url) });
      return;
    }
    var headers = {};
    (Array.isArray(d.headers) ? d.headers : []).forEach(function (pair) {
      if (!Array.isArray(pair) || pair.length !== 2) return;
      var k = String(pair[0]).toLowerCase();
      if (FORWARD_HEADERS.has(k)) headers[k] = String(pair[1]);
    });
    // the engine refuses app-management routes to anything carrying this
    // (a second lock behind allowedRequest); frames cannot set or drop it
    headers["x-chrysalis-app"] = record.appId;
    var body = d.bodyBuffer instanceof ArrayBuffer ? new Uint8Array(d.bodyBuffer) : typeof d.body === "string" ? b64ToBytes(d.body) : undefined;
    if (body && body.byteLength > MAX_BODY) {
      send(source, { __chrysalis: 1, type: "fetch-error", id: d.id, error: "request body too large" });
      return;
    }
    var controller = new AbortController();
    record.fetches.set(d.id, controller);
    fetch(url.toString(), {
      method: method,
      headers: headers,
      body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
      credentials: "same-origin",
      // the allowlist judged THIS url; a redirect must not carry the
      // session somewhere it never looked at
      redirect: "error",
      signal: controller.signal,
    }).then(function (res) {
      return res.arrayBuffer().then(function (buf) {
        var outHeaders = [];
        res.headers.forEach(function (v, k) {
          if (k === "set-cookie") return;
          outHeaders.push([k, v]);
        });
        send(source, {
          __chrysalis: 1,
          type: "fetch-result",
          id: d.id,
          status: res.status,
          statusText: res.statusText,
          headers: outHeaders,
          ...(Object.prototype.hasOwnProperty.call(d, "bodyBuffer") ? { bodyBuffer: buf.byteLength ? buf : null } : { body: buf.byteLength ? bytesToB64(new Uint8Array(buf)) : null }),
        });
      });
    }).catch(function (e) {
      send(source, { __chrysalis: 1, type: "fetch-error", id: d.id, error: String((e && e.message) || e) });
    }).finally(function () {
      if (record.fetches.get(d.id) === controller) record.fetches.delete(d.id);
    });
  }

  function wsAllowed(path) {
    return path === "/v1/ws" || path.indexOf("/v1/ws?") === 0;
  }

  function handleWsOpen(record, source, d) {
    var url;
    try { url = new URL(d.url, location.origin); } catch { url = null; }
    if (!url || url.origin !== location.origin || !wsAllowed(url.pathname + url.search)) {
      send(source, { __chrysalis: 1, type: "ws-event", wsId: d.wsId, event: "error" });
      return;
    }
    var ws;
    try { ws = new WebSocket(url.toString(), d.protocols && d.protocols.length ? d.protocols : undefined); }
    catch {
      send(source, { __chrysalis: 1, type: "ws-event", wsId: d.wsId, event: "error" });
      return;
    }
    var ownKey = String(d.wsId);
    var previous = record.sockets.get(ownKey);
    record.sockets.set(ownKey, ws);
    if (previous) { try { previous.close(); } catch { /* already closed */ } }
    function current() { return frames.get(source) === record && record.sockets.get(ownKey) === ws; }
    ws.binaryType = "arraybuffer";
    ws.onopen = function () {
      if (!current()) return;
      send(source, { __chrysalis: 1, type: "ws-event", wsId: d.wsId, event: "open", protocol: ws.protocol });
    };
    // /v1/ws carries the whole user event bus: only this app's events pass
    ws.onmessage = function (ev) {
      if (!current()) return;
      if (typeof ev.data !== "string" || !eventAllowed(record.appId, record.trusted === true, ev.data)) return;
      send(source, { __chrysalis: 1, type: "ws-event", wsId: d.wsId, event: "message", data: ev.data, binary: false });
    };
    ws.onclose = function (ev) {
      if (!current()) return;
      record.sockets.delete(ownKey);
      send(source, { __chrysalis: 1, type: "ws-event", wsId: d.wsId, event: "close", code: ev.code, reason: ev.reason });
    };
    ws.onerror = function () {
      if (!current()) return;
      send(source, { __chrysalis: 1, type: "ws-event", wsId: d.wsId, event: "error" });
    };
  }

  function storageKey(username, appId) {
    return "chrysalis.app-storage." + username + "." + appId;
  }
  function readStorage(username, appId) {
    try {
      var raw = localStorage.getItem(storageKey(username, appId));
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") {
        if (!parsed.local) parsed.local = {};
        if (!parsed.session) parsed.session = {};
        return parsed;
      }
    } catch { /* fall through */ }
    return { local: {}, session: {} };
  }
  function writeStorage(username, appId, store) {
    try { localStorage.setItem(storageKey(username, appId), JSON.stringify(store)); } catch { /* quota */ }
  }
  /** One app's storage share of the shell origin's quota. localStorage is
   *  one budget for the shell and every app; an app filling it would break
   *  everyone else's saves (and its snapshot rides the frame URL). */
  var MAX_APP_STORAGE = 2 * 1024 * 1024;
  function handleStorage(record, d) {
    var store = readStorage(record.username, record.appId);
    var ns = d.which === "session" ? store.session : store.local;
    if (d.op === "set" && typeof d.key === "string") {
      var prev = Object.prototype.hasOwnProperty.call(ns, d.key) ? ns[d.key] : undefined;
      ns[d.key] = String(d.value);
      if (JSON.stringify(store).length > MAX_APP_STORAGE) {
        if (prev === undefined) delete ns[d.key]; else ns[d.key] = prev;
        return;
      }
    }
    else if (d.op === "remove" && typeof d.key === "string") delete ns[d.key];
    else if (d.op === "clear") store[d.which === "session" ? "session" : "local"] = {};
    writeStorage(record.username, record.appId, store);
  }

  window.addEventListener("message", function (e) {
    var record = frames.get(e.source);
    if (!record) return;
    var d = e.data;
    if (!d || d.__chrysalis !== 1) return;
    if (d.type === "hello") {
      if (!record.handshake || record.documentId !== d.documentId) {
        closeSockets(record);
        closeFetches(record);
        record.documentId = d.documentId;
        record.selection = null;
        record.handshake = true;
      }
      send(e.source, { __chrysalis: 1, type: "init", nonce: record.nonce });
      return;
    }
    // storage is accepted BEFORE the handshake: a write followed immediately
    // by a reload must not die in the frame's queue (see app-bridge.js). The
    // registered source window is the gate, and storage carries no authority
    // beyond the app's own data, so the nonce adds nothing here.
    if (d.type === "storage") {
      handleStorage(record, d);
      return;
    }
    if (d.nonce !== record.nonce) return;
    if (d.type === "agent-context") {
      try { if (JSON.stringify(d.selection).length <= 16000) record.selection = d.selection; } catch { /* Invalid selection is ignored. */ }
      return;
    }
    if (d.type === "inspection") {
      var inspection = inspections.get(d.id);
      if (inspection && inspection.source === e.source && inspection.record === record && inspection.documentId === record.documentId) {
        inspections.delete(d.id);
        inspection.resolve(Object.assign({}, d.result, { appId: record.appId, selection: record.selection }));
      }
      return;
    }
    if (d.type === "download") handleDownload(record, e.source, d);
    else if (d.type === "share") handleShare(record, e.source, d);
    else if (d.type === "fetch") handleFetch(record, e.source, d);
    else if (d.type === "fetch-abort") {
      var controller = record.fetches.get(d.id);
      if (controller) controller.abort();
    }
    else if (d.type === "ws-open") handleWsOpen(record, e.source, d);
    else if (d.type === "ws-send") {
      var ws = record.sockets.get(String(d.wsId));
      if (ws && ws.readyState === 1) ws.send(d.binary ? b64ToBytes(d.data) : d.data);
    } else if (d.type === "ws-close") {
      var closing = record.sockets.get(String(d.wsId));
      if (closing) { record.sockets.delete(String(d.wsId)); try { closing.close(d.code, d.reason); } catch { /* already closed */ } }
    }
  });

  /** Build the frame URL: user-scoped public path plus this app's storage
   *  snapshot in the hash (the frame cannot read the shell's storage). */
  CH.frameSrc = function (appId, username) {
    var store = readStorage(username, appId);
    var hash = "__storage=" + encodeURIComponent(textToB64(JSON.stringify(store)));
    return "/app/" + encodeURIComponent(username) + "/" + encodeURIComponent(appId) + "/#" + hash;
  };

  /** Register an app iframe. The frame's messages are accepted only from its
   *  contentWindow and only with the nonce minted here. `trusted` = shipped
   *  by the engine (see allowedRequest/eventAllowed). */
  CH.serve = function (iframe, appId, username, trusted) {
    var source = iframe.contentWindow;
    var previous = frames.get(source);
    if (previous) { closeSockets(previous); closeFetches(previous); }
    var record = { appId: appId, username: username, nonce: randomNonce(), trusted: trusted === true, sockets: new Map(), fetches: new Map() };
    frames.set(source, record);
    return function unserve() {
      if (frames.get(source) === record) frames.delete(source);
      closeSockets(record);
      closeFetches(record);
      if (pendingDownload && pendingDownload.record === record) pendingDownload.close();
      if (pendingShare && pendingShare.record === record) pendingShare.close({ sentTo: null });
    };
  };

  CH.selection = function (appId) {
    for (var record of frames.values()) if (record.appId === appId && record.selection) return { appId: appId, selection: record.selection };
    return null;
  };
  CH.inspect = function (appId) {
    return new Promise(function (resolve, reject) {
      for (var entry of frames.entries()) {
        var source = entry[0], record = entry[1];
        if (record.appId !== appId || !record.handshake) continue;
        var id = randomNonce();
        var timer = setTimeout(function () { inspections.delete(id); reject(new Error("App inspection timed out")); }, 10000);
        inspections.set(id, { source: source, record: record, documentId: record.documentId, resolve: function (value) { clearTimeout(timer); resolve(value); } });
        send(source, { __chrysalis: 1, type: "inspect", nonce: record.nonce, id: id });
        return;
      }
      reject(new Error("Open the selected app to inspect it"));
    });
  };
  CH.allowedRequest = allowedRequest;
  CH.eventAllowed = eventAllowed;
  CH.storageKey = storageKey;
})();
