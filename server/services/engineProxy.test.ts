// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Proxied connections through the engine (#303), end to end: the app configures
// a proxy in its database, and a different process entirely dials through it.
//
// ⚠⚠ The last test here is the one that matters most in the whole feature. An
// engine below protocol minor 5 has no field to carry the proxy in and would
// IGNORE it — dialling direct and reporting success. That is worse than the
// client-certificate skew it mirrors: a missing certificate fails visibly
// (services refuse you, SASL EXTERNAL errors), while a missing proxy just
// works, with the user's real address on the wire and the UI saying otherwise.
// It is invisible to every other test we have, so it is asserted here.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import type { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';
import { EngineLink } from './engineLink.js';
import { FakeProxy } from '../utils/fakeProxy.js';
import { until } from '../test-utils/until.js';

const SECRET = 'proxy-engine-secret';

let harness: EngineHarness;
let ircd: FakeIrcd;
let userId: number;
let seq = 0;
const proxies: FakeProxy[] = [];

beforeAll(async () => {
  harness = await startEngineHarness({ secret: SECRET });
  ircd = harness.ircd;
  userId = createUser('proxy-engine').id;
});

afterAll(async () => {
  for (const p of proxies) await p.stop();
  await harness.stop();
});

async function proxyToIrcd(protocol: 'socks5' | 'http'): Promise<FakeProxy> {
  const proxy = await FakeProxy.start({
    protocol,
    forwardTo: { host: '127.0.0.1', port: ircd.port },
  });
  proxies.push(proxy);
  return proxy;
}

function makeNetwork(nick: string, fields: Record<string, unknown> = {}): Network {
  return createNetwork(userId, {
    name: `engine-proxy-${seq++}`,
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
    ...fields,
  })!;
}

function connect(network: Network): IrcConnection {
  const conn = new IrcConnection({ network, onEvent: () => {} });
  conn.connect();
  return conn;
}

describe('proxied connections through the engine', () => {
  it.each(['socks5', 'http'] as const)('registers through a %s proxy', async (protocol) => {
    const proxy = await proxyToIrcd(protocol);
    const network = makeNetwork(`viaproxy${protocol}`, {
      proxy_enabled: true,
      proxy_type: protocol,
      proxy_host: '127.0.0.1',
      proxy_port: proxy.port,
    });
    const conn = connect(network);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected through the proxy');
      // The engine opened the socket, so the proxy having seen the request is
      // the only proof that the app's setting crossed the link at all.
      expect(proxy.requests.length).toBeGreaterThan(0);
      expect(proxy.lastRequest).toMatchObject({ port: ircd.port });
    } finally {
      conn.dispose();
    }
  });

  it('dials direct when the proxy is configured but disabled', async () => {
    const proxy = await proxyToIrcd('socks5');
    const before = proxy.requests.length;
    const network = makeNetwork('proxyoff', {
      proxy_enabled: false,
      proxy_type: 'socks5',
      proxy_host: '127.0.0.1',
      proxy_port: proxy.port,
    });
    const conn = connect(network);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected directly');
      expect(proxy.requests.length).toBe(before);
    } finally {
      conn.dispose();
    }
  });

  // ⚠⚠ See the header. This is the silent-failure case.
  it('refuses to dial through an engine that predates the field', async () => {
    const proxy = await proxyToIrcd('socks5');
    const before = proxy.requests.length;
    const network = makeNetwork('skewedproxy', {
      proxy_enabled: true,
      proxy_type: 'socks5',
      proxy_host: '127.0.0.1',
      proxy_port: proxy.port,
    });
    const link = EngineLink.shared();
    const real = link.engineMinor;
    link.engineMinor = 4;
    try {
      const conn = connect(network);
      try {
        await until(() => conn.state === 'disconnected', 5000, 'refused');
        // Neither route was taken: not through the proxy, and — the point —
        // not around it either.
        expect(proxy.requests.length).toBe(before);
        expect(ircd.client('skewedproxy')).toBeUndefined();
      } finally {
        conn.dispose();
      }
    } finally {
      link.engineMinor = real;
    }
  });

  it('still dials through an old engine when the network has no proxy', async () => {
    // The gate is about the network's setting, not about the engine's age: an
    // unproxied network must keep working against every engine it ever did.
    const network = makeNetwork('oldengineok');
    const link = EngineLink.shared();
    const real = link.engineMinor;
    link.engineMinor = 4;
    try {
      const conn = connect(network);
      try {
        await until(() => conn.state === 'connected', 5000, 'connected');
        expect(conn.state).toBe('connected');
        expect(ircd.client('oldengineok')).toBeDefined();
      } finally {
        conn.dispose();
      }
    } finally {
      link.engineMinor = real;
    }
  });
});
