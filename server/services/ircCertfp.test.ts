// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// CertFP end to end (#459): a real IrcConnection, over real TLS, against an ircd
// that asks for a client certificate and only recognises fingerprints somebody
// registered — which is the whole of CertFP as a client experiences it.
//
// Asserting on the connect() option dict would prove nothing here. The claim the
// feature makes is that the network sees the fingerprint the UI told the user to
// paste into NickServ, and the only thing that can confirm that is a server
// looking at the certificate it was handed.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork, setNetworkClientCert } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { generateClientCert, describeClientCert } from '../utils/clientCert.js';
import { until } from '../test-utils/until.js';

let ircd: FakeIrcd;
let userId: number;
let seq = 0;

beforeAll(async () => {
  ircd = await FakeIrcd.start({ tls: true, requestClientCert: true, sasl: true });
  userId = createUser('certfp-int').id;
});

afterAll(async () => {
  await ircd.close();
});

// A network pointed at the fake ircd. trusted_certificates is 0 because the
// ircd's own cert is self-signed — that's the SERVER side of TLS and has
// nothing to do with the client certificate under test.
function makeNetwork(nick: string, fields: Record<string, unknown> = {}): Network {
  return createNetwork(userId, {
    name: `certfp-${seq++}`,
    host: '127.0.0.1',
    port: ircd.port,
    tls: true,
    trusted_certificates: false,
    nick,
    autoconnect: false,
    ...fields,
  })!;
}

function connect(network: Network): { conn: IrcConnection; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  const conn = new IrcConnection({
    network,
    onEvent: (e) => events.push(e as Record<string, unknown>),
  });
  conn.connect();
  return { conn, events };
}

describe('CertFP over a real TLS socket', () => {
  it('presents the attached certificate, and the network sees the registered fingerprint', async () => {
    const pair = await generateClientCert('certuser');
    const network = setNetworkClientCert(makeNetwork('certuser').id, userId, pair)!;

    const { conn } = connect(network);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      const client = ircd.client('certuser')!;
      // The fingerprint the UI tells the user to paste is the one on the wire.
      expect(client.certfp).toBe(describeClientCert(pair.cert).sha256);
    } finally {
      conn.dispose();
    }
  });

  it('logs in with SASL EXTERNAL once the fingerprint is registered, sending no password', async () => {
    const pair = await generateClientCert('extuser');
    const network = setNetworkClientCert(makeNetwork('extuser').id, userId, pair)!;
    // What `/msg NickServ CERT ADD` leaves behind.
    ircd.certfpAccounts.set(describeClientCert(pair.cert).sha256, 'extaccount');

    const { conn } = connect(network);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      const client = ircd.client('extuser')!;
      await until(() => client.account === 'extaccount', 5000, 'logged in');
      expect(client.sent).toContain('AUTHENTICATE EXTERNAL');
      // EXTERNAL carries no credential — the certificate already made the claim.
      expect(client.sent.some((l) => l.startsWith('AUTHENTICATE PLAIN'))).toBe(false);
      expect(client.sent).toContain('AUTHENTICATE +');
    } finally {
      conn.dispose();
    }
  });

  it('is refused by a network that has never seen the fingerprint', async () => {
    const pair = await generateClientCert('strangeruser');
    const network = setNetworkClientCert(makeNetwork('strangeruser').id, userId, pair)!;
    // Deliberately NOT registered at the fake NickServ.

    const { conn } = connect(network);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      const client = ircd.client('strangeruser')!;
      expect(client.sent).toContain('AUTHENTICATE EXTERNAL');
      // SASL is optional here, so the server keeps us — unauthenticated. That
      // is the shape #617 is about, and it's why the advice this failure
      // carries is asserted where the user actually reads it (the give-up
      // message in ircConnection.test.ts) rather than here: registering clears
      // the pending classification on the way past.
      expect(client.account).toBe(null);
    } finally {
      conn.dispose();
    }
  });

  it('keeps PLAIN when a SASL password is set, and still presents the certificate', async () => {
    const pair = await generateClientCert('plainuser');
    const network = setNetworkClientCert(
      makeNetwork('plainuser', { sasl_account: 'plainaccount', sasl_password: 'hunter2' }).id,
      userId,
      pair,
    )!;
    ircd.saslAccounts.set('plainaccount', 'hunter2');

    const { conn } = connect(network);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      const client = ircd.client('plainuser')!;
      await until(() => client.account === 'plainaccount', 5000, 'logged in');
      expect(client.sent).toContain('AUTHENTICATE PLAIN');
      expect(client.sent).not.toContain('AUTHENTICATE EXTERNAL');
      // Passive CertFP works alongside a password, so the certificate goes on
      // the wire either way — the password only decides the MECHANISM.
      expect(client.certfp).toBe(describeClientCert(pair.cert).sha256);
    } finally {
      conn.dispose();
    }
  });

  it('presents nothing, and asks for nothing, when no certificate is attached', async () => {
    const { conn } = connect(makeNetwork('barecert'));
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      const client = ircd.client('barecert')!;
      expect(client.certfp).toBe(null);
      expect(client.sent.some((l) => l.startsWith('AUTHENTICATE'))).toBe(false);
    } finally {
      conn.dispose();
    }
  });
});
