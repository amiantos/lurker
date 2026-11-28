// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DccSender, type DccSendOptions } from './dccSender.js';
import { DccReceiver } from './dccReceiver.js';

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
      server.close();
      resolve({ sender, client, server });
    });
    let client!: net.Socket;
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      client = net.connect({ host: '127.0.0.1', port });
    });
  });
}

// Read the whole transfer off `client`, ACKing cumulatively (from `base`, the
// resume point) like a real DCC receiver, and resolve with the collected bytes
// when it closes. `ackOf` lets a test send a wrong ACK.
function collect(
  client: net.Socket,
  opts: { ack?: boolean; base?: number; ackOf?: (total: number) => number } = {},
): Promise<Buffer> {
  const { ack = true, base = 0, ackOf = (n) => n } = opts;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = base;
    client.on('error', () => {}); // an early-close test resets this socket
    client.on('data', (d: Buffer | string) => {
      const buf = typeof d === 'string' ? Buffer.from(d) : d;
      chunks.push(buf);
      total += buf.length;
      if (ack) {
        const a = Buffer.alloc(4);
        a.writeUInt32BE(ackOf(total) % 0x1_0000_0000, 0);
        client.write(a);
      }
    });
    // A receiver that doesn't ACK closes on the sender's FIN.
    client.on('end', () => client.end());
    client.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

function run(opts: Omit<DccSendOptions, 'onDone' | 'onError'>): Promise<number> {
  return new Promise<number>((res, rej) => {
    new DccSender({ ...opts, onDone: res, onError: rej }).start();
  });
}

describe('DccSender', () => {
  it('streams a whole file and reports done with the full byte count', async () => {
    const data = Buffer.from('hello dcc world '.repeat(5000)); // ~80 KB
    const filePath = writeFile('a.bin', data);
    const { sender, client } = await socketPair();

    const received = collect(client);
    expect(await run({ socket: sender, filePath, size: data.length })).toBe(data.length);
    expect((await received).equals(data)).toBe(true);
  });

  it('surfaces ACK progress', async () => {
    const data = Buffer.alloc(200_000, 7);
    const filePath = writeFile('p.bin', data);
    const { sender, client } = await socketPair();
    collect(client);
    const acks: number[] = [];
    await run({ socket: sender, filePath, size: data.length, onProgress: (n) => acks.push(n) });
    expect(acks.length).toBeGreaterThan(0);
    expect(acks[acks.length - 1]).toBe(data.length);
    // ACKs are monotonically non-decreasing.
    for (let i = 1; i < acks.length; i++) expect(acks[i]).toBeGreaterThanOrEqual(acks[i - 1]);
  });

  it('honors startOffset (resume): sends only the tail', async () => {
    const data = Buffer.from('0123456789'.repeat(1000)); // 10 KB
    const filePath = writeFile('r.bin', data);
    const { sender, client } = await socketPair();
    const start = 4000;
    const received = collect(client, { base: start });
    await run({ socket: sender, filePath, size: data.length, startOffset: start });
    expect((await received).equals(data.subarray(start))).toBe(true);
  });

  it('completes for a receiver that never ACKs once it closes after everything', async () => {
    const data = Buffer.alloc(300_000, 3);
    const filePath = writeFile('noack.bin', data);
    const { sender, client } = await socketPair();
    const received = collect(client, { ack: false });
    expect(await run({ socket: sender, filePath, size: data.length, firstAckWaitMs: 50 })).toBe(
      data.length,
    );
    expect((await received).length).toBe(data.length);
  });

  // #528 counted any close after the last byte was queued as done.
  it('fails when the receiver closes with an ACK short of the size', async () => {
    const data = Buffer.alloc(100_000, 4);
    const filePath = writeFile('short.bin', data);
    const { sender, client } = await socketPair();
    collect(client, { ackOf: (n) => n - 1 });
    // The receiver never ACKs the size, so close it once it has everything.
    let got = 0;
    client.on('data', (d: Buffer) => {
      got += d.length;
      if (got >= data.length) setTimeout(() => client.end(), 20);
    });
    await expect(run({ socket: sender, filePath, size: data.length })).rejects.toThrow(
      /confirmed 99999 of 100000/,
    );
  });

  // An ACK is credited only up to what we've sent (Codex, on the branch).
  it('takes no early ACK of the whole file as done', async () => {
    const data = Buffer.alloc(50_000, 8);
    const filePath = writeFile('early.bin', data);
    const { sender, client } = await socketPair();
    client.on('error', () => {});
    const early = Buffer.alloc(4);
    early.writeUInt32BE(data.length, 0);
    client.write(early);
    let got = 0;
    client.on('data', (d: Buffer) => {
      got += d.length;
      if (got >= data.length) client.end();
    });
    await expect(run({ socket: sender, filePath, size: data.length })).rejects.toThrow(
      /confirmed 0 of 50000/,
    );
  });

  // irssi and KVIrc close only on EOF, so the FIN can't wait forever.
  it('closes, after a grace, on a receiver that ACKs but never confirms it all', async () => {
    const data = Buffer.alloc(20_000, 9);
    const filePath = writeFile('grace.bin', data);
    const { sender, client } = await socketPair();
    // ACKs one short, and closes only on our FIN.
    collect(client, { ackOf: (n) => n - 1 });
    const started = Date.now();
    await expect(
      run({
        socket: sender,
        filePath,
        size: data.length,
        finalAckGraceMs: 150,
        firstAckWaitMs: 50,
      }),
    ).rejects.toThrow(/confirmed 19999 of 20000/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('errors when the receiver closes before the transfer completes', async () => {
    const data = Buffer.alloc(5_000_000, 1); // big enough to still be mid-flight
    const filePath = writeFile('big.bin', data);
    const { sender, client } = await socketPair();
    // Kill the receiver almost immediately.
    client.on('data', () => client.destroy());
    // Which error depends on where the close catches the sender: our own
    // 'close' handler, a reset, or a write after the receiver's FIN (node's
    // "This socket has been ended by the other party", seen on CI, #1474).
    await expect(run({ socket: sender, filePath, size: data.length })).rejects.toThrow(
      /closed|reset|ECONNRESET|EPIPE|ended by the other party/,
    );
  });

  // #528 switched the idle timeout off while waiting for 'drain', so this hung.
  it('times out a receiver that stops reading', async () => {
    const data = Buffer.alloc(20_000_000, 5);
    const filePath = writeFile('stuck.bin', data);
    const { sender, client } = await socketPair();
    client.on('error', () => {});
    client.pause();
    await expect(
      run({ socket: sender, filePath, size: data.length, idleTimeoutMs: 300 }),
    ).rejects.toThrow(/timed out/);
    client.destroy();
  });

  it('fails when the file is shorter than the size it was offered at', async () => {
    const filePath = writeFile('shrunk.bin', Buffer.alloc(1000, 6));
    const { sender, client } = await socketPair();
    collect(client);
    await expect(run({ socket: sender, filePath, size: 2000 })).rejects.toThrow(
      /ended at 1000 of 2000/,
    );
  });

  // The ACK is 32 bits. A sparse file puts the resume point just under 4 GiB
  // without writing 4 GiB, so the ACKs wrap partway.
  it('reads ACKs that wrap past 4 GiB', async () => {
    const size = 0x1_0000_0000 + 1000;
    const start = 0x1_0000_0000 - 1000;
    const filePath = path.join(tmpDir, 'sparse.bin');
    fs.closeSync(fs.openSync(filePath, 'w'));
    fs.truncateSync(filePath, size);
    const { sender, client } = await socketPair();
    collect(client, { base: start });
    const progress: number[] = [];
    expect(
      await run({
        socket: sender,
        filePath,
        size,
        startOffset: start,
        onProgress: (n) => progress.push(n),
      }),
    ).toBe(size);
    expect(progress[progress.length - 1]).toBe(size);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    }
  });

  it('round-trips through our own receiver', async () => {
    const data = Buffer.from(Array.from({ length: 1_500_000 }, (_, i) => i % 251));
    const filePath = writeFile('rt.bin', data);
    const dest = path.join(tmpDir, 'rt.out');
    const server = net.createServer();
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as net.AddressInfo).port;
    const sent = new Promise<number>((res, rej) => {
      server.once('connection', (socket) => {
        server.close();
        new DccSender({ socket, filePath, size: data.length, onDone: res, onError: rej }).start();
      });
    });
    const received = new Promise<number>((res, rej) => {
      new DccReceiver({
        host: '127.0.0.1',
        port,
        size: data.length,
        destPath: dest,
        onDone: res,
        onError: rej,
      }).start();
    });
    expect(await received).toBe(data.length);
    expect(await sent).toBe(data.length);
    expect(fs.readFileSync(dest).equals(data)).toBe(true);
  });

  it('cancel() aborts with an error', async () => {
    const data = Buffer.alloc(5_000_000, 2);
    const filePath = writeFile('c.bin', data);
    const { sender, client } = await socketPair();
    // Not reading, so the send is still in flight when it's cancelled.
    client.on('error', () => {});
    client.pause();
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
    client.destroy();
  });
});
