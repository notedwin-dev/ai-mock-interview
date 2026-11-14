import { isIPv4, isIPv6 } from "node:net";

/**
 * Server-side Base URL validation for user-supplied (BYOK) provider
 * connections (approved workflow, Notion: normalise/validate Base URL
 * server-side; block loopback/private/link-local/metadata destinations).
 *
 * This is the pure, synchronous layer: URL syntax, protocol allow-list and
 * literal-IP/hostname checks. DNS rebinding and redirect pinning are re-checked
 * at outbound-call time by the adapter transport (later slice) — a hostname
 * that passes here is not yet proven safe at connect time.
 */

export type SsrfDecision =
  | { ok: true; normalizedUrl: string }
  | { ok: false; reason: SsrfRejectionReason };

export type SsrfRejectionReason =
  | "not_an_absolute_url"
  | "unsupported_protocol"
  | "credentials_in_url"
  | "missing_host"
  | "blocked_hostname"
  | "blocked_address"
  | "unparseable_host";

const BLOCKED_HOSTNAMES = new Set(["localhost"]);
// .localhost always resolves to loopback; .local is mDNS; .internal is an
// ICANN-reserved private-use TLD. Subdomain forms are blocked with the parent.
const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal"];

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => part === "" || part.length > 3 || !/^\d+$/.test(part))
  ) {
    return false; // not a dotted-quad literal; nothing to decide here
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets as [number, number];
  if (first === 0) return true; // this-network
  if (first === 10) return true; // private
  if (first === 127) return true; // loopback
  if (first === 169 && second === 254) return true; // link-local incl. cloud metadata
  if (first === 172 && second >= 16 && second <= 31) return true; // private
  if (first === 192 && second === 168) return true; // private
  if (first === 100 && second >= 64 && second <= 127) return true; // CGNAT
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified

  // Embedded IPv4 forms — IPv4-mapped (::ffff:a.b.c.d), deprecated
  // IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): the embedded
  // address decides, because that is the address actually contacted. Note the
  // WHATWG URL parser serialises ::ffff:192.168.0.10 as ::ffff:c0a8:a, so the
  // dotted form is not guaranteed to survive parsing.
  const embeddedV4 = lower.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embeddedV4) return isBlockedIpv4(embeddedV4[1]!);

  // Hex-serialised "::"-rooted forms (e.g. ::ffff:c0a8:a) begin with a zero
  // group: 0000::/8 is IETF-reserved (unspecified, loopback, v4-embedded) —
  // fail closed. Otherwise range-check the high-order 16 bits.
  const firstGroup = lower.startsWith("::") ? "0" : lower.split(":")[0]!;
  const value = Number.parseInt(firstGroup, 16);
  if (!Number.isFinite(value) || value === 0) return true;
  if (value >= 0xfc00 && value <= 0xfdff) return true; // fc00::/7 unique local
  if (value >= 0xfe80 && value <= 0xfebf) return true; // fe80::/10 link-local
  return false;
}

export function evaluateBaseUrl(rawUrl: string): SsrfDecision {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "not_an_absolute_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported_protocol" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials_in_url" };
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    return { ok: false, reason: "missing_host" };
  }

  // WHATWG URL keeps IPv6 literals bracketed in .hostname; node:net's
  // isIPv6 expects the bare address.
  const bareHostname =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (
    BLOCKED_HOSTNAMES.has(bareHostname) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => bareHostname.endsWith(suffix))
  ) {
    return { ok: false, reason: "blocked_hostname" };
  }

  if (bareHostname.includes(":")) {
    // IPv6 literal. The parser normalises v4-mapped forms to hex, so both
    // notation families must be covered. Anything that survives URL parsing
    // but that node:net cannot parse fails closed.
    if (!isIPv6(bareHostname)) {
      return { ok: false, reason: "unparseable_host" };
    }
    return isBlockedIpv6(bareHostname)
      ? { ok: false, reason: "blocked_address" }
      : { ok: true, normalizedUrl: url.toString() };
  }

  if (isIPv4(bareHostname)) {
    // The WHATWG parser already normalised decimal/hex/octal shorthand
    // (e.g. 2130706433, 0x7f.0.0.1, 127.1) into a dotted quad, so blocked
    // shorthand forms are caught here.
    return isBlockedIpv4(bareHostname)
      ? { ok: false, reason: "blocked_address" }
      : { ok: true, normalizedUrl: url.toString() };
  }

  // A dot-separated all-numeric host that is not a valid IPv4 quad should
  // never survive WHATWG parsing; if one ever does, fail closed.
  if (/^\d{1,3}(\.\d{1,3})*$/.test(bareHostname)) {
    return { ok: false, reason: "unparseable_host" };
  }

  return { ok: true, normalizedUrl: url.toString() };
}
