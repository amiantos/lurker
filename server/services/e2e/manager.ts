// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// E2eManager — the orchestration layer that ties the RPE2E crypto primitives
// (server/services/e2e/*) to the keyring (server/db/e2e.ts). A faithful port of
// repartee's manager.rs, adapted for Lurker's multi-tenant cell: it is a single
// process-wide instance whose in-memory state (pending handshakes, rate limiter,
// replay cache, identity cache) is keyed by (userId, networkId).
//
// It is IRC-agnostic: callers hand it parsed inbound bodies / plaintext / wire
// lines and it returns the bodies to send back, the wire lines to put on the
// wire, or a decrypt outcome. The IRC layer (a later phase) owns the actual
// NOTICE/PRIVMSG plumbing and the channel-vs-@handle `context` derivation.
//
// CRITICAL — this is a SHARED singleton: an uncaught throw crashes the cell for
// every tenant. So every public entry point is wrapped to turn an unexpected
// error (e.g. an attacker-crafted ephemeral that noble rejects, or an
// undecryptable sealed key after a LURKER_SECRET_KEY rotation) into a safe
// outcome. Security ordering, mirrored from the reference: rate-limit BEFORE
// crypto; verify signatures BEFORE touching state; install under strict TOFU.

import { randomBytes } from 'node:crypto';
import { equalBytes } from '@noble/curves/utils.js';

import { buildAad } from './aad.js';
import * as aead from './aead.js';
import { splitPlaintext } from './chunker.js';
import { DEFAULT_TS_TOLERANCE_SECS, rekeyInfo, wrapInfo } from './constants.js';
import { deriveWrapKey, ed25519SeedToX25519, generateEphemeral } from './ecdh.js';
import { utf8 } from './encoding.js';
import { fingerprint, fingerprintHex, fingerprintWords } from './fingerprint.js';
import {
  encodeKeyReq,
  encodeKeyRsp,
  type KeyRekey,
  type KeyReq,
  type KeyRsp,
  parseHandshake,
  sigPayloadKeyRekey,
  sigPayloadKeyReq,
  sigPayloadKeyRsp,
} from './handshake.js';
import { generateIdentity, type Identity, identityFromSeed, sign, verify } from './identity.js';
import { encodeChunk, freshMsgid, parseChunk } from './wire.js';
import * as keyring from '../../db/e2e.js';
import { RateLimiter } from './rateLimiter.js';
import { ReplayCache } from './replayCache.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

// In-memory state bounds (this is a long-lived multi-tenant singleton).
const PENDING_TTL_MS = 10 * 60_000; // outbound handshakes expire if unanswered
const PENDING_MAX = 4096;
const PENDING_INBOUND_TTL_MS = 30 * 60_000; // normal-mode prompts await /e2e accept
const PENDING_INBOUND_MAX = 4096;

const eqLower = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ─── public result shapes ────────────────────────────────────────────────────

export interface IdentityInfo {
  publicKey: Uint8Array;
  fingerprint: Uint8Array;
  fingerprintHex: string;
  /** Six-word BIP-39 short-authentication-string for out-of-band verification. */
  sas: string;
}

export interface UserNotice {
  level: 'info' | 'warn';
  text: string;
}

/** The result of handling an inbound handshake body: bodies to NOTICE back to
 *  the sender, and an optional user-facing notice for the buffer. */
export interface HandshakeOutcome {
  replies: string[];
  notice?: UserNotice;
}

export type EncryptOutcome =
  | { kind: 'disabled' } // E2E off for this channel — caller MAY send plaintext
  | { kind: 'encrypted'; lines: string[] }
  | { kind: 'error'; reason: string }; // enabled but failed — caller must NOT send plaintext

export type DecryptOutcome =
  | { kind: 'plaintext'; text: string }
  | { kind: 'cleartext'; text: string } // not an RPE2E line — pass through
  | { kind: 'missing-key' }
  | { kind: 'replay' }
  | { kind: 'rejected'; reason: string };

// ─── internal state ──────────────────────────────────────────────────────────

interface PendingHandshake {
  userId: number;
  networkId: number;
  channel: string;
  peerHandle: string | null;
  ephSecret: Uint8Array; // initiator's ephemeral X25519 secret
  createdAt: number; // epoch ms, for TTL expiry
}

interface PendingInbound {
  userId: number;
  networkId: number;
  handle: string;
  channel: string;
  req: KeyReq;
  createdAt: number;
}

type ClassifyResult = 'new' | 'known' | 'handle-changed' | 'fingerprint-changed' | 'revoked';

function isTofuBlock(c: ClassifyResult): boolean {
  return c === 'revoked' || c === 'fingerprint-changed' || c === 'handle-changed';
}

export interface E2eManagerOptions {
  /** Epoch-ms clock, injectable for tests. */
  now?: () => number;
  tsToleranceSecs?: number;
}

export class E2eManager {
  private readonly now: () => number;
  private readonly tsToleranceSecs: number;
  private readonly identities = new Map<number, Identity>();
  private readonly pending = new Map<string, PendingHandshake>();
  private readonly pendingInbound = new Map<string, PendingInbound>();
  private readonly rateLimiter: RateLimiter;
  private readonly replay: ReplayCache;

  constructor(opts: E2eManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.tsToleranceSecs = opts.tsToleranceSecs ?? DEFAULT_TS_TOLERANCE_SECS;
    this.rateLimiter = new RateLimiter(this.now);
    this.replay = new ReplayCache(100_000, this.now);
  }

  private nowUnix(): number {
    return Math.floor(this.now() / 1000);
  }

  // IRC identifiers are case-insensitive (the DB layer is COLLATE NOCASE), so
  // fold the handle here too — otherwise a case-varied handle gets its own
  // rate-limit bucket and the throttle is bypassed for the same peer.
  private rlKey(userId: number, networkId: number, handle: string): string {
    return `${userId}:${networkId}:${handle.toLowerCase()}`;
  }

  // ─── identity ──────────────────────────────────────────────────────────────

  /** Load (or first-time generate + persist) this account's identity. Cached. */
  private loadIdentity(userId: number): Identity {
    const cached = this.identities.get(userId);
    if (cached) return cached;

    const row = keyring.loadIdentity(userId);
    let id: Identity;
    if (row) {
      id = identityFromSeed(row.privkey);
      // Self-consistency: a stored pubkey/fingerprint that doesn't match the
      // secret means the keyring drifted — fail loud rather than sign with a
      // mismatched identity.
      if (!equalBytes(id.publicKey, row.pubkey)) {
        throw new Error('e2e: stored identity pubkey does not match secret');
      }
      if (!equalBytes(fingerprint(id.publicKey), row.fingerprint)) {
        throw new Error('e2e: stored identity fingerprint does not match pubkey');
      }
    } else {
      id = generateIdentity();
      keyring.saveIdentity(userId, {
        pubkey: id.publicKey,
        privkey: id.secretKey,
        fingerprint: fingerprint(id.publicKey),
        createdAt: this.nowUnix(),
      });
    }
    this.identities.set(userId, id);
    return id;
  }

  /** Public identity info for `/e2e fingerprint` / the lock UI. `null` if the
   *  identity can't be loaded (e.g. an unreadable sealed key after a key
   *  rotation) — never throws (singleton safety). */
  getIdentity(userId: number): IdentityInfo | null {
    try {
      const id = this.loadIdentity(userId);
      const fp = fingerprint(id.publicKey);
      return {
        publicKey: id.publicKey,
        fingerprint: fp,
        fingerprintHex: fingerprintHex(fp),
        sas: fingerprintWords(fp),
      };
    } catch (err) {
      console.warn(`e2e getIdentity: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── channel config ──────────────────────────────────────────────────────────

  /** Enable/disable E2E for a channel. Returns false (rather than throwing) if
   *  the write fails — singleton safety. */
  setChannelConfig(
    userId: number,
    networkId: number,
    channel: string,
    enabled: boolean,
    mode: keyring.ChannelMode,
  ): boolean {
    try {
      keyring.setChannelConfig(userId, networkId, { channel, enabled, mode });
      return true;
    } catch (err) {
      console.warn(`e2e setChannelConfig ${channel}: ${(err as Error).message}`);
      return false;
    }
  }

  // ─── outbound handshake ──────────────────────────────────────────────────────

  /** Build a KEYREQ to initiate (or extend) an encrypted session on `channel`,
   *  returning the CTCP body to NOTICE to the peer (or `null` if the identity /
   *  crypto failed — never throws). Stores the pending ephemeral secret so the
   *  matching KEYRSP can be unwrapped. */
  buildKeyReq(
    userId: number,
    networkId: number,
    channel: string,
    peerHandle?: string,
  ): string | null {
    try {
      return encodeKeyReq(this.buildKeyReqStruct(userId, networkId, channel, peerHandle ?? null));
    } catch (err) {
      console.warn(`e2e buildKeyReq ${channel}: ${(err as Error).message}`);
      return null;
    }
  }

  private buildKeyReqStruct(
    userId: number,
    networkId: number,
    channel: string,
    peerHandle: string | null,
  ): KeyReq {
    const id = this.loadIdentity(userId);
    const nonce = new Uint8Array(randomBytes(16));
    const eph = generateEphemeral();
    const sigPayload = sigPayloadKeyReq(channel, id.publicKey, eph.publicKey, nonce);
    const sig = sign(id.secretKey, sigPayload);

    this.sweepPending();
    const nonceHex = Buffer.from(nonce).toString('hex');
    this.pending.set(`${userId}:${networkId}:${channel}:${nonceHex}`, {
      userId,
      networkId,
      channel,
      peerHandle,
      ephSecret: eph.secretKey,
      createdAt: this.now(),
    });

    return { channel, pubkey: id.publicKey, ephX25519: eph.publicKey, nonce, sig };
  }

  // ─── inbound handshake dispatch ──────────────────────────────────────────────

  /**
   * Process an inbound RPEE2E CTCP body. Returns `null` if it is not an RPEE2E
   * message, otherwise the bodies to NOTICE back to `senderHandle`'s nick plus
   * an optional user notice. Never throws (singleton safety).
   */
  handleHandshakeBody(
    userId: number,
    networkId: number,
    senderHandle: string,
    senderNick: string | null,
    body: string,
  ): HandshakeOutcome | null {
    let parsed;
    try {
      parsed = parseHandshake(body);
    } catch {
      return { replies: [] }; // malformed RPEE2E — drop quietly
    }
    if (!parsed) return null;
    try {
      switch (parsed.kind) {
        case 'KEYREQ':
          return this.handleKeyReq(userId, networkId, senderHandle, senderNick, parsed.msg);
        case 'KEYRSP':
          return this.handleKeyRsp(userId, networkId, senderHandle, parsed.msg);
        case 'REKEY':
          return this.handleRekey(userId, networkId, senderHandle, parsed.msg);
        default:
          return { replies: [] };
      }
    } catch (err) {
      // Attacker-crafted ephemeral noble rejects, undecryptable sealed key, etc.
      // — drop, never crash the singleton.
      console.warn(`e2e handshake from ${senderHandle}: ${(err as Error).message}`);
      return { replies: [] };
    }
  }

  private handleKeyReq(
    userId: number,
    networkId: number,
    senderHandle: string,
    senderNick: string | null,
    req: KeyReq,
  ): HandshakeOutcome {
    // Rate-limit gate FIRST — reject a flood before any crypto work.
    if (!this.rateLimiter.allowIncoming(this.rlKey(userId, networkId, senderHandle))) {
      return { replies: [] };
    }
    // Never handshake with ourselves (a replayed copy of our own KEYREQ).
    if (equalBytes(req.pubkey, this.loadIdentity(userId).publicKey)) return { replies: [] };
    // Verify the signature (binds the ephemeral) before touching any state.
    const payload = sigPayloadKeyReq(req.channel, req.pubkey, req.ephX25519, req.nonce);
    if (!verify(req.pubkey, payload, req.sig)) return { replies: [] };

    const mode = this.effectiveMode(userId, networkId, senderHandle, req.channel);
    if (mode === null) return { replies: [] }; // channel not enabled

    const fp = fingerprint(req.pubkey);
    const change = this.classifyPeerChange(userId, networkId, fp, senderHandle);
    if (isTofuBlock(change)) return { replies: [], notice: this.tofuWarning(senderHandle, change) };
    this.upsertSeenPeer(userId, networkId, fp, req.pubkey, senderHandle, senderNick);

    const alreadyTrusted = this.hasTrustedIncoming(userId, networkId, senderHandle, req.channel);
    if (mode === 'normal' && !alreadyTrusted) {
      this.cachePendingInbound(userId, networkId, senderHandle, req);
      const who = senderNick ?? senderHandle;
      return {
        replies: [],
        notice: {
          level: 'info',
          text: `${who} wants to start an encrypted session on ${req.channel} — /e2e accept ${who}`,
        },
      };
    }
    if (mode === 'quiet' && !alreadyTrusted) return { replies: [] };

    // auto-accept, or an already-trusted peer → respond.
    return this.buildKeyRspAndReciprocal(userId, networkId, senderHandle, req, alreadyTrusted);
  }

  private handleKeyRsp(
    userId: number,
    networkId: number,
    senderHandle: string,
    rsp: KeyRsp,
  ): HandshakeOutcome {
    // Cheap pre-filter: a KEYRSP for a channel we never initiated on is dropped
    // BEFORE the expensive verify + trial-ECDH, defeating a KEYRSP flood without
    // throttling legitimate handshakes.
    if (!this.hasPendingForChannel(userId, networkId, rsp.channel)) return { replies: [] };

    const payload = sigPayloadKeyRsp(
      rsp.channel,
      rsp.pubkey,
      rsp.ephemeralPub,
      rsp.wrapNonce,
      rsp.wrapCt,
      rsp.nonce,
    );
    if (!verify(rsp.pubkey, payload, rsp.sig)) return { replies: [] };

    const sk = this.consumePendingForKeyRsp(userId, networkId, rsp);
    if (!sk) return { replies: [] }; // no matching pending handshake

    const fp = fingerprint(rsp.pubkey);
    const change = this.classifyPeerChange(userId, networkId, fp, senderHandle);
    if (isTofuBlock(change)) return { replies: [], notice: this.tofuWarning(senderHandle, change) };

    // We initiated, so receiving the response is our consent → trust the peer.
    const now = this.nowUnix();
    keyring.upsertPeer(userId, networkId, {
      fingerprint: fp,
      pubkey: rsp.pubkey,
      lastHandle: senderHandle,
      lastNick: null,
      firstSeen: now,
      lastSeen: now,
      globalStatus: 'pending', // creates the row; setPeerStatus is the authority
    });
    keyring.setPeerStatus(userId, networkId, fp, 'trusted');

    if (!this.installIncoming(userId, networkId, senderHandle, rsp.channel, fp, sk, now)) {
      return { replies: [], notice: this.tofuWarning(senderHandle, 'fingerprint-changed') };
    }
    return {
      replies: [],
      notice: { level: 'info', text: `Encrypted session established with ${senderHandle}` },
    };
  }

  private handleRekey(
    userId: number,
    networkId: number,
    senderHandle: string,
    rekey: KeyRekey,
  ): HandshakeOutcome {
    // REKEY is infrequent (channel rotation) — a plain rate gate is fine here.
    if (!this.rateLimiter.allowIncoming(this.rlKey(userId, networkId, senderHandle))) {
      return { replies: [] };
    }
    if (equalBytes(rekey.pubkey, this.loadIdentity(userId).publicKey)) return { replies: [] };
    const payload = sigPayloadKeyRekey(
      rekey.channel,
      rekey.pubkey,
      rekey.ephPub,
      rekey.wrapNonce,
      rekey.wrapCt,
      rekey.nonce,
    );
    if (!verify(rekey.pubkey, payload, rekey.sig)) return { replies: [] };

    // NOTE: REKEY carries a signed 16-byte nonce but we don't yet track it, and
    // there's no ts window on this path — a captured REKEY from a known peer is
    // replayable (re-installs an old key). Latent for now (no REKEY distribution
    // is wired); add nonce-LRU + ts-skew here when Phase-2 channel rotation ships.
    const fp = fingerprint(rekey.pubkey);
    const change = this.classifyPeerChange(userId, networkId, fp, senderHandle);
    // A REKEY from a peer we've never handshaked with is illegitimate.
    if (change === 'new') return { replies: [] };
    if (isTofuBlock(change)) return { replies: [], notice: this.tofuWarning(senderHandle, change) };

    // ECDH from OUR Ed25519 identity (converted to X25519) with their fresh
    // ephemeral, HKDF under the REKEY domain separator.
    const id = this.loadIdentity(userId);
    const info = utf8.encode(rekeyInfo(rekey.channel));
    const wrapKey = deriveWrapKey(ed25519SeedToX25519(id.secretKey), rekey.ephPub, info);
    let sk: Uint8Array;
    try {
      sk = aead.decrypt(wrapKey, rekey.wrapNonce, info, rekey.wrapCt);
    } catch {
      return { replies: [] };
    }
    if (sk.length !== 32) return { replies: [] };

    if (
      !this.installIncoming(userId, networkId, senderHandle, rekey.channel, fp, sk, this.nowUnix())
    ) {
      return { replies: [], notice: this.tofuWarning(senderHandle, 'fingerprint-changed') };
    }
    return { replies: [] };
  }

  /** Accept a normal-mode KEYREQ cached for `/e2e accept`. */
  acceptPending(
    userId: number,
    networkId: number,
    senderHandle: string,
    channel: string,
  ): HandshakeOutcome {
    try {
      const key = this.inboundKey(userId, networkId, senderHandle, channel);
      const entry = this.pendingInbound.get(key);
      if (!entry) {
        return { replies: [], notice: { level: 'warn', text: 'no pending handshake to accept' } };
      }
      this.pendingInbound.delete(key);
      const alreadyTrusted = this.hasTrustedIncoming(userId, networkId, senderHandle, channel);
      return this.buildKeyRspAndReciprocal(
        userId,
        networkId,
        senderHandle,
        entry.req,
        alreadyTrusted,
      );
    } catch (err) {
      console.warn(`e2e accept ${senderHandle}: ${(err as Error).message}`);
      return { replies: [] };
    }
  }

  // Build the KEYRSP (wrapping our outgoing key) for `req`, plus a reciprocal
  // KEYREQ so the peer sends us their key too (symmetric handshake). Responding
  // is our consent, so the peer is promoted to trusted.
  private buildKeyRspAndReciprocal(
    userId: number,
    networkId: number,
    senderHandle: string,
    req: KeyReq,
    alreadyTrusted: boolean,
  ): HandshakeOutcome {
    const id = this.loadIdentity(userId);
    const fp = fingerprint(req.pubkey);
    keyring.setPeerStatus(userId, networkId, fp, 'trusted');

    const ourSk = this.getOrGenerateOutgoingKey(userId, networkId, req.channel);
    keyring.recordOutgoingRecipient(
      userId,
      networkId,
      req.channel,
      senderHandle,
      fp,
      this.nowUnix(),
    );

    const ourEph = generateEphemeral();
    const info = utf8.encode(wrapInfo(req.channel));
    const wrapKey = deriveWrapKey(ourEph.secretKey, req.ephX25519, info);
    const sealed = aead.encrypt(wrapKey, info, ourSk);

    const rspNonce = new Uint8Array(randomBytes(16));
    const rspPayload = sigPayloadKeyRsp(
      req.channel,
      id.publicKey,
      ourEph.publicKey,
      sealed.nonce,
      sealed.ciphertext,
      rspNonce,
    );
    const rsp: KeyRsp = {
      channel: req.channel,
      pubkey: id.publicKey,
      ephemeralPub: ourEph.publicKey,
      wrapNonce: sealed.nonce,
      wrapCt: sealed.ciphertext,
      nonce: rspNonce,
      sig: sign(id.secretKey, rspPayload),
    };

    const replies = [encodeKeyRsp(rsp)];
    // Reciprocal KEYREQ unless we already hold their key, rate-limited.
    if (
      !alreadyTrusted &&
      this.rateLimiter.allowOutgoing(this.rlKey(userId, networkId, senderHandle))
    ) {
      replies.push(
        encodeKeyReq(this.buildKeyReqStruct(userId, networkId, req.channel, senderHandle)),
      );
    }
    return { replies };
  }

  private consumePendingForKeyRsp(
    userId: number,
    networkId: number,
    rsp: KeyRsp,
  ): Uint8Array | null {
    this.sweepPending();
    const info = utf8.encode(wrapInfo(rsp.channel));
    for (const [key, ph] of this.pending) {
      if (ph.userId !== userId || ph.networkId !== networkId || ph.channel !== rsp.channel)
        continue;
      try {
        const wrapKey = deriveWrapKey(ph.ephSecret, rsp.ephemeralPub, info);
        const sk = aead.decrypt(wrapKey, rsp.wrapNonce, info, rsp.wrapCt);
        if (sk.length !== 32) continue;
        this.pending.delete(key); // consume only on success
        return sk;
      } catch {
        // Not the matching pending entry (or a bad ephemeral) — keep trying.
        continue;
      }
    }
    return null;
  }

  // Install an incoming session under strict TOFU. Returns false on a
  // fingerprint mismatch (caller surfaces the TOFU warning).
  private installIncoming(
    userId: number,
    networkId: number,
    handle: string,
    channel: string,
    fp: Uint8Array,
    sk: Uint8Array,
    createdAt: number,
  ): boolean {
    try {
      keyring.installIncomingSessionStrict(userId, networkId, {
        handle,
        channel,
        fingerprint: fp,
        sk,
        status: 'trusted',
        createdAt,
      });
      return true;
    } catch (err) {
      if (err instanceof keyring.HandleMismatchError) return false;
      throw err;
    }
  }

  // ─── encrypt / decrypt ───────────────────────────────────────────────────────

  /** Encrypt `plaintext` for `channel`. `disabled` means the caller may send
   *  plaintext; `error` means E2E is on but encryption failed — the caller must
   *  NOT fall back to plaintext (that would leak on an E2E channel). */
  encryptOutgoing(
    userId: number,
    networkId: number,
    channel: string,
    plaintext: string,
  ): EncryptOutcome {
    try {
      const cfg = keyring.getChannelConfig(userId, networkId, channel);
      if (!cfg || !cfg.enabled) return { kind: 'disabled' };

      let chunks: Uint8Array[];
      try {
        chunks = splitPlaintext(plaintext);
      } catch (e) {
        return { kind: 'error', reason: (e as Error).message };
      }

      const sk = this.getOrGenerateOutgoingKey(userId, networkId, channel);
      const total = chunks.length;
      const msgid = freshMsgid();
      const ts = this.nowUnix();
      const lines = chunks.map((chunk, idx) => {
        const part = idx + 1;
        const aad = buildAad(channel, msgid, ts, part, total);
        const sealed = aead.encrypt(sk, aad, chunk);
        return encodeChunk({
          msgid,
          ts,
          part,
          total,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
        });
      });
      return { kind: 'encrypted', lines };
    } catch (err) {
      console.warn(`e2e encrypt ${channel}: ${(err as Error).message}`);
      return { kind: 'error', reason: 'internal error' };
    }
  }

  /** Decrypt one inbound wire line. Never throws (singleton safety). */
  decryptIncoming(
    userId: number,
    networkId: number,
    senderHandle: string,
    channel: string,
    line: string,
  ): DecryptOutcome {
    try {
      let wire;
      try {
        wire = parseChunk(line);
      } catch {
        return { kind: 'rejected', reason: 'malformed RPE2E line' };
      }
      if (!wire) return { kind: 'cleartext', text: line };

      const skew = Math.abs(this.nowUnix() - wire.ts);
      if (skew > this.tsToleranceSecs) {
        return { kind: 'rejected', reason: `ts outside tolerance window (${skew}s skew)` };
      }

      const sess = keyring.getIncomingSession(userId, networkId, senderHandle, channel);
      if (!sess) return { kind: 'missing-key' };
      if (sess.status !== 'trusted') return { kind: 'rejected', reason: 'peer not trusted' };

      const aad = buildAad(channel, wire.msgid, wire.ts, wire.part, wire.total);
      let pt: Uint8Array;
      try {
        pt = aead.decrypt(sess.sk, wire.nonce, aad, wire.ciphertext);
      } catch {
        return { kind: 'rejected', reason: 'authentication failed' };
      }
      let text: string;
      try {
        text = decoder.decode(pt);
      } catch {
        return { kind: 'rejected', reason: 'invalid utf-8' };
      }

      // Replay check only AFTER a chunk authenticates, so unauthenticated
      // traffic can't poison the cache. ttl past the ts window covers the horizon.
      const replayKey = `${userId}:${networkId}:${channel}:${senderHandle}:${Buffer.from(
        wire.msgid,
      ).toString('hex')}:${wire.part}`;
      if (!this.replay.observe(replayKey, (this.tsToleranceSecs * 2 + 5) * 1000)) {
        return { kind: 'replay' };
      }
      return { kind: 'plaintext', text };
    } catch (err) {
      console.warn(`e2e decrypt ${channel} from ${senderHandle}: ${(err as Error).message}`);
      return { kind: 'rejected', reason: 'internal error' };
    }
  }

  // ─── trust operations ────────────────────────────────────────────────────────

  /** Their fingerprint + SAS for `/e2e verify <nick>`, or null if unknown. */
  verifyInfo(
    userId: number,
    networkId: number,
    handle: string,
  ): { fingerprintHex: string; sas: string; status: keyring.TrustStatus } | null {
    try {
      const peer = keyring.getPeerByHandle(userId, networkId, handle);
      if (!peer) return null;
      return {
        fingerprintHex: fingerprintHex(peer.fingerprint),
        sas: fingerprintWords(peer.fingerprint),
        status: peer.globalStatus,
      };
    } catch (err) {
      console.warn(`e2e verifyInfo ${handle}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Revoke a peer: mark them + their sessions revoked (no unsealing), and trip
   *  outgoing-key rotation on the affected channels so the revoked peer can no
   *  longer decrypt our FUTURE messages. */
  revokePeer(userId: number, networkId: number, handle: string): boolean {
    try {
      const peer = keyring.getPeerByHandle(userId, networkId, handle);
      if (peer) keyring.setPeerStatus(userId, networkId, peer.fingerprint, 'revoked');
      const channels = keyring.listIncomingChannelsForHandle(userId, networkId, handle);
      const revoked = keyring.revokeIncomingSessionsForHandle(userId, networkId, handle);
      for (const channel of channels) {
        keyring.markOutgoingPendingRotation(userId, networkId, channel);
        keyring.removeOutgoingRecipient(userId, networkId, channel, handle);
      }
      return peer !== null || revoked > 0;
    } catch (err) {
      console.warn(`e2e revoke ${handle}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Forget a peer entirely so the next handshake re-pins (TOFU reset). Returns
   *  the number of rows / pending entries cleared. */
  reverifyPeer(userId: number, networkId: number, handle: string): number {
    try {
      let cleared = 0;
      const peer = keyring.getPeerByHandle(userId, networkId, handle);
      if (peer) {
        keyring.deletePeerByFingerprint(userId, networkId, peer.fingerprint);
        cleared += 1;
      }
      cleared += keyring.deleteIncomingSessionsForHandle(userId, networkId, handle);
      cleared += keyring.deleteOutgoingRecipientsForHandle(userId, networkId, handle);
      cleared += this.clearPendingForHandle(userId, networkId, handle);
      return cleared;
    } catch (err) {
      console.warn(`e2e reverify ${handle}: ${(err as Error).message}`);
      return 0;
    }
  }

  // ─── private helpers ─────────────────────────────────────────────────────────

  private getOrGenerateOutgoingKey(userId: number, networkId: number, channel: string): Uint8Array {
    const sess = keyring.getOutgoingSession(userId, networkId, channel);
    if (sess && !sess.pendingRotation) return sess.sk;
    // No session yet, or a rotation is pending — generate a fresh key. (REKEY
    // distribution to existing recipients is a Phase-2 channel feature.)
    const fresh = aead.generateSessionKey();
    keyring.setOutgoingSession(userId, networkId, channel, fresh, this.nowUnix());
    return fresh;
  }

  private effectiveMode(
    userId: number,
    networkId: number,
    handle: string,
    channel: string,
  ): keyring.ChannelMode | null {
    const cfg = keyring.getChannelConfig(userId, networkId, channel);
    if (!cfg || !cfg.enabled) return null;
    if (keyring.autotrustMatches(userId, networkId, handle, channel)) return 'auto-accept';
    return cfg.mode;
  }

  // by-fingerprint first (matching the reference): a known fp returns
  // known/handle-changed/revoked; only an UNKNOWN fp consults the by-handle
  // pin to detect a key substitution.
  private classifyPeerChange(
    userId: number,
    networkId: number,
    fp: Uint8Array,
    handle: string,
  ): ClassifyResult {
    const byFp = keyring.getPeerByFingerprint(userId, networkId, fp);
    if (byFp) {
      if (byFp.globalStatus === 'revoked') return 'revoked';
      if (byFp.lastHandle && !eqLower(byFp.lastHandle, handle)) return 'handle-changed';
      return 'known';
    }
    const byHandle = keyring.getPeerByHandle(userId, networkId, handle);
    if (byHandle && !equalBytes(byHandle.fingerprint, fp)) return 'fingerprint-changed';
    return 'new';
  }

  private upsertSeenPeer(
    userId: number,
    networkId: number,
    fp: Uint8Array,
    pubkey: Uint8Array,
    handle: string,
    nick: string | null,
  ): void {
    const now = this.nowUnix();
    keyring.upsertPeer(userId, networkId, {
      fingerprint: fp,
      pubkey,
      lastHandle: handle,
      lastNick: nick,
      firstSeen: now,
      lastSeen: now,
      globalStatus: 'pending', // only the insert uses this; conflicts preserve
    });
  }

  private hasTrustedIncoming(
    userId: number,
    networkId: number,
    handle: string,
    channel: string,
  ): boolean {
    return keyring.getIncomingSession(userId, networkId, handle, channel)?.status === 'trusted';
  }

  private hasPendingForChannel(userId: number, networkId: number, channel: string): boolean {
    for (const ph of this.pending.values()) {
      if (ph.userId === userId && ph.networkId === networkId && ph.channel === channel) return true;
    }
    return false;
  }

  private cachePendingInbound(
    userId: number,
    networkId: number,
    handle: string,
    req: KeyReq,
  ): void {
    this.sweepPendingInbound();
    this.pendingInbound.set(this.inboundKey(userId, networkId, handle, req.channel), {
      userId,
      networkId,
      handle,
      channel: req.channel,
      req,
      createdAt: this.now(),
    });
  }

  private clearPendingForHandle(userId: number, networkId: number, handle: string): number {
    let cleared = 0;
    for (const [key, ph] of this.pending) {
      if (
        ph.userId === userId &&
        ph.networkId === networkId &&
        ph.peerHandle &&
        eqLower(ph.peerHandle, handle)
      ) {
        this.pending.delete(key);
        cleared += 1;
      }
    }
    for (const [key, pi] of this.pendingInbound) {
      if (pi.userId === userId && pi.networkId === networkId && eqLower(pi.handle, handle)) {
        this.pendingInbound.delete(key);
        cleared += 1;
      }
    }
    return cleared;
  }

  private sweepPending(): void {
    const now = this.now();
    for (const [k, ph] of this.pending) {
      if (now - ph.createdAt > PENDING_TTL_MS) this.pending.delete(k);
    }
    this.cap(this.pending, PENDING_MAX);
  }

  private sweepPendingInbound(): void {
    const now = this.now();
    for (const [k, pi] of this.pendingInbound) {
      if (now - pi.createdAt > PENDING_INBOUND_TTL_MS) this.pendingInbound.delete(k);
    }
    this.cap(this.pendingInbound, PENDING_INBOUND_MAX);
  }

  private cap(map: Map<string, unknown>, max: number): void {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  // Fold case so `/e2e accept` finds the cached KEYREQ even if the handle/
  // channel casing differs between the inbound message and the accept command.
  private inboundKey(userId: number, networkId: number, handle: string, channel: string): string {
    return `${userId}:${networkId}:${handle.toLowerCase()}:${channel.toLowerCase()}`;
  }

  private tofuWarning(handle: string, change: ClassifyResult): UserNotice {
    if (change === 'revoked') {
      return { level: 'warn', text: `Ignoring encrypted handshake from revoked peer ${handle}` };
    }
    if (change === 'handle-changed') {
      return {
        level: 'warn',
        text: `⚠ a known encryption key appeared under a new handle (${handle}) — verify, then /e2e reverify ${handle}`,
      };
    }
    return {
      level: 'warn',
      text: `⚠ encryption key changed for ${handle} — verify out-of-band, then /e2e reverify ${handle} to accept`,
    };
  }
}

/** Process-wide singleton used by the IRC layer. Tests construct their own
 *  instances (with an injected clock) to drive time-dependent paths. */
export const e2eManager = new E2eManager();
