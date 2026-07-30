// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC CHAT session engine (#270 phase 2). A DCC CHAT is a direct, line-oriented
// TCP conversation between two clients — no server relays it. This wraps one
// socket as a chat: inbound bytes are split into CRLF-delimited lines and handed
// up as messages; outbound text is framed with CRLF. The caller owns the socket
// (from a listener we opened for an offer, or a dial-out to accept a peer's
// offer or answer a passive one) and the buffer/persistence — this is IRC-free
// and DB-free, exactly like dccReceiver/dccSender.
//
// A malicious peer could stream bytes without a newline forever; MAX_LINE_BYTES
// caps the unterminated buffer and closes the session rather than growing the
// heap. Lines themselves are capped on the way out too (a chat line isn't a file).

import net from 'net';

const MAX_LINE_BYTES = 16 * 1024;

export interface DccChatOptions {
  /** A socket already connected to the peer (active offer we listened for, or a
   *  dial-out). When absent, `start()` dials host:port. */
  socket?: net.Socket;
  /** Dial target when `socket` is not provided (accepting a peer's active offer,
   *  or answering our passive offer's reverse reply). */
  host?: string;
  port?: number;
  /** A received line of chat text (already CRLF-stripped). */
  onLine?: (text: string) => void;
  /** The peer connected (only meaningful for the dial-out path). */
  onConnect?: () => void;
  /** The session ended cleanly (peer closed, or we did). */
  onClose?: () => void;
  /** The session failed (connect error, socket error, line-length abuse). */
  onError?: (err: Error) => void;
}

export class DccChat {
  private socket: net.Socket | null = null;
  private buf = '';
  private closed = false;

  constructor(private readonly opts: DccChatOptions) {}

  start(): void {
    const provided = this.opts.socket ?? null;
    const sock =
      provided ?? net.connect({ host: this.opts.host as string, port: this.opts.port as number });
    this.socket = sock;

    const wire = (): void => {
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => this.onData(chunk));
      sock.on('error', (e) => this.fail(e));
      sock.on('close', () => this.end());
    };

    if (provided) {
      wire();
    } else {
      sock.on('connect', () => {
        this.opts.onConnect?.();
        wire();
      });
      sock.on('error', (e) => this.fail(e));
    }
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    this.buf += chunk;
    if (this.buf.length > MAX_LINE_BYTES) {
      this.fail(new Error('DCC CHAT line exceeded the length cap'));
      return;
    }
    let nl: number;
    while (!this.closed && (nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this.opts.onLine?.(line);
    }
  }

  /** Send one line of chat text (CRLF is appended; embedded CR/LF is stripped so
   *  a single message can't inject extra lines). Returns false if the session is
   *  already closed. */
  send(text: string): boolean {
    if (this.closed || !this.socket) return false;
    const clean = text.replace(/[\r\n]/g, ' ').slice(0, MAX_LINE_BYTES);
    try {
      this.socket.write(clean + '\r\n');
      return true;
    } catch {
      return false;
    }
  }

  /** Close the session gracefully. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.end();
    } catch {
      /* already gone */
    }
    this.opts.onClose?.();
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    this.opts.onClose?.();
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {
      /* already gone */
    }
    this.opts.onError?.(err);
  }
}
