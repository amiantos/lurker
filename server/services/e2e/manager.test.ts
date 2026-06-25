// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolate the DB at a throwaway file before any db-touching module loads. No
// LURKER_SECRET_KEY is set — the keyring's sealing is a no-op passthrough, which
// the manager doesn't care about (it gets the same bytes back) and which keeps
// this file from leaking that env var into other test files.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-e2e-manager-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let mod: typeof import('./manager.js');
let createUser: typeof import('../../db/users.js').createUser;
let createNetwork: typeof import('../../db/networks.js').createNetwork;

// Two Lurker accounts standing in for the two ends of an encrypted conversation.
let alice: number;
let bob: number;
let aliceNet: number;
let bobNet: number;
const ALICE_H = '~alice@a.host';
const BOB_H = '~bob@b.host';

let clock: number;
let mgr: import('./manager.js').E2eManager;

beforeAll(async () => {
  mod = await import('./manager.js');
  ({ createUser } = await import('../../db/users.js'));
  ({ createNetwork } = await import('../../db/networks.js'));
  alice = createUser('mgr-alice').id;
  bob = createUser('mgr-bob').id;
  const mkNet = (uid: number) =>
    createNetwork(uid, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'n' })!.id;
  aliceNet = mkNet(alice);
  bobNet = mkNet(bob);
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  clock = 1_700_000_000_000;
  mgr = new mod.E2eManager({ now: () => clock });
});

// Encrypt and assert it produced wire lines (the happy path).
function encLines(uid: number, net: number, channel: string, text: string): string[] {
  const r = mgr.encryptOutgoing(uid, net, channel, text);
  if (r.kind !== 'encrypted') throw new Error(`expected encrypted, got ${r.kind}`);
  return r.lines;
}

// Drive a full bidirectional handshake on `channel` (auto-accept both ends).
function fullHandshake(channel: string): void {
  mgr.setChannelConfig(alice, aliceNet, channel, true, 'auto-accept');
  mgr.setChannelConfig(bob, bobNet, channel, true, 'auto-accept');
  // Bob → KEYREQ; Alice → KEYRSP + reciprocal KEYREQ.
  const req = mgr.buildKeyReq(bob, bobNet, channel)!;
  const aOut = mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', req)!;
  expect(aOut.replies).toHaveLength(2);
  mgr.handleHandshakeBody(bob, bobNet, ALICE_H, 'alice', aOut.replies[0]); // KEYRSP → Bob installs Alice's key
  const bOut = mgr.handleHandshakeBody(bob, bobNet, ALICE_H, 'alice', aOut.replies[1])!; // reciprocal
  expect(bOut.replies).toHaveLength(1); // Bob already trusts Alice → no further reciprocal
  mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', bOut.replies[0]); // KEYRSP → Alice installs Bob's key
}

describe('E2eManager handshake + exchange', () => {
  it('completes a full handshake and exchanges encrypted messages both ways', () => {
    fullHandshake('#x');

    const aToB = encLines(alice, aliceNet, '#x', 'hello bob');
    expect(aToB).toHaveLength(1);
    expect(aToB[0].startsWith('+RPE2E01')).toBe(true);
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#x', aToB[0])).toEqual({
      kind: 'plaintext',
      text: 'hello bob',
    });

    const bToA = encLines(bob, bobNet, '#x', 'hi alice 👋');
    expect(mgr.decryptIncoming(alice, aliceNet, BOB_H, '#x', bToA[0])).toEqual({
      kind: 'plaintext',
      text: 'hi alice 👋',
    });
  });

  it('chunks a long message and decrypts every chunk', () => {
    fullHandshake('#big');
    const long = 'x'.repeat(500);
    const lines = encLines(alice, aliceNet, '#big', long);
    expect(lines.length).toBeGreaterThan(1);
    const decoded = lines.map((l) => {
      const out = mgr.decryptIncoming(bob, bobNet, ALICE_H, '#big', l);
      return out.kind === 'plaintext' ? out.text : `<${out.kind}>`;
    });
    expect(decoded.join('')).toBe(long);
  });

  it('reports disabled (not plaintext) when the channel is not enabled', () => {
    expect(mgr.encryptOutgoing(alice, aliceNet, '#off', 'secret')).toEqual({ kind: 'disabled' });
  });

  it('reports error (never plaintext) when the message is too long to chunk', () => {
    fullHandshake('#toolong');
    const huge = 'x'.repeat(180 * 16 + 1); // exceeds MAX_CHUNKS * MAX_PLAINTEXT
    const r = mgr.encryptOutgoing(alice, aliceNet, '#toolong', huge);
    expect(r.kind).toBe('error');
  });

  it('passes a non-RPE2E line through as cleartext', () => {
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#x', 'just a normal line')).toEqual({
      kind: 'cleartext',
      text: 'just a normal line',
    });
  });

  it('reports missing-key when no session exists for the sender', () => {
    fullHandshake('#mk');
    const line = encLines(alice, aliceNet, '#mk', 'hi')[0];
    // Bob has a session for ALICE_H, but not for a different handle.
    expect(mgr.decryptIncoming(bob, bobNet, '~stranger@h', '#mk', line)).toEqual({
      kind: 'missing-key',
    });
  });
});

describe('E2eManager trust modes', () => {
  it('normal mode caches the KEYREQ and accepts on demand', () => {
    mgr.setChannelConfig(alice, aliceNet, '#nrm', true, 'normal');
    mgr.setChannelConfig(bob, bobNet, '#nrm', true, 'auto-accept');

    const req = mgr.buildKeyReq(bob, bobNet, '#nrm')!;
    const out = mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', req)!;
    expect(out.replies).toHaveLength(0); // no auto-response in normal mode
    expect(out.notice?.text).toMatch(/wants to start an encrypted session/);

    // Alice accepts → now she emits the KEYRSP (+ reciprocal).
    const accepted = mgr.acceptPending(alice, aliceNet, BOB_H, '#nrm');
    expect(accepted.replies.length).toBeGreaterThanOrEqual(1);
    mgr.handleHandshakeBody(bob, bobNet, ALICE_H, 'alice', accepted.replies[0]); // Bob installs Alice's key

    const line = encLines(alice, aliceNet, '#nrm', 'now secured')[0];
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#nrm', line)).toEqual({
      kind: 'plaintext',
      text: 'now secured',
    });
    // Accepting promotes the peer to trusted (#11).
    expect(mgr.verifyInfo(alice, aliceNet, BOB_H)?.status).toBe('trusted');
  });

  it('quiet mode silently ignores an unknown peer', () => {
    mgr.setChannelConfig(alice, aliceNet, '#qt', true, 'quiet');
    const req = mgr.buildKeyReq(bob, bobNet, '#qt')!;
    const out = mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', req)!;
    expect(out.replies).toHaveLength(0);
    expect(out.notice).toBeUndefined();
  });

  it('accept folds case — different handle/channel casing still finds the cached KEYREQ', () => {
    mgr.setChannelConfig(alice, aliceNet, '#NormCase', true, 'normal');
    const req = mgr.buildKeyReq(bob, bobNet, '#NormCase')!;
    mgr.handleHandshakeBody(alice, aliceNet, '~Bob@B.Host', 'Bob', req); // cached under one casing
    // Accept with a different casing of both handle and channel.
    const accepted = mgr.acceptPending(alice, aliceNet, '~bob@b.host', '#normcase');
    expect(accepted.replies.length).toBeGreaterThanOrEqual(1);
  });
});

describe('E2eManager TOFU + replay + window', () => {
  it('warns and refuses when a pinned handle presents a new fingerprint', () => {
    fullHandshake('#tofu'); // pins Bob's fp under BOB_H for Alice
    // A third identity (mallory) sends a KEYREQ impersonating BOB_H.
    const mallory = createUser('mgr-mallory').id;
    const malloryNet = createNetwork(mallory, {
      name: 'libera',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'm',
    })!.id;
    mgr.setChannelConfig(mallory, malloryNet, '#tofu', true, 'auto-accept');
    const impostorReq = mgr.buildKeyReq(mallory, malloryNet, '#tofu')!;

    const out = mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', impostorReq)!;
    expect(out.replies).toHaveLength(0); // refused
    expect(out.notice?.level).toBe('warn');
    expect(out.notice?.text).toMatch(/key changed/);
  });

  it('flags a replayed chunk', () => {
    fullHandshake('#rp');
    const line = encLines(alice, aliceNet, '#rp', 'once')[0];
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#rp', line)).toEqual({
      kind: 'plaintext',
      text: 'once',
    });
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#rp', line)).toEqual({ kind: 'replay' });
  });

  it('rejects a chunk whose ts is outside the tolerance window', () => {
    fullHandshake('#win');
    const line = encLines(alice, aliceNet, '#win', 'stale')[0];
    clock += 1000 * 1000; // advance 1000s, well past the 300s default tolerance
    const out = mgr.decryptIncoming(bob, bobNet, ALICE_H, '#win', line);
    expect(out.kind).toBe('rejected');
  });
});

describe('E2eManager identity + verify', () => {
  it('returns a stable per-account identity with a 6-word SAS', () => {
    const a1 = mgr.getIdentity(alice)!;
    const a2 = new mod.E2eManager({ now: () => clock }).getIdentity(alice)!; // reload from DB
    expect(a2.fingerprintHex).toBe(a1.fingerprintHex);
    expect(a1.sas.split(' ')).toHaveLength(6);
    // Different account → different identity.
    expect(mgr.getIdentity(bob)!.fingerprintHex).not.toBe(a1.fingerprintHex);
  });

  it('verifyInfo returns the peer fingerprint after a handshake', () => {
    fullHandshake('#vf');
    const info = mgr.verifyInfo(alice, aliceNet, BOB_H)!;
    expect(info.fingerprintHex).toBe(mgr.getIdentity(bob)!.fingerprintHex);
    expect(info.status).toBe('trusted');
  });

  it('revoke stops decryption; reverify clears the pin', () => {
    fullHandshake('#rv');
    const line = encLines(alice, aliceNet, '#rv', 'pre-revoke')[0];
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#rv', line).kind).toBe('plaintext');

    expect(mgr.revokePeer(bob, bobNet, ALICE_H)).toBe(true);
    const line2 = encLines(alice, aliceNet, '#rv', 'post-revoke')[0];
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#rv', line2).kind).toBe('rejected');

    expect(mgr.reverifyPeer(bob, bobNet, ALICE_H)).toBeGreaterThan(0);
    // After reverify the session is gone entirely.
    const line3 = encLines(alice, aliceNet, '#rv', 'after-reverify')[0];
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#rv', line3)).toEqual({
      kind: 'missing-key',
    });
  });
});

describe('E2eManager review hardening', () => {
  it('does not crash the singleton on a crafted all-zero ephemeral (#1/#2)', async () => {
    const hs = await import('./handshake.js');
    const idmod = await import('./identity.js');
    mgr.setChannelConfig(alice, aliceNet, '#az', true, 'auto-accept');
    // A real (self-signed) attacker KEYREQ whose ephemeral is the all-zero
    // X25519 point — noble rejects it inside deriveWrapKey.
    const atk = idmod.generateIdentity();
    const nonce = new Uint8Array(16);
    const zeroEph = new Uint8Array(32);
    const sig = idmod.sign(
      atk.secretKey,
      hs.sigPayloadKeyReq('#az', atk.publicKey, zeroEph, nonce),
    );
    const body = hs.encodeKeyReq({
      channel: '#az',
      pubkey: atk.publicKey,
      ephX25519: zeroEph,
      nonce,
      sig,
    });
    // Must drop, not throw out of the shared singleton.
    expect(mgr.handleHandshakeBody(alice, aliceNet, '~atk@h', 'atk', body)).toEqual({
      replies: [],
    });
  });

  it('warns rather than silently auto-migrating when a known key reappears under a new handle (#3)', () => {
    fullHandshake('#hc'); // pins Bob's fp under BOB_H for Alice
    const NEW_BOB = '~bob@newhost';
    const req = mgr.buildKeyReq(bob, bobNet, '#hc')!; // Bob's identity, new handshake
    const out = mgr.handleHandshakeBody(alice, aliceNet, NEW_BOB, 'bob', req)!;
    expect(out.replies).toHaveLength(0);
    expect(out.notice?.text).toMatch(/new handle/);
  });

  it('reverify drops the outbound pending so a stale KEYRSP cannot re-trust (#8)', () => {
    mgr.setChannelConfig(alice, aliceNet, '#stale', true, 'auto-accept');
    mgr.setChannelConfig(bob, bobNet, '#stale', true, 'auto-accept');
    // Bob → KEYREQ; Alice → KEYRSP + reciprocal (the reciprocal stores Alice's
    // pending, peerHandle = BOB_H).
    const aOut = mgr.handleHandshakeBody(
      alice,
      aliceNet,
      BOB_H,
      'bob',
      mgr.buildKeyReq(bob, bobNet, '#stale', ALICE_H)!,
    )!;
    // Bob answers Alice's reciprocal with his KEYRSP — capture but DON'T deliver.
    const bobRsp = mgr.handleHandshakeBody(bob, bobNet, ALICE_H, 'alice', aOut.replies[1])!
      .replies[0];

    mgr.reverifyPeer(alice, aliceNet, BOB_H); // clears Alice's pending for BOB_H

    // The stale KEYRSP now finds no pending → dropped, no re-trust.
    expect(mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', bobRsp)).toEqual({ replies: [] });
    expect(mgr.verifyInfo(alice, aliceNet, BOB_H)).toBeNull();
  });
});
