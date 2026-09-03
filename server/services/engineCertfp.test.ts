// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// CertFP through the engine (#459). The certificate is configured in the app's
// database and presented by a different process entirely, so the only assertion
// worth making is the one the ircd makes: the fingerprint on the handshake is
// the one the app was told to register.
//
// Also pinned here, because both are silent when wrong: an engine that predates
// the field must not be dialed through with a certificate attached, and changing
// the certificate must force a fresh dial rather than re-attaching to a socket
// still presenting the old one.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork, setNetworkClientCert } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import type { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';
import { EngineLink } from './engineLink.js';
import { generateClientCert, describeClientCert } from '../utils/clientCert.js';
import { until } from '../test-utils/until.js';

const SECRET = 'certfp-engine-secret';

let harness: EngineHarness;
let ircd: FakeIrcd;
let userId: number;
let seq = 0;

beforeAll(async () => {
  harness = await startEngineHarness({
    secret: SECRET,
    ircd: { tls: true, requestClientCert: true, sasl: true },
  });
  ircd = harness.ircd;
  userId = createUser('certfp-engine').id;
});

afterAll(async () => {
  await harness.stop();
});

function makeNetwork(nick: string): Network {
  return createNetwork(userId, {
    name: `engine-certfp-${seq++}`,
    host: '127.0.0.1',
    port: ircd.port,
    tls: true,
    // The ircd's own certificate is self-signed; that's the server side of TLS
    // and unrelated to the client certificate under test.
    trusted_certificates: false,
    nick,
    autoconnect: false,
  })!;
}

function connect(network: Network): IrcConnection {
  const conn = new IrcConnection({ network, onEvent: () => {} });
  conn.connect();
  return conn;
}

describe('CertFP through the engine', () => {
  it('presents the certificate the app holds, from the process that dials', async () => {
    const pair = await generateClientCert('engineuser');
    const network = setNetworkClientCert(makeNetwork('engineuser').id, userId, pair)!;
    ircd.certfpAccounts.set(describeClientCert(pair.cert).sha256, 'engineaccount');

    const conn = connect(network);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      const client = ircd.client('engineuser')!;
      expect(client.certfp).toBe(describeClientCert(pair.cert).sha256);
      // And it is good for more than the handshake: SASL EXTERNAL is spoken by
      // the app, over a socket the engine opened.
      await until(() => client.account === 'engineaccount', 5000, 'logged in');
    } finally {
      conn.dispose();
    }
  });

  // The engine holds sockets across app restarts, and a CONNECT for an id it
  // already holds is normally an attach. A changed certificate is a changed
  // identity, though: the held socket is still presenting the old one, and
  // services still know the user by the old fingerprint.
  it('re-dials rather than re-attaching when the certificate changes', async () => {
    const first = await generateClientCert('rotator');
    const network = setNetworkClientCert(makeNetwork('rotator').id, userId, first)!;

    const before = connect(network);
    await until(() => before.state === 'connected', 5000, 'first connect');
    expect(ircd.client('rotator')!.certfp).toBe(describeClientCert(first.cert).sha256);
    // Detach without ending the socket — what a redeploy looks like to the
    // engine, and the state in which an attach would be offered.
    before.detach();
    await until(() => before.state === 'disconnected', 5000, 'detached');

    const second = await generateClientCert('rotator');
    const rotated = setNetworkClientCert(network.id, userId, second)!;
    const after = connect(rotated);
    try {
      await until(
        () => ircd.registrations.filter((r) => r.nick === 'rotator').length === 2,
        5000,
        'second registration',
      );
      await until(() => after.state === 'connected', 5000, 'reconnected');
      const live = ircd.clients.filter((c) => c.nick === 'rotator' && !c.socket.destroyed);
      expect(live[live.length - 1].certfp).toBe(describeClientCert(second.cert).sha256);
    } finally {
      after.dispose();
    }
  });

  // An engine below minor 2 has no field to carry the key in and would ignore
  // it silently — leaving the app asking for SASL EXTERNAL over a socket that
  // presented nothing, and the user re-registering a fingerprint that was never
  // sent.
  it('refuses to dial through an engine that predates the field', async () => {
    const pair = await generateClientCert('skewed');
    const network = setNetworkClientCert(makeNetwork('skewed').id, userId, pair)!;
    const link = EngineLink.shared();
    const real = link.engineMinor;
    link.engineMinor = 1;
    try {
      const conn = connect(network);
      try {
        await until(() => conn.state === 'disconnected', 5000, 'refused');
        expect(ircd.client('skewed')).toBeUndefined();
      } finally {
        conn.dispose();
      }
    } finally {
      link.engineMinor = real;
    }
  });
});
