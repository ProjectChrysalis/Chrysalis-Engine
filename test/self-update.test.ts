import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickAsset, platformTarget, swapProgram } from "../src/self-update.js";

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
});
