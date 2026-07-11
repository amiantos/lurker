// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DccSender } from './dccSender.js';

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-send-'));
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeFile(name: string, buf: Buffer): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, buf);
  return p;
}

// A connected socket pair over loopback: resolves { sender, client } where the
// DccSender writes to `sender` and the mock receiver reads `client`.
function socketPair(): Promise<{ sender: net.Socket; client: net.Socket; server: net.Server }> {
  return new Promise((resolve) => {
    const server = net.createServer((sender) => {
      sender.on('error', () => {}); // early-close tests reset this socket
      resolve({ sender, client, server });
    });
    let client!: net.Socket;
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      client = net.connect({ host: '127.0.0.1', port });
    });
  });
}

// Read the whole transfer off `client`, ACKing cumulatively like a real DCC
// receiver, and resolve with the collected bytes when it closes.
function collect(client: net.Socket, ack = true): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    client.on('error', () => {}); // an early-close test resets this socket
    client.on('data', (d: Buffer | string) => {
      const buf = typeof d === 'string' ? Buffer.from(d) : d;
      chunks.push(buf);
      total += buf.length;
      if (ack) {
        const a = Buffer.alloc(4);
        a.writeUInt32BE(total % 0x1_0000_0000, 0);
        client.write(a);
      }
    });
    client.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

describe('DccSender', () => {
  it('streams a whole file and reports done with the full byte count', async () => {
    const data = Buffer.from('hello dcc world '.repeat(5000)); // ~80 KB
    const filePath = writeFile('a.bin', data);
    const { sender, client } = await socketPair();

    const received = collect(client);
    const done = new Promise<number>((res, rej) => {
      new DccSender({
        socket: sender,
        filePath,
        size: data.length,
        onDone: (sent) => res(sent),
        onError: (e) => rej(e),
      }).start();
    });

    expect(await done).toBe(data.length);
    expect((await received).equals(data)).toBe(true);
  });

  it('surfaces ACK progress', async () => {
    const data = Buffer.alloc(200_000, 7);
    const filePath = writeFile('p.bin', data);
    const { sender, client } = await socketPair();
    collect(client);
    const acks: number[] = [];
    await new Promise<void>((res, rej) => {
      new DccSender({
        socket: sender,
        filePath,
        size: data.length,
        onProgress: (n) => acks.push(n),
        onDone: () => res(),
        onError: rej,
      }).start();
    });
    expect(acks.length).toBeGreaterThan(0);
    expect(acks[acks.length - 1]).toBe(data.length);
    // ACKs are monotonically non-decreasing.
    for (let i = 1; i < acks.length; i++) expect(acks[i]).toBeGreaterThanOrEqual(acks[i - 1]);
  });

  it('honors startOffset (resume): sends only the tail', async () => {
    const data = Buffer.from('0123456789'.repeat(1000)); // 10 KB
    const filePath = writeFile('r.bin', data);
    const { sender, client } = await socketPair();
    const received = collect(client);
    const start = 4000;
    await new Promise<void>((res, rej) => {
      new DccSender({
        socket: sender,
        filePath,
        size: data.length,
        startOffset: start,
        onDone: () => res(),
        onError: rej,
      }).start();
    });
    expect((await received).equals(data.subarray(start))).toBe(true);
  });

  it('errors when the receiver closes before the transfer completes', async () => {
    const data = Buffer.alloc(5_000_000, 1); // big enough to still be mid-flight
    const filePath = writeFile('big.bin', data);
    const { sender, client } = await socketPair();
    // Kill the receiver almost immediately.
    client.on('data', () => client.destroy());
    await expect(
      new Promise<void>((res, rej) => {
        new DccSender({
          socket: sender,
          filePath,
          size: data.length,
          onDone: () => res(),
          onError: (e) => rej(e),
        }).start();
      }),
    ).rejects.toThrow(/closed|reset|ECONNRESET|EPIPE/);
  });

  it('cancel() aborts with an error', async () => {
    const data = Buffer.alloc(5_000_000, 2);
    const filePath = writeFile('c.bin', data);
    const { sender, client } = await socketPair();
    collect(client);
    await expect(
      new Promise<void>((res, rej) => {
        const s = new DccSender({
          socket: sender,
          filePath,
          size: data.length,
          onDone: () => res(),
          onError: (e) => rej(e),
        });
        s.start();
        setTimeout(() => s.cancel(), 5);
      }),
    ).rejects.toThrow(/cancelled/);
  });
});
