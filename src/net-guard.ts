/**
 * Egress guard for allowlisted hostnames. An allowlist entry is a NAME, and
 * the name's DNS answer can point at loopback, the LAN or link-local metadata
 * services; a plugin must not reach those through a public name it was
 * granted. Address literals and localhost are exempt: a manifest that lists
 * them is explicitly asking for a local target.
 */
import dns from "node:dns/promises";
import net from "node:net";

/** Private, loopback, link-local, CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const low = ip.toLowerCase();
  if (low === "::" || low === "::1") return true;
  if (low.startsWith("::ffff:")) return isPrivateAddress(low.slice("::ffff:".length));
  if (low.startsWith("64:ff9b::")) {
    const tail = low.slice("64:ff9b::".length);
    if (net.isIPv4(tail)) return isPrivateAddress(tail);
  }
  return low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb") || low.startsWith("ff");
}

/** Loopback is the machine's own process: the one private target a service
 *  the user configured themselves legitimately lives on. */
export function isLoopbackAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return ip.split(".")[0] === "127";
  const low = ip.toLowerCase();
  if (low === "::1") return true;
  if (low.startsWith("::ffff:")) return isLoopbackAddress(low.slice("::ffff:".length));
  return false;
}

/**
 * Egress guard for MCP endpoints. Unlike plugin egress there is no per-server
 * host allowlist behind this one, so address LITERALS are checked too: a
 * config naming 169.254.169.254 outright must not reach the metadata service.
 * Only loopback is exempt — a local MCP server is the user's own process.
 */
export async function assertMcpHost(hostname: string): Promise<void> {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return;
  if (net.isIP(hostname)) {
    if (isLoopbackAddress(hostname)) return;
    if (isPrivateAddress(hostname)) throw new Error(`MCP endpoint points at a private address: ${hostname}`);
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    return; // an unresolvable name is the connect attempt's error to report
  }
  const bad = addrs.find((a) => isPrivateAddress(a.address) && !isLoopbackAddress(a.address));
  if (bad) throw new Error(`MCP endpoint resolves to a private address: ${hostname} -> ${bad.address}`);
}

/** Resolve a non-literal host and reject any private answer. Literals (and
 *  localhost) pass: the allowlist named them on purpose. Lookup failures are
 *  left for the fetch itself to report. */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname) || hostname === "localhost" || hostname.endsWith(".localhost")) return;
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    return;
  }
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`host resolves to a private address: ${hostname}`);
  }
}
