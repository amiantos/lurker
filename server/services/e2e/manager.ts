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
import {
  deriveWrapKey,
  ed25519PubToX25519,
  ed25519SeedToX25519,
  generateEphemeral,
} from './ecdh.js';
import { utf8 } from './encoding.js';
import { fingerprint, fingerprintHex, fingerprintWords } from './fingerprint.js';
import {
  encodeKeyRekey,
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
import {
  buildPortable,
  countsOf,
  parseAndValidate,
  type PortableCounts,
  serializePortable,
} from './portable.js';
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
const KEYCHANGE_TTL_MS = 30 * 60_000; // a remembered key/handle change awaits /e2e reverify
const KEYCHANGE_MAX = 4096;
// A REKEY carries a signed 16-byte nonce but no timestamp. We remember each
// nonce we've accepted so a captured REKEY can't be re-injected to re-install a
// superseded key (a DoS, not a confidentiality break — the key is authentic).
// Generous TTL since REKEYs are infrequent; bounded so a churn of peers can't
// grow it unbounded. Resets on cell restart (same exposure the reference has,
// which tracks nothing at all).
const REKEY_REPLAY_TTL_MS = 24 * 60 * 60_000;
const REKEY_REPLAY_MAX = 10_000;

const eqLower = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Compact, stable string form of raw bytes for use as an in-memory map key.
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

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

/** A row in `/e2e list` — a peer/session with its trust status + short fp. */
export interface PeerListEntry {
  handle: string;
  status: keyring.TrustStatus;
  fingerprintHex: string;
}
export interface SessionListEntry extends PeerListEntry {
  channel: string;
}

/** The result of `/e2e reverify`. `applied` = a remembered key/handle change was
 *  accepted in place (re-pinned trusted, no re-handshake); `cleared` = no change
 *  was pending so we did a clean forget instead. */
export type ReverifyOutcome =
  | {
      kind: 'applied';
      change: 'fingerprint-changed' | 'handle-changed';
      oldFpHex: string;
      newFpHex: string;
    }
  | { kind: 'cleared'; cleared: number }
  | { kind: 'not-found' };

/** The result of handling an inbound handshake body: bodies to NOTICE back to
 *  the sender, and an optional user-facing notice for the buffer. */
export interface HandshakeOutcome {
  replies: string[];
  notice?: UserNotice;
  /** The channel/context this handshake is about, so the IRC layer can route
   *  `notice` to that buffer instead of the server buffer. Only set on
   *  notice-bearing outcomes (silent drops stay `{ replies: [] }`). */
  channel?: string;
}

export type EncryptOutcome =
  | { kind: 'disabled' } // E2E off for this channel — caller MAY send plaintext
  | { kind: 'encrypted'; lines: string[] }
  | { kind: 'error'; reason: string }; // enabled but failed — caller must NOT send plaintext

/** A REKEY CTCP produced by a lazy rotation, waiting for the IRC layer to ship.
 *  `body` is UNFRAMED (the IRC layer wraps it in `\x01..\x01` and resolves
 *  `targetHandle` → a current nick on `channel` before sending it as a NOTICE). */
export interface PendingRekeySend {
  channel: string;
  targetHandle: string;
  body: string;
}

/** Result of `exportKeyring` — the serialized JSON + row counts, or a reason. */
export type ExportResult =
  | { ok: true; json: string; counts: PortableCounts }
  | { ok: false; reason: string };

/** Result of `importKeyring`. `identityChanged` = the imported identity differs
 *  from the current account identity (now applies to ALL networks). */
export type ImportResult =
  | { ok: true; counts: PortableCounts; identityChanged: boolean; fingerprintHex: string }
  | { ok: false; reason: string };

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

/** A TOFU-blocked key/handle change we remember so `/e2e reverify <handle>` can
 *  accept it in place. `newPubkey` is signature-verified (the block happens after
 *  verify), so re-pinning it on the user's explicit out-of-band confirmation is
 *  safe. Keyed by the NEW handle the change appeared under. */
interface PendingKeyChange {
  kind: 'fingerprint-changed' | 'handle-changed';
  newPubkey: Uint8Array;
  channel: string;
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
  private readonly pendingKeyChange = new Map<string, PendingKeyChange>();
  // REKEY CTCPs queued by a lazy rotation, keyed by tenant (`userId:networkId`).
  // The IRC layer drains this right after each send (see takePendingRekeySends).
  private readonly pendingRekey = new Map<string, PendingRekeySend[]>();
  private readonly rateLimiter: RateLimiter;
  private readonly replay: ReplayCache;
  private readonly rekeyReplay: ReplayCache;

  constructor(opts: E2eManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.tsToleranceSecs = opts.tsToleranceSecs ?? DEFAULT_TS_TOLERANCE_SECS;
    this.rateLimiter = new RateLimiter(this.now);
    this.replay = new ReplayCache(100_000, this.now);
    this.rekeyReplay = new ReplayCache(REKEY_REPLAY_MAX, this.now);
  }

  private nowUnix(): number {
    return Math.floor(this.now() / 1000);
  }

  // Per-peer scope key shared by the rate-limiter, the key-change stash, and the
  // pending-inbound map. IRC identifiers are case-insensitive (the DB layer is
  // COLLATE NOCASE), so fold the handle here too — otherwise a case-varied handle
  // gets its own bucket and the throttle/stash is bypassed for the same peer.
  private peerKey(userId: number, networkId: number, handle: string): string {
    return `${userId}:${networkId}:${handle.toLowerCase()}`;
  }

  private rlKey(userId: number, networkId: number, handle: string): string {
    return this.peerKey(userId, networkId, handle);
  }

  private tenantKey(userId: number, networkId: number): string {
    return `${userId}:${networkId}`;
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

  /** Whether E2E is enabled for `channel`. The IRC layer's single egress/ingress
   *  gate: encrypt outgoing messages, refuse cleartext actions/notices, and
   *  attempt inbound decryption only on an enabled channel. Never throws. */
  isChannelEnabled(userId: number, networkId: number, channel: string): boolean {
    try {
      return keyring.getChannelConfig(userId, networkId, channel)?.enabled === true;
    } catch (err) {
      console.warn(`e2e isChannelEnabled ${channel}: ${(err as Error).message}`);
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

  /** Auto-initiate a handshake with `peerHandle` after we received ciphertext we
   *  couldn't read (a missing key), mirroring repartee's auto-KEYREQ on
   *  DecryptOutcome::MissingKey (events.rs). Returns the KEYREQ body to NOTICE to
   *  the sender, or null when the OUTGOING rate limiter says wait, when the peer
   *  is revoked (don't chase someone we cut off), or on a crypto/identity error.
   *  Rate-limiting here is what stops a multi-chunk message from firing N KEYREQs. */
  autoHandshakeBody(
    userId: number,
    networkId: number,
    channel: string,
    peerHandle: string,
  ): string | null {
    try {
      if (keyring.getPeerByHandle(userId, networkId, peerHandle)?.globalStatus === 'revoked') {
        return null;
      }
      if (!this.rateLimiter.allowOutgoing(this.rlKey(userId, networkId, peerHandle))) return null;
      return encodeKeyReq(this.buildKeyReqStruct(userId, networkId, channel, peerHandle));
    } catch (err) {
      console.warn(`e2e autoHandshake ${channel}: ${(err as Error).message}`);
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
    if (mode === null) {
      // Channel not enabled. Don't silently drop — the peer would sit "awaiting a
      // session" forever with nothing on our screen to explain it (the bug that
      // motivated this). The KEYREQ already cleared verify + rate-limit, so
      // surface a one-line hint and let the user opt in. No state is recorded for
      // a channel we never enabled; enabling + initiating is the opt-in.
      const who = senderNick ?? senderHandle;
      return {
        replies: [],
        notice: {
          level: 'info',
          text: `${who} wants an encrypted session on ${req.channel} — enable it with /e2e on ${req.channel}, then /e2e handshake ${who}`,
        },
        channel: req.channel,
      };
    }

    const fp = fingerprint(req.pubkey);
    const change = this.classifyPeerChange(userId, networkId, fp, senderHandle);
    if (isTofuBlock(change)) {
      this.stashKeyChange(userId, networkId, senderHandle, change, req.pubkey, req.channel);
      return {
        replies: [],
        notice: this.tofuWarning(senderHandle, change, fp),
        channel: req.channel,
      };
    }
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
        channel: req.channel,
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
    if (isTofuBlock(change)) {
      this.stashKeyChange(userId, networkId, senderHandle, change, rsp.pubkey, rsp.channel);
      return {
        replies: [],
        notice: this.tofuWarning(senderHandle, change, fp),
        channel: rsp.channel,
      };
    }

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
      // Install-time second line of defense: the session row for this (handle,
      // channel) is pinned to a different fingerprint. Stash the new (already
      // sig-verified) pubkey so `/e2e reverify` can re-pin it in place.
      this.stashKeyChange(
        userId,
        networkId,
        senderHandle,
        'fingerprint-changed',
        rsp.pubkey,
        rsp.channel,
      );
      return {
        replies: [],
        notice: this.tofuWarning(senderHandle, 'fingerprint-changed', fp),
        channel: rsp.channel,
      };
    }
    return {
      replies: [],
      notice: {
        level: 'info',
        text: `encrypted session established with ${senderHandle} on ${rsp.channel}`,
      },
      channel: rsp.channel,
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

    // Replay guard: the REKEY nonce is signed, so it can't be tampered with;
    // reject a repeat so a captured REKEY can't be re-injected to re-install a
    // superseded key. Checked AFTER signature verify (an unsigned packet can't
    // poison the cache) and BEFORE any state change. There's no ts field on a
    // REKEY, so this is a nonce-LRU, not a skew window. Scoped by CHANNEL too: a
    // REKEY only installs a key for its own channel (the channel is in the signed
    // payload + the HKDF wrap info), so replay only matters per-channel and the
    // scope avoids a cross-channel nonce collision dropping a legit REKEY. See
    // REKEY_REPLAY_TTL_MS.
    const replayKey = `${this.peerKey(userId, networkId, senderHandle)}:${rekey.channel.toLowerCase()}:${b64(rekey.nonce)}`;
    if (!this.rekeyReplay.observe(replayKey, REKEY_REPLAY_TTL_MS)) return { replies: [] };

    const fp = fingerprint(rekey.pubkey);
    const change = this.classifyPeerChange(userId, networkId, fp, senderHandle);
    // A REKEY from a peer we've never handshaked with is illegitimate.
    if (change === 'new') return { replies: [] };
    if (isTofuBlock(change)) {
      // Remember a fingerprint/handle change (as the KEYREQ/KEYRSP handlers do)
      // so a later `/e2e reverify` can re-pin in place instead of falling back to
      // a forget. A 'revoked' block is intentionally a no-op here (stashKeyChange
      // only stashes fingerprint/handle changes).
      this.stashKeyChange(userId, networkId, senderHandle, change, rekey.pubkey, rekey.channel);
      return {
        replies: [],
        notice: this.tofuWarning(senderHandle, change, fp),
        channel: rekey.channel,
      };
    }

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
      // Install-time second line of defense (see handleKeyRsp): stash the new
      // pubkey so `/e2e reverify` can re-pin it in place.
      this.stashKeyChange(
        userId,
        networkId,
        senderHandle,
        'fingerprint-changed',
        rekey.pubkey,
        rekey.channel,
      );
      return {
        replies: [],
        notice: this.tofuWarning(senderHandle, 'fingerprint-changed', fp),
        channel: rekey.channel,
      };
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
        return {
          replies: [],
          notice: { level: 'warn', text: `no pending handshake from ${senderHandle} to accept` },
          channel,
        };
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
      // Rotate every channel where the peer can read us. That's the UNION of the
      // channels we hold an incoming session on AND the channels they're an
      // outgoing recipient of — the latter is recorded at KEYRSP-build, before any
      // reciprocal incoming session exists, so a peer who never completed the
      // reciprocal handshake is an outgoing recipient with NO incoming session.
      // Enumerating from incoming sessions alone left such a peer able to decrypt
      // our future messages (and still queued for the next REKEY) after a revoke.
      const channels = new Set([
        ...keyring.listIncomingChannelsForHandle(userId, networkId, handle),
        ...keyring.listOutgoingChannelsForHandle(userId, networkId, handle),
      ]);
      const revoked = keyring.revokeIncomingSessionsForHandle(userId, networkId, handle);
      for (const channel of channels) {
        keyring.markOutgoingPendingRotation(userId, networkId, channel);
        keyring.removeOutgoingRecipient(userId, networkId, channel, handle);
      }
      // Drop any stashed key-change so a later `/e2e reverify` can't resurrect the
      // key we just cut off (it would otherwise re-pin it as trusted within TTL).
      this.clearKeyChange(userId, networkId, handle);
      return peer !== null || revoked > 0;
    } catch (err) {
      console.warn(`e2e revoke ${handle}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Forget a peer entirely (pinned key + all sessions + recipients + pending) so
   *  the next handshake re-pins from scratch. `handle` is the ident@host. Returns
   *  the number of rows / pending entries cleared. Works for a peer who has LEFT
   *  the channel — there's no nick resolution here, just the handle. */
  forgetPeer(userId: number, networkId: number, handle: string): number {
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
      this.clearKeyChange(userId, networkId, handle);
      return cleared;
    } catch (err) {
      console.warn(`e2e forget ${handle}: ${(err as Error).message}`);
      return 0;
    }
  }

  /** Forget a peer's state on ONE channel only (the session + recipient + any
   *  cached prompt), leaving their identity pin intact for other channels —
   *  repartee's `/e2e forget` without `-all`. */
  forgetPeerOnChannel(userId: number, networkId: number, handle: string, channel: string): boolean {
    try {
      // "Did we clear anything?" = an installed session OR a cached prompt for
      // this channel (the user-visible state) — computed BEFORE deleting, and
      // including the pending prompt so a forget that drops only a prompt isn't
      // reported as "nothing remembered".
      const hadSession = keyring.getIncomingSession(userId, networkId, handle, channel) !== null;
      const hadPending = this.pendingInbound.delete(
        this.inboundKey(userId, networkId, handle, channel),
      );
      keyring.deleteIncomingSession(userId, networkId, handle, channel);
      keyring.removeOutgoingRecipient(userId, networkId, channel, handle);
      // Also drop any outbound handshake we initiated to this peer on this
      // channel, so a late KEYRSP can't complete and silently recreate the
      // session we just forgot.
      let hadOutbound = false;
      for (const [k, ph] of this.pending) {
        if (
          ph.userId === userId &&
          ph.networkId === networkId &&
          eqLower(ph.channel, channel) &&
          ph.peerHandle &&
          eqLower(ph.peerHandle, handle)
        ) {
          this.pending.delete(k);
          hadOutbound = true;
        }
      }
      return hadSession || hadPending || hadOutbound;
    } catch (err) {
      console.warn(`e2e forget ${handle} on ${channel}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Accept a TOFU-blocked key/handle change for `handle` after the user verified
   *  it out-of-band. If we remembered the change (it appeared since the last
   *  handshake), re-pin the new key/handle as trusted IN PLACE — no re-handshake,
   *  no re-prompt. If there's nothing remembered, fall back to a clean forget so
   *  the next handshake re-pins from scratch. Never throws.
   *
   *  Parity note: repartee applies in place for a fingerprint change but forgets
   *  for a handle change; Lurker deliberately re-pins in place for BOTH (a
   *  handle change is the same already-trusted key under a new ident@host, so an
   *  in-place re-pin is safe and avoids a needless re-handshake). */
  reverifyPeer(userId: number, networkId: number, handle: string): ReverifyOutcome {
    try {
      const stashKey = this.keyChangeKey(userId, networkId, handle);
      const stash = this.pendingKeyChange.get(stashKey);
      if (stash && this.now() - stash.createdAt <= KEYCHANGE_TTL_MS) {
        return this.applyStashedKeyChange(userId, networkId, handle, stash);
      }
      // An expired (or absent) stash → drop it now so the map stays TTL-bounded
      // even if the forget below short-circuits on a DB error (forgetPeer also
      // clears it on the happy path).
      this.pendingKeyChange.delete(stashKey);
      const cleared = this.forgetPeer(userId, networkId, handle);
      return cleared > 0 ? { kind: 'cleared', cleared } : { kind: 'not-found' };
    } catch (err) {
      console.warn(`e2e reverify ${handle}: ${(err as Error).message}`);
      return { kind: 'not-found' };
    }
  }

  // Re-pin a remembered key/handle change as trusted. `newPubkey` was already
  // signature-verified when the block was recorded.
  private applyStashedKeyChange(
    userId: number,
    networkId: number,
    handle: string,
    stash: PendingKeyChange,
  ): ReverifyOutcome {
    const newFp = fingerprint(stash.newPubkey);
    const now = this.nowUnix();
    const pinNew = () => {
      keyring.upsertPeer(userId, networkId, {
        fingerprint: newFp,
        pubkey: stash.newPubkey,
        lastHandle: handle,
        lastNick: null,
        firstSeen: now,
        lastSeen: now,
        globalStatus: 'pending', // setPeerStatus is the authority
      });
      keyring.setPeerStatus(userId, networkId, newFp, 'trusted');
      // Match forgetPeer + repartee's reverify-apply: drop stale outgoing
      // recipients (keyed to the evicted fingerprint) and any pending
      // handshakes/prompts so the next handshake re-establishes cleanly.
      keyring.deleteOutgoingRecipientsForHandle(userId, networkId, handle);
      this.clearPendingForHandle(userId, networkId, handle);
      this.clearKeyChange(userId, networkId, handle);
    };

    if (stash.kind === 'fingerprint-changed') {
      // Same handle, NEW key. Drop the old identity + its now-undecryptable
      // sessions, then pin the new key. A re-handshake re-establishes sessions.
      const old = keyring.getPeerByHandle(userId, networkId, handle);
      const oldFpHex = old ? fingerprintHex(old.fingerprint) : '(unknown)';
      if (old && !equalBytes(old.fingerprint, newFp)) {
        keyring.deletePeerByFingerprint(userId, networkId, old.fingerprint);
      }
      keyring.deleteIncomingSessionsForHandle(userId, networkId, handle);
      pinNew();
      return {
        kind: 'applied',
        change: 'fingerprint-changed',
        oldFpHex,
        newFpHex: fingerprintHex(newFp),
      };
    }

    // handle-changed: SAME key (newFp), new ident@host. Re-pin the handle and drop
    // the stale sessions under the prior handle; the next handshake re-establishes.
    const peer = keyring.getPeerByFingerprint(userId, networkId, newFp);
    const oldHandle = peer?.lastHandle ?? null;
    if (oldHandle && !eqLower(oldHandle, handle)) {
      keyring.deleteIncomingSessionsForHandle(userId, networkId, oldHandle);
      keyring.deleteOutgoingRecipientsForHandle(userId, networkId, oldHandle);
      this.clearPendingForHandle(userId, networkId, oldHandle);
    }
    pinNew();
    const fpHex = fingerprintHex(newFp);
    return { kind: 'applied', change: 'handle-changed', oldFpHex: fpHex, newFpHex: fpHex };
  }

  private keyChangeKey(userId: number, networkId: number, handle: string): string {
    return this.peerKey(userId, networkId, handle);
  }

  private stashKeyChange(
    userId: number,
    networkId: number,
    handle: string,
    change: ClassifyResult,
    pubkey: Uint8Array,
    channel: string,
  ): void {
    if (change !== 'fingerprint-changed' && change !== 'handle-changed') return;
    this.sweepKeyChanges();
    this.pendingKeyChange.set(this.keyChangeKey(userId, networkId, handle), {
      kind: change,
      newPubkey: pubkey,
      channel,
      createdAt: this.now(),
    });
  }

  private clearKeyChange(userId: number, networkId: number, handle: string): void {
    this.pendingKeyChange.delete(this.keyChangeKey(userId, networkId, handle));
  }

  private sweepKeyChanges(): void {
    this.sweepMap(this.pendingKeyChange, KEYCHANGE_TTL_MS, KEYCHANGE_MAX);
  }

  // ─── listing + management (the /e2e list/mode/decline/unrevoke surface) ──────

  /** Trusted peers with a session on `channel`, for `/e2e list`. Never throws. */
  listChannelPeers(userId: number, networkId: number, channel: string): PeerListEntry[] {
    try {
      return keyring
        .listIncomingSessionMeta(userId, networkId, channel)
        .filter((s) => s.status === 'trusted')
        .map((s) => ({
          handle: s.handle,
          status: s.status,
          fingerprintHex: fingerprintHex(s.fingerprint),
        }));
    } catch (err) {
      console.warn(`e2e listChannelPeers ${channel}: ${(err as Error).message}`);
      return [];
    }
  }

  /** The whole remembered keyring (peers + sessions), for `/e2e list -all`. */
  listKeyring(
    userId: number,
    networkId: number,
  ): { peers: PeerListEntry[]; sessions: SessionListEntry[] } {
    try {
      const peers = keyring.listPeers(userId, networkId).map((p) => ({
        handle: p.lastHandle ?? '(unknown)',
        status: p.globalStatus,
        fingerprintHex: fingerprintHex(p.fingerprint),
      }));
      const sessions = keyring.listIncomingSessionMeta(userId, networkId).map((s) => ({
        handle: s.handle,
        channel: s.channel,
        status: s.status,
        fingerprintHex: fingerprintHex(s.fingerprint),
      }));
      return { peers, sessions };
    } catch (err) {
      console.warn(`e2e listKeyring: ${(err as Error).message}`);
      return { peers: [], sessions: [] };
    }
  }

  /** Per-channel summary for `/e2e status`. Never throws. */
  channelStatus(
    userId: number,
    networkId: number,
    channel: string,
  ): { enabled: boolean; mode: keyring.ChannelMode; peers: number } | null {
    try {
      const cfg = keyring.getChannelConfig(userId, networkId, channel);
      if (!cfg) return { enabled: false, mode: 'normal', peers: 0 };
      return {
        enabled: cfg.enabled,
        mode: cfg.mode,
        peers: this.listChannelPeers(userId, networkId, channel).length,
      };
    } catch (err) {
      console.warn(`e2e channelStatus ${channel}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Change a channel's mode, preserving its enabled flag (defaulting to on when
   *  the channel was never configured — setting a mode implies wanting E2E). */
  setChannelMode(
    userId: number,
    networkId: number,
    channel: string,
    mode: keyring.ChannelMode,
  ): boolean {
    const existing = keyring.getChannelConfig(userId, networkId, channel);
    return this.setChannelConfig(userId, networkId, channel, existing?.enabled ?? true, mode);
  }

  /** Decline a pending inbound handshake: drop the cached prompt and revoke this
   *  CHANNEL's session (mirrors repartee's channel-scoped `/e2e decline`).
   *  Returns false if there was nothing to decline. */
  declinePeer(userId: number, networkId: number, handle: string, channel: string): boolean {
    try {
      // Only act when there's actually a pending inbound handshake to reject —
      // otherwise `/e2e decline` on an established peer would silently behave like
      // `/e2e revoke` (Copilot review on #408). No pending → no-op.
      const hadPending = this.pendingInbound.delete(
        this.inboundKey(userId, networkId, handle, channel),
      );
      if (!hadPending) return false;
      // Channel-scoped, like repartee: revoke only THIS channel's session (a
      // no-op when none is installed yet) and drop any stashed key-change. We
      // deliberately do NOT touch the peer's GLOBAL trust status — declining one
      // channel's prompt must not cut the peer off on every other channel, nor
      // leave a global 'revoked' that a later `/e2e unrevoke` would launder into
      // 'trusted'.
      keyring.updateIncomingStatus(userId, networkId, handle, channel, 'revoked');
      this.clearKeyChange(userId, networkId, handle);
      return true;
    } catch (err) {
      console.warn(`e2e decline ${handle}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Restore a revoked peer to trusted (and their revoked sessions). Returns
   *  false if the peer isn't currently revoked. */
  unrevokePeer(userId: number, networkId: number, handle: string): boolean {
    try {
      const peer = keyring.getPeerByHandle(userId, networkId, handle);
      if (!peer || peer.globalStatus !== 'revoked') return false;
      keyring.setPeerStatus(userId, networkId, peer.fingerprint, 'trusted');
      for (const channel of keyring.listIncomingChannelsForHandle(userId, networkId, handle)) {
        keyring.updateIncomingStatus(userId, networkId, handle, channel, 'trusted');
      }
      return true;
    } catch (err) {
      console.warn(`e2e unrevoke ${handle}: ${(err as Error).message}`);
      return false;
    }
  }

  // ─── autotrust (glob rules that auto-accept matching handles) ────────────────

  listAutotrust(userId: number, networkId: number): keyring.AutotrustRule[] {
    try {
      return keyring.listAutotrust(userId, networkId);
    } catch (err) {
      console.warn(`e2e listAutotrust: ${(err as Error).message}`);
      return [];
    }
  }

  addAutotrust(userId: number, networkId: number, scope: string, pattern: string): boolean {
    try {
      keyring.addAutotrust(userId, networkId, scope, pattern, this.nowUnix());
      return true;
    } catch (err) {
      console.warn(`e2e addAutotrust ${scope}/${pattern}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Remove every autotrust rule whose pattern matches (across scopes), mirroring
   *  repartee's `/e2e autotrust remove <pattern>`. Returns how many were removed. */
  removeAutotrust(userId: number, networkId: number, pattern: string): number {
    try {
      // Match case-insensitively: rules apply via globMatchCi (case-insensitive)
      // and handle_pattern is NOT COLLATE NOCASE, so a case-differing `remove`
      // must still find the rule (else it stays active but looks removed). The
      // DELETE uses each rule's stored casing, so it lands.
      const want = pattern.toLowerCase();
      const rules = keyring
        .listAutotrust(userId, networkId)
        .filter((r) => r.handlePattern.toLowerCase() === want);
      for (const r of rules) keyring.removeAutotrust(userId, networkId, r.scope, r.handlePattern);
      return rules.length;
    } catch (err) {
      console.warn(`e2e removeAutotrust ${pattern}: ${(err as Error).message}`);
      return 0;
    }
  }

  // ─── key rotation ────────────────────────────────────────────────────────────

  /** Flag `channel`'s outgoing key for rotation (the `/e2e rotate` command). The
   *  fresh key is generated AND distributed lazily on the next send to the
   *  channel — matching the reference's lazy-rotate model, and the same path
   *  `/e2e revoke` already uses. Returns false if there's no outgoing session yet
   *  (nothing to rotate — the first send generates a fresh key regardless). */
  rotateChannel(userId: number, networkId: number, channel: string): boolean {
    try {
      if (!keyring.getOutgoingSession(userId, networkId, channel)) return false;
      keyring.markOutgoingPendingRotation(userId, networkId, channel);
      return true;
    } catch (err) {
      console.warn(`e2e rotate ${channel}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Drain the REKEY CTCPs queued by a lazy rotation for this tenant. The IRC
   *  layer calls this right after each send: it resolves each entry's
   *  `targetHandle` → a current nick on `channel` and ships `body` as a framed
   *  NOTICE. Never throws (shared singleton). */
  takePendingRekeySends(userId: number, networkId: number): PendingRekeySend[] {
    try {
      const key = this.tenantKey(userId, networkId);
      const queue = this.pendingRekey.get(key);
      if (!queue || queue.length === 0) return [];
      this.pendingRekey.delete(key);
      return queue;
    } catch (err) {
      console.warn(`e2e takePendingRekeySends: ${(err as Error).message}`);
      return [];
    }
  }

  // ─── keyring portability (export / import) ───────────────────────────────────

  /** Serialize this account's identity + this network's peers/sessions/configs/
   *  autotrust to a repartee-compatible portable JSON document (`/e2e export`).
   *  WARNING: contains the identity private key + session keys in plaintext hex —
   *  the caller must treat it like a password. `ok:false` if there's no identity
   *  yet. Never throws (singleton). */
  exportKeyring(userId: number, networkId: number): ExportResult {
    try {
      const identity = keyring.loadIdentity(userId);
      if (!identity) return { ok: false, reason: 'no encryption identity yet — nothing to export' };
      const doc = buildPortable({
        identity,
        peers: keyring.listPeers(userId, networkId),
        incoming: keyring.listIncomingSessions(userId, networkId),
        outgoing: keyring.listOutgoingSessions(userId, networkId),
        channels: keyring.listChannelConfigs(userId, networkId),
        autotrust: keyring.listAutotrust(userId, networkId),
        exportedAt: this.nowUnix(),
      });
      return { ok: true, json: serializePortable(doc), counts: countsOf(doc) };
    } catch (err) {
      console.warn(`e2e export: ${(err as Error).message}`);
      return { ok: false, reason: (err as Error).message };
    }
  }

  /** Validate a portable JSON document and, if it's well-formed, REPLACE this
   *  network's keyring + (re)set the account identity (`/e2e import`). Validation
   *  is complete before any write, so a malformed import changes nothing.
   *  `identityChanged` flags when the imported identity differs from the current
   *  one (it becomes the account identity on ALL networks — the caller should
   *  warn). Never throws (singleton). */
  importKeyring(userId: number, networkId: number, json: string): ImportResult {
    try {
      const data = parseAndValidate(json);
      const current = keyring.loadIdentity(userId);
      const identityChanged =
        !current || !equalBytes(current.fingerprint, data.identity.fingerprint);
      keyring.replaceKeyringForImport(userId, networkId, data, this.nowUnix());
      // The cached identity may now be stale (import can change it) — drop it so
      // the next load re-reads the imported key.
      this.identities.delete(userId);
      return {
        ok: true,
        counts: {
          peers: data.peers.length,
          incoming: data.incoming.length,
          outgoing: data.outgoing.length,
          channels: data.channels.length,
          autotrust: data.autotrust.length,
        },
        identityChanged,
        fingerprintHex: fingerprintHex(data.identity.fingerprint),
      };
    } catch (err) {
      console.warn(`e2e import: ${(err as Error).message}`);
      return { ok: false, reason: (err as Error).message };
    }
  }

  // ─── private helpers ─────────────────────────────────────────────────────────

  private getOrGenerateOutgoingKey(userId: number, networkId: number, channel: string): Uint8Array {
    const sess = keyring.getOutgoingSession(userId, networkId, channel);
    if (sess && !sess.pendingRotation) return sess.sk;
    // No session yet, or a rotation is pending — generate a fresh key. When this
    // is a ROTATION (an existing session flagged pendingRotation by /e2e revoke
    // or /e2e rotate) we must hand the new key to every remaining recipient via a
    // REKEY CTCP so they can keep decrypting us. Capture the rotation flag BEFORE
    // setOutgoingSession clears it. Distribution is queued for the IRC layer to
    // drain + ship (it owns handle → nick resolution and the wire).
    const rotating = sess?.pendingRotation === true;
    const fresh = aead.generateSessionKey();
    if (rotating) this.queueRekeyDistribution(userId, networkId, channel, fresh);
    keyring.setOutgoingSession(userId, networkId, channel, fresh, this.nowUnix());
    return fresh;
  }

  // Build a REKEY CTCP for every remaining recipient of our outgoing key on
  // `channel`, delivering `freshSk`, and queue them for the IRC layer. The
  // recipients table is kept in lock-step with consent (recordOutgoingRecipient
  // on KEYRSP-build, removeOutgoingRecipient on revoke/forget), so a revoked
  // peer is already gone from it and never gets the new key. A recipient with no
  // peer pin (shouldn't happen) or whose key won't build is skipped, not fatal.
  private queueRekeyDistribution(
    userId: number,
    networkId: number,
    channel: string,
    freshSk: Uint8Array,
  ): void {
    const recipients = keyring.listOutgoingRecipients(userId, networkId, channel);
    if (recipients.length === 0) return;
    const sends: PendingRekeySend[] = [];
    for (const r of recipients) {
      const peer = keyring.getPeerByFingerprint(userId, networkId, r.fingerprint);
      if (!peer) {
        console.warn(`e2e rekey: no peer pin for recipient ${r.handle} on ${channel}; skipping`);
        continue;
      }
      try {
        const body = this.buildRekeyBody(userId, networkId, channel, peer.pubkey, freshSk);
        // Address the REKEY to the peer's CURRENT pinned handle (peer is looked up
        // by the stable fingerprint), not the recipient row's snapshot handle —
        // the row handle can lag a handle change and fail nickForHandle, orphaning
        // the peer. They're in sync today (a reverify drops stale recipient rows),
        // but this is the right semantic and survives future drift. Fall back to
        // the row handle.
        sends.push({ channel, targetHandle: peer.lastHandle ?? r.handle, body });
      } catch (err) {
        console.warn(`e2e rekey build for ${r.handle} on ${channel}: ${(err as Error).message}`);
      }
    }
    if (sends.length === 0) return;
    const key = this.tenantKey(userId, networkId);
    const queue = this.pendingRekey.get(key);
    if (queue) queue.push(...sends);
    else this.pendingRekey.set(key, sends);
  }

  // Encode a single KeyRekey delivering `freshSk` for `channel` to `recipientEdPub`.
  // Fresh ephemeral X25519 → ECDH against the recipient's static identity (their
  // Ed25519 pubkey mapped to X25519), HKDF under the REKEY domain separator, AEAD
  // seal, sign with our identity. Mirrors buildKeyRspAndReciprocal's wrap, but
  // wrapping to a STATIC peer key (not a per-handshake ephemeral) — that's why
  // the recipient unwraps with their long-term key in handleRekey.
  private buildRekeyBody(
    userId: number,
    networkId: number,
    channel: string,
    recipientEdPub: Uint8Array,
    freshSk: Uint8Array,
  ): string {
    const id = this.loadIdentity(userId);
    const ourEph = generateEphemeral();
    const recipientX = ed25519PubToX25519(recipientEdPub);
    const info = utf8.encode(rekeyInfo(channel));
    const wrapKey = deriveWrapKey(ourEph.secretKey, recipientX, info);
    const sealed = aead.encrypt(wrapKey, info, freshSk);

    const nonce = new Uint8Array(randomBytes(16));
    const payload = sigPayloadKeyRekey(
      channel,
      id.publicKey,
      ourEph.publicKey,
      sealed.nonce,
      sealed.ciphertext,
      nonce,
    );
    const rk: KeyRekey = {
      channel,
      pubkey: id.publicKey,
      ephPub: ourEph.publicKey,
      wrapNonce: sealed.nonce,
      wrapCt: sealed.ciphertext,
      nonce,
      sig: sign(id.secretKey, payload),
    };
    return encodeKeyRekey(rk);
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
      // A missing/empty stored handle counts as a change (matching repartee's
      // `last_handle != Some(new)`, where None != Some(h) is true) — otherwise an
      // imported peer with a null handle would suppress the handle-changed warning.
      if (!byFp.lastHandle || !eqLower(byFp.lastHandle, handle)) return 'handle-changed';
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
    this.sweepMap(this.pending, PENDING_TTL_MS, PENDING_MAX);
  }

  private sweepPendingInbound(): void {
    this.sweepMap(this.pendingInbound, PENDING_INBOUND_TTL_MS, PENDING_INBOUND_MAX);
  }

  // Expire entries past `ttlMs` (by createdAt), then bound the map to `max`
  // (oldest-first eviction). One implementation for every TTL+capped map on this
  // long-lived singleton, so none can silently lose its size bound.
  private sweepMap<T extends { createdAt: number }>(
    map: Map<string, T>,
    ttlMs: number,
    max: number,
  ): void {
    const now = this.now();
    for (const [k, v] of map) {
      if (now - v.createdAt > ttlMs) map.delete(k);
    }
    this.cap(map, max);
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
    return `${this.peerKey(userId, networkId, handle)}:${channel.toLowerCase()}`;
  }

  private tofuWarning(handle: string, change: ClassifyResult, newFp?: Uint8Array): UserNotice {
    if (change === 'revoked') {
      return { level: 'warn', text: `Ignoring encrypted handshake from revoked peer ${handle}` };
    }
    // Surface the key's short fingerprint + SAS so the user has something to
    // compare out-of-band BEFORE running /e2e reverify — the keyring still pins
    // the OLD key, so `/e2e verify` can't show this one. (reverify applies the
    // most recently stashed key, which is exactly the one shown here.)
    const keyInfo = newFp
      ? ` — key ${fingerprintHex(newFp).slice(0, 16)}… (${fingerprintWords(newFp)})`
      : '';
    if (change === 'handle-changed') {
      return {
        level: 'warn',
        text: `⚠ a known encryption key appeared under a new handle (${handle})${keyInfo} — verify out-of-band, then /e2e reverify ${handle} to accept it`,
      };
    }
    return {
      level: 'warn',
      text: `⚠ encryption key changed for ${handle}${keyInfo} — verify out-of-band, then /e2e reverify ${handle} to accept it`,
    };
  }
}

/** Process-wide singleton used by the IRC layer. Tests construct their own
 *  instances (with an injected clock) to drive time-dependent paths. */
export const e2eManager = new E2eManager();
