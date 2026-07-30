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
// Same threat, same answer, so it lives once. On a hosted cell the VPC
// neighbours — the control plane, other cells — sit squarely in the blocked
// ranges, which is what makes this load-bearing rather than hygienic.
//
// ⚠⚠ IPv6 is an ALLOWLIST, not a denylist, and that asymmetry is deliberate.
// An earlier version enumerated the bad IPv6 prefixes and returned `false`
// (allow) for anything it didn't recognise. That shipped a real hole: the WHATWG
// URL parser rewrites an IPv4-mapped literal into hex, so
// `http://[::ffff:169.254.169.254]/` arrives as `[::ffff:a9fe:a9fe]` — which
// matched none of the deny prefixes and was allowed straight through to the
// cloud metadata endpoint. `net.isIP()` calls that string IPv6, so node skips
// DNS for it and `pinnedLookup` never runs either; this function was the only
// guard on the path, and it said yes.
//
// The lesson is the general one: a denylist over a 128-bit space with several
// IPv4-embedding notations cannot be audited. Only 2000::/3 is global unicast,
// so that's what we allow, and everything we can't parse or don't recognise is
// refused.

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
 * Expand an IPv6 literal to its eight 16-bit groups, or null if it isn't one.
 *
 * Handles `::` elision and a trailing dotted quad (`::ffff:1.2.3.4`), which is
 * the form DCC hands us — the URL parser has already converted that shape to
 * hex by the time a preview URL reaches us, but both have to be understood
 * because both call this.
 */
function parseIpv6(input: string): number[] | null {
  let text = input;

  // At most ONE elision. `filter(g => g !== '')` below silently swallows extra empty groups, so
  // `2001::1::1` parsed as a perfectly good address — the parser failing open in a file whose
  // whole premise is failing closed.
  if (text.split('::').length > 2) return null;

  // A trailing dotted quad contributes the last two groups.
  const tail: number[] = [];
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    text = text.slice(0, dotted.index + 1); // keep the ':' so the split below still works
  }

  const elision = text.indexOf('::');
  let head: string[];
  let rest: string[];
  if (elision === -1) {
    head = text.split(':').filter((g) => g !== '');
    rest = [];
  } else {
    head = text
      .slice(0, elision)
      .split(':')
      .filter((g) => g !== '');
    rest = text
      .slice(elision + 2)
      .split(':')
      .filter((g) => g !== '');
  }

  const toGroup = (g: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    return Number.parseInt(g, 16);
  };

  const headGroups: number[] = [];
  for (const g of head) {
    const v = toGroup(g);
    if (v === null) return null;
    headGroups.push(v);
  }
  const restGroups: number[] = [];
  for (const g of rest) {
    const v = toGroup(g);
    if (v === null) return null;
    restGroups.push(v);
  }
  restGroups.push(...tail);

  const total = headGroups.length + restGroups.length;
  if (elision === -1) {
    return total === 8 ? [...headGroups, ...restGroups] : null;
  }
  if (total > 8) return null;
  return [...headGroups, ...Array.from<number>({ length: 8 - total }).fill(0), ...restGroups];
}

/** The IPv4 embedded in an IPv6 address, for every notation that embeds one. */
function embeddedIpv4(groups: number[]): string | null {
  const isZero = (n: number) => groups[n] === 0;
  const last32 = () => {
    const g6 = groups[6];
    const g7 = groups[7];
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  };

  // ::ffff:a.b.c.d — IPv4-mapped. The form that caused the hole.
  if ([0, 1, 2, 3, 4].every(isZero) && groups[5] === 0xffff) return last32();
  // ::a.b.c.d and ::0:a.b.c.d — deprecated IPv4-compatible, still routable by some stacks.
  if ([0, 1, 2, 3, 4, 5].every(isZero)) return last32();
  // 64:ff9b::/96 — NAT64. Blocked by the 2000::/3 rule anyway, but judging the
  // embedded address gives a more honest answer than "unrecognised".
  if (groups[0] === 0x64 && groups[1] === 0xff9b && [2, 3, 4, 5].every(isZero)) return last32();
  return null;
}

/**
 * Whether an IP *literal* — dotted-quad IPv4 or an IPv6 literal — is one the
 * cell must not dial.
 *
 * Takes a literal, never a hostname: a name says nothing about where it points,
 * so it has to be resolved first and judged by the answer. See `pinnedLookup` in
 * linkFetch.ts for the pinning that makes that safe against DNS rebinding.
 *
 * Fails CLOSED throughout. Anything unparseable, and any IPv6 outside global
 * unicast, is blocked.
 */
export function isBlockedIpLiteral(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === '') return true;
  // `new URL().hostname` keeps IPv6 literals bracketed; callers may or may not
  // have stripped them.
  const bare = h.replace(/^\[|\]$/g, '');
  if (bare === '') return true;

  if (!bare.includes(':')) return isBlockedIpv4(bare);

  const groups = parseIpv6(bare);
  if (groups === null) return true; // not a literal we understand → refuse

  const embedded = embeddedIpv4(groups);
  if (embedded !== null) return isBlockedIpv4(embedded);

  // ⚠ IPv4-in-IPv6 TUNNELS, blocked outright. Both live INSIDE the 2000::/3 allowlist below, so
  // without this they were the `::ffff:a9fe:a9fe` hole again wearing a different notation:
  // `http://[2002:7f00:0001::]/` is 6to4 for 127.0.0.1 and `[2002:a9fe:a9fe::]` for the cloud
  // metadata endpoint — `net.isIP` calls them IPv6, so `pinnedLookup` never runs.
  //
  // Refused rather than decoded. Both mechanisms are deprecated (6to4 by RFC 7526, Teredo
  // effectively dead), Teredo's embedded client address is bit-complemented so reading it is
  // fiddly, and a preview fetcher has no business dialling a tunnel broker either way. Blocking
  // costs us nothing real and removes a whole class of notation from the audit.
  if (groups[0] === 0x2002) return true; // 2002::/16 — 6to4
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return true; // 2001:0::/32 — Teredo

  // ALLOWLIST: 2000::/3 is the global unicast range. Loopback (::1), the
  // unspecified address, unique-local (fc00::/7), link-local (fe80::/10),
  // multicast (ff00::/8) and every unassigned block all fall outside it, so one
  // check covers the lot — including notations nobody has thought of yet.
  return (groups[0] & 0xe000) !== 0x2000;
}
