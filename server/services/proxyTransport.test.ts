// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Dial path A (#303): the app's own socket through a proxy.
//
// Two jobs here. One is the ordinary one — a Client dialled through a proxy
// reaches the ircd, and a proxy failure closes the connection the way a refused
// TCP connect does. The other is a PIN on irc-framework's internals: this
// transport subclasses an unpublished module and relies on specific members of
// it, so a version bump that moves them must fail here rather than on someone's
// connection.

import net from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import NetTransport from 'irc-framework/src/transports/net.js';
import { FakeProxy } from '../utils/fakeProxy.js';
import { ProxyTransport } from './proxyTransport.js';
import type { ProxyConfig } from '../../shared/proxy.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).toReversed()) await fn();
});

/** A plaintext ircd that greets and echoes what it is told, so a test can prove
 *  both directions of the tunnel. */
async function fakeIrcServer(): Promise<{ host: string; port: number; lines: string[] }> {
  const lines: string[] = [];
  const live = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    live.add(sock);
    sock.on('close', () => live.delete(sock));
    sock.on('error', () => {});
    sock.setEncoding('utf8');
    sock.write(':fake 020 * :Please wait\r\n');
    sock.on('data', (chunk: string) => {
      for (const line of String(chunk).split('\r\n')) if (line) lines.push(line);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of live) s.destroy();
        server.close(() => resolve());
      }),
  );
  const addr = server.address() as net.AddressInfo;
  return { host: '127.0.0.1', port: addr.port, lines };
}

async function proxyTo(
  protocol: 'socks5' | 'http',
  ircd: { host: string; port: number },
): Promise<{ proxy: FakeProxy; config: ProxyConfig }> {
  const proxy = await FakeProxy.start({ protocol, forwardTo: ircd });
  cleanups.push(() => proxy.stop());
  return { proxy, config: { type: protocol, host: '127.0.0.1', port: proxy.port } };
}

// ⚠ The pin. Each of these is something ProxyTransport calls or assigns on the
// base class. They have no published types and no compatibility promise, so
// this test is the early-warning system for an irc-framework bump.
describe('irc-framework net transport internals', () => {
  it('still has the members ProxyTransport builds on', () => {
    const t = new NetTransport({ host: 'h', port: 1 });
    const members = [
      '_onSocketCreate',
      'disposeSocket',
      'onSocketError',
      'setEncoding',
      'writeLine',
      'close',
      'debugOut',
    ];
    // One assertion listing the missing names, so a failure says WHICH member
    // an irc-framework bump moved rather than just the first one.
    const missing = members.filter(
      (m) => typeof (t as unknown as Record<string, unknown>)[m] !== 'function',
    );
    expect(missing).toEqual([]);
  });

  it('still accepts an ALREADY-CONNECTED socket', async () => {
    // The property the whole approach rests on: a proxied dial hands back an
    // open socket, and `_onSocketCreate` has to notice that its readyState is
    // not 'opening' and fire the connect callbacks itself rather than waiting
    // for a 'connect' event that has already been and gone.
    const ircd = await fakeIrcServer();
    const t = new NetTransport({ host: ircd.host, port: ircd.port });
    const sock = net.connect(ircd);
    await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
    const opened = new Promise<boolean>((resolve) => t.once('open', () => resolve(true)));
    t.socket = sock;
    t._onSocketCreate(t.options, sock);
    // Resolving at all is the point — it means _onSocketCreate noticed the
    // socket was already open instead of waiting for a 'connect' that has been
    // and gone — but assert explicitly so this reads as a check, not a hang.
    expect(await opened).toBe(true);
    expect(t.isConnected()).toBe(true);
    t.close(true);
  });
});

describe.each(['socks5', 'http'] as const)('ProxyTransport over %s', (protocol) => {
  it('reaches the ircd and passes lines both ways', async () => {
    const ircd = await fakeIrcServer();
    const { proxy, config } = await proxyTo(protocol, ircd);
    const transport = new ProxyTransport({
      host: 'irc.example.org',
      port: 6667,
      proxy: config,
    } as unknown as Record<string, unknown>);

    const first = new Promise<string>((resolve) => transport.once('line', resolve));
    transport.connect();
    // ⚠ The pipelined-greeting case in disguise: the ircd speaks first, so this
    // line only arrives if the tunnelled socket's buffered bytes survived the
    // hand-off from proxyDial.
    expect(await first).toContain('020');

    // And the destination reached the proxy as a NAME, not as something we
    // resolved on the way past.
    expect(proxy.lastRequest).toMatchObject({ addressType: 'domain', host: 'irc.example.org' });

    transport.writeLine('NICK someone');
    await new Promise((r) => setTimeout(r, 50));
    expect(ircd.lines).toContain('NICK someone');
    transport.close(true);
  });

  it('closes with the proxy error when the proxy refuses', async () => {
    // A proxy failure has to end as a socket failure, or the Client sits
    // waiting for an 'open' that never comes.
    const proxy = await FakeProxy.start({ protocol, reject: protocol === 'socks5' ? 0x02 : 403 });
    cleanups.push(() => proxy.stop());
    const transport = new ProxyTransport({
      host: 'irc.example.org',
      port: 6667,
      proxy: { type: protocol, host: '127.0.0.1', port: proxy.port },
    } as unknown as Record<string, unknown>);

    const closed = new Promise<unknown>((resolve) => transport.once('close', resolve));
    transport.connect();
    const err = (await closed) as { code?: string; message?: string };
    expect(err.code).toMatch(/^PROXY_/);
    // The proxy is named, so nobody goes and debugs the ircd.
    expect(err.message).toContain('127.0.0.1');
  });

  it('abandons a dial that is closed while still in flight', async () => {
    // The base class's close() opens with `if (!this.socket) return`, and
    // during a proxy dial there is no socket yet — so without the abandon flag
    // this resolves into an orphan socket nobody owns.
    const ircd = await fakeIrcServer();
    const { config } = await proxyTo(protocol, ircd);
    const transport = new ProxyTransport({
      host: 'irc.example.org',
      port: 6667,
      proxy: config,
    } as unknown as Record<string, unknown>);
    let opened = false;
    transport.on('open', () => {
      opened = true;
    });
    transport.connect();
    transport.close(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(opened).toBe(false);
    expect(transport.socket).toBeNull();
  });

  it('dials directly when no proxy is configured', async () => {
    // Reachable if a network's proxy is cleared without the Client being
    // rebuilt; it must behave exactly like the base transport.
    const ircd = await fakeIrcServer();
    const transport = new ProxyTransport({
      host: ircd.host,
      port: ircd.port,
    } as unknown as Record<string, unknown>);
    const first = new Promise<string>((resolve) => transport.once('line', resolve));
    transport.connect();
    expect(await first).toContain('020');
    transport.close(true);
  });
});
