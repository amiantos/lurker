// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Exercises the active-DCC receive engine against a local fake DCC sender (a
// plain TCP server) — no IRC involved. Covers the happy path (bytes land on
// disk, onDone fires), the 4-byte ACK backchannel, and early-close failure.

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { DccReceiver } from './dccReceiver.js';

// Deterministic payload so we can byte-compare the written file.
function makePayload(n: number): Buffer {
  return Buffer.from(Array.from({ length: n }, (_, i) => i % 256));
}

// A fake DCC sender: on connect, writes `toSend` then half-closes; meanwhile it
// records every byte the receiver sends back (the ACK stream).
function startSender(toSend: Buffer): Promise<{
  port: number;
  acks: () => number[];
  close: () => void;
}> {
  return new Promise((resolve) => {
    const ackChunks: Buffer[] = [];
    const server = net.createServer((sock) => {
      sock.on('data', (d) => ackChunks.push(typeof d === 'string' ? Buffer.from(d) : d));
      sock.on('error', () => {});
      sock.write(toSend, () => sock.end());
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        acks: () => {
          const all = Buffer.concat(ackChunks);
          const out: number[] = [];
          for (let i = 0; i + 4 <= all.length; i += 4) out.push(all.readUInt32BE(i));
          return out;
        },
        close: () => server.close(),
      });
    });
  });
}

let tmp: string;
let sender: { close: () => void } | null = null;
afterEach(() => {
  sender?.close();
  sender = null;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function tmpFile(name: string): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-recv-'));
  return path.join(tmp, name);
}

describe('DccReceiver', () => {
  it('downloads the full payload to disk and reports done', async () => {
    const payload = makePayload(100_000);
    const s = await startSender(payload);
    sender = s;
    const dest = tmpFile('out.bin');

    const received = await new Promise<number>((resolve, reject) => {
      new DccReceiver({
        host: '127.0.0.1',
        port: s.port,
        size: payload.length,
        destPath: dest,
        onDone: resolve,
        onError: reject,
      }).start();
    });

    expect(received).toBe(payload.length);
    expect(fs.readFileSync(dest).equals(payload)).toBe(true);
  });

  it('sends a cumulative 4-byte ACK whose final value is the total size', async () => {
    const payload = makePayload(50_000);
    const s = await startSender(payload);
    sender = s;
    const dest = tmpFile('out.bin');

    await new Promise<number>((resolve, reject) => {
      new DccReceiver({
        host: '127.0.0.1',
        port: s.port,
        size: payload.length,
        destPath: dest,
        onDone: resolve,
        onError: reject,
      }).start();
    });

    const acks = s.acks();
    expect(acks.length).toBeGreaterThan(0);
    expect(acks).toEqual(acks.toSorted((a, b) => a - b)); // monotonically increasing
    expect(acks.at(-1)).toBe(payload.length);
  });

  it('errors when the connection closes before the advertised size arrives', async () => {
    const full = makePayload(100_000);
    // Sender ships only the first half but the receiver was promised the full size.
    const s = await startSender(full.subarray(0, 50_000));
    sender = s;
    const dest = tmpFile('partial.bin');

    const err = await new Promise<Error>((resolve, reject) => {
      new DccReceiver({
        host: '127.0.0.1',
        port: s.port,
        size: full.length,
        destPath: dest,
        onDone: () => reject(new Error('should not have completed')),
        onError: resolve,
      }).start();
    });

    expect(err.message).toMatch(/closed before/);
  });

  it('errors on connection refused (nothing listening)', async () => {
    const dest = tmpFile('none.bin');
    const err = await new Promise<Error>((resolve, reject) => {
      new DccReceiver({
        host: '127.0.0.1',
        port: 1, // privileged + nothing listening → ECONNREFUSED
        size: 10,
        destPath: dest,
        idleTimeoutMs: 2000,
        onDone: () => reject(new Error('should not have completed')),
        onError: resolve,
      }).start();
    });
    expect(err).toBeInstanceOf(Error);
  });
});
