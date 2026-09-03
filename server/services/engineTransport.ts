// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// An irc-framework transport backed by the engine (server/engine.ts) instead of
// a socket of its own. Same contract as irc-framework's src/transports/net.js
// — `connect / writeLine / close / disposeSocket / setEncoding / isConnected`,
// events `open / line / close / debug / extra` — so ircConnection.ts keeps a
// real, live Client and none of its handlers know the socket is elsewhere.
//
// The one thing this does that a socket never would is RESTORE. When the engine
// answers CONNECT with `attached`, the socket is already registered and this
// Client is brand new, so the transport feeds it the engine's replay (the
// recorded registration burst, our NICK, one JOIN per channel) and swallows the
// registration commands the Client sends in response. The end-of-restore marker
// is a PING the transport makes up: when the Client's PONG for it comes back
// through writeLine(), everything before it has been processed. irc-framework's
// read path is synchronous today; the marker means nothing here depends on that.

import { EventEmitter } from 'node:events';
import type { ConnectOptions } from 'irc-framework';
import { ircLineParser } from 'irc-framework';
import { EngineLink } from './engineLink.js';
import type { FrameHandler } from './engineLink.js';
import type { EngineToApp, Gap } from '../engine/protocol.js';

export const ENGINE_CLOSE = {
  // The app↔engine link dropped; the IRC socket is (probably) still held.
  LINK_LOST: 'ENGINE_LINK_LOST',
  // The engine never became reachable (or never answered) within the window.
  UNREACHABLE: 'ENGINE_UNREACHABLE',
  // A newer app process claimed this connection.
  TAKEN_OVER: 'ENGINE_TAKEN_OVER',
  // The engine refused this app outright (secret / protocol major).
  REFUSED: 'ENGINE_REFUSED',
  // This process let go on purpose (shutdown); the socket stays in the engine.
  DETACHED: 'ENGINE_DETACHED',
} as const;

export class EngineCloseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// irc-framework hands the close error through as-is ('socket close' event arg).
export function engineCloseCode(err: unknown): string | null {
  if (err instanceof EngineCloseError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('ENGINE_') ? code : null;
}

export type EnginePhase = 'dialing' | 'attached' | 'restored' | 'live' | 'gap';

export interface EnginePhaseInfo {
  detachedForMs?: number;
  nick?: string | null;
  channels?: string[];
  replay?: number;
  unattended?: boolean;
  swallowed?: string[];
  gap?: Gap;
}

export interface EngineHooks {
  onTransport?(transport: EngineTransport): void;
  onPhase?(phase: EnginePhase, info: EnginePhaseInfo): void;
}

const RESTORE_MARK = '__lurker_restore__';
// Outbound lines that belong to registration. While restoring they are answered
// by the replay, never by the network.
const SWALLOW = /^(CAP|NICK|USER|PASS|AUTHENTICATE)(\s|$)/;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
// After CONNECT goes out on a ready link, how long the engine has to say
// dialing / attached / closed / error before the attempt is called off.
const CONNECT_REPLY_TIMEOUT_MS = Number(process.env.LURKER_ENGINE_REPLY_TIMEOUT_MS) || 30_000;

// The replay is the OLD registration, verbatim — including its SASL exchange.
// The fresh Client would answer a replayed `AUTHENTICATE +` from the network
// row as it is NOW (and irc-framework dereferences a missing account without
// checking), so the exchange is taken out: SASL already happened on this
// socket, and nothing in the replay needs it to happen again.
const SASL_NUMERICS = new Set(['900', '901', '902', '903', '904', '905', '906', '907', '908']);
export function sanitizeReplay(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const msg = ircLineParser(line);
    if (!msg) continue;
    const command = String(msg.command || '').toUpperCase();
    if (command === 'AUTHENTICATE' || SASL_NUMERICS.has(command)) continue;
    if (command === 'CAP' && /^(LS|ACK|NEW)$/i.test(msg.params[1] ?? '')) {
      const caps = (msg.params[msg.params.length - 1] ?? '')
        .split(' ')
        .filter((c) => c && c.split('=')[0] !== 'sasl');
      if (caps.length === 0) continue;
      const head = msg.params.slice(0, -1);
      const prefix = msg.prefix ? `:${msg.prefix} ` : '';
      out.push(`${prefix}CAP ${head.join(' ')} :${caps.join(' ')}`);
      continue;
    }
    out.push(line);
  }
  return out;
}

export interface EngineConnectOptions extends ConnectOptions {
  engineConnId: string;
  engineIdent?: string;
  engineHooks?: EngineHooks;
  // Test seams.
  engineLink?: EngineLink;
  engineConnectTimeoutMs?: number;
}

export class EngineTransport extends EventEmitter implements FrameHandler {
  readonly id: string;
  restoring = false;
  requested_disconnect = false;
  private connected = false;
  private ended = false;
  private detachedByApp = false;
  // A newer process owns the socket now; nothing we send may touch it.
  private lostToPeer = false;
  private closeSent = false;
  private readonly link: EngineLink;
  private readonly hooks: EngineHooks | undefined;
  private pending: EngineToApp[] = [];
  private swallowed: string[] = [];
  private replyTimer: ReturnType<typeof setTimeout> | null = null;
  // Acks are coalesced per synchronous batch (one microtask), so a chunk of a
  // hundred lines is one frame, not a hundred.
  private ackSeq = 0;
  private ackQueued = false;

  constructor(readonly options: EngineConnectOptions) {
    super();
    this.id = options.engineConnId;
    this.link = options.engineLink ?? EngineLink.shared();
    this.hooks = options.engineHooks;
    this.hooks?.onTransport?.(this);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private debugOut(s: string): void {
    this.emit('debug', 'EngineTransport ' + s);
  }

  connect(): void {
    this.ended = false;
    this.requested_disconnect = false;
    this.detachedByApp = false;
    this.link.register(this.id, this);
    const go = () => {
      const o = this.options;
      // The authoritative skew check, made where the link is known to be ready
      // and its protocol minor is therefore known. ircConnection refuses
      // earlier and more quietly when it can, but on a cold start the first
      // dial can outrun the engine's hello — and an engine that predates
      // minor 2 would simply ignore the field, leaving the app to authenticate
      // with a certificate that was never presented.
      if (o.client_certificate && !this.link.supportsClientCert()) {
        this.end(
          new Error(
            'the IRC engine this deployment connects through cannot present a client certificate — update the engine, or remove the certificate from this network',
          ),
        );
        return;
      }
      this.link.send({
        op: 'connect',
        id: this.id,
        host: o.host,
        port: o.port,
        tls: !!o.tls,
        rejectUnauthorized: o.rejectUnauthorized !== false,
        ...(o.outgoing_addr ? { outgoingAddr: o.outgoing_addr } : {}),
        ...(o.engineIdent ? { ident: o.engineIdent } : {}),
        ...(o.client_certificate
          ? {
              clientCert: {
                cert: o.client_certificate.certificate,
                key: o.client_certificate.private_key,
              },
            }
          : {}),
      });
      this.armReplyTimer();
    };
    if (this.link.state === 'ready') return go();
    void this.link
      .whenReady(this.options.engineConnectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
      .then((r) => {
        if (this.ended) return;
        if (r === 'ready') {
          // The link may have come and gone in between; register again so a
          // restart of the link didn't drop us.
          this.link.register(this.id, this);
          return go();
        }
        if (r === 'refused') {
          this.fail(
            ENGINE_CLOSE.REFUSED,
            `the Lurker engine at ${this.link.address} refused this app (${this.link.refusedReason})`,
          );
        } else {
          this.fail(
            ENGINE_CLOSE.UNREACHABLE,
            `the Lurker engine at ${this.link.address} is unreachable`,
          );
        }
      });
  }

  private armReplyTimer(): void {
    this.clearReplyTimer();
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      if (this.ended || this.connected) return;
      this.fail(
        ENGINE_CLOSE.UNREACHABLE,
        `the Lurker engine at ${this.link.address} did not answer the connect request`,
      );
    }, CONNECT_REPLY_TIMEOUT_MS);
    this.replyTimer.unref();
  }

  private clearReplyTimer(): void {
    if (this.replyTimer) {
      clearTimeout(this.replyTimer);
      this.replyTimer = null;
    }
  }

  private fail(code: string, message: string): void {
    this.end(new EngineCloseError(code, message));
  }

  // This transport is finished: no more frames in either direction, and
  // irc-framework hears a close so it tears the Client's timers down. A fresh
  // connect() builds a fresh transport.
  private end(err: Error | false): void {
    this.clearReplyTimer();
    this.ended = true;
    this.link.unregister(this.id, this);
    this.connected = false;
    this.restoring = false;
    this.pending = [];
    this.emit('close', err);
  }

  // --- FrameHandler ---------------------------------------------------------

  onLost(): void {
    if (this.ended || this.detachedByApp) return;
    const wasConnected = this.connected;
    this.connected = false;
    this.restoring = false;
    this.pending = [];
    if (wasConnected) {
      this.end(
        new EngineCloseError(
          ENGINE_CLOSE.LINK_LOST,
          `lost the link to the Lurker engine at ${this.link.address}`,
        ),
      );
    } else {
      // Mid-connect: wait for the link like a fresh connect would.
      this.clearReplyTimer();
      this.connect();
    }
  }

  onFrame(frame: EngineToApp): void {
    if (this.ended) return;
    switch (frame.op) {
      case 'dialing':
        this.clearReplyTimer();
        this.hooks?.onPhase?.('dialing', {});
        return;
      case 'open':
        this.clearReplyTimer();
        this.connected = true;
        this.emit('extra', 'raw socket connected', {
          localAddress: frame.local.address,
          localPort: frame.local.port,
          remoteAddress: frame.remote.address,
          remotePort: frame.remote.port,
        });
        this.emit('open');
        return;
      case 'attached':
        this.clearReplyTimer();
        this.restore(frame);
        return;
      case 'line':
        if (this.restoring) this.pending.push(frame);
        else this.deliver(frame);
        return;
      case 'gap':
        if (this.restoring) this.pending.push(frame);
        else this.hooks?.onPhase?.('gap', { gap: frame.gap });
        return;
      case 'live':
        if (this.restoring) this.pending.push(frame);
        else this.hooks?.onPhase?.('live', {});
        return;
      case 'detached':
        this.lostToPeer = true;
        this.fail(ENGINE_CLOSE.TAKEN_OVER, 'another Lurker process took over this connection');
        return;
      case 'closed':
        this.end(frame.error ? new Error(frame.error) : false);
        return;
      case 'error':
        // Before the socket is up, an error naming our id is the engine's
        // answer to the CONNECT (a bad port, a non-IP bind address): the dial
        // failed. irc-framework has no connect timeout of its own, so this is
        // where the Client learns it. After that it is informational.
        if (!this.connected) this.end(new Error(frame.message));
        else this.debugOut(`engine error: ${frame.message}`);
        return;
      default:
        return;
    }
  }

  private restore(frame: Extract<EngineToApp, { op: 'attached' }>): void {
    this.connected = true;
    this.restoring = true;
    this.swallowed = [];
    this.hooks?.onPhase?.('attached', {
      detachedForMs: frame.detachedForMs,
      nick: frame.nick,
      channels: frame.channels,
      replay: frame.replay.length,
      unattended: frame.unattended,
    });
    this.emit('extra', 'raw socket connected', {
      localAddress: frame.local.address,
      localPort: frame.local.port,
      remoteAddress: frame.remote.address,
      remotePort: frame.remote.port,
    });
    try {
      // irc-framework answers 'open' by sending CAP LS / NICK / USER — swallowed.
      this.emit('open');
      for (const line of sanitizeReplay(frame.replay)) this.emit('line', line);
      this.emit('line', `PING :${RESTORE_MARK}`);
    } catch (err) {
      // A handler threw mid-replay. The Client is in no state to continue on
      // this socket, and attaching again would throw again: end the socket so
      // the next attempt is a fresh dial, and report why.
      this.link.requestClose(this.id);
      this.closeSent = true;
      this.end(new Error(`restore failed: ${(err as Error).message}`));
    }
  }

  private finishRestore(): void {
    this.restoring = false;
    this.hooks?.onPhase?.('restored', { swallowed: this.swallowed.slice() });
    const queued = this.pending.splice(0);
    for (const f of queued) this.onFrame(f);
  }

  private deliver(frame: Extract<EngineToApp, { op: 'line' }>): void {
    this.emit('line', frame.line);
    // By the time emit() returns, irc-framework and every ircConnection handler
    // have run — persistence included, better-sqlite3 being synchronous — so
    // the ack can never get ahead of the row. Coalesced: one frame per batch.
    this.ackSeq = frame.seq;
    if (!this.ackQueued) {
      this.ackQueued = true;
      queueMicrotask(() => {
        this.ackQueued = false;
        if (!this.ended && this.connected)
          this.link.send({ op: 'ack', id: this.id, seq: this.ackSeq });
      });
    }
  }

  // --- irc-framework transport contract ---------------------------------------

  // irc-framework passes a callback only from Connection.end(), to close the
  // socket once the last line (a QUIT) is out. It is called SYNCHRONOUSLY here
  // so the `close` frame follows the QUIT on the link immediately — ahead of
  // anything the app does next, such as restartNetwork's fresh CONNECT for the
  // same id, which must find the old socket closing rather than attach to it.
  writeLine(line: string, cb?: () => void): void {
    if (this.restoring) {
      if (line === `PONG ${RESTORE_MARK}` || line === `PONG :${RESTORE_MARK}`) {
        this.finishRestore();
        cb?.();
        return;
      }
      if (SWALLOW.test(line)) {
        this.swallowed.push(line);
        cb?.();
        return;
      }
    }
    if (this.connected) this.link.send({ op: 'write', id: this.id, line });
    else this.debugOut('writeLine() called when not connected');
    cb?.();
  }

  // End the IRC socket. This is what QUIT ends in. A no-op after detach() (the
  // socket is meant to outlive us) and after a takeover (it is someone else's).
  // Otherwise the close is delivered now, or the moment the link is back — a
  // Disconnect during an outage is still a Disconnect.
  close(): void {
    this.requested_disconnect = true;
    if (this.detachedByApp || this.lostToPeer || this.closeSent) return;
    this.closeSent = true;
    this.link.requestClose(this.id);
    // End our side NOW rather than on the engine's `closed`: irc-framework must
    // tear this Client's timers down before a successor claims the same id, or
    // a zombie PING (or ping-timeout QUIT) from the old Client would land on the
    // successor's socket. The engine's later `closed` for the old socket goes
    // unrouted, by design.
    if (!this.ended) this.end(false);
  }

  // Leave the IRC socket alive in the engine for the next app process, and end
  // only our side. Tagged, so ircConnection knows nothing about the network
  // changed — no presence sweep, no "Disconnected" row.
  detach(): void {
    if (this.detachedByApp || this.ended) return;
    this.detachedByApp = true;
    this.requested_disconnect = true;
    this.link.send({ op: 'detach', id: this.id });
    this.link.noteDetached(this.id);
    this.end(new EngineCloseError(ENGINE_CLOSE.DETACHED, 'detached; the engine keeps the socket'));
  }

  disposeSocket(): void {
    this.clearReplyTimer();
    this.ended = true;
    this.link.unregister(this.id, this);
  }

  setEncoding(encoding: string): boolean {
    return encoding === 'utf8';
  }
}
