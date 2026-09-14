import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkProgram, cleanUpAfterUpdate, pickAsset, platformTarget, restoreEngineFiles, restoreProgram, runReplacement, saveEngineFiles, swapProgram } from "../src/self-update.js";
import { dataFormatProblem, recordDataFormat } from "../src/data-format.js";

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
