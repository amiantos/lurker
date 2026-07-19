// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The DCC SEND *out* engine (#270 phase 2): one file on disk → one already-
// connected TCP socket. The mirror image of dccReceiver — the caller hands us a
// live socket (from a listener we opened for an active offer, or a dial-out for a
// passive/reverse offer) plus the file path + size, and we stream the bytes with
// backpressure, tracking the receiver's 4-byte cumulative ACKs so progress
// reflects what the peer has actually confirmed, not just what we've queued.
// Deliberately IRC-free and DB-free: the caller owns the dcc_transfers row and
// the CTCP handshake; this just moves bytes and reports via callbacks, and never
// throws out of an async boundary.

import fs from 'fs';
import net from 'net';

export interface DccSendOptions {
  /** A socket that is ALREADY connected to the receiver. */
  socket: net.Socket;
  /** Absolute path to the file being sent. */
  filePath: string;
  /** Total file size in bytes (the receiver expects exactly this many). */
  size: number;
  /** Byte offset to start from — for a resume the receiver asked for; 0 = whole file. */
  startOffset?: number;
  /** Abort if the socket makes no progress this long. */
  idleTimeoutMs?: number;
  /** Cumulative bytes the receiver has ACKed (or bytes written when a receiver
   *  never ACKs — see onData). The caller throttles DB/UI writes. */
  onProgress?: (confirmed: number) => void;
  /** All bytes sent and the socket flushed. `acked` is the final ACK we saw. */
  onDone?: (sent: number) => void;
  /** Failed (socket error, timeout, receiver closed early, file read error). */
  onError?: (err: Error, sent: number) => void;
}

export class DccSender {
  private readonly socket: net.Socket;
  private stream: fs.ReadStream | null = null;
  private sent: number;
  private acked = 0;
  private finishedReading = false;
  private settled = false;

  constructor(private readonly opts: DccSendOptions) {
    this.socket = opts.socket;
    this.sent = opts.startOffset ?? 0;
    this.acked = opts.startOffset ?? 0;
  }

  get bytesSent(): number {
    return this.sent;
  }

  start(): void {
    const { filePath, startOffset = 0, idleTimeoutMs = 120_000 } = this.opts;
    const sock = this.socket;
    sock.setTimeout(idleTimeoutMs);

    // Empty / already-complete file: nothing to stream, just close cleanly.
    if (this.opts.size <= startOffset) {
      this.finishedReading = true;
      this.settle(null);
      return;
    }

    this.stream = fs.createReadStream(filePath, { start: startOffset });
    this.stream.on('error', (e) => this.settle(e));

    this.stream.on('data', (chunk) => {
      if (this.settled) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      this.sent += buf.length;
      // Backpressure: pause the file read while the socket buffer drains, and
      // disable the idle timeout meanwhile (no writes flowing is expected).
      if (!sock.write(buf)) {
        this.stream?.pause();
        sock.setTimeout(0);
        sock.once('drain', () => {
          if (this.settled) return;
          sock.setTimeout(idleTimeoutMs);
          this.stream?.resume();
        });
      }
    });

    this.stream.on('end', () => {
      this.finishedReading = true;
      // All bytes queued to the kernel. end() sends them + FIN; the receiver
      // completes on size and closes. We settle on our own 'close' below.
      try {
        sock.end();
      } catch {
        /* already closing */
      }
    });

    // The receiver streams 4-byte big-endian cumulative ACKs back. We don't
    // gate sending on them (fast-send, like modern clients), but we DO surface
    // them as confirmed progress and use the last one on completion. Partial
    // 1–3 byte ACK fragments are coalesced by only reading whole 4-byte words.
    let ackBuf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      ackBuf = Buffer.concat([ackBuf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (ackBuf.length >= 4) {
        this.acked = ackBuf.readUInt32BE(0);
        ackBuf = ackBuf.subarray(4);
        this.opts.onProgress?.(this.acked);
      }
    });

    sock.on('timeout', () => this.settle(new Error('DCC send timed out')));
    sock.on('error', (e) => this.settle(e));
    sock.on('close', () => {
      if (this.settled) return;
      // A clean finish is: we read the whole file and queued it. Some receivers
      // close the moment they hit `size` without a final ACK, so completion is
      // "we sent everything", not "acked == size".
      this.settle(this.finishedReading ? null : new Error('receiver closed before transfer done'));
    });
  }

  /** Abort an in-flight send; surfaces as an error to the caller. */
  cancel(): void {
    this.settle(new Error('cancelled'));
  }

  private settle(err: Error | null): void {
    if (this.settled) return;
    this.settled = true;
    try {
      this.stream?.destroy();
    } catch {
      /* already gone */
    }
    try {
      if (err) this.socket.destroy();
      else this.socket.end();
    } catch {
      /* already gone */
    }
    if (err) this.opts.onError?.(err, this.sent);
    else this.opts.onDone?.(this.sent);
  }
}
