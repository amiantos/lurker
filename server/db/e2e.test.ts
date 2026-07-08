// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolate the DB at a throwaway file, and configure a secret key so the at-rest
// sealing path is exercised — set BOTH before any db-touching module loads.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-e2e-keyring-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
process.env.LURKER_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');

let e2e: typeof import('./e2e.js');
let db: typeof import('./index.js').default;
let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let backfillEncryptColumns: typeof import('./secretBackfill.js').backfillEncryptColumns;

let userId: number;
let otherUserId: number;
let netA: number;
let netB: number;
let otherNet: number;

const key = (b: number) => new Uint8Array(32).fill(b);
const fp = (b: number) => new Uint8Array(16).fill(b);

beforeAll(async () => {
  e2e = await import('./e2e.js');
  db = (await import('./index.js')).default;
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ backfillEncryptColumns } = await import('./secretBackfill.js'));

  userId = createUser('keyring-alice').id;
  otherUserId = createUser('keyring-bob').id;
  const mkNet = (uid: number, name: string) =>
    createNetwork(uid, { name, host: 'h', port: 6697, tls: true, nick: 'n' })!.id;
  netA = mkNet(userId, 'libera');
  netB = mkNet(userId, 'oftc');
  otherNet = mkNet(otherUserId, 'libera');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('identity (per account, shared across networks)', () => {
  it('round-trips and is the same identity regardless of network', () => {
    e2e.saveIdentity(userId, {
      pubkey: key(1),
      privkey: key(2),
      fingerprint: fp(3),
      createdAt: 1000,
    });
    const loaded = e2e.loadIdentity(userId)!;
    expect(loaded.pubkey).toEqual(key(1));
    expect(loaded.privkey).toEqual(key(2));
    expect(loaded.fingerprint).toEqual(fp(3));
    expect(loaded.createdAt).toBe(1000);
  });

  it('seals the private key at rest (stored column is an lk1 envelope, not raw hex)', () => {
    const row = db.prepare(`SELECT privkey FROM e2e_identity WHERE user_id = ?`).get(userId) as {
      privkey: string;
    };
    expect(row.privkey.startsWith('lk1.')).toBe(true); // sealed, not raw hex
  });

  it('upserts (one row per account)', () => {
    e2e.saveIdentity(userId, { pubkey: key(5), privkey: key(6), fingerprint: fp(7), createdAt: 2 });
    const n = db.prepare(`SELECT COUNT(*) c FROM e2e_identity WHERE user_id = ?`).get(userId) as {
      c: number;
    };
    expect(n.c).toBe(1);
    expect(e2e.loadIdentity(userId)!.pubkey).toEqual(key(5));
  });

  it('returns null for an account with no identity', () => {
    expect(e2e.loadIdentity(otherUserId)).toBeNull();
  });
});

describe('peers', () => {
  const peer = (fpb: number, handle: string | null, lastSeen: number) => ({
    fingerprint: fp(fpb),
    pubkey: key(fpb),
    lastHandle: handle,
    lastNick: handle,
    firstSeen: 100,
    lastSeen,
    globalStatus: 'pending' as const,
  });

  it('upserts and preserves first_seen on conflict', () => {
    e2e.upsertPeer(userId, netA, peer(10, '~bob@a', 100));
    e2e.upsertPeer(userId, netA, { ...peer(10, '~bob@b', 200), firstSeen: 999 });
    const got = e2e.getPeerByFingerprint(userId, netA, fp(10))!;
    expect(got.lastHandle).toBe('~bob@b');
    expect(got.firstSeen).toBe(100); // preserved, not 999
    expect(got.lastSeen).toBe(200);
  });

  it('reverse-lookup by handle returns the most recently seen', () => {
    e2e.upsertPeer(userId, netA, peer(11, '~dup@x', 50));
    e2e.upsertPeer(userId, netA, peer(12, '~dup@x', 300));
    expect(e2e.getPeerByHandle(userId, netA, '~dup@x')!.fingerprint).toEqual(fp(12));
  });

  it('deletes by fingerprint and lists in first_seen order', () => {
    e2e.deletePeerByFingerprint(userId, netA, fp(10));
    expect(e2e.getPeerByFingerprint(userId, netA, fp(10))).toBeNull();
    const fps = e2e.listPeers(userId, netA).map((p) => p.fingerprint[0]);
    expect(fps).toEqual([11, 12]);
  });

  it('does not downgrade global_status on a routine re-upsert; setPeerStatus is explicit', () => {
    e2e.upsertPeer(userId, netA, { ...peer(15, '~t@h', 10), globalStatus: 'trusted' });
    // A routine re-sighting refreshing last_handle/last_seen passes the caller's
    // default 'pending' — must NOT clobber the trusted status.
    e2e.upsertPeer(userId, netA, peer(15, '~t@h2', 20));
    let got = e2e.getPeerByFingerprint(userId, netA, fp(15))!;
    expect(got.globalStatus).toBe('trusted');
    expect(got.lastHandle).toBe('~t@h2');
    // Explicit change still works.
    e2e.setPeerStatus(userId, netA, fp(15), 'revoked');
    got = e2e.getPeerByFingerprint(userId, netA, fp(15))!;
    expect(got.globalStatus).toBe('revoked');
  });
});

describe('incoming sessions + strict TOFU', () => {
  const sess = (handle: string, channel: string, fpb: number) => ({
    handle,
    channel,
    fingerprint: fp(fpb),
    sk: key(fpb),
    status: 'pending' as const,
    createdAt: 1,
  });

  it('installs, seals the session key, and round-trips', () => {
    e2e.installIncomingSessionStrict(userId, netA, sess('~p@h', '#chan', 20));
    const got = e2e.getIncomingSession(userId, netA, '~p@h', '#chan')!;
    expect(got.sk).toEqual(key(20));
    const raw = db
      .prepare(
        `SELECT sk FROM e2e_incoming_sessions WHERE user_id=? AND network_id=? AND handle=? AND channel=?`,
      )
      .get(userId, netA, '~p@h', '#chan') as { sk: string };
    expect(raw.sk.startsWith('lk1.')).toBe(true);
  });

  it('idempotent refresh with the same fingerprint is allowed', () => {
    expect(() =>
      e2e.installIncomingSessionStrict(userId, netA, { ...sess('~p@h', '#chan', 20), sk: key(99) }),
    ).not.toThrow();
    expect(e2e.getIncomingSession(userId, netA, '~p@h', '#chan')!.sk).toEqual(key(99));
  });

  it('rejects a different fingerprint for the same (handle, channel)', () => {
    let err: unknown;
    try {
      e2e.installIncomingSessionStrict(userId, netA, sess('~p@h', '#chan', 77));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(e2e.HandleMismatchError);
    expect((err as InstanceType<typeof e2e.HandleMismatchError>).kind).toBe('keyring');
    // existing row untouched
    expect(e2e.getIncomingSession(userId, netA, '~p@h', '#chan')!.fingerprint).toEqual(fp(20));
  });

  it('transitions status and filters trusted-for-channel', () => {
    e2e.setIncomingSession(userId, netA, sess('~q@h', '#chan', 30));
    e2e.updateIncomingStatus(userId, netA, '~p@h', '#chan', 'trusted');
    const trusted = e2e.listTrustedSessionsForChannel(userId, netA, '#chan').map((s) => s.handle);
    expect(trusted).toEqual(['~p@h']); // ~q@h still pending
  });

  it('deletes all sessions for a handle and reports the count', () => {
    e2e.setIncomingSession(userId, netA, sess('~multi@h', '#a', 40));
    e2e.setIncomingSession(userId, netA, sess('~multi@h', '#b', 40));
    expect(e2e.deleteIncomingSessionsForHandle(userId, netA, '~multi@h')).toBe(2);
    expect(e2e.getIncomingSession(userId, netA, '~multi@h', '#a')).toBeNull();
  });

  it('a same-fingerprint re-handshake rotates the key but preserves trust + created_at', () => {
    e2e.setIncomingSession(userId, netA, {
      handle: '~keep@h',
      channel: '#keep',
      fingerprint: fp(80),
      sk: key(80),
      status: 'trusted',
      createdAt: 5,
    });
    // Same fingerprint, NEW key, caller passes the default 'pending' + a new ts.
    e2e.installIncomingSessionStrict(userId, netA, {
      handle: '~keep@h',
      channel: '#keep',
      fingerprint: fp(80),
      sk: key(81),
      status: 'pending',
      createdAt: 999,
    });
    const got = e2e.getIncomingSession(userId, netA, '~keep@h', '#keep')!;
    expect(got.sk).toEqual(key(81)); // key rotated
    expect(got.status).toBe('trusted'); // trust NOT downgraded
    expect(got.createdAt).toBe(5); // original install time preserved
  });
});

describe('outgoing sessions', () => {
  it('sets, seals, and round-trips with pending_rotation default false', () => {
    e2e.setOutgoingSession(userId, netA, '#out', key(50), 123);
    const got = e2e.getOutgoingSession(userId, netA, '#out')!;
    expect(got.sk).toEqual(key(50));
    expect(got.pendingRotation).toBe(false);
    const raw = db
      .prepare(
        `SELECT sk FROM e2e_outgoing_sessions WHERE user_id=? AND network_id=? AND channel=?`,
      )
      .get(userId, netA, '#out') as { sk: string };
    expect(raw.sk.startsWith('lk1.')).toBe(true); // sealed, not raw hex
  });

  it('marks and clears pending rotation', () => {
    e2e.markOutgoingPendingRotation(userId, netA, '#out');
    expect(e2e.getOutgoingSession(userId, netA, '#out')!.pendingRotation).toBe(true);
    e2e.clearOutgoingPendingRotation(userId, netA, '#out');
    expect(e2e.getOutgoingSession(userId, netA, '#out')!.pendingRotation).toBe(false);
  });

  it('re-setting a session resets pending_rotation to false', () => {
    e2e.markOutgoingPendingRotation(userId, netA, '#out');
    e2e.setOutgoingSession(userId, netA, '#out', key(51), 200);
    expect(e2e.getOutgoingSession(userId, netA, '#out')!.pendingRotation).toBe(false);
  });
});

describe('channel config', () => {
  it('sets and reads enabled + mode', () => {
    e2e.setChannelConfig(userId, netA, { channel: '#c', enabled: true, mode: 'auto-accept' });
    const got = e2e.getChannelConfig(userId, netA, '#c')!;
    expect(got.enabled).toBe(true);
    expect(got.mode).toBe('auto-accept');
  });

  it('returns null when unconfigured', () => {
    expect(e2e.getChannelConfig(userId, netA, '#nope')).toBeNull();
  });
});

describe('autotrust', () => {
  it('adds idempotently and lists', () => {
    e2e.addAutotrust(userId, netA, 'global', '*@trusted.org', 1);
    e2e.addAutotrust(userId, netA, 'global', '*@trusted.org', 2); // dup ignored
    expect(e2e.listAutotrust(userId, netA)).toHaveLength(1);
  });

  it('matches via glob, honoring scope', () => {
    e2e.addAutotrust(userId, netA, '#secret', '~admin@*', 1);
    expect(e2e.autotrustMatches(userId, netA, '~bob@trusted.org', '#anywhere')).toBe(true); // global
    expect(e2e.autotrustMatches(userId, netA, '~admin@box', '#secret')).toBe(true); // channel-scoped
    expect(e2e.autotrustMatches(userId, netA, '~admin@box', '#other')).toBe(false); // wrong channel
    expect(e2e.autotrustMatches(userId, netA, '~nope@evil.com', '#secret')).toBe(false);
  });

  it('removes one rule by (scope, pattern), leaving a same-pattern rule in another scope', () => {
    e2e.addAutotrust(userId, netA, 'global', '~dup@*', 1);
    e2e.addAutotrust(userId, netA, '#room', '~dup@*', 1);
    e2e.removeAutotrust(userId, netA, 'global', '~dup@*');
    // The channel-scoped rule survives; the global one is gone.
    expect(e2e.autotrustMatches(userId, netA, '~dup@x', '#room')).toBe(true);
    expect(e2e.autotrustMatches(userId, netA, '~dup@x', '#elsewhere')).toBe(false);
    e2e.removeAutotrust(userId, netA, 'global', '*@trusted.org');
    expect(e2e.autotrustMatches(userId, netA, '~bob@trusted.org', '#anywhere')).toBe(false);
  });
});

describe('outgoing recipients', () => {
  it('records idempotently, preserves first_sent_at, lists by age', () => {
    e2e.recordOutgoingRecipient(userId, netA, '#r', '~a@h', fp(1), 100);
    e2e.recordOutgoingRecipient(userId, netA, '#r', '~b@h', fp(2), 200);
    e2e.recordOutgoingRecipient(userId, netA, '#r', '~a@h', fp(9), 999); // updates fp, keeps order
    const recips = e2e.listOutgoingRecipients(userId, netA, '#r');
    expect(recips.map((r) => r.handle)).toEqual(['~a@h', '~b@h']);
    expect(recips[0].fingerprint).toEqual(fp(9));
  });

  it('removes one and deletes-for-handle with a count', () => {
    e2e.removeOutgoingRecipient(userId, netA, '#r', '~b@h');
    expect(e2e.listOutgoingRecipients(userId, netA, '#r').map((r) => r.handle)).toEqual(['~a@h']);
    expect(e2e.deleteOutgoingRecipientsForHandle(userId, netA, '~a@h')).toBe(1);
  });
});

describe('scoping isolation', () => {
  it('does not leak across networks (same user)', () => {
    e2e.setChannelConfig(userId, netA, { channel: '#iso', enabled: true, mode: 'normal' });
    expect(e2e.getChannelConfig(userId, netB, '#iso')).toBeNull();
  });

  it('does not leak across tenants (the user_id predicate actually bites)', () => {
    // Seed a row under a DIFFERENT tenant's own network, then confirm our user
    // can't read it — if a query dropped its user_id predicate this would fail.
    e2e.setChannelConfig(otherUserId, otherNet, {
      channel: '#tenant',
      enabled: true,
      mode: 'quiet',
    });
    expect(e2e.getChannelConfig(otherUserId, otherNet, '#tenant')).not.toBeNull();
    expect(e2e.getChannelConfig(userId, otherNet, '#tenant')).toBeNull();
  });
});

describe('glob + enum parsing (pure helpers)', () => {
  it('globMatchCi handles * and ? case-insensitively', () => {
    expect(e2e.globMatchCi('*@host', '~Bob@HOST')).toBe(true);
    expect(e2e.globMatchCi('~a?@*', '~ab@anything')).toBe(true);
    expect(e2e.globMatchCi('exact', 'exact')).toBe(true);
    expect(e2e.globMatchCi('a*c', 'abd')).toBe(false);
    expect(e2e.globMatchCi('?', 'ab')).toBe(false);
  });

  it('enum parsing falls back to safe defaults like repartee', () => {
    expect(e2e.parseTrustStatus('bogus')).toBe('pending');
    expect(e2e.parseChannelMode('bogus')).toBe('normal');
    expect(e2e.parseChannelMode('auto')).toBe('auto-accept'); // alias
  });
});

describe('review hardening', () => {
  const sess = (handle: string, channel: string, fpb: number, status: 'pending' | 'trusted') => ({
    handle,
    channel,
    fingerprint: fp(fpb),
    sk: key(fpb),
    status,
    createdAt: 1,
  });

  it('folds IRC target case — strict TOFU catches a case-flipped channel (C1)', () => {
    e2e.installIncomingSessionStrict(userId, netA, sess('~cf@h', '#Case', 60, 'pending'));
    // Same logical channel, different casing, DIFFERENT fingerprint: must be a
    // handle mismatch, not a silent second row.
    expect(() =>
      e2e.installIncomingSessionStrict(userId, netA, sess('~cf@h', '#case', 61, 'pending')),
    ).toThrow(/fingerprint changed/);
    // Case-flipped lookup finds the one row.
    expect(e2e.getIncomingSession(userId, netA, '~CF@h', '#CASE')!.fingerprint).toEqual(fp(60));
  });

  it('folds case for channel-config lookups (C1)', () => {
    e2e.setChannelConfig(userId, netA, { channel: '#FoldMe', enabled: true, mode: 'auto-accept' });
    expect(e2e.getChannelConfig(userId, netA, '#foldme')!.enabled).toBe(true);
  });

  it('rejects a wrong-length key on the write side (C3)', () => {
    expect(() => e2e.setOutgoingSession(userId, netA, '#bad', new Uint8Array(16), 1)).toThrow(
      /key must be 32 bytes/,
    );
  });

  it('enforces blob length at the schema via CHECK (C3)', () => {
    expect(() =>
      e2e.upsertPeer(userId, netA, {
        fingerprint: new Uint8Array(15),
        pubkey: key(1),
        lastHandle: null,
        lastNick: null,
        firstSeen: 1,
        lastSeen: 1,
        globalStatus: 'pending',
      }),
    ).toThrow(/constraint/);
  });

  it('skips an unreadable trusted session instead of dropping the channel (C6)', () => {
    e2e.setIncomingSession(userId, netA, sess('~ok@h', '#mix', 62, 'trusted'));
    e2e.setIncomingSession(userId, netA, sess('~bad@h', '#mix', 63, 'trusted'));
    db.prepare(
      `UPDATE e2e_incoming_sessions SET sk = 'not-decryptable'
       WHERE user_id=? AND network_id=? AND handle=? AND channel=?`,
    ).run(userId, netA, '~bad@h', '#mix');
    expect(e2e.listTrustedSessionsForChannel(userId, netA, '#mix').map((s) => s.handle)).toEqual([
      '~ok@h',
    ]);
  });

  it('backfill re-seals a plaintext-hex secret from a keyless window (C2)', () => {
    // Simulate a keyless write: raw plaintext hex straight into the column.
    const rawHex = Buffer.from(key(70)).toString('hex');
    db.prepare(
      `INSERT INTO e2e_identity (user_id, pubkey, privkey, fingerprint, created_at) VALUES (?, ?, ?, ?, 1)`,
    ).run(otherUserId, Buffer.from(key(70)), rawHex, Buffer.from(fp(70)));
    const before = db
      .prepare(`SELECT privkey FROM e2e_identity WHERE user_id=?`)
      .get(otherUserId) as {
      privkey: string;
    };
    expect(before.privkey.startsWith('lk1.')).toBe(false);

    expect(backfillEncryptColumns().encrypted).toBeGreaterThanOrEqual(1);

    const after = db
      .prepare(`SELECT privkey FROM e2e_identity WHERE user_id=?`)
      .get(otherUserId) as {
      privkey: string;
    };
    expect(after.privkey.startsWith('lk1.')).toBe(true);
    expect(e2e.loadIdentity(otherUserId)!.privkey).toEqual(key(70)); // still round-trips
  });
});
