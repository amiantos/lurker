// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// MUST be first — dccListener → dccConfig → userCapabilities → db/index opens
// the real DB at module load unless DATABASE_PATH is redirected before then.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'net';
import { openDccListener, activeDccListenerCount, resetDccListeners } from './dccListener.js';

// A high, uncommon range so the test doesn't collide with anything real.
const MIN = 45820;
const MAX = 45829;

beforeEach(() => {
  process.env.LURKER_DCC_LISTEN_BIND = '127.0.0.1';
  process.env.LURKER_DCC_LISTEN_PORT_MIN = String(MIN);
  process.env.LURKER_DCC_LISTEN_PORT_MAX = String(MAX);
  resetDccListeners();
});

afterEach(() => {
  delete process.env.LURKER_DCC_LISTEN_BIND;
  delete process.env.LURKER_DCC_LISTEN_PORT_MIN;
  delete process.env.LURKER_DCC_LISTEN_PORT_MAX;
});

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('connect', () => resolve(s));
    s.on('error', reject);
  });
}

describe('openDccListener', () => {
  it('binds a port in range and resolves accepted with the first inbound socket', async () => {
    const handle = await openDccListener({ timeoutMs: 2000 });
    expect(handle.port).toBeGreaterThanOrEqual(MIN);
    expect(handle.port).toBeLessThanOrEqual(MAX);
    expect(activeDccListenerCount()).toBe(1);

    const client = await connect(handle.port);
    const server = await handle.accepted;
    expect(server).toBeInstanceOf(net.Socket);

    // Bytes flow both ways over the accepted socket.
    const got = new Promise<string>((res) => server.once('data', (d) => res(d.toString())));
    client.write('ping');
    expect(await got).toBe('ping');

    server.destroy();
    client.destroy();
    // Port released once the one connection was accepted (server closed).
    expect(activeDccListenerCount()).toBe(0);
  });

  it('rejects accepted on timeout and releases the port', async () => {
    const handle = await openDccListener({ timeoutMs: 120 });
    await expect(handle.accepted).rejects.toThrow(/timed out/);
    expect(activeDccListenerCount()).toBe(0);
  });

  it('close() rejects a pending accept and frees the port', async () => {
    const handle = await openDccListener({ timeoutMs: 5000 });
    handle.close();
    await expect(handle.accepted).rejects.toThrow(/closed/);
    expect(activeDccListenerCount()).toBe(0);
    handle.close(); // idempotent
  });

  it('allocates distinct ports for concurrent listeners', async () => {
    const a = await openDccListener({ timeoutMs: 1000 });
    const b = await openDccListener({ timeoutMs: 1000 });
    expect(a.port).not.toBe(b.port);
    expect(activeDccListenerCount()).toBe(2);
    a.close();
    b.close();
    await expect(a.accepted).rejects.toThrow(/closed/);
    await expect(b.accepted).rejects.toThrow(/closed/);
  });

  it('rejects when no port range is configured', async () => {
    delete process.env.LURKER_DCC_LISTEN_PORT_MIN;
    await expect(openDccListener()).rejects.toThrow(/not configured/);
  });

  it('drops a connection from an unexpected peer and keeps waiting', async () => {
    // Loopback connections all report 127.0.0.1; expecting a different host
    // means the localhost dial is dropped and the offer times out.
    const handle = await openDccListener({ timeoutMs: 200, expectPeerHost: '203.0.113.5' });
    const client = await connect(handle.port);
    await expect(handle.accepted).rejects.toThrow(/timed out/);
    client.destroy();
  });

  it('accepts a connection matching expectPeerHost', async () => {
    const handle = await openDccListener({ timeoutMs: 2000, expectPeerHost: '127.0.0.1' });
    const client = await connect(handle.port);
    const server = await handle.accepted;
    expect(server).toBeInstanceOf(net.Socket);
    server.destroy();
    client.destroy();
  });
});
