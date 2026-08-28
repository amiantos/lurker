// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The app's one link to the IRC engine (server/engine.ts). Engine mode is
// switched on by LURKER_ENGINE_URL, the same way LURKER_PREVIEWS_URL switches on
// the preview decoder: unset, nothing here runs and the app dials IRC itself.
//
// One TCP link per process carries every connection's frames, routed by id to
// the EngineTransport that claimed it. The link reconnects on its own with a
// short backoff — the engine being briefly unreachable is not the same as the
// IRC sockets being gone, and the transports get a chance to re-attach. It also
// heartbeats: a half-open link (a NAT entry expired under an engine on another
// host) is noticed in seconds, not when irc-framework's 120 s ping timeout
// misreads the silence as an IRC disconnect.
//
// Two failures are terminal and turn engine mode OFF for the life of the
// process: a bad secret and a protocol-major mismatch. Both mean the operator
// has to change something, and a cell with a misconfigured engine must not sit
// with no IRC at all — it falls back to dialing directly, loudly.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { FrameReader, PROTOCOL_MAJOR, encodeFrame, parseHostPort } from '../engine/protocol.js';
import { instanceId } from '../db/instanceId.js';
import type { AppToEngine, EngineToApp } from '../engine/protocol.js';
import { APP_VERSION } from '../utils/userAgent.js';

// This process's generation, for the engine's newest-wins rule (protocol.ts):
// the start time, with the pid as a sub-millisecond tiebreak. The engine reads
// an EQUAL generation as "another link of the same process" (its predecessor,
// which it may supersede), so two processes must never share one — and two
// started in the same millisecond otherwise would.
const PROCESS_GENERATION = Date.now() * 1000 + (process.pid % 1000);

// The id the engine knows a network's socket by. One definition, so the two
// sides of every comparison agree.
// `<instance>:<userId>:<networkId>`. The instance prefix is not decoration: the
// two rowids are unique within ONE Lurker database and collide freely across
// two, so without it a second Lurker on the same engine mints the same id for a
// different person's connection. Every caller goes through this function, which
// is the point — none of them can forget the prefix.
export function engineConnectionId(userId: number, networkId: number): string {
  return `${instanceId()}:${userId}:${networkId}`;
}

// Does this id belong to us? Used where an id comes back FROM the engine rather
// than being minted here.
export function isOurConnectionId(id: string): boolean {
  return id.startsWith(`${instanceId()}:`);
}

let urlWarned = false;

// `tcp://host:port`, `host:port`, or the same with a scheme/path an operator
// might habitually add. Garbage is a null (and one warning), never a throw —
// this is read at module top level in server.ts.
export function parseEngineUrl(raw: string | undefined): { host: string; port: number } | null {
  const s = (raw || '').trim();
  if (!s) return null;
  const authority = s
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .trim();
  try {
    return parseHostPort(authority, { host: '127.0.0.1', port: 8016 });
  } catch (err) {
    if (!urlWarned) {
      urlWarned = true;
      console.error(
        `[lurker] LURKER_ENGINE_URL is not usable (${(err as Error).message}) — engine mode is off; expected tcp://host:port`,
      );
    }
    return null;
  }
}

let disabledReason: string | null = null;

export function engineConfigured(): boolean {
  return disabledReason === null && parseEngineUrl(process.env.LURKER_ENGINE_URL) !== null;
}

// Fall back to direct dialing for the rest of this process. See the header.
export function disableEngineMode(reason: string): void {
  disabledReason = reason;
}

export function engineDisabledReason(): string | null {
  return disabledReason;
}

export type LinkState = 'idle' | 'connecting' | 'ready' | 'down' | 'refused';

export interface FrameHandler {
  onFrame(frame: EngineToApp): void;
  // The link itself dropped (not the IRC socket). Handlers are unregistered
  // before this fires; a transport that wants to come back re-registers.
  onLost(): void;
}

function envInt(name: string, fallback: number): number {
  const n = Number((process.env[name] || '').trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface EngineLinkOptions {
  host: string;
  port: number;
  secret: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  heartbeatMs?: number;
  log?: (line: string, level?: 'info' | 'warn' | 'error') => void;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

export class EngineLink extends EventEmitter {
  state: LinkState = 'idle';
  engineVersion: string | null = null;
  refusedReason: string | null = null;

  private socket: net.Socket | null = null;
  private reader = new FrameReader();
  private readonly handlers = new Map<string, FrameHandler>();
  // What the engine holds for us, kept current: seeded by hello, then
  // maintained from the frames that change it. The labels ("Attaching…" vs
  // "Starting connection…") and the re-attach decision both read it.
  private readonly heldSet = new Set<string>();
  // Closes requested while the link was down. A QUIT that never left is not a
  // reason to keep the session: they are sent the moment the link is back,
  // before anyone gets to adopt those sockets.
  private readonly pendingCloses = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private attempt = 0;
  private stopped = false;
  private everReady = false;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly heartbeatMs: number;
  private readonly log: (line: string, level?: 'info' | 'warn' | 'error') => void;

  constructor(readonly opts: EngineLinkOptions) {
    super();
    // One waiter per network on whenReady()/awaitSettled(); the default cap
    // of 10 would warn on the 11th.
    this.setMaxListeners(0);
    this.retryBaseMs = opts.retryBaseMs ?? envInt('LURKER_ENGINE_RETRY_BASE_MS', 1000);
    this.retryMaxMs = opts.retryMaxMs ?? 15_000;
    this.heartbeatMs =
      opts.heartbeatMs ?? envInt('LURKER_ENGINE_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS);
    this.log =
      opts.log ??
      ((line, level = 'info') => {
        const fn =
          level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn(`[lurker] engine: ${line}`);
      });
  }

  private static instance: EngineLink | null = null;

  static shared(): EngineLink {
    if (!EngineLink.instance) {
      const url = parseEngineUrl(process.env.LURKER_ENGINE_URL);
      EngineLink.instance = new EngineLink({
        host: url?.host ?? '127.0.0.1',
        port: url?.port ?? 8016,
        secret: (process.env.LURKER_ENGINE_SECRET || '').trim(),
      });
    }
    return EngineLink.instance;
  }

  // Tests build engines on ephemeral ports and need a fresh singleton each time.
  static resetForTests(): void {
    EngineLink.instance?.stop();
    EngineLink.instance = null;
    disabledReason = null;
  }

  get address(): string {
    return `${this.opts.host}:${this.opts.port}`;
  }

  get held(): string[] {
    return [...this.heldSet];
  }

  holds(id: string): boolean {
    return this.heldSet.has(id);
  }

  start(): void {
    if (this.stopped || this.state !== 'idle') return;
    this.connectOnce();
  }

  // Resolves once the first attempt has an answer (ready / refused / down) or
  // the timeout passes with it still connecting.
  awaitSettled(timeoutMs: number): Promise<LinkState> {
    if (this.state !== 'idle' && this.state !== 'connecting') return Promise.resolve(this.state);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off('ready', done);
        this.off('refused', done);
        this.off('down', done);
        resolve(this.state);
      };
      const timer = setTimeout(done, timeoutMs);
      this.on('ready', done);
      this.on('refused', done);
      this.on('down', done);
    });
  }

  // Wait for the link to be usable. 'refused' is terminal; 'timeout' means the
  // engine stayed unreachable for the whole window.
  whenReady(timeoutMs: number): Promise<'ready' | 'refused' | 'timeout'> {
    if (this.state === 'ready') return Promise.resolve('ready');
    if (this.state === 'refused') return Promise.resolve('refused');
    this.start();
    return new Promise((resolve) => {
      const finish = (r: 'ready' | 'refused' | 'timeout') => {
        clearTimeout(timer);
        this.off('ready', onReady);
        this.off('refused', onRefused);
        resolve(r);
      };
      const onReady = () => finish('ready');
      const onRefused = () => finish('refused');
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      this.on('ready', onReady);
      this.on('refused', onRefused);
    });
  }

  register(id: string, handler: FrameHandler): void {
    this.handlers.set(id, handler);
  }

  unregister(id: string, handler?: FrameHandler): void {
    if (!handler || this.handlers.get(id) === handler) this.handlers.delete(id);
  }

  send(frame: AppToEngine): boolean {
    if (this.state !== 'ready' || !this.socket || this.socket.destroyed) return false;
    this.socket.write(encodeFrame(frame));
    return true;
  }

  // End an engine-held socket. Sent now if the link is up; otherwise remembered
  // and sent the moment it is — a user's Disconnect (or a settings change that
  // needs a fresh dial) during an outage must not quietly become "kept".
  requestClose(id: string): void {
    this.heldSet.delete(id);
    if (!this.send({ op: 'close', id })) this.pendingCloses.add(id);
  }

  noteDetached(id: string): void {
    this.heldSet.delete(id);
  }

  // Test seam: the link dies under a live app.
  simulateLoss(): void {
    this.socket?.destroy();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopHeartbeat();
    this.socket?.destroy();
    this.socket = null;
  }

  private startHeartbeat(socket: net.Socket): void {
    this.stopHeartbeat();
    this.lastFrameAt = Date.now();
    let lastBeat = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket) return this.stopHeartbeat();
      const now = Date.now();
      const overran = now - lastBeat > this.heartbeatMs * 2;
      lastBeat = now;
      // A beat that fired far later than scheduled means the event loop was
      // starved, not the link — a stale lastFrameAt would then be OUR fault. Send
      // a fresh ping and give the peer another interval to answer it, rather than
      // drop a link that may be perfectly healthy.
      if (!overran && now - this.lastFrameAt > this.heartbeatMs * 3) {
        this.log(
          `no answer from ${this.address} for ${now - this.lastFrameAt}ms — dropping the link`,
          'warn',
        );
        socket.destroy();
        return;
      }
      this.send({ op: 'ping' });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private connectOnce(): void {
    this.state = 'connecting';
    this.reader = new FrameReader();
    const socket = net.connect(this.opts.port, this.opts.host);
    this.socket = socket;
    let sawHello = false;
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 10_000);
    socket.on('connect', () => {
      socket.write(
        encodeFrame({
          op: 'hello',
          protocol: PROTOCOL_MAJOR,
          secret: this.opts.secret,
          instance: instanceId(),
          app: { version: APP_VERSION, startedAt: PROCESS_GENERATION },
        }),
      );
    });
    socket.on('data', (chunk: string) => {
      this.lastFrameAt = Date.now();
      let frames: EngineToApp[];
      try {
        frames = this.reader.push(chunk) as EngineToApp[];
      } catch (err) {
        this.log(`dropping link: ${(err as Error).message}`, 'warn');
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (!sawHello) {
          if (frame.op === 'hello') {
            sawHello = true;
            this.state = 'ready';
            this.heldSet.clear();
            for (const id of frame.held) this.heldSet.add(id);
            this.engineVersion = frame.engine.version;
            if (this.everReady) {
              this.log(`link restored to ${this.address} after ${this.attempt} attempt(s)`);
            }
            this.everReady = true;
            this.attempt = 0;
            this.startHeartbeat(socket);
            // Closes that never left go out before anyone hears 'ready' and
            // decides those sockets are worth adopting.
            for (const id of this.pendingCloses) {
              this.heldSet.delete(id);
              this.send({ op: 'close', id });
            }
            this.pendingCloses.clear();
            this.emit('ready');
            continue;
          }
          if (frame.op === 'error') {
            // Nothing a retry can fix. Engine mode is over for this process:
            // every connection that fails from here dials IRC directly on its
            // next attempt, instead of collecting a refusal per backoff tick.
            this.refusedReason = frame.message;
            this.state = 'refused';
            this.stopped = true;
            disableEngineMode(frame.message);
            this.log(
              `refused by ${this.address}: ${frame.message} — falling back to dialing IRC directly`,
              'error',
            );
            this.emit('refused', frame.message);
            socket.destroy();
            return;
          }
          continue;
        }
        this.route(frame);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      const wasReady = this.state === 'ready';
      if (this.state !== 'refused') this.state = 'down';
      if (wasReady) {
        this.log(
          `link to ${this.address} lost — holding IRC connections in the engine, re-attaching`,
          'warn',
        );
        const lost = [...this.handlers.values()];
        this.handlers.clear();
        this.emit('lost');
        for (const h of lost) h.onLost();
      } else if (this.attempt === 0 && this.state === 'down') {
        this.log(`unreachable at ${this.address} — retrying`, 'warn');
        this.emit('down');
      }
      this.scheduleRetry();
    });
  }

  private route(frame: EngineToApp): void {
    switch (frame.op) {
      case 'ping':
        this.send({ op: 'pong' });
        return;
      case 'pong':
        return;
      case 'attached':
      case 'open':
        this.heldSet.add(frame.id);
        break;
      case 'closed':
      case 'detached':
        this.heldSet.delete(frame.id);
        break;
      default:
        break;
    }
    if ('id' in frame && typeof frame.id === 'string') {
      const h = this.handlers.get(frame.id);
      if (h) h.onFrame(frame);
      else if (frame.op !== 'closed' && frame.op !== 'detached') {
        // A frame for a connection this process never claimed (or has since
        // released) — the engine's answer to an orphan close, typically.
        this.emit('unrouted', frame);
      }
      return;
    }
    this.emit('frame', frame);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(this.retryBaseMs * 2 ** this.attempt, this.retryMaxMs);
    this.attempt++;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        if (!this.stopped) this.connectOnce();
      },
      delay + Math.floor(Math.random() * 250),
    );
  }
}

// Boot-time entry point for server.ts: start connecting and log the verdict
// when it comes. Deliberately not awaited by the caller — a down engine must
// not hold up the HTTP listener; connections simply wait for the link.
export function startEngineLink(timeoutMs = 5000): Promise<LinkState> {
  const link = EngineLink.shared();
  link.start();
  return link.awaitSettled(timeoutMs).then((state) => {
    if (state === 'ready') {
      console.log(
        `[lurker] engine mode: attached to ${link.address} (engine ${link.engineVersion}, holding ${link.held.length} connection(s))`,
      );
    } else if (state === 'refused') {
      console.error(
        `[lurker] engine at ${link.address} refused this app (${link.refusedReason}) — falling back to dialing IRC directly for this run. Fix LURKER_ENGINE_SECRET or update the engine, then restart.`,
      );
    } else {
      console.warn(
        `[lurker] engine at ${link.address} did not answer within ${timeoutMs}ms — staying in engine mode; IRC connections will open once it is reachable`,
      );
    }
    return state;
  });
}

export function stopEngineLink(): void {
  EngineLink.shared().stop();
}
