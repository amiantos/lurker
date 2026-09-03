// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// One held IRC socket. The engine's whole reason to exist is that this object
// outlives the app process that asked for it.
//
// It understands exactly six IRC things, and nothing else:
//   1. PING       — answered here, always, never forwarded. A detached (or
//                   stalled) app can't ping out because the app isn't in the loop.
//   2. 001        — our nick, as the server confirmed it.
//   3. 376 / 422  — the end of the registration burst we record for replay.
//   4. own NICK   — so a replay lands on the live nick.
//   5. own JOIN / PART / KICK — the channel set a replay must re-enter.
//   6. own CHGHOST — the hostmask the synthesised JOINs carry.
// Every other line is bytes: numbered, buffered until acked, relayed.
//
// Re-attach is a replay: the recorded burst (verbatim — irc-framework walks it
// exactly as it walked the real one), then ONE synthesised NICK if the nick has
// changed since the burst ended, then one synthesised JOIN per channel we are
// in. The app's fresh Client ends up registered, on the right nick, with the
// right caps and ISUPPORT, in the right channels, without the server having seen
// a single extra command. The NICK goes BEFORE the JOINs on purpose: the app's
// nick handler fans a per-channel "now known as" row out to every channel it
// knows, and at that point it knows none.
//
// The replay is built from tracked STATE, not from history, so it stays bounded
// no matter how long the socket has lived: the burst is capped in bytes, the
// nick is one line, and the channel set is what we are in NOW (own JOIN/PART/
// KICK lines are deliberately not recorded into the burst, so a channel joined
// during registration and left later is not replayed as joined).

import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { ircLineParser } from 'irc-framework';
import { LineBuffer } from './lineBuffer.js';
import type { ByteBudget } from './lineBuffer.js';
import type { ConnectionInfo, Endpoint, EngineToApp } from './protocol.js';
import {
  registerIdent,
  unregisterIdent,
  isIdentdEnabled,
  isOidentdFileEnabled,
} from '../services/identd.js';

export interface UpstreamOptions {
  id: string;
  // The app instance (Lurker database) this session belongs to. The id already
  // carries it, but the engine checks this field on every operation rather than
  // trusting the string: an app that minted a colliding id still cannot reach
  // another instance's socket.
  instance: string;
  host: string;
  port: number;
  tls: boolean;
  rejectUnauthorized: boolean;
  outgoingAddr?: string;
  ident?: string;
  // CertFP (#459): the client certificate to present on the TLS handshake. The
  // caller has already checked that the pair parses and matches — tls.connect
  // throws synchronously on a malformed key, and this dial runs inside the
  // process holding every other session.
  clientCert?: { cert: string; key: string };
  // How long a dial (TCP + TLS handshake) may take before it is given up on.
  dialTimeoutMs?: number;
}

// Where frames for the attached app go. `send` answers false when the link is
// over its high-water mark; the upstream then stops pushing and waits for
// `resume()` — the buffer, not the socket's write queue, holds the backlog.
export interface FrameSink {
  send(frame: EngineToApp): boolean;
}

export interface AttachedPayload {
  local: Endpoint;
  remote: Endpoint;
  replay: string[];
  nick: string | null;
  channels: string[];
  detachedForMs: number;
  unattended: boolean;
}

// IRCv3 caps a line at 8191 bytes including tags. This guard is deliberately
// double that: the engine relays bytes rather than policing them, and a server
// a little over the line is the app's problem to parse, not the engine's to
// disconnect over. What it exists to stop is a peer that is not an IRC server
// at all streaming an unbounded "line" into the buffer. Well under the 256 KiB
// frame cap (MAX_FRAME_BYTES), so anything relayed here fits on the wire.
const MAX_IRC_LINE = 16 * 1024;

// The recorded registration burst stops growing here. Registration itself
// (CAP, 001–005) is a few KiB; what pads a burst is a long MOTD, which a replay
// does not need — irc-framework is registered at 001. A server that never sends
// 376/422 would otherwise grow the burst forever.
export const MAX_BURST_BYTES = 64 * 1024;

// A dial that neither connects nor fails — a tarpit, a middlebox eating the
// ClientHello, a wedged TLS listener — must end, or the network sits on
// "Connecting…" until the engine restarts. irc-framework's own transport uses
// 150 s; a minute is generous for a handshake.
export const DEFAULT_DIAL_TIMEOUT_MS = 60_000;

// After QUIT + FIN, how long to wait for the peer's FIN before destroying the
// socket ourselves. A peer that ignores half-close would otherwise leave a
// 'closing' zombie holding an fd, an ident entry, and its budget bytes forever.
export const CLOSE_GRACE_MS = 10_000;

const FALLBACK_USERHOST = '~lurker@engine.invalid';

function prefixNick(prefix: string | undefined): string {
  if (!prefix) return '';
  const bang = prefix.indexOf('!');
  return bang >= 0 ? prefix.slice(0, bang) : prefix;
}

export class EngineUpstream extends EventEmitter {
  readonly id: string;
  state: 'dialing' | 'open' | 'closed' = 'dialing';
  // `close()`/`quit()` were called: the socket is on its way out. Not a state
  // of its own because `open`-specific bookkeeping still applies until 'close'
  // fires, but every entry point treats it as gone.
  closing = false;
  local: Endpoint | null = null;
  remote: Endpoint | null = null;
  readonly buffer: LineBuffer;
  nick: string | null = null;
  pingsAnsweredDetached = 0;

  private socket: net.Socket | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private inbuf = '';
  private lastError: string | null = null;
  private identdId: number | null = null;
  private burst: string[] = [];
  private burstBytes = 0;
  // Latched once a line didn't fit, so the burst is a contiguous prefix.
  private burstFull = false;
  private burstDone = false;
  // The seq of the last burst line; a replay covers everything up to it.
  private burstEndSeq = 0;
  // Registration finished with no app attached (see AttachedPayload.unattended).
  private registeredUnattended = false;
  private nickAtBurstEnd: string | null = null;
  private hostmask: string | null = null;
  // folded name → name as the server spelled it on JOIN
  private channels = new Map<string, string>();

  private sink: FrameSink | null = null;
  // The app asked for this close. Its transport ends its own side the moment
  // it asks (engineTransport.close()), so the eventual `closed` has nobody to
  // go to — and MUST not go anywhere: on a fast loopback the FIN can round-trip
  // between a `close` and the `connect` that reuses the id, and a `closed`
  // routed by id would then hit the successor. Engine-initiated deaths (the
  // server dropped us, a dial failed) are still reported.
  private quietClose = false;
  private stalled = false;
  // Highest seq written to the current sink; everything pending above it is
  // still owed.
  private sentSeq = 0;
  // `live` is owed once the backlog that existed at attach time has been sent.
  private liveAfterSeq: number | null = null;
  private detachedAt: number | null = null;

  constructor(
    readonly opts: UpstreamOptions,
    bufferBytes: number,
    budget: ByteBudget,
  ) {
    super();
    this.id = opts.id;
    this.buffer = new LineBuffer(bufferBytes, budget);
  }

  get attached(): boolean {
    return this.sink !== null;
  }

  get registered(): boolean {
    return this.burstDone;
  }

  // When the last link let go of this socket (null while attached).
  get detachedSince(): number | null {
    return this.detachedAt;
  }

  // Is this the same session a CONNECT with these parameters would open? A
  // changed host/port/TLS/source address means the user edited the network and
  // wants a fresh dial, not the old socket under new settings.
  matchesDial(frame: {
    host: string;
    port: number;
    tls: boolean;
    outgoingAddr?: string;
    clientCert?: { cert: string; key: string };
  }): boolean {
    return (
      this.opts.host === frame.host &&
      this.opts.port === frame.port &&
      this.opts.tls === !!frame.tls &&
      (this.opts.outgoingAddr || '') === (frame.outgoingAddr || '') &&
      // A changed client certificate is a changed IDENTITY: this socket is
      // still presenting the old one, and services still know the user by the
      // old fingerprint. Re-attaching would make the new certificate look
      // applied while nothing about the connection had changed. (#459)
      (this.opts.clientCert?.cert || '') === (frame.clientCert?.cert || '')
    );
  }

  // May throw synchronously (Node validates the port and the bind address
  // before it ever touches the network); the caller owns that.
  dial(): void {
    const { host, port, outgoingAddr, rejectUnauthorized, clientCert } = this.opts;
    const onConnect = () => this.onOpen();
    const base = {
      host,
      port,
      localAddress: outgoingAddr || undefined,
      // A bound source address fixes the family, or a dual-stack host whose
      // lookup answers the other family first fails with `bind EINVAL` — the
      // same pairing irc-framework's transport makes.
      family: outgoingAddr ? net.isIP(outgoingAddr) || undefined : undefined,
    };
    const socket = this.opts.tls
      ? tls.connect(
          {
            ...base,
            // SNI only for a name — an IP literal is not a valid server name.
            servername: net.isIP(host) ? undefined : host,
            rejectUnauthorized,
            key: clientCert?.key,
            cert: clientCert?.cert,
          },
          onConnect,
        )
      : net.connect(base, onConnect);
    this.socket = socket;
    // utf8 with a StringDecoder underneath, so a multibyte character split across
    // chunks reassembles correctly. Lurker never negotiates another encoding.
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 60_000);
    // identd is answered the instant the ircd accepts our TCP connection —
    // concurrently with the TLS handshake — so the 4-tuple must be registered on
    // the raw 'connect', not on secureConnect. Same race the app path fixed.
    socket.once('connect', () => this.onTcpConnect(socket));
    socket.setTimeout(this.opts.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS);
    socket.on('timeout', () => {
      if (this.state === 'dialing') this.dropPeer('dial timed out');
    });
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err: Error) => {
      this.lastError = err.message;
    });
    socket.on('close', () => this.onClose());
  }

  // TCP is up (before any TLS handshake): the 4-tuple exists, so identd can be
  // registered — this is the only place it can be, the app never sees the socket.
  private onTcpConnect(s: net.Socket): void {
    if (this.closing) return;
    this.local = { address: s.localAddress || '', port: s.localPort || 0 };
    this.remote = { address: s.remoteAddress || '', port: s.remotePort || 0 };
    if (
      this.opts.ident &&
      this.identdId === null &&
      (isIdentdEnabled() || isOidentdFileEnabled())
    ) {
      this.identdId = registerIdent({
        localAddress: this.local.address,
        localPort: this.local.port,
        remoteAddress: this.remote.address,
        remotePort: this.remote.port,
        ident: this.opts.ident,
      });
    }
  }

  private onOpen(): void {
    const s = this.socket;
    if (!s || this.closing) return;
    this.state = 'open';
    s.setTimeout(0);
    // Normally set on the raw 'connect' already; the fallback is for a socket
    // whose 'connect' we somehow missed (it costs nothing to be sure).
    if (!this.local || !this.remote) this.onTcpConnect(s);
    const local = this.local ?? { address: s.localAddress || '', port: s.localPort || 0 };
    const remote = this.remote ?? { address: s.remoteAddress || '', port: s.remotePort || 0 };
    this.local = local;
    this.remote = remote;
    this.emit('open', local, remote);
    this.sink?.send({ op: 'open', id: this.id, local, remote });
  }

  private onData(chunk: string): void {
    this.inbuf += chunk;
    let nl: number;
    while ((nl = this.inbuf.indexOf('\n')) >= 0) {
      const line = this.inbuf.slice(0, nl).replace(/\r$/, '');
      this.inbuf = this.inbuf.slice(nl + 1);
      if (line.length > MAX_IRC_LINE) return this.dropPeer('peer sent an over-long line');
      if (line) this.onLine(line);
    }
    if (this.inbuf.length > MAX_IRC_LINE) this.dropPeer('peer sent an over-long line');
  }

  private dropPeer(why: string): void {
    this.lastError = why;
    this.socket?.destroy();
  }

  private onLine(line: string): void {
    const msg = ircLineParser(line);
    if (!msg) return;
    const command = String(msg.command || '').toUpperCase();
    if (command === 'PING') {
      const token = msg.params[msg.params.length - 1];
      this.rawWrite(token === undefined ? 'PONG' : `PONG :${token}`);
      if (!this.sink) this.pingsAnsweredDetached++;
      return;
    }
    if (command === '001') this.nick = msg.params[0] || null;
    // Own state is tracked from the first line on — a NICK forced on us between
    // 001 and 376, or a server that JOINs us to a channel during registration,
    // must not be missed just because the burst is still open.
    const ownState = this.nick ? this.track(command, msg.prefix, msg.params) : false;
    if (!this.burstDone) {
      // Own channel movement is state, replayed from the channel set; recording
      // the line too would replay a JOIN the tracked set may since have undone.
      if (!ownState) this.recordBurst(line, command === '376' || command === '422');
      if (command === '376' || command === '422') {
        this.burstDone = true;
        this.nickAtBurstEnd = this.nick;
        this.registeredUnattended = this.sink === null;
      }
    }
    const seq = this.buffer.push(line);
    if (this.burstDone && this.burstEndSeq === 0) this.burstEndSeq = seq;
    this.flush();
  }

  // The cap LATCHES. Testing each line against the remaining headroom on its
  // own would keep taking short lines after a long one was skipped, and the
  // replay would be a subset of the registration with holes punched in it
  // rather than a prefix of it. A truncated burst is a thing irc-framework can
  // walk; a burst missing its middle is not.
  //
  // `force` is the single exception, for the line that ends the burst. Dropping
  // that would replay a MOTD that starts and never finishes — irc-framework
  // emits 'motd' only on 376/422, and that event is the one thing that renders
  // the block, since 372/375/376 are on the app's numeric denylist. It is one
  // short line, and it is what makes the truncation well-formed.
  private recordBurst(line: string, force = false): void {
    const bytes = Buffer.byteLength(line, 'utf8') + 2;
    if (this.burstFull || this.burstBytes + bytes > MAX_BURST_BYTES) {
      this.burstFull = true;
      if (!force) return;
    }
    this.burst.push(line);
    this.burstBytes += bytes;
  }

  private isSelf(nick: string): boolean {
    return !!this.nick && nick.toLowerCase() === this.nick.toLowerCase();
  }

  // Apply an own-state line. Returns true when the line was own channel
  // movement (JOIN/PART/KICK of us), which the burst must not record.
  private track(command: string, prefix: string | undefined, params: string[]): boolean {
    const from = prefixNick(prefix);
    if (command === 'NICK' && this.isSelf(from)) {
      this.nick = params[0] || this.nick;
      this.noteHostmask(prefix);
      return false;
    }
    if (command === 'JOIN' && this.isSelf(from)) {
      const chan = params[0] || '';
      if (chan) this.channels.set(chan.toLowerCase(), chan);
      this.noteHostmask(prefix);
      return true;
    }
    if (command === 'PART' && this.isSelf(from)) {
      this.channels.delete((params[0] || '').toLowerCase());
      return true;
    }
    if (command === 'KICK' && this.isSelf(params[1] || '')) {
      this.channels.delete((params[0] || '').toLowerCase());
      return true;
    }
    if (command === 'CHGHOST' && this.isSelf(from)) {
      if (params[0] && params[1]) this.hostmask = `${params[0]}@${params[1]}`;
    }
    return false;
  }

  // Own user@host, learned from any line the server prefixes with our full
  // mask (JOIN, NICK) and kept current by CHGHOST. The nick half is whatever
  // the nick is now.
  private noteHostmask(prefix: string | undefined): void {
    if (!prefix) return;
    const bang = prefix.indexOf('!');
    if (bang >= 0) this.hostmask = prefix.slice(bang + 1);
  }

  private rawWrite(line: string): void {
    if (this.state === 'open' && !this.closing) this.socket?.write(line + '\r\n');
  }

  write(line: string): void {
    this.rawWrite(line);
  }

  // Send the unacked backlog to the current sink, in order, stopping when the
  // sink is over its high-water mark. Called on every new line, on attach, and
  // on drain.
  private flush(): void {
    const sink = this.sink;
    if (!sink || this.stalled) return;
    // A hole is only news to a sink that has not already been sent the lines
    // that fell into it. One that has (it was attached, and simply hasn't acked
    // yet) keeps them in hand; the gap stays recorded for whoever attaches
    // next — and is forgotten if this sink acks past it (LineBuffer.ack).
    const gap = this.buffer.peekGap();
    if (gap && gap.lastDroppedSeq > this.sentSeq) {
      // Taken BEFORE looking at the backpressure answer: `send` has queued the
      // frame either way, and a stalled sink must not be told twice.
      this.buffer.takeGap();
      if (!sink.send({ op: 'gap', id: this.id, gap })) {
        this.stalled = true;
        return;
      }
    }
    // Seqs are contiguous and only ever trimmed from the front, so the first
    // owed line is at a computable index — no rescan of everything already sent.
    const pending = this.buffer.pending();
    const first =
      pending.length && this.sentSeq >= pending[0].seq ? this.sentSeq - pending[0].seq + 1 : 0;
    for (let i = first; i < pending.length; i++) {
      const b = pending[i];
      this.sentSeq = b.seq;
      const ok = sink.send({ op: 'line', id: this.id, seq: b.seq, line: b.line });
      if (this.liveAfterSeq !== null && b.seq >= this.liveAfterSeq) this.sendLive();
      if (!ok) {
        this.stalled = true;
        return;
      }
    }
    if (this.liveAfterSeq !== null) this.sendLive();
  }

  private sendLive(): void {
    this.liveAfterSeq = null;
    this.sink?.send({ op: 'live', id: this.id });
  }

  resume(): void {
    this.stalled = false;
    this.flush();
  }

  ack(seq: number): void {
    this.buffer.ack(seq);
  }

  // Claim this socket for a sink. While still dialing there is nothing to replay:
  // the sink simply becomes the one that hears `open`. Once open and registered,
  // the caller sends the returned payload, then this flushes the backlog and
  // `live`. 'unregistered' means the previous app died mid-registration; there
  // is no session to hand over, so the caller should end the socket and let the
  // app dial afresh.
  attach(sink: FrameSink): AttachedPayload | 'dialing' | 'unregistered' {
    this.sink = sink;
    this.stalled = false;
    const detachedForMs = this.detachedAt === null ? 0 : Date.now() - this.detachedAt;
    this.detachedAt = null;
    if (this.state !== 'open' || !this.local || !this.remote) {
      this.sentSeq = 0;
      return 'dialing';
    }
    if (!this.burstDone) return 'unregistered';
    // The replay IS the delivery of the burst: the fresh Client walks it and
    // registers. Sending those lines again as backlog would register it twice.
    this.buffer.ack(this.burstEndSeq);
    this.sentSeq = this.burstEndSeq;
    // `live` is owed after the last line that exists right now — or immediately
    // when there is nothing pending.
    const pending = this.buffer.pending();
    this.liveAfterSeq = pending.length ? pending[pending.length - 1].seq : 0;
    return {
      local: this.local,
      remote: this.remote,
      replay: this.replaySet(),
      nick: this.nick,
      channels: [...this.channels.values()],
      detachedForMs,
      unattended: this.registeredUnattended,
    };
  }

  // Called by the server right after it has sent the `attached` frame.
  flushAfterAttach(): void {
    if (this.liveAfterSeq === 0) this.sendLive();
    this.flush();
  }

  detach(): void {
    if (!this.sink) return;
    this.sink = null;
    this.stalled = false;
    this.liveAfterSeq = null;
    this.detachedAt = Date.now();
  }

  // Nobody hears from this socket again — used when a fresh dial takes over its
  // id. In particular the `closed` it will eventually produce must not reach a
  // link that has moved on to the new socket under the same id.
  silence(): void {
    this.detach();
    this.quietClose = true;
  }

  replaySet(): string[] {
    const out = [...this.burst];
    if (!this.nick) return out;
    const userhost = this.hostmask || FALLBACK_USERHOST;
    if (this.nickAtBurstEnd && this.nickAtBurstEnd !== this.nick) {
      out.push(`:${this.nickAtBurstEnd}!${userhost} NICK :${this.nick}`);
    }
    for (const chan of this.channels.values()) out.push(`:${this.nick}!${userhost} JOIN ${chan}`);
    return out;
  }

  // End the socket. The app asked (a QUIT went out first, or a user disconnected).
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.quietClose = true;
    // Still dialing: end() would let the connect (and a TLS handshake) complete
    // and only then FIN — a wasted registration attempt against the ircd's
    // per-IP throttle, an ident entry for a socket nobody wanted, and an `open`
    // the app has already given up on. Cut it off.
    if (this.state !== 'open') return this.destroy();
    this.socket?.end();
    this.closeTimer = setTimeout(() => this.socket?.destroy(), CLOSE_GRACE_MS);
    this.closeTimer.unref();
  }

  // Engine shutdown: say goodbye properly, then end. The server bounds the wait.
  quit(message: string): void {
    this.rawWrite(`QUIT :${message}`);
    this.close();
  }

  destroy(): void {
    this.closing = true;
    this.socket?.destroy();
  }

  private onClose(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    unregisterIdent(this.identdId);
    this.identdId = null;
    this.buffer.dispose();
    const error = this.lastError ?? undefined;
    if (!this.quietClose) {
      this.sink?.send({ op: 'closed', id: this.id, ...(error ? { error } : {}) });
    }
    this.sink = null;
    this.emit('closed', error);
  }

  info(): ConnectionInfo {
    return {
      id: this.id,
      state: this.closing ? 'closing' : this.state === 'closed' ? 'closing' : this.state,
      attached: this.attached,
      nick: this.nick,
      channelCount: this.channels.size,
      bufferedLines: this.buffer.length,
      bufferedBytes: this.buffer.bytes,
      detachedForMs: this.detachedAt === null ? null : Date.now() - this.detachedAt,
    };
  }
}
