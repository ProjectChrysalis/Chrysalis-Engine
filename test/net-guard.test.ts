/** An allowlisted hostname is a name, not an address: a plugin granted a
 *  public name must not reach loopback or the LAN through that name's DNS
 *  answer. Literals and localhost are explicit choices and pass. */
import { describe, it, expect } from "bun:test";
import { isPrivateAddress, assertPublicHost, assertMcpHost, isLoopbackAddress } from "../src/net-guard.js";

describe("egress address guard", () => {
  it("flags loopback, LAN, link-local, CGNAT and reserved ranges", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.5",
      "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fc00::1", "fd12::3", "fe80::1", "ff02::1", "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("passes explicit local targets and ignores lookup failures", async () => {
    await expect(assertPublicHost("127.0.0.1")).resolves.toBeUndefined();
    await expect(assertPublicHost("localhost")).resolves.toBeUndefined();
    await expect(assertPublicHost("::1")).resolves.toBeUndefined();
    await expect(assertPublicHost("name.invalid")).resolves.toBeUndefined();
  });
});

/** MCP endpoints have no per-server host allowlist behind them, so unlike
 *  plugin egress the guard must judge address literals too. */
describe("MCP endpoint guard", () => {
  it("knows loopback from the rest of the private space", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(ip), ip).toBe(true);
    }
    for (const ip of ["10.0.0.1", "192.168.1.1", "169.254.169.254", "fd00::1", "8.8.8.8"]) {
      expect(isLoopbackAddress(ip), ip).toBe(false);
    }
  });

  it("allows loopback — a local MCP server is the user's own process", async () => {
    await expect(assertMcpHost("localhost")).resolves.toBeUndefined();
    await expect(assertMcpHost("dev.localhost")).resolves.toBeUndefined();
    await expect(assertMcpHost("127.0.0.1")).resolves.toBeUndefined();
    await expect(assertMcpHost("::1")).resolves.toBeUndefined();
  });

  it("refuses private LITERALS, which the plugin guard deliberately exempts", async () => {
    for (const host of ["169.254.169.254", "10.0.0.5", "192.168.1.1", "172.16.9.9", "100.64.0.1", "fd00::1"]) {
      await expect(assertMcpHost(host), host).rejects.toThrow(/private address/);
    }
    // the plugin guard passes the same literal: a manifest allowlist named it
    await expect(assertPublicHost("169.254.169.254")).resolves.toBeUndefined();
  });

  it("passes public targets and leaves unresolvable names to the connect attempt", async () => {
    await expect(assertMcpHost("8.8.8.8")).resolves.toBeUndefined();
    await expect(assertMcpHost("name.invalid")).resolves.toBeUndefined();
  });
});
