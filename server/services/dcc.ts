// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC (Direct Client-to-Client) wire parsing — pure, unit-testable in isolation,
// kept out of ircConnection just like ctcp.ts. DCC rides CTCP: a peer sends a
// `\x01DCC SEND <file> <ip> <port> <size> [token]\x01`-framed PRIVMSG, which
// reaches us as a CTCP request of type `DCC` (the rest of the body — the part
// this module parses — is `SEND <file> ...`). irc-framework gives us only the
// CTCP plumbing; the DCC grammar is ours.
//
// Phase 0 handles the inbound `SEND` offer (the only thing the download manager
// reacts to); the other subtypes (ACCEPT/RESUME for resume, CHAT) are recognised
// but reported as `unsupported` so the caller can ignore them cleanly — they'll
// grow real parsing when resume lands (phase 3).
//
// References cloned for parity (see ~/Coding/irc-clients): irssi
// (src/irc/dcc/dcc-get.c — the SEND param parse + IPv4/IPv6 address handling) and
// WeeChat (src/plugins/irc/irc-ctcp.c — the quoted-first / single-token-else
// filename rule). The protocol's fiddly bits: the IPv4 address is a uint32 in
// network byte order (NOT dotted-quad), a port of 0 means passive/reverse DCC and
// carries a token, and a filename with spaces must be double-quoted.

/** A parsed inbound `DCC SEND` offer. `host` is decoded to a dotted-quad (IPv4)
 *  or kept as an IPv6 literal; `filename` is RAW and unsanitised — path-safety is
 *  the storage layer's job, not the parser's. `passive` (port 0) means the sender
 *  is firewalled and we'd be the one to listen; `token` correlates the passive
 *  reply. `size` is the advertised byte count (can exceed 4 GiB, so it's a JS
 *  number, not a uint32). */
export interface DccSend {
  kind: 'send';
  filename: string;
  host: string;
  port: number;
  size: number;
  token: number | null;
  passive: boolean;
}

/** Result of parsing a CTCP DCC body: a `SEND` offer, a recognised-but-unhandled
 *  subtype (CHAT/ACCEPT/RESUME/…), or a structural rejection with a reason for
 *  logging. */
export type DccParse =
  | DccSend
  | { kind: 'unsupported'; subtype: string }
  | { kind: 'invalid'; reason: string };

/** Non-negative integer or null. Used for port/size/token — size may be > 2^32
 *  (files over 4 GiB) so the only ceiling is JS's safe-integer range. */
function parseUint(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Decode a DCC address field to a printable host, or null if malformed. Three
 * forms are accepted:
 *  - the classic DCC IPv4-as-uint32 (network byte order), e.g. 3232235777 →
 *    "192.168.1.1" — this is what real senders use;
 *  - a dotted-quad IPv4 (some passive replies / lenient senders use it directly);
 *  - an IPv6 literal (sent verbatim, detected by its colons).
 */
export function decodeDccAddress(addr: string): string | null {
  const s = addr.trim();
  if (s === '') return null;
  // IPv6 literal — sent as-is; a colon is the giveaway (a valid v6 literal has at
  // least two). Allow the v4-mapped `::ffff:1.2.3.4` form's dot too.
  if (s.includes(':')) {
    const colons = s.match(/:/g)?.length ?? 0;
    return /^[0-9a-fA-F:.]+$/.test(s) && colons >= 2 ? s : null;
  }
  // Dotted-quad IPv4.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return s.split('.').every((o) => Number(o) <= 255) ? s : null;
  }
  // Classic DCC form: IPv4 packed into a uint32, network byte order.
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
    return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
  }
  return null;
}

/**
 * Parse the body of a CTCP DCC request — i.e. everything AFTER the `DCC` keyword,
 * such as `SEND "my file.mkv" 3232235777 50612 1024`. The caller has already
 * split `DCC` off via parseCtcp (`{ type: 'DCC', args }`), so pass `args` here.
 */
export function parseDcc(args: string): DccParse {
  const body = args.trim();
  if (body === '') return { kind: 'invalid', reason: 'empty DCC body' };
  const sp = body.indexOf(' ');
  const subtype = (sp === -1 ? body : body.slice(0, sp)).toUpperCase();
  const rest = sp === -1 ? '' : body.slice(sp + 1).trim();
  if (subtype !== 'SEND') return { kind: 'unsupported', subtype };
  return parseDccSend(rest);
}

function parseDccSend(rest: string): DccParse {
  if (rest === '') return { kind: 'invalid', reason: 'missing DCC SEND parameters' };

  let filename: string;
  let remainder: string;
  if (rest.startsWith('"')) {
    // Quoted filename — the only spec-conformant way to carry spaces.
    const end = rest.indexOf('"', 1);
    if (end === -1) return { kind: 'invalid', reason: 'unterminated quoted filename' };
    filename = rest.slice(1, end);
    remainder = rest.slice(end + 1).trim();
  } else {
    // Unquoted: the filename is the first whitespace token. A name with spaces
    // MUST be quoted per the DCC convention; XDCC bots use space-free names
    // (underscores), so first-token is correct for real traffic and keeps the
    // address/port/size fields unambiguous (WeeChat irc-ctcp.c does the same).
    const fsp = rest.indexOf(' ');
    if (fsp === -1) return { kind: 'invalid', reason: 'missing address/port/size' };
    filename = rest.slice(0, fsp);
    remainder = rest.slice(fsp + 1).trim();
  }
  if (filename === '') return { kind: 'invalid', reason: 'empty filename' };

  const fields = remainder.split(/\s+/).filter(Boolean);
  if (fields.length < 3 || fields.length > 4) {
    return { kind: 'invalid', reason: 'expected <ip> <port> <size> [token]' };
  }
  const [hostStr, portStr, sizeStr, tokenStr] = fields;

  const host = decodeDccAddress(hostStr);
  if (host === null) return { kind: 'invalid', reason: `bad address: ${hostStr}` };
  const port = parseUint(portStr);
  if (port === null || port > 65535) return { kind: 'invalid', reason: `bad port: ${portStr}` };
  const size = parseUint(sizeStr);
  if (size === null) return { kind: 'invalid', reason: `bad size: ${sizeStr}` };
  let token: number | null = null;
  if (tokenStr !== undefined) {
    token = parseUint(tokenStr);
    if (token === null) return { kind: 'invalid', reason: `bad token: ${tokenStr}` };
  }

  return { kind: 'send', filename, host, port, size, token, passive: port === 0 };
}

/** Human-readable byte size for status lines — 1024-based, one decimal place
 *  (whole bytes under 1 KiB). "5.0 GB", "1.5 MB", "512 B". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** One-line description of an inbound DCC SEND offer for a status buffer, e.g.
 *  `[EWG]MArchive offered "scene.mkv" (5.0 GB) via DCC SEND`. */
export function formatDccOfferLine(nick: string, offer: DccSend): string {
  const mode = offer.passive ? ' (passive)' : '';
  return `${nick} offered "${offer.filename}" (${formatBytes(offer.size)}) via DCC SEND${mode}`;
}

function isBlockedIpv4(ip: string): boolean {
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
 * Whether the cell should REFUSE to dial this DCC host. The address comes from
 * the (attacker-controlled) offer, and the cell dials it directly — so without
 * this an offer could point the cell at its own loopback, a cloud metadata
 * endpoint (169.254.169.254), or an internal VPC service (SSRF), and the
 * response would be written to a file the user can download. Blocks loopback /
 * link-local / private / CGNAT / multicast / reserved by default; the operator
 * can opt back in for LAN bots via LURKER_DCC_ALLOW_PRIVATE_HOSTS (see dccConfig).
 * `host` is the decoded form from decodeDccAddress (dotted-quad IPv4 or IPv6
 * literal).
 */
export function isBlockedDccHost(host: string): boolean {
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
