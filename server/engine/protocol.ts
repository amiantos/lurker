// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The wire contract between the IRC engine (server/engine.ts) and the app tier.
//
// Newline-delimited JSON over one TCP link per app process. The engine is a
// line-level holder of IRC sockets: it relays raw IRC lines in both directions
// and keeps the socket — and the server's idea of who is connected — alive while
// the app is being redeployed. Everything that understands IRC beyond a handful
// of commands lives on the app side, in irc-framework and ircConnection.ts.
//
// Version skew is expected and allowed in one direction at a time: the engine is
// the thing that DOESN'T get redeployed, so an app of any minor version must be
// able to talk to it. `PROTOCOL_MAJOR` is the compatibility line — a mismatch is
// refused at `hello`, and the app falls back to dialing IRC itself (which is
// exactly what it did before the engine existed). Adding an optional field or a
// new op is a minor change; renaming or re-meaning one is a major.

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 1;

// One frame is one JSON object on one line. Most wrap a single IRC line (≤ 8191
// bytes with tags); the one large frame is `attached`, whose replay is bounded by
// the engine's burst cap (upstream.ts MAX_BURST_BYTES) plus one JOIN per channel,
// and is size-checked by the engine before it is sent. Enforced by the framer on
// both sides so a misbehaving link can't make either process buffer without
// bound.
export const MAX_FRAME_BYTES = 256 * 1024;

export interface Endpoint {
  address: string;
  port: number;
}

// A run of inbound lines the engine had to drop because the app stayed away
// longer than its buffer covers. Delivered in sequence position so the app can
// say exactly where the hole is.
export interface Gap {
  firstDroppedSeq: number;
  lastDroppedSeq: number;
  // ms since epoch when the last line was dropped.
  at: number;
}

export interface ConnectionInfo {
  id: string;
  state: 'dialing' | 'open' | 'closing';
  attached: boolean;
  nick: string | null;
  // A count, not the names: a listing of a busy cell must stay one bounded frame.
  channelCount: number;
  bufferedLines: number;
  bufferedBytes: number;
  detachedForMs: number | null;
}

export type AppToEngine =
  // `startedAt` is the app process's generation — its start time in ms, times
  // 1000, plus a pid tiebreak, so no two processes share one: when two processes overlap
  // (a rolling deploy), a connection goes to the NEWER one and an older one is
  // refused rather than allowed to steal it back.
  // `instance` identifies the Lurker DATABASE this app speaks for, and it is
  // required. Connection ids are `<instance>:<userId>:<networkId>`, and userId
  // and networkId are rowids from that database — so two Lurker instances
  // pointed at one engine would otherwise both mint `1:1` for unrelated people.
  // `matchesDial` would not catch it either: two users on the same popular
  // network dial the identical host/port/tls. That is how IRCCloud leaked logs
  // between accounts in July 2020 (two servers, one id space). The engine
  // partitions every session by this value and refuses a hello without one.
  | {
      op: 'hello';
      protocol: number;
      secret: string;
      instance: string;
      app: { version: string; startedAt?: number };
    }
  // Link liveness, both directions: the engine answers `pong`; the app sends
  // `ping` on a timer and drops a link that answers nothing for a while.
  | { op: 'ping' }
  | { op: 'pong' }
  // Connect-or-attach. The app never has to know which one it is getting: the
  // engine answers `dialing` for a fresh socket and `attached` for one it holds.
  | {
      op: 'connect';
      id: string;
      host: string;
      port: number;
      tls: boolean;
      rejectUnauthorized: boolean;
      // Source address for the outbound socket (LURKER_OUTGOING_ADDR today).
      outgoingAddr?: string;
      // The RFC 1413 ident to answer for this connection, if identd is on. Set by
      // the app because it is derived from the account, which the engine never
      // sees.
      ident?: string;
    }
  | { op: 'write'; id: string; line: string }
  // Everything up to and including `seq` has been persisted; the engine may
  // forget it.
  | { op: 'ack'; id: string; seq: number }
  // Leave the socket alive and stop delivering to this link. The link closing is
  // the implicit form.
  | { op: 'detach'; id: string }
  // End the IRC socket. This is what QUIT ends in. Allowed from the link that
  // holds the claim, from any link when NOBODY does (an orphan left behind by a
  // previous process), and — the attach rule — from any link the holder is not
  // NEWER than: the holder is then a superseded link (this process's dead
  // predecessor, or an older process), its claim is dropped, it is sent
  // `detached` (taken-over), and the socket ends. Only a newer holder refuses
  // (`error`).
  | { op: 'close'; id: string }
  | { op: 'list' };

export type EngineToApp =
  | { op: 'hello'; protocol: number; minor: number; engine: { version: string }; held: string[] }
  | { op: 'ping' }
  | { op: 'pong' }
  | { op: 'dialing'; id: string }
  | { op: 'open'; id: string; local: Endpoint; remote: Endpoint }
  | {
      op: 'attached';
      id: string;
      local: Endpoint;
      remote: Endpoint;
      // Lines to feed the app's fresh irc-framework Client so it believes it just
      // registered: the recorded registration burst, then our own NICK changes in
      // order, then one synthesised JOIN per channel we are in.
      replay: string[];
      nick: string | null;
      channels: string[];
      detachedForMs: number;
      // Registration completed while NO app was attached: the previous app
      // wrote NICK/USER and died before 001, so nothing ever ran the post-
      // registration steps (connect commands, autojoin). The app treats this
      // like a first registration, minus the history.
      unattended: boolean;
    }
  // The unacked backlog follows `attached` as ordinary `line` frames, then `live`
  // marks the point after which frames are real-time.
  | { op: 'line'; id: string; seq: number; line: string }
  | { op: 'live'; id: string }
  | { op: 'gap'; id: string; gap: Gap }
  // The engine stopped serving this id to THIS link because a newer app process
  // claimed the connection — to serve it, or to end it (a `close` over this
  // link's claim). Either way not a socket event for this link: it must not
  // reconnect.
  | { op: 'detached'; id: string; reason: 'taken-over' }
  // The IRC socket is gone. The engine forgets the id.
  | { op: 'closed'; id: string; error?: string }
  | { op: 'listing'; connections: ConnectionInfo[] }
  | { op: 'error'; id?: string; message: string };

export type Frame = AppToEngine | EngineToApp;

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame) + '\n';
}

// Incremental NDJSON reader shared by both ends. Feed chunks in; complete frames
// come out. Throws on an over-long line, and the caller should drop the link —
// nothing legitimate is that big.
export class FrameReader {
  private buf = '';

  push(chunk: string): Frame[] {
    this.buf += chunk;
    const out: Frame[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const raw = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!raw.trim()) continue;
      if (raw.length > MAX_FRAME_BYTES) throw new Error('frame too long');
      const parsed: unknown = JSON.parse(raw);
      if (!isFrame(parsed)) throw new Error('malformed frame');
      out.push(parsed);
    }
    if (this.buf.length > MAX_FRAME_BYTES) throw new Error('frame too long');
    return out;
  }
}

function isFrame(v: unknown): v is Frame {
  return typeof v === 'object' && v !== null && typeof (v as { op?: unknown }).op === 'string';
}

// Parse `host:port` / `[v6]:port` / `port` for the listen address. Exported so
// the app side can parse LURKER_ENGINE_URL's authority with the same rules.
export function parseHostPort(
  raw: string,
  defaults: { host: string; port: number },
): { host: string; port: number } {
  const s = raw.trim();
  if (!s) return { ...defaults };
  // Every shape that names a port checks it the same way. Letting `70000` or
  // `[::1]:70000` through when `host:70000` throws only defers the failure to
  // listen()/connect(), which reports it as an opaque ERR_SOCKET_BAD_PORT with
  // no mention of the setting that carried it.
  const checkPort = (text: string): number => {
    const n = Number(text);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(`invalid port in "${raw}"`);
    }
    return n;
  };
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) return { host: v6[1], port: v6[2] ? checkPort(v6[2]) : defaults.port };
  if (/^\d+$/.test(s)) return { host: defaults.host, port: checkPort(s) };
  const colon = s.lastIndexOf(':');
  if (colon < 0) return { host: s, port: defaults.port };
  return { host: s.slice(0, colon) || defaults.host, port: checkPort(s.slice(colon + 1)) };
}
