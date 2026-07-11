// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import net from 'net';
import { DccChat } from './dccChat.js';

// A connected socket pair over loopback.
function socketPair(): Promise<{ a: net.Socket; b: net.Socket; server: net.Server }> {
  return new Promise((resolve) => {
    const server = net.createServer((a) => {
      a.on('error', () => {});
      resolve({ a, b, server });
    });
    let b!: net.Socket;
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      b = net.connect({ host: '127.0.0.1', port });
      b.on('error', () => {});
    });
  });
}

describe('DccChat', () => {
  it('frames outbound text with CRLF and splits inbound lines', async () => {
    const { a, b } = await socketPair();
    const linesA: string[] = [];
    const chat = new DccChat({ socket: a, onLine: (t) => linesA.push(t) });
    chat.start();

    // b (the peer) sends two lines in one packet, split across a boundary.
    b.write('hello ');
    b.write('world\r\nsecond line\r\n');

    await new Promise((r) => setTimeout(r, 30));
    expect(linesA).toEqual(['hello world', 'second line']);

    // a sends back; b receives with CRLF framing.
    const gotB = new Promise<string>((r) => b.once('data', (d) => r(d.toString())));
    expect(chat.send('reply here')).toBe(true);
    expect(await gotB).toBe('reply here\r\n');

    chat.close();
  });

  it('strips embedded CR/LF from a sent line so it cannot inject extra lines', async () => {
    const { a, b } = await socketPair();
    const chat = new DccChat({ socket: a });
    chat.start();
    const gotB = new Promise<string>((r) => b.once('data', (d) => r(d.toString())));
    chat.send('line1\r\nINJECTED');
    expect(await gotB).toBe('line1  INJECTED\r\n');
    chat.close();
  });

  it('fires onClose when the peer disconnects', async () => {
    const { a, b } = await socketPair();
    const closed = new Promise<void>((r) => {
      const chat = new DccChat({ socket: a, onClose: () => r() });
      chat.start();
    });
    b.end();
    await expect(closed).resolves.toBeUndefined();
  });

  it('send() returns false after close', async () => {
    const { a } = await socketPair();
    const chat = new DccChat({ socket: a });
    chat.start();
    chat.close();
    expect(chat.send('nope')).toBe(false);
  });

  it('fails a peer that streams past the line-length cap with no newline', async () => {
    const { a, b } = await socketPair();
    const failed = new Promise<Error>((r) => {
      const chat = new DccChat({ socket: a, onError: (e) => r(e) });
      chat.start();
    });
    // 20 KB with no newline > MAX_LINE_BYTES (16 KB).
    b.write('x'.repeat(20 * 1024));
    const err = await failed;
    expect(err.message).toMatch(/length cap/);
  });

  it('dials host:port when no socket is provided and reports onConnect', async () => {
    const server = net.createServer((peer) => {
      peer.write('welcome\r\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;

    const line = new Promise<string>((res) => {
      const chat = new DccChat({
        host: '127.0.0.1',
        port,
        onLine: (t) => res(t),
      });
      chat.start();
    });
    expect(await line).toBe('welcome');
    server.close();
  });
});
