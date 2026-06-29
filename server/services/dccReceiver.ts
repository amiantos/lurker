// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The active-DCC receive engine (#270, phase 1): one TCP socket → one file on
// disk. The cell has a public IP, so for a standard XDCC bot we dial out to the
// address/port in its DCC SEND offer (the common case) and stream the bytes to
// destPath, sending the DCC 4-byte cumulative ACK back so ACK-gated senders keep
// going. Deliberately IRC-free and DB-free: the caller (ircConnection) owns the
// dcc_transfers row and throttles its writes — this just moves bytes and reports
// progress via callbacks. Passive/reverse DCC (we listen) and RESUME come later.
//
// References for the wire details (see ~/Coding/irc-clients): irssi
// src/irc/dcc/dcc-get.c and WeeChat src/plugins/xfer/xfer-dcc.c — the 4-byte
// big-endian ACK (wrapping past 4 GiB) and "done when received >= advertised
// size" completion rule.

import fs from 'fs';
import net from 'net';

export interface DccReceiveOptions {
  /** Decoded host from the offer (dotted-quad IPv4 or IPv6 literal). */
  host: string;
  port: number;
  /** Advertised total size in bytes; 0 means unknown (finish on clean close). */
  size: number;
  /** Absolute path to write to (already resolved + de-collided by the caller). */
  destPath: string;
  /** Bytes already on disk to resume from (phase 3); 0 starts fresh. */
  startOffset?: number;
  /** Abort if the socket is idle this long (also bounds the initial connect). */
  idleTimeoutMs?: number;
  /** Per-chunk progress (cumulative bytes). The caller throttles DB/UI writes. */
  onProgress?: (received: number) => void;
  /** Transfer completed (received >= size, or a clean close when size unknown). */
  onDone?: (received: number) => void;
  /** Transfer failed (connect/socket error, timeout, or early close). */
  onError?: (err: Error) => void;
}

export class DccReceiver {
  private socket: net.Socket | null = null;
  private out: fs.WriteStream | null = null;
  private received: number;
  private settled = false;

  constructor(private readonly opts: DccReceiveOptions) {
    this.received = opts.startOffset ?? 0;
  }

  get bytesReceived(): number {
    return this.received;
  }

  start(): void {
    const { host, port, destPath, startOffset = 0, idleTimeoutMs = 60_000 } = this.opts;
    // Resume appends; a fresh transfer truncates any stale partial.
    this.out = fs.createWriteStream(destPath, { flags: startOffset > 0 ? 'a' : 'w' });
    this.out.on('error', (e) => this.settle(e));

    const sock = net.connect({ host, port });
    this.socket = sock;
    sock.setTimeout(idleTimeoutMs);
    // We never setEncoding, so chunk is always a Buffer at runtime; the event
    // type is widened to string|Buffer, so coerce defensively.
    sock.on('data', (chunk) => this.onData(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    sock.on('timeout', () => this.settle(new Error('DCC transfer timed out')));
    sock.on('error', (e) => this.settle(e));
    sock.on('close', () => {
      if (this.settled) return;
      const complete = this.opts.size > 0 ? this.received >= this.opts.size : this.received > 0;
      this.settle(complete ? null : new Error('connection closed before the transfer completed'));
    });
  }

  /** Cancel an in-flight transfer; surfaces as an error to the caller. */
  cancel(): void {
    this.settle(new Error('cancelled'));
  }

  private onData(chunk: Buffer): void {
    if (this.settled || !this.out || !this.socket) return;
    this.received += chunk.length;

    // Backpressure: pause the socket whenever the disk falls behind.
    if (!this.out.write(chunk)) {
      this.socket.pause();
      this.out.once('drain', () => this.socket?.resume());
    }

    // DCC ACK: cumulative bytes received, 4-byte big-endian, wrapping past 4 GiB
    // (matches irssi/WeeChat — ACK-gated senders won't advance without it).
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(this.received % 0x1_0000_0000, 0);
    this.socket.write(ack);

    this.opts.onProgress?.(this.received);
    if (this.opts.size > 0 && this.received >= this.opts.size) this.settle(null);
  }

  private settle(err: Error | null): void {
    if (this.settled) return;
    this.settled = true;
    try {
      this.socket?.destroy();
    } catch {
      // socket already gone
    }
    const finish = () => {
      if (err) this.opts.onError?.(err);
      else this.opts.onDone?.(this.received);
    };
    // Flush + close the file before declaring done, so the bytes are durable.
    if (this.out) this.out.end(finish);
    else finish();
  }
}
