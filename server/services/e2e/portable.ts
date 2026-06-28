// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Portable JSON export / import for the RPE2E keyring — a byte-compatible port of
// repartee's e2e/portable.rs (schema `version: 1`). Binary fields are lowercase
// hex so the document diffs cleanly, can be hand-inspected, and moves losslessly
// between Lurker and repartee.
//
// WARNING: the identity private key and every session key are written in
// PLAINTEXT hex. Lurker stores them sealed at rest (secretCrypto), but an export
// necessarily unseals them — it's a backup / migration escape hatch and must be
// treated like a password (never redistributed). A future revision may add
// passphrase-wrapping; v1 keeps the format transparent on purpose, matching the
// reference.
//
// SCOPE: Lurker's keyring is per-`(user, network)` for everything EXCEPT the
// identity, which is per-ACCOUNT (`user_id`). So an export is "this account's
// identity + this network's peers / sessions / channel configs / autotrust", and
// an import REPLACES that network's keyring and (re)sets the account identity.
// (repartee has no network dimension; a single-network round-trip is lossless.)

import type {
  ChannelConfig,
  ChannelMode,
  IdentityRow,
  IncomingSession,
  OutgoingSession,
  PeerRecord,
  TrustStatus,
} from '../../db/e2e.js';
import { E2eError } from './errors.js';

// Lenient enum parsing (unknown → safe default; `auto` aliases `auto-accept`),
// mirroring db/e2e.ts. Inlined so this serialization module has NO runtime
// dependency on the storage layer (only erased type-imports above) — keeping it
// pure + unit-testable without opening a database.
function parseStatus(s: string): TrustStatus {
  return s === 'trusted' ? 'trusted' : s === 'revoked' ? 'revoked' : 'pending';
}
function parseMode(s: string): ChannelMode {
  if (s === 'auto-accept' || s === 'auto') return 'auto-accept';
  if (s === 'quiet') return 'quiet';
  return 'normal';
}

/** Current schema version. Bump when a field is added or semantics change. */
export const EXPORT_VERSION = 1;

/** Hard ceiling on an import payload (bytes), enforced before parsing. Generous
 *  vs a realistic keyring (≈ a few hundred KB even with hundreds of peers) — an
 *  abuse backstop against an event-loop-blocking parse, not a usage limit. */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

// ─── on-disk document shapes (JSON, hex-encoded binary) ──────────────────────

export interface PortableIdentity {
  pubkey: string;
  privkey: string;
  fingerprint: string;
  createdAt: number;
}
export interface PortablePeer {
  fingerprint: string;
  pubkey: string;
  lastHandle: string | null;
  lastNick: string | null;
  firstSeen: number;
  lastSeen: number;
  globalStatus: string;
}
export interface PortableIncoming {
  handle: string;
  channel: string;
  fingerprint: string;
  sk: string;
  status: string;
  createdAt: number;
}
export interface PortableOutgoing {
  channel: string;
  sk: string;
  createdAt: number;
  pendingRotation: boolean;
}
export interface PortableChannel {
  channel: string;
  enabled: boolean;
  mode: string;
}
export interface PortableAutotrust {
  scope: string;
  handlePattern: string;
}
export interface Portable {
  version: number;
  exportedAt: number;
  identity: PortableIdentity;
  peers: PortablePeer[];
  incomingSessions: PortableIncoming[];
  outgoingSessions: PortableOutgoing[];
  channels: PortableChannel[];
  autotrust: PortableAutotrust[];
}

// ─── decoded (validated) form — raw bytes + typed enums ──────────────────────

export interface ValidatedKeyring {
  identity: IdentityRow;
  peers: PeerRecord[];
  incoming: IncomingSession[];
  outgoing: OutgoingSession[];
  channels: ChannelConfig[];
  autotrust: PortableAutotrust[];
}

export interface ExportInput {
  identity: IdentityRow;
  peers: PeerRecord[];
  incoming: IncomingSession[];
  outgoing: OutgoingSession[];
  channels: ChannelConfig[];
  autotrust: PortableAutotrust[];
  exportedAt: number;
}

export interface PortableCounts {
  peers: number;
  incoming: number;
  outgoing: number;
  channels: number;
  autotrust: number;
}

const hex = (u8: Uint8Array): string => Buffer.from(u8).toString('hex');

// ─── build (export) ──────────────────────────────────────────────────────────

/** Serialize already-read keyring rows into the portable document. Pure (no DB,
 *  no clock) — the caller supplies the unsealed rows and `exportedAt`. */
export function buildPortable(input: ExportInput): Portable {
  return {
    version: EXPORT_VERSION,
    exportedAt: input.exportedAt,
    identity: {
      pubkey: hex(input.identity.pubkey),
      privkey: hex(input.identity.privkey),
      fingerprint: hex(input.identity.fingerprint),
      createdAt: input.identity.createdAt,
    },
    peers: input.peers.map((p) => ({
      fingerprint: hex(p.fingerprint),
      pubkey: hex(p.pubkey),
      lastHandle: p.lastHandle,
      lastNick: p.lastNick,
      firstSeen: p.firstSeen,
      lastSeen: p.lastSeen,
      globalStatus: p.globalStatus,
    })),
    incomingSessions: input.incoming.map((s) => ({
      handle: s.handle,
      channel: s.channel,
      fingerprint: hex(s.fingerprint),
      sk: hex(s.sk),
      status: s.status,
      createdAt: s.createdAt,
    })),
    outgoingSessions: input.outgoing.map((o) => ({
      channel: o.channel,
      sk: hex(o.sk),
      createdAt: o.createdAt,
      pendingRotation: o.pendingRotation,
    })),
    channels: input.channels.map((c) => ({
      channel: c.channel,
      enabled: c.enabled,
      mode: c.mode,
    })),
    autotrust: input.autotrust.map((a) => ({ scope: a.scope, handlePattern: a.handlePattern })),
  };
}

/** Pretty-print a portable document (2-space indent, like the reference). */
export function serializePortable(doc: Portable): string {
  return JSON.stringify(doc, null, 2);
}

export function countsOf(doc: Portable): PortableCounts {
  return {
    peers: doc.peers.length,
    incoming: doc.incomingSessions.length,
    outgoing: doc.outgoingSessions.length,
    channels: doc.channels.length,
    autotrust: doc.autotrust.length,
  };
}

// ─── parse + validate (import) ───────────────────────────────────────────────

/** Parse JSON and validate the ENTIRE structure (version, hex lengths, enum
 *  strings) before returning decoded bytes — so a malformed import is rejected
 *  before the keyring is touched. Every failure is an `E2eError('keyring')`. */
export function parseAndValidate(json: string): ValidatedKeyring {
  // Bound the input BEFORE JSON.parse so a pathological payload can't block the
  // event loop / spike memory. A real keyring is well under this (hundreds of
  // peers ≈ a few hundred KB); the cap is an abuse backstop, not a usage limit.
  if (json.length > MAX_IMPORT_BYTES) {
    throw new E2eError('keyring', `import too large (max ${MAX_IMPORT_BYTES} bytes)`);
  }
  let doc: Portable;
  try {
    doc = JSON.parse(json) as Portable;
  } catch (err) {
    throw new E2eError('keyring', `parse json: ${(err as Error).message}`);
  }
  if (typeof doc !== 'object' || doc === null) {
    throw new E2eError('keyring', 'import: not a JSON object');
  }
  if (doc.version !== EXPORT_VERSION) {
    throw new E2eError(
      'keyring',
      `unsupported export version: got ${doc.version}, expected ${EXPORT_VERSION}`,
    );
  }
  if (typeof doc.identity !== 'object' || doc.identity === null) {
    throw new E2eError('keyring', 'import: missing identity');
  }
  for (const [field, arr] of [
    ['peers', doc.peers],
    ['incomingSessions', doc.incomingSessions],
    ['outgoingSessions', doc.outgoingSessions],
    ['channels', doc.channels],
    ['autotrust', doc.autotrust],
  ] as const) {
    if (!Array.isArray(arr)) throw new E2eError('keyring', `import: ${field} must be an array`);
  }

  const identity: IdentityRow = {
    pubkey: parseHex('identity.pubkey', doc.identity.pubkey, 32),
    privkey: parseHex('identity.privkey', doc.identity.privkey, 32),
    fingerprint: parseHex('identity.fingerprint', doc.identity.fingerprint, 16),
    createdAt: intField('identity.createdAt', doc.identity.createdAt),
  };

  const peers: PeerRecord[] = doc.peers.map((p, i) => ({
    fingerprint: parseHex(`peers[${i}].fingerprint`, p.fingerprint, 16),
    pubkey: parseHex(`peers[${i}].pubkey`, p.pubkey, 32),
    lastHandle: nullableStr(`peers[${i}].lastHandle`, p.lastHandle),
    lastNick: nullableStr(`peers[${i}].lastNick`, p.lastNick),
    firstSeen: intField(`peers[${i}].firstSeen`, p.firstSeen),
    lastSeen: intField(`peers[${i}].lastSeen`, p.lastSeen),
    globalStatus: parseStatus(strField(`peers[${i}].globalStatus`, p.globalStatus)),
  }));

  const incoming: IncomingSession[] = doc.incomingSessions.map((s, i) => ({
    handle: strField(`incomingSessions[${i}].handle`, s.handle),
    channel: strField(`incomingSessions[${i}].channel`, s.channel),
    fingerprint: parseHex(`incomingSessions[${i}].fingerprint`, s.fingerprint, 16),
    sk: parseHex(`incomingSessions[${i}].sk`, s.sk, 32),
    status: parseStatus(strField(`incomingSessions[${i}].status`, s.status)),
    createdAt: intField(`incomingSessions[${i}].createdAt`, s.createdAt),
  }));

  const outgoing: OutgoingSession[] = doc.outgoingSessions.map((o, i) => ({
    channel: strField(`outgoingSessions[${i}].channel`, o.channel),
    sk: parseHex(`outgoingSessions[${i}].sk`, o.sk, 32),
    createdAt: intField(`outgoingSessions[${i}].createdAt`, o.createdAt),
    pendingRotation: o.pendingRotation === true,
  }));

  const channels: ChannelConfig[] = doc.channels.map((c, i) => ({
    channel: strField(`channels[${i}].channel`, c.channel),
    enabled: c.enabled === true,
    mode: parseMode(strField(`channels[${i}].mode`, c.mode)),
  }));

  const autotrust: PortableAutotrust[] = doc.autotrust.map((a, i) => ({
    scope: strField(`autotrust[${i}].scope`, a.scope),
    handlePattern: strField(`autotrust[${i}].handlePattern`, a.handlePattern),
  }));

  return { identity, peers, incoming, outgoing, channels, autotrust };
}

// ─── field helpers ───────────────────────────────────────────────────────────

/** Strict hex → exactly `len` bytes. Rejects non-hex chars and wrong length
 *  (Buffer.from is lenient, so validate the string shape first). */
function parseHex(field: string, s: unknown, len: number): Uint8Array {
  if (typeof s !== 'string' || !/^[0-9a-fA-F]*$/.test(s)) {
    throw new E2eError('keyring', `${field}: invalid hex`);
  }
  if (s.length !== len * 2) {
    throw new E2eError(
      'keyring',
      `${field}: expected ${len} bytes (hex length ${len * 2}), got ${s.length}`,
    );
  }
  return new Uint8Array(Buffer.from(s, 'hex'));
}

function strField(field: string, s: unknown): string {
  if (typeof s !== 'string') throw new E2eError('keyring', `${field}: expected a string`);
  return s;
}

/** A `string | null` field: null/absent → null, a string passes through, but any
 *  other type (number/object/bool) is REJECTED rather than silently coerced to
 *  null — a malformed export shouldn't import and quietly lose data. */
function nullableStr(field: string, s: unknown): string | null {
  if (s === null || s === undefined) return null;
  if (typeof s === 'string') return s;
  throw new E2eError('keyring', `${field}: expected a string or null`);
}

/** A strictly-integer field. Reject non-integers rather than `Math.trunc`-ing
 *  them — the schema round-trips exact values, so a fractional timestamp is
 *  malformed input, not something to silently rewrite. */
function intField(field: string, n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new E2eError('keyring', `${field}: expected an integer`);
  }
  return n;
}
