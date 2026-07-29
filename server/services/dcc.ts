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

import zlib from 'zlib';
import { isBlockedIpLiteral } from '../utils/ipGuard.js';

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

/** A parsed inbound `DCC ACCEPT` — the sender's reply to a `DCC RESUME` we sent,
 *  confirming it will resume from `position` bytes. */
export interface DccAccept {
  kind: 'accept';
  filename: string;
  port: number;
  position: number;
  token: number | null;
}

/** Result of parsing a CTCP DCC body: a `SEND` offer, an `ACCEPT` (resume
 *  confirmation), a recognised-but-unhandled subtype (CHAT/RESUME/…), or a
 *  structural rejection with a reason for logging. */
export type DccParse =
  | DccSend
  | DccAccept
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
  if (subtype === 'SEND') return parseDccSend(rest);
  if (subtype === 'ACCEPT') return parseDccAccept(rest);
  return { kind: 'unsupported', subtype };
}

// `DCC ACCEPT <filename> <port> <position> [token]` — the sender's go-ahead for a
// resume. Same filename grammar as SEND (quoted, else first token), then the port
// the original offer used and the byte position it will resume from.
function parseDccAccept(rest: string): DccParse {
  if (rest === '') return { kind: 'invalid', reason: 'missing DCC ACCEPT parameters' };
  let filename: string;
  let remainder: string;
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end === -1) return { kind: 'invalid', reason: 'unterminated quoted filename' };
    filename = rest.slice(1, end);
    remainder = rest.slice(end + 1).trim();
  } else {
    const fsp = rest.indexOf(' ');
    if (fsp === -1) return { kind: 'invalid', reason: 'missing port/position' };
    filename = rest.slice(0, fsp);
    remainder = rest.slice(fsp + 1).trim();
  }
  if (filename === '') return { kind: 'invalid', reason: 'empty filename' };

  const fields = remainder.split(/\s+/).filter(Boolean);
  if (fields.length < 2 || fields.length > 3) {
    return { kind: 'invalid', reason: 'expected <port> <position> [token]' };
  }
  const [portStr, posStr, tokenStr] = fields;
  const port = parseUint(portStr);
  if (port === null || port > 65535) return { kind: 'invalid', reason: `bad port: ${portStr}` };
  const position = parseUint(posStr);
  if (position === null) return { kind: 'invalid', reason: `bad position: ${posStr}` };
  let token: number | null = null;
  if (tokenStr !== undefined) {
    token = parseUint(tokenStr);
    if (token === null) return { kind: 'invalid', reason: `bad token: ${tokenStr}` };
  }
  return { kind: 'accept', filename, port, position, token };
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
 *
 * The range list itself lives in utils/ipGuard — link previews dial
 * user-supplied hosts too, and one drifting copy of "which addresses are
 * internal" is exactly the bug you don't find until it's exploited.
 */
export function isBlockedDccHost(host: string): boolean {
  return isBlockedIpLiteral(host);
}

// CRC32 (IEEE 802.3, the variant zip/PNG use and the one scene/anime releases
// embed in their filenames). Node's native zlib.crc32 with its incremental seed,
// so folding it over a multi-GB transfer's chunks doesn't run a byte-by-byte JS
// loop on the shared event loop.

/** Fold more bytes into a running CRC32. Seed with 0 for a fresh stream;
 *  `crc32Update(crc32Update(0, a), b)` equals the CRC32 of `a` concatenated with
 *  `b`, so it composes across chunks. */
export function crc32Update(crc: number, buf: Buffer): number {
  return zlib.crc32(buf, crc) >>> 0;
}

/** Render a CRC32 value as the conventional 8-char uppercase hex. */
export function crc32Hex(crc: number): string {
  return (crc >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Extract the CRC32 a release filename embeds, as 8-char uppercase hex, or null
 * if absent. Scene/anime names carry it bracketed near the end, e.g.
 * `[HorribleSubs] Show - 01 [1080p][A1B2C3D4].mkv` or `(a1b2c3d4)`. The LAST
 * 8-hex bracket token wins (the CRC sits after tags like `[1080p]`).
 */
export function parseCrcFromFilename(name: string): string | null {
  // Only treat an 8-hex bracket token as the CRC when it's the LAST token,
  // optionally right before the extension (`… [1080p][A1B2C3D4].mkv`). Anchoring
  // to the end avoids mistaking a release-group or resolution tag for a CRC and
  // flagging a perfectly good file with a bogus mismatch.
  const m = /[[(]([0-9A-Fa-f]{8})[\])](?:\.[^\])]*)?$/.exec(name);
  return m ? m[1].toUpperCase() : null;
}
