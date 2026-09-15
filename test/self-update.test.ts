import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { checkProgram, cleanUpAfterUpdate, installUpdate, pickAsset, platformTarget, restoreEngineFiles, restoreProgram, runReplacement, saveEngineFiles, swapProgram } from "../src/self-update.js";
import { dataFormatProblem, recordDataFormat } from "../src/data-format.js";
import { forgetRelease, latestRelease } from "../src/updates.js";

const asset = (name: string, url = `https://github.com/o/r/releases/download/v1/${name}`) => ({ name, browser_download_url: url, size: 10 });

describe("self-update", () => {
  it("names this computer's download the way release archives do", () => {
    expect(platformTarget("win32", "x64")).toBe("windows-x64");
    expect(platformTarget("darwin", "arm64")).toBe("macos-arm64");
    expect(platformTarget("linux", "arm64")).toBe("linux-arm64");
  });

  it("picks the archive for this platform only", () => {
    const assets = [
      asset("Chrysalis-1.1.0-android-arm64.apk"),
      asset("Chrysalis-1.1.0-linux-arm64.tar.gz"),
      asset("Chrysalis-1.1.0-linux-x64.tar.gz"),
      asset("Chrysalis-1.1.0-windows-x64.zip"),
    ];
    expect(pickAsset(assets, "linux-x64")?.name).toBe("Chrysalis-1.1.0-linux-x64.tar.gz");
    expect(pickAsset(assets, "windows-x64")?.name).toBe("Chrysalis-1.1.0-windows-x64.zip");
    expect(pickAsset(assets, "macos-arm64")).toBeNull();
    expect(pickAsset([asset("Chrysalis-1.1.0-linux-x64.tar.gz", "https://evil.example/x.tar.gz")], "linux-x64")).toBeNull();
  });

  it("swaps the program and resources, leaving config and data alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-swap-"));
    const fresh = path.join(dir, ".update", "unpacked", "Chrysalis-1.1.0-linux-x64");
    fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
    fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(path.join(dir, "chrysalis"), "old");
    fs.writeFileSync(path.join(dir, "resources", "v"), "old");
    fs.writeFileSync(path.join(dir, "config.yaml"), "port: 1\n");
    fs.writeFileSync(path.join(dir, "data", "users.json"), "{}");
    fs.mkdirSync(path.join(fresh, "resources"), { recursive: true });
    fs.writeFileSync(path.join(fresh, "chrysalis"), "new");
    fs.writeFileSync(path.join(fresh, "resources", "v"), "new");

    swapProgram(dir, fresh, "chrysalis");
    expect(fs.readFileSync(path.join(dir, "chrysalis"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(dir, "resources", "v"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(dir, "chrysalis.old"), "utf8")).toBe("old");
    expect(fs.readFileSync(path.join(dir, "config.yaml"), "utf8")).toBe("port: 1\n");
    expect(fs.existsSync(path.join(dir, "data", "users.json"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("puts everything back when the new copy is incomplete", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-swap-"));
    const fresh = path.join(dir, "fresh");
    fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
    fs.writeFileSync(path.join(dir, "chrysalis"), "old");
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, "chrysalis"), "new");
    expect(() => swapProgram(dir, fresh, "chrysalis")).toThrow();
    expect(fs.readFileSync(path.join(dir, "chrysalis"), "utf8")).toBe("old");
    expect(fs.existsSync(path.join(dir, "resources"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips archives still uploading and keeps the release's checksum", () => {
    const digest = "sha256:" + "ab".repeat(32);
    expect(pickAsset([{ ...asset("Chrysalis-1.1.0-linux-x64.tar.gz"), state: "open" }], "linux-x64")).toBeNull();
    expect(pickAsset([{ ...asset("Chrysalis-1.1.0-linux-x64.tar.gz"), state: "uploaded", digest }], "linux-x64")?.sha256).toBe("ab".repeat(32));
    expect(pickAsset([asset("Chrysalis-1.1.0-linux-x64.tar.gz")], "linux-x64")?.sha256).toBeUndefined();
  });

  it("only swaps in a program that runs and names the release's version", async () => {
    if (process.platform === "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-check-"));
    const program = (body: string) => {
      const file = path.join(dir, `p${Math.random().toString(36).slice(2)}`);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
      return file;
    };
    await checkProgram(program("echo 1.2.0"), "1.2.0");
    await expect(checkProgram(program("echo 1.1.9"), "1.2.0")).rejects.toThrow(/says it is Chrysalis 1.1.9/);
    await expect(checkProgram(program("exit 127"), "1.2.0")).rejects.toThrow(/does not run on this computer/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the old program through the first run after an update, and clears it after", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-clean-"));
    for (const name of ["chrysalis.old", "resources.old", "chrysalis.failed", "resources.old-123", ".update"]) fs.mkdirSync(path.join(dir, name));
    cleanUpAfterUpdate(dir, true);
    expect(fs.readdirSync(dir).sort()).toEqual(["chrysalis.old", "resources.old", "resources.old-123"]);
    cleanUpAfterUpdate(dir, false);
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("puts the old program back after a swap, keeping the failed one aside", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-restore-"));
    const fresh = path.join(dir, "fresh");
    fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
    fs.mkdirSync(path.join(fresh, "resources"), { recursive: true });
    fs.writeFileSync(path.join(dir, "chrysalis"), "old");
    fs.writeFileSync(path.join(fresh, "chrysalis"), "new");
    swapProgram(dir, fresh, "chrysalis");
    restoreProgram(dir, "chrysalis");
    expect(fs.readFileSync(path.join(dir, "chrysalis"), "utf8")).toBe("old");
    expect(fs.readFileSync(path.join(dir, "chrysalis.failed"), "utf8")).toBe("new");
    expect(fs.existsSync(path.join(dir, "chrysalis.old"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("saves and restores the engine's account files, not app baselines", () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-snapshot-"));
    fs.writeFileSync(path.join(data, "users.json"), "before");
    fs.mkdirSync(path.join(data, "credentials", "ann", "app-upstream", "roleplay"), { recursive: true });
    fs.writeFileSync(path.join(data, "credentials", "ann", "auth.json"), "keys");
    fs.writeFileSync(path.join(data, "credentials", "ann", "app-upstream", "roleplay", "big"), "baseline");
    saveEngineFiles(data);
    expect(fs.existsSync(path.join(data, ".update-snapshot", "credentials", "ann", "app-upstream"))).toBe(false);
    // what a failed first start of a new version might leave
    fs.writeFileSync(path.join(data, "users.json"), "migrated");
    fs.writeFileSync(path.join(data, "format.json"), '{"format":9}');
    fs.writeFileSync(path.join(data, "credentials", "ann", "auth.json"), "moved");
    restoreEngineFiles(data);
    expect(fs.readFileSync(path.join(data, "users.json"), "utf8")).toBe("before");
    expect(fs.existsSync(path.join(data, "format.json"))).toBe(false);
    expect(fs.readFileSync(path.join(data, "credentials", "ann", "auth.json"), "utf8")).toBe("keys");
    expect(fs.readFileSync(path.join(data, "credentials", "ann", "app-upstream", "roleplay", "big"), "utf8")).toBe("baseline");
    fs.rmSync(data, { recursive: true, force: true });
  });

  /** A program folder mid-update: the new program in place, the old aside. */
  const updatedFolder = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-supervise-"));
    const dir = path.join(root, "program");
    const data = path.join(root, "data");
    fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
    fs.mkdirSync(path.join(dir, "resources.old"), { recursive: true });
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(dir, "chrysalis"), "new");
    fs.writeFileSync(path.join(dir, "chrysalis.old"), "old");
    fs.writeFileSync(path.join(data, "users.json"), "before");
    return { root, dir, data };
  };

  it("goes back to the old version when the new one exits before it serves", async () => {
    const { root, dir, data } = updatedFolder();
    const marker = path.join(root, "came-back");
    const script = path.join(root, "version.js");
    fs.writeFileSync(script, `
      const fs = require("node:fs");
      const [marker, data] = process.argv.slice(2);
      if (process.env.CHRYSALIS_UPDATE_FAILED) {
        fs.writeFileSync(marker, process.env.CHRYSALIS_UPDATE_FAILED);
        process.exit(0);
      }
      fs.writeFileSync(data + "/users.json", "half-migrated");
      process.exit(3);
    `);
    const code = await new Promise<number>((resolve) =>
      runReplacement({ dataDir: data, dir, exe: "chrysalis", command: process.execPath, args: [script, marker, data], forwardSignals: false, proveMs: 500, exit: resolve }),
    );
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(dir, "chrysalis"), "utf8")).toBe("old");
    expect(fs.readFileSync(path.join(dir, "chrysalis.failed"), "utf8")).toBe("new");
    expect(fs.existsSync(path.join(dir, "resources.old"))).toBe(false);
    expect(fs.readFileSync(path.join(data, "users.json"), "utf8")).toBe("before");
    expect(fs.existsSync(path.join(data, ".update-snapshot"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).error).toMatch(/exited with code 3/);
    fs.rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it("keeps the new version once it has served, and passes its exit code on", async () => {
    const { root, dir, data } = updatedFolder();
    const script = path.join(root, "serve.js");
    fs.writeFileSync(script, `
      const fs = require("node:fs");
      const data = process.argv[2];
      const instance = "fresh-instance";
      const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true, instance }) });
      fs.writeFileSync(data + "/engine.lock", JSON.stringify({ pid: process.pid, instance, url: "http://127.0.0.1:" + server.port, startedAt: Date.now() }));
      setTimeout(() => process.exit(7), 2500);
    `);
    const code = await new Promise<number>((resolve) =>
      runReplacement({ dataDir: data, dir, exe: "chrysalis", command: process.execPath, args: [script, data], forwardSignals: false, proveMs: 500, exit: resolve }),
    );
    expect(code).toBe(7);
    expect(fs.readFileSync(path.join(dir, "chrysalis"), "utf8")).toBe("new");
    expect(fs.existsSync(path.join(dir, "chrysalis.old"))).toBe(true);
    expect(fs.existsSync(path.join(data, ".update-snapshot"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  }, 30_000);
});

describe("data format", () => {
  it("refuses a folder a newer layout wrote, and records its own", () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "chrysalis-format-"));
    expect(dataFormatProblem(data, 1)).toBeNull();
    recordDataFormat(data, "1.0.0", 1);
    expect(dataFormatProblem(data, 1)).toBeNull();
    recordDataFormat(data, "2.0.0", 2);
    expect(dataFormatProblem(data, 1)).toMatch(/last used by Chrysalis 2.0.0/);
    expect(dataFormatProblem(data, 2)).toBeNull();
    fs.rmSync(data, { recursive: true, force: true });
  });
});

/**
 * The whole chain against a real HTTP server and a real archive: download,
 * the size and checksum guards, unpack, the does-it-even-run check, the swap.
 * Everything but asking GitHub which release is newest.
 */
describe("installing a release", () => {
  let dir: string;
  let served: string;
  let server: http.Server;
  let base: string;

  /** A stand-in for the program: it answers --version like the real one. */
  const program = (version: string): string => `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; else echo running; fi\n`;

  const archiveOf = (version: string, name = "Chrysalis-9.9.9-linux-x64.tar.gz"): { name: string; url: string; size: number; sha256: string } => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
    const inner = path.join(staging, "Chrysalis-9.9.9-linux-x64");
    fs.mkdirSync(path.join(inner, "resources"), { recursive: true });
    fs.writeFileSync(path.join(inner, "chrysalis"), program(version), { mode: 0o755 });
    fs.writeFileSync(path.join(inner, "resources", "marker.txt"), version);
    execFileSync("tar", ["-czf", path.join(served, name), "-C", staging, "Chrysalis-9.9.9-linux-x64"]);
    const body = fs.readFileSync(path.join(served, name));
    fs.rmSync(staging, { recursive: true, force: true });
    return { name, url: `${base}/${name}`, size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") };
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "installed-"));
    served = fs.mkdtempSync(path.join(os.tmpdir(), "served-"));
    // the copy that is already installed, as an update would find it
    fs.writeFileSync(path.join(dir, "chrysalis"), program("1.0.0"), { mode: 0o755 });
    fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
    fs.writeFileSync(path.join(dir, "resources", "marker.txt"), "1.0.0");
    server = http.createServer((req, res) => {
      const f = path.join(served, path.basename(req.url ?? ""));
      if (!fs.existsSync(f)) { res.writeHead(404).end("no"); return; }
      res.writeHead(200).end(fs.readFileSync(f));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const d of [dir, served]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows */ } }
  });

  const run = (asset: ReturnType<typeof archiveOf>, version = "9.9.9") => {
    let restarted = false;
    return installUpdate(dir, version, asset, async () => { restarted = true; }, "chrysalis")
      .then((s) => ({ state: s, restarted: () => restarted }));
  };

  it("swaps the program and its resources in, then restarts", async () => {
    const { state, restarted } = await run(archiveOf("9.9.9"));
    expect(state.phase).toBe("restarting");
    expect(restarted()).toBe(true);
    expect(fs.readFileSync(path.join(dir, "chrysalis"), "utf8")).toContain("9.9.9");
    expect(fs.readFileSync(path.join(dir, "resources", "marker.txt"), "utf8")).toBe("9.9.9");
    // the old program is kept, so the first run of the new one can be undone
    expect(fs.readdirSync(dir).some((n) => n.startsWith("chrysalis.old"))).toBe(true);
    // and nothing is left of the work it did
    expect(fs.existsSync(path.join(dir, ".update"))).toBe(false);
  }, 30_000);

  it("refuses a download whose checksum does not match the release", async () => {
    const asset = archiveOf("9.9.9");
    const { state, restarted } = await run({ ...asset, sha256: "0".repeat(64) });
    expect(state.phase).toBe("failed");
    expect(state.error).toContain("checksum");
    expect(restarted()).toBe(false);
    // the installed copy is untouched
    expect(fs.readFileSync(path.join(dir, "chrysalis"), "utf8")).toContain("1.0.0");
  }, 30_000);

  it("refuses a download bigger than the release says", async () => {
    const asset = archiveOf("9.9.9");
    const { state } = await run({ ...asset, size: 10 });
    expect(state.phase).toBe("failed");
    expect(state.error).toContain("larger than the release says");
    expect(fs.readFileSync(path.join(dir, "chrysalis"), "utf8")).toContain("1.0.0");
  }, 30_000);

  it("refuses a download that stopped short", async () => {
    const asset = archiveOf("9.9.9");
    const { state } = await run({ ...asset, size: asset.size + 1024 });
    expect(state.phase).toBe("failed");
    expect(state.error).toContain("incomplete");
  }, 30_000);

  it("survives a release that is not there", async () => {
    const asset = archiveOf("9.9.9");
    const { state } = await run({ ...asset, url: `${base}/gone.tar.gz` });
    expect(state.phase).toBe("failed");
    expect(state.error).toContain("HTTP 404");
    expect(fs.readFileSync(path.join(dir, "chrysalis"), "utf8")).toContain("1.0.0");
  }, 30_000);

  it("refuses a program that does not say it is the version promised", async () => {
    // a mislabelled archive: the release claims 9.9.9, the program says otherwise
    const { state } = await run(archiveOf("3.3.3"));
    expect(state.phase).toBe("failed");
    expect(fs.readFileSync(path.join(dir, "chrysalis"), "utf8")).toContain("1.0.0");
    expect(fs.existsSync(path.join(dir, ".update"))).toBe(false);
  }, 30_000);
});

/** The release side of updating: which release GitHub names, whether it is
 *  newer, and which archive on it belongs to this computer. Driven through
 *  the fetcher seam, so no request ever leaves the machine. */
describe("asking GitHub which release is newest", () => {
  const stable = {
    tag_name: "v9.9.9",
    html_url: "https://github.com/ProjectChrysalis/Chrysalis-Engine/releases/tag/v9.9.9",
    name: "Chrysalis 9.9.9",
    assets: [
      { name: `Chrysalis-9.9.9-${platformTarget()}.tar.gz`, browser_download_url: `https://github.com/o/r/releases/download/v9.9.9/Chrysalis-9.9.9-${platformTarget()}.tar.gz`, size: 42, state: "uploaded", digest: `sha256:${"ab".repeat(32)}` },
    ],
  };
  const fetcher = (body: unknown, status = 200) => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  beforeEach(() => forgetRelease());
  afterEach(() => forgetRelease());

  it("reads the newest stable release and names its page", async () => {
    const { f, calls } = fetcher(stable);
    const release = await latestRelease(f, "1.0.0");
    expect(calls[0]).toContain("/releases/latest");
    expect(release?.version).toBe("9.9.9");
    expect(release?.newer).toBe(true);
    expect(release?.url).toBe(stable.html_url);
    // the archive to download is pickAsset's job, tested on its own: a source
    // or container copy runs without SELF_UPDATE and never offers one
  });

  it("keeps the release, but not newer, when it is this version", async () => {
    const { f } = fetcher(stable);
    const release = await latestRelease(f, "9.9.9");
    expect(release?.newer).toBe(false);
  });

  it("follows the staging pre-release when this build is staging", async () => {
    const { f, calls } = fetcher({ ...stable, tag_name: undefined, name: "Staging 9.9.9-staging.4" });
    const release = await latestRelease(f, "9.9.9-staging.3");
    expect(calls[0]).toContain("/releases/tags/staging-latest");
    expect(release?.version).toBe("9.9.9-staging.4");
    expect(release?.newer).toBe(true);
    // any other staging build is newer, so the same one is the only "no"
    forgetRelease();
    const same = await latestRelease(fetcher({ ...stable, tag_name: undefined, name: "Staging 9.9.9-staging.4" }).f, "9.9.9-staging.4");
    expect(same?.newer).toBe(false);
  });

  it("remembers the answer, so reopening Settings does not ask again", async () => {
    const { f, calls } = fetcher(stable);
    await latestRelease(f, "1.0.0");
    await latestRelease(f, "1.0.0");
    expect(calls.length).toBe(1);
    forgetRelease();
    await latestRelease(f, "1.0.0");
    expect(calls.length).toBe(2);
  });

  it("says nothing when the release cannot be read", async () => {
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await latestRelease(down, "1.0.0")).toBeNull();
    forgetRelease();
    expect(await latestRelease(fetcher({}, 500).f, "1.0.0")).toBeNull();
    forgetRelease();
    expect(await latestRelease(fetcher({ tag_name: "v9.9.9" }, 200).f, "1.0.0")).toBeNull();
  });
});
