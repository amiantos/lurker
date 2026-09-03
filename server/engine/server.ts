// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine's listener: accepts app links, authenticates them, and routes
// frames to the held upstream sockets. One app process holds one link and may
// claim any number of connections over it.
//
// "Newest link wins": a CONNECT for an id another link already holds moves the
// connection to the new link and tells the old one `detached`. That is what
// lets a deploy start the new app before the old one has finished dying — and
// it is not a socket event, so the old app must not treat it as one.

import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ByteBudget } from './lineBuffer.js';
import { EngineUpstream } from './upstream.js';
import type { FrameSink } from './upstream.js';
import {
  FrameReader,
  MAX_FRAME_BYTES,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  encodeFrame,
} from './protocol.js';
import type { AppToEngine, EngineToApp } from './protocol.js';
import { isDialableCertPair } from '../utils/clientCert.js';

export interface EngineServerOptions {
  secret: string;
  bufferBytes: number;
  bufferTotalBytes: number;
  version: string;
  log?: (line: string) => void;
  // Test seam; production takes the upstream's default.
  dialTimeoutMs?: number;
  // End a session no link has claimed for this long. 0 disables.
  orphanMs?: number;
}

// Past this much unsent data queued on a link the upstreams stop pushing and let
// their buffers hold the backlog (see EngineUpstream.flush). Node would otherwise
// queue without bound. Generous, because a burst is normal right after attach.
const LINK_HIGH_WATER = 1024 * 1024;

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

// A link that has said nothing for this long — not even a ping — is dead,
// whatever TCP thinks: its claims are released so a successor can attach.
const LINK_SILENCE_MS = 90_000;

class AppLink implements FrameSink {
  authed = false;
  readonly reader = new FrameReader();
  readonly claimed = new Set<EngineUpstream>();
  // The first bytes decide whether this is a peer or a health probe.
  sniffed = false;
  // The app process's generation (hello.app.startedAt). Newer wins a contested
  // connection; an older process is refused rather than allowed to steal.
  generation = 0;
  // The Lurker database this app speaks for (hello.instance). Every session the
  // link touches must belong to it.
  instance = '';
  lastSeen = Date.now();

  constructor(
    readonly socket: net.Socket,
    readonly peer: string,
  ) {}

  send(frame: EngineToApp): boolean {
    if (this.socket.destroyed) return false;
    const ok = this.socket.write(encodeFrame(frame));
    return ok && this.socket.writableLength < LINK_HIGH_WATER;
  }

  fail(message: string, id?: string): void {
    this.send({ op: 'error', ...(id ? { id } : {}), message });
  }
}

export class EngineServer {
  private readonly upstreams = new Map<string, EngineUpstream>();
  private readonly links = new Set<AppLink>();
  private readonly budget: ByteBudget;
  private readonly server: net.Server;
  private readonly log: (line: string) => void;
  private readonly secretDigest: Buffer;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: EngineServerOptions) {
    this.budget = new ByteBudget(opts.bufferTotalBytes);
    this.log = opts.log ?? ((line) => console.log(`[engine] ${line}`));
    this.secretDigest = digest(opts.secret);
    this.server = net.createServer({ highWaterMark: LINK_HIGH_WATER }, (socket) =>
      this.accept(socket),
    );
  }

  listen(port: number, host: string): Promise<{ port: number; host: string }> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        const addr = this.server.address() as net.AddressInfo;
        this.sweepTimer = setInterval(() => {
          this.sweepSilentLinks();
          this.reapOrphans();
        }, LINK_SILENCE_MS / 3);
        this.sweepTimer.unref();
        resolve({ port: addr.port, host: addr.address });
      });
    });
  }

  // A session nobody has claimed for orphanMs has no app coming back for it —
  // or the app that did come back was refused (a protocol-major mismatch) and
  // is dialing its own sockets, colliding with this ghost. Say goodbye.
  private reapOrphans(): void {
    const limit = this.opts.orphanMs ?? 0;
    if (limit <= 0) return;
    const cutoff = Date.now() - limit;
    for (const u of this.upstreams.values()) {
      if (u.attached || u.closing || u.state !== 'open') continue;
      const since = u.detachedSince;
      if (since !== null && since < cutoff) {
        this.log(`${u.id}: no app has claimed it for ${limit}ms — ending the session`);
        u.quit('Lurker: no app returned for this connection');
      }
    }
  }

  private sweepSilentLinks(): void {
    const cutoff = Date.now() - LINK_SILENCE_MS;
    for (const link of this.links) {
      if (link.lastSeen < cutoff) {
        this.log(`dropping link ${link.peer}: silent for ${LINK_SILENCE_MS}ms`);
        link.socket.destroy();
      }
    }
  }

  // The sessions a given link may attach to: everything held that no OTHER
  // link currently claims. A session another process owns is not offered —
  // and neither is one this process's own dead predecessor link still claims,
  // deliberately: a `connect` for it takes the claim over (contest) a backoff
  // later, whereas offering it would let reconcile re-adopt a session whose
  // user-issued close is still sitting in the dead link's unread bytes, and
  // turn that Disconnect into a reconnect.
  private heldFor(link: AppLink): string[] {
    return [...this.upstreams.values()]
      .filter((u) => u.opts.instance === link.instance)
      .filter((u) => u.state === 'open' && u.registered && !u.closing)
      .filter((u) => !this.holderOf(u, link))
      .map((u) => u.id);
  }

  // The one other link holding `u`, if any. A claim is exclusive — every path
  // that adds one strips the previous holder first — so there is at most one.
  private holderOf(u: EngineUpstream, except: AppLink): AppLink | undefined {
    for (const l of this.links) if (l !== except && l.claimed.has(u)) return l;
    return undefined;
  }

  // Newest wins — the one rule for an attach and for a close. Another link
  // holding `u` either refuses `link`, because it is a NEWER process and an
  // older one must not take back or end what it lost, or is superseded: its
  // claim is dropped and it is told `detached` (taken-over) — for a close as
  // well as for an attach, since its transport reads `closed` as a network
  // drop and would re-dial the same id through the engine, undoing the close,
  // while `detached` is the path that disposes without reconnecting. Returns
  // the refusing holder, or null when the way is clear; a refusal and a
  // takeover are both logged, an uncontested socket is not.
  //
  // "Not newer" deliberately includes the SAME generation, which is a
  // predecessor link of the same process — the app never keeps two alive, and
  // no two processes share a generation (the app's is its start time with a
  // pid tiebreak, engineLink.ts). That is the case that bites (#849): a
  // Disconnect issued while the link was down is flushed on the replacement
  // link, and under load the engine can read that link's hello and close
  // before it has processed the dead socket's EOF — both are ready in the same
  // poll batch, and the poll does not order them by time. Refusing the close
  // then loses the user's Disconnect for good: the app has already forgotten
  // it, and nobody holds the socket but a link that will be reaped a moment
  // later.
  private contest(link: AppLink, u: EngineUpstream, verb: 'attach' | 'close'): AppLink | null {
    const other = this.holderOf(u, link);
    if (!other) return null;
    if (other.generation > link.generation) {
      this.log(
        `${u.id}: ${verb} from ${link.peer} (gen ${link.generation}) refused; held by newer ${other.peer} (gen ${other.generation})`,
      );
      return other;
    }
    other.claimed.delete(u);
    other.send({ op: 'detached', id: u.id, reason: 'taken-over' });
    this.log(
      `${u.id}: ${verb === 'attach' ? 'taken over by' : 'closed by'} ${link.peer} over ${other.peer}'s claim`,
    );
    return null;
  }

  // The sessions an app can attach to: open, registered, and not on their way
  // out. Anything else in the map is not a session — a dial in progress, or a
  // socket the previous app never finished registering — and advertising it
  // would only make the app adopt something that ends in a fresh dial anyway.
  held(): string[] {
    return [...this.upstreams.values()]
      .filter((u) => u.state === 'open' && u.registered && !u.closing)
      .map((u) => u.id);
  }

  connectionCount(): number {
    return this.upstreams.size;
  }

  // Whether the engine still has a socket (in any state) under this id.
  hasConnection(id: string): boolean {
    return this.upstreams.has(id);
  }

  // Stop accepting, drop every link, and — because the engine going away IS
  // the sockets going away — say goodbye on each upstream. Resolves when every
  // socket has closed or `graceMs` has passed, whichever is first.
  async shutdown(message: string, graceMs = 2000): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.server.close();
    for (const link of this.links) link.socket.destroy();
    this.links.clear();
    const pending = [...this.upstreams.values()];
    const closed = Promise.all(
      pending.map(
        (u) =>
          new Promise<void>((resolve) => {
            if (u.state === 'closed') return resolve();
            u.once('closed', () => resolve());
            u.quit(message);
          }),
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    for (const u of pending) u.destroy();
  }

  private accept(socket: net.Socket): void {
    const link = new AppLink(socket, `${socket.remoteAddress}:${socket.remotePort}`);
    this.links.add(link);
    socket.setEncoding('utf8');
    // Detect a dead peer host (the app can be on another box) rather than hold
    // its connections "attached" to a link that will never ack again.
    socket.setKeepAlive(true, 10_000);
    socket.on('data', (chunk: string) => this.onData(link, chunk));
    socket.on('drain', () => {
      for (const u of link.claimed) u.resume();
    });
    socket.on('error', () => {});
    socket.on('close', () => this.onLinkClose(link));
  }

  private onData(link: AppLink, chunk: string): void {
    link.lastSeen = Date.now();
    if (!link.sniffed) {
      link.sniffed = true;
      // A plain HTTP probe on the same port keeps the health check dependency-
      // free for whoever runs the container. An NDJSON peer's first byte is `{`.
      if (/^(GET|HEAD) /.test(chunk)) {
        const body = JSON.stringify({ ok: true, held: this.upstreams.size });
        link.socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
        return;
      }
    }
    let frames: AppToEngine[];
    try {
      frames = link.reader.push(chunk) as AppToEngine[];
    } catch (err) {
      this.log(`dropping link ${link.peer}: ${(err as Error).message}`);
      link.socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (link.socket.destroyed) return;
      this.dispatch(link, frame);
    }
  }

  private dispatch(link: AppLink, frame: AppToEngine): void {
    if (!link.authed) {
      if (frame.op !== 'hello') {
        link.fail('hello first');
        link.socket.destroy();
        return;
      }
      if (frame.protocol !== PROTOCOL_MAJOR) {
        link.fail(
          `protocol major mismatch: engine speaks ${PROTOCOL_MAJOR}, app speaks ${frame.protocol}`,
        );
        link.socket.destroy();
        return;
      }
      const theirs = digest(typeof frame.secret === 'string' ? frame.secret : '');
      if (!timingSafeEqual(theirs, this.secretDigest)) {
        this.log(`refused link ${link.peer}: bad secret`);
        link.fail('bad secret');
        link.socket.destroy();
        return;
      }
      // Fail CLOSED. An app that sends no instance would otherwise share an id
      // space with every other app on this engine, which is exactly the
      // collision this field exists to prevent.
      if (typeof frame.instance !== 'string' || !frame.instance) {
        this.log(`refused link ${link.peer}: hello without an instance`);
        link.fail('hello needs an instance');
        link.socket.destroy();
        return;
      }
      link.authed = true;
      link.instance = frame.instance;
      link.generation = Number(frame.app?.startedAt) || 0;
      link.send({
        op: 'hello',
        protocol: PROTOCOL_MAJOR,
        minor: PROTOCOL_MINOR,
        engine: { version: this.opts.version },
        held: this.heldFor(link),
      });
      this.log(
        `app ${frame.app?.version ?? '?'} (gen ${link.generation}) attached from ${link.peer}`,
      );
      return;
    }
    switch (frame.op) {
      case 'hello':
        return; // already authed; ignore a repeat
      case 'ping':
        return void link.send({ op: 'pong' });
      case 'pong':
        return;
      case 'connect':
        return this.connect(link, frame);
      case 'list':
        return void link.send({
          op: 'listing',
          connections: [...this.upstreams.values()].map((u) => u.info()),
        });
      case 'write':
      case 'ack':
      case 'detach':
      case 'close': {
        const u = this.upstreams.get(frame.id);
        if (!u) return link.fail('unknown connection', frame.id);
        // Another instance's session is not this app's to read, write, end or
        // adopt. Said plainly rather than hidden behind 'unknown connection':
        // anyone who gets this far already holds the engine secret, so there is
        // no attacker to withhold it from — while the case that actually
        // produces it is two Lurker instances misconfigured onto one engine,
        // and that operator needs to be told exactly what is wrong.
        if (u.opts.instance !== link.instance) {
          return link.fail('connection id belongs to another instance', frame.id);
        }
        // Only the link that holds the claim may drive the socket: a process
        // that was taken over is on its way out and must not get a line onto a
        // connection it no longer owns. Two exceptions. An `ack` from anyone is
        // welcome — it only says "persisted", and the process that was just taken
        // over is exactly the one whose in-flight acks decide whether its
        // successor sees those lines a second time. And a `close` follows the
        // attach rule instead (contest): ending an orphan nobody claims is what
        // reconciling after a restart is, and ending one a superseded link still
        // claims is #849.
        if (!link.claimed.has(u) && frame.op !== 'ack') {
          if (frame.op !== 'close') {
            return link.fail('not attached to this connection', frame.id);
          }
          if (this.contest(link, u, 'close')) {
            return link.fail('not attached to this connection', frame.id);
          }
          // Nothing from the closing socket reaches a link that was just told
          // it no longer holds it.
          u.silence();
        }
        if (frame.op === 'write') u.write(frame.line);
        else if (frame.op === 'ack') u.ack(frame.seq);
        else if (frame.op === 'detach') this.release(link, u);
        else u.close();
        return;
      }
      default:
        return link.fail(`unknown op ${(frame as { op: string }).op}`);
    }
  }

  private connect(link: AppLink, frame: Extract<AppToEngine, { op: 'connect' }>): void {
    const { id } = frame;
    if (typeof id !== 'string' || !id || typeof frame.host !== 'string' || !frame.host) {
      return link.fail('connect needs an id and a host', id);
    }
    // Node throws SYNCHRONOUSLY from net.connect for a bad port or a bind
    // address that isn't an IP — and an uncaught throw here is the whole engine,
    // every held socket with it. Refuse those frames instead.
    const port = Number(frame.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return link.fail(`connect: invalid port ${String(frame.port)}`, id);
    }
    if (
      frame.outgoingAddr !== undefined &&
      frame.outgoingAddr !== '' &&
      !net.isIP(frame.outgoingAddr)
    ) {
      return link.fail(
        `connect: outgoingAddr must be an IP address (got ${String(frame.outgoingAddr)})`,
        id,
      );
    }
    // Validated HERE, before any upstream exists: tls.connect throws
    // SYNCHRONOUSLY on a key it can't parse or one that doesn't match its
    // certificate, and an uncaught throw in this process takes every held
    // socket with it. The app validates too, but the app is not the only thing
    // that can put a certificate in a database (archive import writes the
    // columns verbatim), and an engine does not get to trust its callers.
    if (frame.clientCert !== undefined) {
      const { cert, key } = frame.clientCert ?? {};
      if (typeof cert !== 'string' || typeof key !== 'string' || !cert || !key) {
        return link.fail('connect: clientCert needs both a cert and a key', id);
      }
      if (!isDialableCertPair(cert, key)) {
        // Deliberately says nothing about the key itself — not its length, not
        // where parsing stopped. The engine logs this line.
        return link.fail('connect: clientCert is not a usable certificate/key pair', id);
      }
    }
    let u = this.upstreams.get(id);
    // Belt and braces over the `<instance>:…` id prefix. If a session under this
    // id belongs to someone else's database, this app does not get to attach to
    // it, take it over, or close it out of the way and dial its own in its
    // place — any of which would put one person's socket behind another
    // person's session. Refuse, loudly, and leave the held socket alone.
    if (u && u.opts.instance !== link.instance) {
      this.log(`${id}: refused ${link.peer} — held for another instance`);
      return link.fail('connection id belongs to another instance', id);
    }
    if (u && (u.closing || u.state === 'closed')) {
      // A socket on its way out (the app asked to close it and the FIN hasn't
      // round-tripped) is not one to attach to: this CONNECT is the app coming
      // back, and it gets a fresh dial. The old one finishes dying on its own —
      // and quietly, so its `closed` never reaches a link that has moved on.
      for (const l of this.links) l.claimed.delete(u);
      u.silence();
      u = undefined;
    }
    if (
      u &&
      !u.matchesDial({
        host: frame.host,
        port,
        tls: !!frame.tls,
        outgoingAddr: frame.outgoingAddr,
        clientCert: frame.clientCert,
      })
    ) {
      // Same id, different destination: the user edited the network. That is a
      // new session, not this one under new settings.
      this.log(`${id}: connect parameters changed — closing the held socket and dialing afresh`);
      for (const l of this.links) l.claimed.delete(u);
      u.silence();
      u.close();
      u = undefined;
    }
    let payload: ReturnType<EngineUpstream['attach']> | null = null;
    if (u) {
      // Someone else's? Take it over — unless that someone is a NEWER process,
      // in which case this is an older one trying to steal back what it lost.
      if (this.contest(link, u, 'attach')) {
        link.send({ op: 'detached', id, reason: 'taken-over' });
        return;
      }
      link.claimed.add(u);
      payload = u.attach(link);
      if (payload === 'dialing') {
        // Still dialing: this link simply inherits the `open` when it comes.
        link.send({ op: 'dialing', id });
        return;
      }
      if (payload === 'unregistered') {
        // The previous app died before registration finished. There is no
        // session to hand over — but nothing went wrong on the network either,
        // so this is a fresh dial under the same id, not an error: the old
        // socket dies quietly and the app sees `dialing` → `open` as usual.
        this.log(`${id}: attach before registration completed — dialing afresh`);
        link.claimed.delete(u);
        u.silence();
        u.close();
        u = undefined;
        payload = null;
      }
    }
    if (u && payload && typeof payload === 'object') {
      const attached = encodeFrame({ op: 'attached', id, ...payload });
      if (attached.length > MAX_FRAME_BYTES) {
        // Can't happen within the burst cap short of thousands of channels, but
        // a frame the app's reader would refuse must never leave here: it would
        // drop the link, and the reconnect would fetch the same frame again.
        this.log(`${id}: replay too large (${attached.length} bytes) — closing so the app redials`);
        link.claimed.delete(u);
        u.silence();
        u.close();
        link.send({ op: 'closed', id, error: 'replay too large to hand over' });
        return;
      }
      link.socket.write(attached);
      u.flushAfterAttach();
      this.log(
        `${id}: attached (replay ${payload.replay.length}, pending ${u.buffer.length}, away ${payload.detachedForMs}ms, nick ${payload.nick ?? '?'})`,
      );
      return;
    }
    u = new EngineUpstream(
      {
        id,
        instance: link.instance,
        host: frame.host,
        port,
        tls: !!frame.tls,
        rejectUnauthorized: frame.rejectUnauthorized !== false,
        outgoingAddr: frame.outgoingAddr || undefined,
        ident: frame.ident || undefined,
        clientCert: frame.clientCert,
        dialTimeoutMs: this.opts.dialTimeoutMs,
      },
      this.opts.bufferBytes,
      this.budget,
    );
    this.upstreams.set(id, u);
    link.claimed.add(u);
    u.on('open', (local, remote) => {
      this.log(`${id}: open ${local.address}:${local.port} -> ${remote.address}:${remote.port}`);
    });
    const created = u;
    u.on('closed', (error?: string) => {
      this.log(`${id}: closed${error ? ` (${error})` : ''}`);
      // Only if the id still means this socket — a fresh dial may have taken
      // the key while this one was closing.
      if (this.upstreams.get(id) === created) this.upstreams.delete(id);
      for (const l of this.links) l.claimed.delete(created);
    });
    u.attach(link);
    link.send({ op: 'dialing', id });
    this.log(`${id}: dialing ${frame.host}:${port}${frame.tls ? ' (TLS)' : ''}`);
    try {
      u.dial();
    } catch (err) {
      // Belt and braces for whatever Node decides to throw on top of the
      // validation above; report it as a failed dial, not a dead engine.
      this.log(`${id}: dial threw: ${(err as Error).message}`);
      this.upstreams.delete(id);
      link.claimed.delete(created);
      link.send({ op: 'closed', id, error: (err as Error).message });
    }
  }

  private release(link: AppLink, u: EngineUpstream): void {
    if (!link.claimed.delete(u)) return;
    u.detach();
    this.log(`${u.id}: detached by ${link.peer} (pending ${u.buffer.length})`);
  }

  private onLinkClose(link: AppLink): void {
    if (!this.links.delete(link)) return;
    for (const u of link.claimed) {
      u.detach();
      this.log(`${u.id}: link ${link.peer} lost — holding (pending ${u.buffer.length})`);
    }
    link.claimed.clear();
  }
}
