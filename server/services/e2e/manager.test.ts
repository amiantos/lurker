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

  it('hints (with the channel) instead of silently dropping a KEYREQ for a not-enabled channel (#382)', () => {
    // #later is never configured for Alice — a disabled channel. A peer's KEYREQ
    // must surface a routable hint, not vanish (the "awaiting a session" bug).
    const req = mgr.buildKeyReq(bob, bobNet, '#later')!;
    const out = mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', req)!;
    expect(out.replies).toHaveLength(0); // never auto-responds on a disabled channel
    expect(out.channel).toBe('#later'); // routable to the channel buffer
    expect(out.notice?.text).toMatch(/\/e2e on #later/);
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

    // The new (signature-verified) key was remembered — after out-of-band
    // verification, /e2e reverify installs it in place, replacing the old one.
    const before = mgr.verifyInfo(alice, aliceNet, BOB_H)!.fingerprintHex;
    const outcome = mgr.reverifyPeer(alice, aliceNet, BOB_H);
    expect(outcome).toMatchObject({ kind: 'applied', change: 'fingerprint-changed' });
    const after = mgr.verifyInfo(alice, aliceNet, BOB_H)!;
    expect(after.status).toBe('trusted');
    expect(after.fingerprintHex).not.toBe(before); // the pinned key actually changed
    mgr.forgetPeer(alice, aliceNet, BOB_H); // restore the shared keyring for later tests
  });

  it('treats a pinned peer with a null stored handle as handle-changed (matches repartee)', async () => {
    // The null-last_handle state is reachable via an imported repartee keyring.
    // repartee's `last_handle != Some(new)` flags this as a change; Lurker must
    // not silently swallow it as 'known'.
    const keyring = await import('../../db/e2e.js');
    fullHandshake('#nullh'); // pin Bob's fp under BOB_H, trusted
    const peer = keyring.getPeerByHandle(alice, aliceNet, BOB_H)!;
    keyring.upsertPeer(alice, aliceNet, {
      fingerprint: peer.fingerprint,
      pubkey: peer.pubkey,
      lastHandle: null, // simulate an imported peer carrying no handle
      lastNick: null,
      firstSeen: peer.firstSeen,
      lastSeen: peer.lastSeen,
      globalStatus: 'trusted', // ignored on conflict; the row stays trusted
    });

    // Bob re-handshakes under BOB_H. A null stored handle must surface a
    // handle-changed warning (refused), not a silent re-handshake.
    mgr.setChannelConfig(bob, bobNet, '#nullh', true, 'auto-accept');
    const out = mgr.handleHandshakeBody(
      alice,
      aliceNet,
      BOB_H,
      'bob',
      mgr.buildKeyReq(bob, bobNet, '#nullh')!,
    )!;
    expect(out.replies).toHaveLength(0);
    expect(out.notice?.level).toBe('warn');
    expect(out.notice?.text).toMatch(/new handle/);

    // Restore the shared keyring: the row now has a NULL handle, so the
    // handle-keyed forgetPeer can't reach it — delete by fingerprint.
    keyring.deletePeerByFingerprint(alice, aliceNet, peer.fingerprint);
    mgr.forgetPeer(alice, aliceNet, BOB_H); // sessions/recipients/pending
    mgr.forgetPeer(bob, bobNet, ALICE_H);
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

    expect(mgr.reverifyPeer(bob, bobNet, ALICE_H)).toMatchObject({ kind: 'cleared' });
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

  it('reverify accepts a handle change IN PLACE — re-pins the key under the new handle (1d-2)', () => {
    fullHandshake('#hc2'); // pins Bob's fp under BOB_H, trusted
    const NEW_BOB = '~bob@newhost2';
    // Bob re-handshakes under a new ident@host (same identity) → handle-changed
    // block, which now also remembers the change.
    const req = mgr.buildKeyReq(bob, bobNet, '#hc2')!;
    const out = mgr.handleHandshakeBody(alice, aliceNet, NEW_BOB, 'bob', req)!;
    expect(out.notice?.text).toMatch(/new handle/);
    expect(mgr.verifyInfo(alice, aliceNet, NEW_BOB)).toBeNull(); // not pinned under the new handle yet

    // User verified out-of-band → accept in place. No re-handshake, no delete.
    expect(mgr.reverifyPeer(alice, aliceNet, NEW_BOB)).toMatchObject({
      kind: 'applied',
      change: 'handle-changed',
    });
    expect(mgr.verifyInfo(alice, aliceNet, NEW_BOB)?.status).toBe('trusted');
    mgr.forgetPeer(alice, aliceNet, NEW_BOB); // restore the shared keyring for later tests
  });

  it('reverify with no remembered change falls back to a clean forget', () => {
    fullHandshake('#nochange');
    expect(mgr.reverifyPeer(alice, aliceNet, BOB_H)).toMatchObject({ kind: 'cleared' });
    expect(mgr.verifyInfo(alice, aliceNet, BOB_H)).toBeNull();
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

// ─── Phase 2: channel key rotation / REKEY distribution ──────────────────────
describe('E2eManager key rotation (Phase 2)', () => {
  // A third account so rotation can target one peer while keeping another.
  let carol: number;
  let carolNet: number;
  const CAROL_H = '~carol@c.host';

  beforeAll(() => {
    carol = createUser('mgr-carol').id;
    carolNet = createNetwork(carol, {
      name: 'libera',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    })!.id;
  });

  // Bidirectional handshake of (uid,net,handle,nick) with Alice on `channel`,
  // both auto-accept — leaves Alice holding `handle` as an outgoing recipient
  // (the precondition for rotation to target them).
  function handshakeWithAlice(
    uid: number,
    net: number,
    handle: string,
    nick: string,
    channel: string,
  ): void {
    // The keyring (DB) is shared across tests; clear any pin/session a prior
    // test left (e.g. a revoke) so this is a clean first-contact handshake
    // regardless of test order.
    mgr.forgetPeer(alice, aliceNet, handle);
    mgr.forgetPeer(uid, net, ALICE_H);
    mgr.setChannelConfig(alice, aliceNet, channel, true, 'auto-accept');
    mgr.setChannelConfig(uid, net, channel, true, 'auto-accept');
    const aOut = mgr.handleHandshakeBody(
      alice,
      aliceNet,
      handle,
      nick,
      mgr.buildKeyReq(uid, net, channel)!,
    )!;
    expect(aOut.replies).toHaveLength(2); // KEYRSP + reciprocal KEYREQ
    mgr.handleHandshakeBody(uid, net, ALICE_H, 'alice', aOut.replies[0]); // installs Alice's key
    const peerOut = mgr.handleHandshakeBody(uid, net, ALICE_H, 'alice', aOut.replies[1])!;
    if (peerOut.replies.length) {
      mgr.handleHandshakeBody(alice, aliceNet, handle, nick, peerOut.replies[0]); // Alice installs theirs
    }
  }

  it('lazy-rotates on revoke and distributes a REKEY to the remaining recipient only', () => {
    const ch = '#rot-revoke';
    handshakeWithAlice(bob, bobNet, BOB_H, 'bob', ch);
    handshakeWithAlice(carol, carolNet, CAROL_H, 'carol', ch);

    // Before any rotation: both peers read Alice's message, nothing queued.
    const first = encLines(alice, aliceNet, ch, 'before revoke');
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, ch, first[0])).toMatchObject({
      kind: 'plaintext',
    });
    expect(mgr.decryptIncoming(carol, carolNet, ALICE_H, ch, first[0])).toMatchObject({
      kind: 'plaintext',
    });
    expect(mgr.takePendingRekeySends(alice, aliceNet)).toEqual([]);

    // Revoke Bob → the next send rotates the key and ships a REKEY to Carol ONLY.
    expect(mgr.revokePeer(alice, aliceNet, BOB_H)).toBe(true);
    const second = encLines(alice, aliceNet, ch, 'after revoke');
    const sends = mgr.takePendingRekeySends(alice, aliceNet);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ channel: ch, targetHandle: CAROL_H });
    // Draining is one-shot.
    expect(mgr.takePendingRekeySends(alice, aliceNet)).toEqual([]);

    // Carol applies the REKEY (installs silently) and reads the new message;
    // Bob, cut off, can no longer decrypt Alice's post-revoke traffic.
    expect(mgr.handleHandshakeBody(carol, carolNet, ALICE_H, 'alice', sends[0].body)).toEqual({
      replies: [],
    });
    expect(mgr.decryptIncoming(carol, carolNet, ALICE_H, ch, second[0])).toMatchObject({
      kind: 'plaintext',
      text: 'after revoke',
    });
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, ch, second[0]).kind).not.toBe('plaintext');
  });

  it('rotateChannel queues a REKEY for every current recipient on the next send', () => {
    const ch = '#rot-manual';
    handshakeWithAlice(bob, bobNet, BOB_H, 'bob', ch);
    handshakeWithAlice(carol, carolNet, CAROL_H, 'carol', ch);

    expect(mgr.rotateChannel(alice, aliceNet, ch)).toBe(true);
    const lines = encLines(alice, aliceNet, ch, 'rotated');
    const sends = mgr.takePendingRekeySends(alice, aliceNet);
    expect(sends.map((s) => s.targetHandle).sort()).toEqual([BOB_H, CAROL_H].sort());

    // Every peer applies its REKEY and reads the message under the fresh key.
    for (const s of sends) {
      const peer =
        s.targetHandle === BOB_H ? { uid: bob, net: bobNet } : { uid: carol, net: carolNet };
      mgr.handleHandshakeBody(peer.uid, peer.net, ALICE_H, 'alice', s.body);
      expect(mgr.decryptIncoming(peer.uid, peer.net, ALICE_H, ch, lines[0])).toMatchObject({
        kind: 'plaintext',
        text: 'rotated',
      });
    }
  });

  it('rotateChannel is a no-op (false) when there is no outgoing session yet', () => {
    expect(mgr.rotateChannel(alice, aliceNet, '#rot-never')).toBe(false);
    expect(mgr.takePendingRekeySends(alice, aliceNet)).toEqual([]);
  });

  it('revoke cuts off an outgoing-only recipient (incomplete reciprocal handshake)', () => {
    // Regression: a peer who completed only HALF the handshake — they got our
    // channel key (so they can read us) but never answered our reciprocal KEYREQ,
    // so we hold NO incoming session for them. Revoke once enumerated rotation
    // channels from incoming sessions alone and silently missed this peer.
    const ch = '#rv-outgoing-only';
    mgr.forgetPeer(alice, aliceNet, BOB_H);
    mgr.forgetPeer(bob, bobNet, ALICE_H);
    mgr.setChannelConfig(alice, aliceNet, ch, true, 'auto-accept');
    mgr.setChannelConfig(bob, bobNet, ch, true, 'auto-accept');

    // Bob → KEYREQ; Alice auto-accepts → KEYRSP (records Bob as an outgoing
    // recipient) + a reciprocal KEYREQ. Bob applies the KEYRSP but never answers
    // the reciprocal, so Alice has the recipient row but no incoming session.
    const aOut = mgr.handleHandshakeBody(
      alice,
      aliceNet,
      BOB_H,
      'bob',
      mgr.buildKeyReq(bob, bobNet, ch)!,
    )!;
    expect(aOut.replies).toHaveLength(2); // KEYRSP + reciprocal KEYREQ
    mgr.handleHandshakeBody(bob, bobNet, ALICE_H, 'alice', aOut.replies[0]); // Bob installs Alice's key
    // aOut.replies[1] (Alice's reciprocal KEYREQ) is intentionally dropped.

    // Precondition: Bob can read Alice (he has her current channel key).
    const pre = encLines(alice, aliceNet, ch, 'pre-revoke');
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, ch, pre[0])).toMatchObject({
      kind: 'plaintext',
    });

    // Revoke Bob → the next send must rotate the key away from him even though
    // there was never an incoming session on this channel.
    expect(mgr.revokePeer(alice, aliceNet, BOB_H)).toBe(true);
    const post = encLines(alice, aliceNet, ch, 'post-revoke');
    // Bob was the only recipient and was dropped, so nothing is re-keyed to him.
    expect(mgr.takePendingRekeySends(alice, aliceNet)).toEqual([]);
    // And he can no longer decrypt Alice's post-revoke traffic.
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, ch, post[0]).kind).not.toBe('plaintext');

    // Clean up the shared DB: leaving Bob revoked would block a later
    // re-handshake in another test (the keyring is shared across this file).
    mgr.forgetPeer(alice, aliceNet, BOB_H);
    mgr.forgetPeer(bob, bobNet, ALICE_H);
  });

  it('rejects a replayed REKEY (nonce-LRU) so a superseded key cannot be reinstalled', () => {
    const ch = '#rot-replay';
    handshakeWithAlice(carol, carolNet, CAROL_H, 'carol', ch);

    // First rotation → REKEY #1 to Carol; she installs it.
    mgr.rotateChannel(alice, aliceNet, ch);
    encLines(alice, aliceNet, ch, 'r1');
    const rekey1 = mgr.takePendingRekeySends(alice, aliceNet)[0].body;
    mgr.handleHandshakeBody(carol, carolNet, ALICE_H, 'alice', rekey1);

    // Second rotation → REKEY #2; Carol now reads under the newest key.
    mgr.rotateChannel(alice, aliceNet, ch);
    const msg2 = encLines(alice, aliceNet, ch, 'r2');
    const rekey2 = mgr.takePendingRekeySends(alice, aliceNet)[0].body;
    mgr.handleHandshakeBody(carol, carolNet, ALICE_H, 'alice', rekey2);
    expect(mgr.decryptIncoming(carol, carolNet, ALICE_H, ch, msg2[0])).toMatchObject({
      kind: 'plaintext',
      text: 'r2',
    });

    // Replaying the FIRST REKEY is ignored (nonce already seen) and must NOT
    // reinstall the superseded key — Carol still reads Alice's current traffic.
    expect(mgr.handleHandshakeBody(carol, carolNet, ALICE_H, 'alice', rekey1)).toEqual({
      replies: [],
    });
    const msg3 = encLines(alice, aliceNet, ch, 'r3');
    expect(mgr.decryptIncoming(carol, carolNet, ALICE_H, ch, msg3[0])).toMatchObject({
      kind: 'plaintext',
      text: 'r3',
    });
  });
});

// ─── keyring portability: /e2e export · import ───────────────────────────────
describe('E2eManager keyring export/import', () => {
  let dave: number;
  let daveNet: number;

  beforeAll(() => {
    dave = createUser('mgr-dave').id;
    daveNet = createNetwork(dave, {
      name: 'libera',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    })!.id;
  });

  const strip = (json: string): Record<string, unknown> => {
    const o = JSON.parse(json) as Record<string, unknown>;
    delete o.exportedAt; // export time, not keyring content
    return o;
  };

  it('round-trips a full keyring losslessly through the DB (export → import → export)', () => {
    const ch = '#exp';
    fullHandshake(ch); // alice gets an identity, a bob peer pin, sessions, a channel config
    mgr.addAutotrust(alice, aliceNet, 'global', '*@trusted.host');

    const e1 = mgr.exportKeyring(alice, aliceNet);
    expect(e1.ok).toBe(true);
    if (!e1.ok) return;
    // Earlier tests share alice's keyring, so assert relationships, not absolutes.
    expect(e1.counts.peers).toBeGreaterThanOrEqual(1);
    expect(e1.counts.autotrust).toBeGreaterThanOrEqual(1);

    // Import into a DIFFERENT account+network — a clean migration target.
    const imp = mgr.importKeyring(dave, daveNet, e1.json);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    expect(imp.identityChanged).toBe(true); // dave had no identity
    expect(imp.counts).toEqual(e1.counts); // every row imported

    // Re-exporting the imported keyring reproduces the same document (modulo the
    // export timestamp) — proves the seal/unseal + replace path is lossless.
    const e2 = mgr.exportKeyring(dave, daveNet);
    expect(e2.ok).toBe(true);
    if (!e2.ok) return;
    expect(strip(e2.json)).toEqual(strip(e1.json));

    // Dave now holds Alice's identity fingerprint.
    expect(mgr.getIdentity(dave)?.fingerprintHex).toBe(mgr.getIdentity(alice)?.fingerprintHex);
  });

  it('reports identityChanged=false when re-importing the same identity', () => {
    fullHandshake('#exp2');
    const e = mgr.exportKeyring(alice, aliceNet);
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    mgr.importKeyring(dave, daveNet, e.json); // first import sets dave's identity
    const again = mgr.importKeyring(dave, daveNet, e.json); // same identity again
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.identityChanged).toBe(false);
  });

  it('rejects malformed input without touching the keyring', () => {
    fullHandshake('#exp3');
    const before = mgr.exportKeyring(alice, aliceNet);
    expect(before.ok).toBe(true);
    const bad = mgr.importKeyring(alice, aliceNet, '{ not valid json');
    expect(bad.ok).toBe(false);
    // Alice's keyring is unchanged (import validated-then-replaced; nothing ran).
    const after = mgr.exportKeyring(alice, aliceNet);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(strip(after.json)).toEqual(strip(before.json));
  });

  it('exports ok:false when there is no identity yet', () => {
    const fresh = createUser('mgr-noident').id;
    const freshNet = createNetwork(fresh, {
      name: 'libera',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    })!.id;
    const e = mgr.exportKeyring(fresh, freshNet);
    expect(e.ok).toBe(false);
  });
});
