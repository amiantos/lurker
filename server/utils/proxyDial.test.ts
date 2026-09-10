// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import net from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { FakeProxy } from './fakeProxy.js';
import { dialThroughProxy, ProxyDialError, PROXY_ERROR } from './proxyDial.js';
import type { ProxyConfig } from '../../shared/proxy.js';

const DEST = { host: 'irc.example.org', port: 6697 };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  // Reverse order: a forwarded-to server must outlive the proxy bridging to it.
  for (const fn of cleanups.splice(0).toReversed()) await fn();
});

async function proxyOn(
  opts: Parameters<typeof FakeProxy.start>[0],
): Promise<{ proxy: FakeProxy; config: ProxyConfig }> {
  const proxy = await FakeProxy.start(opts);
  cleanups.push(() => proxy.stop());
  return {
    proxy,
    config: { type: opts.protocol, host: '127.0.0.1', port: proxy.port },
  };
}

/** A TCP server that accepts and immediately says something, standing in for an
 *  ircd that speaks first. Tracks its connections: `close()` waits for open
 *  ones, and a leaked socket here hangs the suite instead of failing it. */
async function talkingServer(
  greeting: string,
): Promise<{ host: string; port: number; received: string[] }> {
  const live = new Set<net.Socket>();
  const received: string[] = [];
  const server = net.createServer((sock) => {
    live.add(sock);
    sock.on('close', () => live.delete(sock));
    sock.on('error', () => {});
    sock.on('data', (d: Buffer) => received.push(d.toString()));
    if (greeting) sock.write(greeting);
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
  return { host: '127.0.0.1', port: addr.port, received };
}

async function expectDialError(p: Promise<unknown>): Promise<ProxyDialError> {
  // The assertion lives outside the catch on purpose — expecting inside one
  // passes vacuously if the promise ever resolves (and oxlint says so).
  let thrown: unknown;
  let settled = false;
  try {
    await p;
    settled = true;
  } catch (err) {
    thrown = err;
  }
  expect(settled, 'expected the dial to be refused').toBe(false);
  // Never a bare library error reaching a caller: that is the contract.
  expect(thrown).toBeInstanceOf(ProxyDialError);
  return thrown as ProxyDialError;
}

describe.each(['socks5', 'http'] as const)('dialThroughProxy over %s', (protocol) => {
  it('forwards bytes a client pipelined straight after connecting', async () => {
    // The harness used to keep its handshake parser attached, so anything
    // written immediately after the tunnel opened was swallowed into its own
    // buffer instead of reaching the far end. That would have failed a future
    // test in a thoroughly confusing way.
    const ircd = await talkingServer('');
    const { config } = await proxyOn({ protocol, forwardTo: ircd });
    const sock = await dialThroughProxy(config, DEST, { deadlineMs: 2000 });
    sock.write('NICK early\r\n');
    await new Promise((r) => setTimeout(r, 100));
    sock.destroy();
    expect(ircd.received.join('')).toContain('NICK early');
  });

  // ⚠⚠ THE assertion. The destination must reach the proxy as a NAME, because
  // the proxy resolving it is the entire feature: resolve locally and a Tor
  // user's DNS names every server they talk to, and `.onion` cannot work at
  // all. Asserted on the bytes the proxy received, so it survives a rewrite of
  // how we get there — including swapping the `socks` dependency out.
  it('sends the destination as a NAME, never an address it resolved', async () => {
    const { proxy, config } = await proxyOn({ protocol });
    const sock = await dialThroughProxy(config, DEST, { deadlineMs: 2000 });
    sock.destroy();
    expect(proxy.lastRequest).toMatchObject({
      addressType: 'domain',
      host: 'irc.example.org',
      port: 6697,
    });
  });

  it('sends an IP literal as an address, because that is what it was given', async () => {
    const { proxy, config } = await proxyOn({ protocol });
    const sock = await dialThroughProxy(
      config,
      { host: '192.0.2.10', port: 6667 },
      {
        deadlineMs: 2000,
      },
    );
    sock.destroy();
    expect(proxy.lastRequest).toMatchObject({ addressType: 'ipv4', host: '192.0.2.10' });
  });

  it('carries a username and password when one is configured', async () => {
    const auth = { username: 'lurker', password: 'hunter2' };
    const { proxy, config } = await proxyOn({ protocol, auth });
    const sock = await dialThroughProxy({ ...config, ...auth }, DEST, { deadlineMs: 2000 });
    sock.destroy();
    expect(proxy.lastRequest).toMatchObject(auth);
  });

  it('refuses, naming auth, when the credentials are wrong', async () => {
    const { config } = await proxyOn({
      protocol,
      auth: { username: 'lurker', password: 'hunter2' },
    });
    const err = await expectDialError(
      dialThroughProxy({ ...config, username: 'lurker', password: 'wrong' }, DEST, {
        deadlineMs: 2000,
      }),
    );
    expect(err.code).toBe(PROXY_ERROR.AUTH);
  });

  it('refuses when the proxy wants auth and none is configured', async () => {
    const { config } = await proxyOn({
      protocol,
      auth: { username: 'lurker', password: 'hunter2' },
    });
    const err = await expectDialError(dialThroughProxy(config, DEST, { deadlineMs: 2000 }));
    expect(err.code).toBe(PROXY_ERROR.AUTH);
  });

  it('refuses, without hanging, when nothing is listening', async () => {
    // Port 1 on loopback: reliably refused, never firewalled into a timeout.
    const config: ProxyConfig = { type: protocol, host: '127.0.0.1', port: 1 };
    const err = await expectDialError(dialThroughProxy(config, DEST, { deadlineMs: 2000 }));
    expect(err.code).toBe(PROXY_ERROR.UNREACHABLE);
  });

  it('gives up on a proxy that accepts and then says nothing', async () => {
    const { config } = await proxyOn({ protocol, tarpit: true });
    const err = await expectDialError(dialThroughProxy(config, DEST, { deadlineMs: 250 }));
    expect(err.code).toBe(PROXY_ERROR.TIMEOUT);
  });

  it('survives a reply delivered one byte at a time', async () => {
    // The framing test. A length-naive reader passes every case above and
    // fails this one, and in production it fails only under load.
    const { proxy, config } = await proxyOn({ protocol, dribble: true });
    const sock = await dialThroughProxy(config, DEST, { deadlineMs: 5000 });
    sock.destroy();
    expect(proxy.lastRequest?.host).toBe('irc.example.org');
  });

  it('names the proxy in its errors, and never leaks the password', async () => {
    const { config } = await proxyOn({
      protocol,
      auth: { username: 'lurker', password: 'hunter2' },
    });
    const err = await expectDialError(
      dialThroughProxy({ ...config, username: 'lurker', password: 's3cret-pw' }, DEST, {
        deadlineMs: 2000,
      }),
    );
    expect(err.message).toContain(`127.0.0.1:${config.port}`);
    expect(err.message).not.toContain('s3cret-pw');
  });

  it('passes bytes both ways once the tunnel is open', async () => {
    const ircd = await talkingServer(':server 020 * :Please wait\r\n');
    const { config } = await proxyOn({ protocol, forwardTo: ircd });
    const sock = await dialThroughProxy(config, DEST, { deadlineMs: 2000 });
    const line = await new Promise<string>((resolve) =>
      sock.once('data', (d) => resolve(String(d))),
    );
    sock.destroy();
    expect(line).toContain('020');
  });
});

describe('dialThroughProxy over socks5', () => {
  // ⚠ The one brittle seam in taking the `socks` dependency: it reports a
  // rejection as an Error whose message ends in the reply code's symbolic name,
  // and proxyDial matches on that suffix. A `socks` upgrade that reworded them
  // must fail HERE and not in a user's system buffer.
  const REPLIES: Array<[number, string, string]> = [
    [0x01, 'general failure', PROXY_ERROR.REFUSED],
    [0x02, 'not allowed', PROXY_ERROR.REFUSED],
    [0x03, 'network unreachable', PROXY_ERROR.REFUSED],
    [0x04, 'host unreachable', PROXY_ERROR.REFUSED],
    [0x05, 'connection refused', PROXY_ERROR.REFUSED],
    [0x06, 'TTL expired', PROXY_ERROR.REFUSED],
    [0x07, 'command not supported', PROXY_ERROR.PROTOCOL],
    [0x08, 'address not supported', PROXY_ERROR.PROTOCOL],
  ];

  it.each(REPLIES)(
    'maps SOCKS5 reply 0x%s (%s) to our own prose',
    async (code, _name, expected) => {
      const { config } = await proxyOn({ protocol: 'socks5', reject: code as number });
      const err = await expectDialError(dialThroughProxy(config, DEST, { deadlineMs: 2000 }));
      expect(err.code).toBe(expected);
      // Never the library's own wording reaching a user. (Our prose legitimately
      // says "SOCKS5 proxy", so this matches `socks`' phrases, not the word.)
      expect(err.message).not.toMatch(/final handshake|SocksClient|Invalid/i);
      expect(err.message).toContain('socks5://127.0.0.1');
    },
  );

  it('reads a reply whose bound address is a DOMAIN', async () => {
    // fakeProxy replies domain-bound by default precisely because a reader that
    // assumes the IPv4 form desynchronises here — the trap WeeChat switches on
    // and `socks` handles. This asserts we inherited the correct behaviour.
    const { config } = await proxyOn({ protocol: 'socks5' });
    const sock = await dialThroughProxy(config, DEST, { deadlineMs: 2000 });
    expect(sock.destroyed).toBe(false);
    sock.destroy();
  });
});

describe('dialThroughProxy over http', () => {
  // ⚠⚠ A proxy may deliver the ircd's first line in the SAME write as its own
  // 200. Ours to get wrong, so ours to pin: without the unshift the line is
  // eaten silently, and it reproduces only against real proxies.
  it('keeps tunnel bytes that arrived alongside the CONNECT response', async () => {
    const greeting = ':server 020 * :Please wait\r\n';
    const { config } = await proxyOn({ protocol: 'http', pipeline: greeting });
    const sock = await dialThroughProxy(config, DEST, { deadlineMs: 2000 });
    const first = await new Promise<string>((resolve) =>
      sock.once('data', (d) => resolve(String(d))),
    );
    sock.destroy();
    expect(first).toBe(greeting);
  });

  it('keeps them even when the response was dribbled', async () => {
    const greeting = ':server 020 * :Please wait\r\n';
    const { config } = await proxyOn({ protocol: 'http', pipeline: greeting, dribble: true });
    const sock = await dialThroughProxy(config, DEST, { deadlineMs: 5000 });
    let seen = '';
    await new Promise<void>((resolve) => {
      sock.on('data', (d) => {
        seen += String(d);
        if (seen.includes('\r\n')) resolve();
      });
    });
    sock.destroy();
    expect(seen).toBe(greeting);
  });

  it('reports the proxy own words when it refuses', async () => {
    const { config } = await proxyOn({ protocol: 'http', reject: 403 });
    const err = await expectDialError(dialThroughProxy(config, DEST, { deadlineMs: 2000 }));
    expect(err.code).toBe(PROXY_ERROR.REFUSED);
    // The reason phrase is routinely the most useful thing on screen.
    expect(err.message).toContain('403');
  });

  it('brackets an IPv6 destination in the CONNECT line', async () => {
    // Unbracketed, `CONNECT 2001:db8::1:6697` is an unparseable authority and
    // the proxy answers with something opaque. Bracketing is not "normalising
    // the host" — the bytes still name exactly what we were given.
    const { proxy, config } = await proxyOn({ protocol: 'http' });
    const sock = await dialThroughProxy(
      config,
      { host: '2001:db8::1', port: 6697 },
      {
        deadlineMs: 2000,
      },
    );
    sock.destroy();
    expect(proxy.lastRequest).toMatchObject({ host: '2001:db8::1', port: 6697 });
  });

  it('refuses a destination that would break out of the request line', async () => {
    // `network.host` is only checked for being non-empty by the routes, so a
    // CR/LF in it reaches the CONNECT line unescaped. Refused here, at the
    // point of use, because dialThroughProxy is exported.
    const { config } = await proxyOn({ protocol: 'http' });
    const err = await expectDialError(
      dialThroughProxy(
        config,
        { host: 'irc.example.org\r\nX-Evil: 1', port: 6697 },
        {
          deadlineMs: 2000,
        },
      ),
    );
    expect(err.code).toBe(PROXY_ERROR.PROTOCOL);
  });

  it('refuses a peer that is not an HTTP proxy at all', async () => {
    // A COMPLETE header block that is not an HTTP response: the read finishes,
    // so this asserts the protocol check rather than the deadline.
    const notAProxy = await talkingServer('220 smtp.example ESMTP ready\r\n\r\n');
    const config: ProxyConfig = { type: 'http', host: notAProxy.host, port: notAProxy.port };
    const err = await expectDialError(dialThroughProxy(config, DEST, { deadlineMs: 2000 }));
    expect(err.code).toBe(PROXY_ERROR.PROTOCOL);
  });
});
