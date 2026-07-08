// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the DB layer at a throwaway file and configure an encryption key before
// importing anything that touches them — db/index.js reads DATABASE_PATH and
// secretCrypto.js reads LURKER_SECRET_KEY on first use.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-netsecrets-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
process.env.LURKER_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');

let db: typeof import('./index.js').default;
let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let updateNetwork: typeof import('./networks.js').updateNetwork;
let getNetwork: typeof import('./networks.js').getNetwork;
let listNetworksForUser: typeof import('./networks.js').listNetworksForUser;
let backfillEncryptColumns: typeof import('./secretBackfill.js').backfillEncryptColumns;
let isEncrypted: typeof import('../utils/secretCrypto.js').isEncrypted;

const SECRETS = {
  server_password: 'srv-pw',
  sasl_account: 'alice-acct',
  sasl_password: 'sasl-pw',
  connect_commands: 'PRIVMSG NickServ :identify nickserv-pw',
};

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ createUser } = await import('./users.js'));
  ({ createNetwork, updateNetwork, getNetwork, listNetworksForUser } =
    await import('./networks.js'));
  ({ backfillEncryptColumns } = await import('./secretBackfill.js'));
  ({ isEncrypted } = await import('../utils/secretCrypto.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Read the raw on-disk row, bypassing the decrypt chokepoint.
function rawRow(id: number): Record<string, string | null> {
  return db.prepare('SELECT * FROM networks WHERE id = ?').get(id) as Record<string, string | null>;
}

const SECRET_COLS = Object.keys(SECRETS) as (keyof typeof SECRETS)[];

describe('network secret encryption at rest (key configured)', () => {
  it('stores ciphertext at rest but returns plaintext from the accessors', () => {
    const alice = createUser('alice');
    const net = createNetwork(alice.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 'alice',
      ...SECRETS,
    })!;

    const raw = rawRow(net.id);
    for (const col of SECRET_COLS) {
      expect(isEncrypted(raw[col])).toBe(true);
      expect(raw[col]).not.toBe(SECRETS[col]);
    }

    // getNetwork and listNetworksForUser both decrypt.
    const fetched = getNetwork(net.id, alice.id)!;
    const listed = listNetworksForUser(alice.id).find((n) => n.id === net.id)!;
    for (const col of SECRET_COLS) {
      expect(fetched[col]).toBe(SECRETS[col]);
      expect(listed[col]).toBe(SECRETS[col]);
    }
  });

  it('re-encrypts on update and can clear a secret to null', () => {
    const bob = createUser('bob');
    const net = createNetwork(bob.id, {
      name: 'oftc',
      host: 'irc.oftc.net',
      port: 6697,
      tls: true,
      nick: 'bob',
      server_password: 'old-pw',
    })!;

    updateNetwork(net.id, bob.id, { server_password: 'new-pw', sasl_password: null });
    const raw = rawRow(net.id);
    expect(isEncrypted(raw.server_password)).toBe(true);
    expect(raw.sasl_password).toBeNull();

    const fetched = getNetwork(net.id, bob.id)!;
    expect(fetched.server_password).toBe('new-pw');
    expect(fetched.sasl_password).toBeNull();
  });

  it('backfill wraps pre-existing plaintext rows and is idempotent', () => {
    const carol = createUser('carol');
    const net = createNetwork(carol.id, {
      name: 'snoonet',
      host: 'irc.snoonet.org',
      port: 6697,
      tls: true,
      nick: 'carol',
    })!;
    // Simulate a legacy plaintext row (written before the key was configured).
    db.prepare('UPDATE networks SET server_password = ?, connect_commands = ? WHERE id = ?').run(
      'legacy-plain',
      'PRIVMSG NickServ :identify legacy',
      net.id,
    );
    expect(isEncrypted(rawRow(net.id).server_password)).toBe(false);

    const first = backfillEncryptColumns();
    expect(first.encrypted).toBeGreaterThanOrEqual(1);
    const raw = rawRow(net.id);
    expect(isEncrypted(raw.server_password)).toBe(true);
    expect(isEncrypted(raw.connect_commands)).toBe(true);
    expect(getNetwork(net.id, carol.id)!.server_password).toBe('legacy-plain');

    // Second run finds nothing left to wrap.
    expect(backfillEncryptColumns().encrypted).toBe(0);
  });
});
