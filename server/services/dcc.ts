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

/** A parsed inbound `DCC CHAT` offer — a request to open a direct line-oriented
 *  chat. `host`/`port` are where the offerer is listening (active); `passive`
 *  (port 0) means the offerer is firewalled and wants US to listen, correlated
 *  by `token`. The `protocol` field is almost always `chat` (the only widely
 *  used subtype). */
export interface DccChat {
  kind: 'chat';
  protocol: string;
  host: string;
  port: number;
  token: number | null;
  passive: boolean;
}

/** Result of parsing a CTCP DCC body: a `SEND` offer, an `ACCEPT` (resume
 *  confirmation), a recognised-but-unhandled subtype (CHAT/RESUME/…), or a
 *  structural rejection with a reason for logging. */
export type DccParse =
  | DccSend
  | DccAccept
  | DccChat
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
  if (subtype === 'CHAT') return parseDccChat(rest);
  return { kind: 'unsupported', subtype };
}

// `DCC CHAT <protocol> <ip> <port> [token]` — an offer to open a direct chat.
// `protocol` is conventionally the literal `chat` (some clients send `chat`,
// others echo it in other case); we keep it verbatim but don't require a
// specific value. Port 0 marks a passive/reverse offer carrying a token.
function parseDccChat(rest: string): DccParse {
  if (rest === '') return { kind: 'invalid', reason: 'missing DCC CHAT parameters' };
  const fields = rest.split(/\s+/).filter(Boolean);
  if (fields.length < 3 || fields.length > 4) {
    return { kind: 'invalid', reason: 'expected <protocol> <ip> <port> [token]' };
  }
  const [protocol, hostStr, portStr, tokenStr] = fields;
  const host = decodeDccAddress(hostStr);
  if (host === null) return { kind: 'invalid', reason: `bad address: ${hostStr}` };
  const port = parseUint(portStr);
  if (port === null || port > 65535) return { kind: 'invalid', reason: `bad port: ${portStr}` };
  let token: number | null = null;
  if (tokenStr !== undefined) {
    token = parseUint(tokenStr);
    if (token === null) return { kind: 'invalid', reason: `bad token: ${tokenStr}` };
  }
  return { kind: 'chat', protocol, host, port, token, passive: port === 0 };
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

// ---------------------------------------------------------------------------
// Outgoing DCC — building the CTCP bodies WE send when offering a transfer/chat.
// The IPv4 address goes on the wire as a uint32 in network byte order (the
// classic form every client understands); an IPv6 offerer sends the literal.
// These return the CTCP *body* (the part after `DCC`); the caller frames it as a
// CTCP request of type DCC. Pure + unit-tested.
// ---------------------------------------------------------------------------

/** Encode a host for a DCC offer field: IPv4 → its uint32 (network byte order)
 *  as a decimal string; an IPv6 literal is passed through verbatim (detected by
 *  a colon). Returns null if it's neither a dotted-quad nor a v6 literal. */
export function encodeDccAddress(host: string): string | null {
  const h = host.trim();
  if (h.includes(':')) {
    return /^[0-9a-fA-F:.]+$/.test(h) ? h : null;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const o = m.slice(1).map((x) => Number(x));
  if (o.some((x) => x > 255)) return null;
  const n = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  return String(n);
}

// A filename with a space (or a quote) must be double-quoted on the wire so the
// address/port/size fields stay unambiguous. Embedded quotes are dropped — DCC
// has no escaping, and a name with a literal quote is degenerate anyway. Names
// reaching here are already storage-sanitized, so this is belt-and-suspenders.
function quoteDccFilename(name: string): string {
  // Strip quotes + line breaks + NUL so the offer can't be split or smuggled;
  // matching the control chars is the whole point here.
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/["\r\n\x00]/g, '');
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

/** Build the body of an active `DCC SEND` offer (we listen; the peer connects to
 *  `host:port`). Returns `SEND <file> <addr> <port> <size>`. */
export function buildDccSend(
  filename: string,
  host: string,
  port: number,
  size: number,
): string | null {
  const addr = encodeDccAddress(host);
  if (addr === null) return null;
  return `SEND ${quoteDccFilename(filename)} ${addr} ${port} ${size}`;
}

/** Build the body of a passive/reverse `DCC SEND` offer (the PEER listens; port
 *  is 0 and a token correlates its reply). Returns
 *  `SEND <file> <addr> 0 <size> <token>`. */
export function buildDccSendPassive(
  filename: string,
  host: string,
  size: number,
  token: number,
): string | null {
  const addr = encodeDccAddress(host);
  if (addr === null) return null;
  return `SEND ${quoteDccFilename(filename)} ${addr} 0 ${size} ${token}`;
}

/** Build the body of an active `DCC CHAT` offer — `CHAT chat <addr> <port>`. */
export function buildDccChat(host: string, port: number): string | null {
  const addr = encodeDccAddress(host);
  if (addr === null) return null;
  return `CHAT chat ${addr} ${port}`;
}

/** Build the body of a passive/reverse `DCC CHAT` offer —
 *  `CHAT chat <addr> 0 <token>` (the peer listens and replies). */
export function buildDccChatPassive(host: string, token: number): string | null {
  const addr = encodeDccAddress(host);
  if (addr === null) return null;
  return `CHAT chat ${addr} 0 ${token}`;
}

/** Reverse reply to a peer's PASSIVE `DCC SEND`: after we start listening for
 *  their firewalled send, we echo our own listening address/port plus their
 *  token so they dial us — `SEND <file> <addr> <port> <size> <token>`. */
export function buildDccSendReverse(
  filename: string,
  host: string,
  port: number,
  size: number,
  token: number,
): string | null {
  const addr = encodeDccAddress(host);
  if (addr === null) return null;
  return `SEND ${quoteDccFilename(filename)} ${addr} ${port} ${size} ${token}`;
}

/** Reverse reply to a peer's PASSIVE `DCC CHAT`: our listening address/port +
 *  their token — `CHAT chat <addr> <port> <token>`. */
export function buildDccChatReverse(host: string, port: number, token: number): string | null {
  const addr = encodeDccAddress(host);
  if (addr === null) return null;
  return `CHAT chat ${addr} ${port} ${token}`;
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
