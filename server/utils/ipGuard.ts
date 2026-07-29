// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The one definition of "an address the cell must not dial".
//
// Two features hand the cell an address that someone else chose, and both are
// SSRF in the classic shape — the cell connects, and the result comes back to a
// user:
//
//   - DCC SEND offers (services/dcc.ts): the host comes from a CTCP message any
//     IRC user can send, and the response is written to a downloadable file.
//   - Link previews (services/linkFetch.ts): the host comes from a URL any IRC
//     user can paste, and the response is parsed into a card or proxied to a
//     browser.
//
// Same threat, same answer, so it lives once. Blocks loopback, RFC 1918, the
// cloud metadata endpoint at 169.254.169.254, CGNAT, multicast and reserved
// space. On a hosted cell the VPC neighbours — the control plane, other cells —
// sit squarely in this range, which is what makes it load-bearing rather than
// hygienic.
//
// Fails SAFE: anything unparseable is blocked. A malformed address that reaches
// a real socket is a worse outcome than a false refusal.

/** True when a dotted-quad IPv4 string is in a range the cell must not dial. */
export function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // malformed → block, fail safe
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255 broadcast
  return false;
}

/**
 * True when an IP *literal* — dotted-quad IPv4 or an IPv6 literal — is in a
 * range the cell must not dial.
 *
 * This takes a literal, never a hostname: a name has to be resolved first and
 * then judged by what it resolved to, because the name says nothing about where
 * it points. See `safeLookup` in linkFetch.ts for the pinning that makes that
 * safe against DNS rebinding.
 */
export function isBlockedIpLiteral(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === '') return true;
  if (h.includes(':')) {
    // IPv4-mapped IPv6 (::ffff:1.2.3.4) — judge by the embedded IPv4.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
    if (mapped) return isBlockedIpv4(mapped[1]);
    if (h === '::1' || h === '::') return true; // loopback / unspecified
    if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
    if (h.startsWith('ff')) return true; // ff00::/8 multicast
    return false;
  }
  return isBlockedIpv4(h);
}
