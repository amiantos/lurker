// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import {
  buildPortable,
  countsOf,
  EXPORT_VERSION,
  type ExportInput,
  MAX_IMPORT_BYTES,
  parseAndValidate,
  serializePortable,
} from './portable.js';

const bytes = (len: number, fill: number): Uint8Array => new Uint8Array(len).fill(fill);

// A representative keyring covering every row type.
function sampleInput(): ExportInput {
  return {
    identity: {
      pubkey: bytes(32, 1),
      privkey: bytes(32, 2),
      fingerprint: bytes(16, 3),
      createdAt: 1_700_000_000,
    },
    peers: [
      {
        fingerprint: bytes(16, 4),
        pubkey: bytes(32, 5),
        lastHandle: '~bob@b.host',
        lastNick: 'bob',
        firstSeen: 1_700_000_100,
        lastSeen: 1_700_000_200,
        globalStatus: 'trusted',
      },
      {
        fingerprint: bytes(16, 6),
        pubkey: bytes(32, 7),
        lastHandle: null,
        lastNick: null,
        firstSeen: 1_700_000_300,
        lastSeen: 1_700_000_400,
        globalStatus: 'revoked',
      },
    ],
    incoming: [
      {
        handle: '~bob@b.host',
        channel: '#x',
        fingerprint: bytes(16, 4),
        sk: bytes(32, 8),
        status: 'trusted',
        createdAt: 1_700_000_500,
      },
    ],
    outgoing: [
      { channel: '#x', sk: bytes(32, 9), createdAt: 1_700_000_600, pendingRotation: true },
    ],
    channels: [{ channel: '#x', enabled: true, mode: 'auto-accept' }],
    autotrust: [{ scope: 'global', handlePattern: '*@trusted.host' }],
    exportedAt: 1_700_000_700,
  };
}

describe('portable keyring export/import', () => {
  it('round-trips build → serialize → parse → validate losslessly', () => {
    const input = sampleInput();
    const doc = buildPortable(input);
    expect(doc.version).toBe(EXPORT_VERSION);
    expect(doc.exportedAt).toBe(input.exportedAt);

    const v = parseAndValidate(serializePortable(doc));

    // Identity bytes survive the hex round-trip.
    expect(v.identity.pubkey).toEqual(input.identity.pubkey);
    expect(v.identity.privkey).toEqual(input.identity.privkey);
    expect(v.identity.fingerprint).toEqual(input.identity.fingerprint);
    expect(v.identity.createdAt).toBe(input.identity.createdAt);

    expect(v.peers).toHaveLength(2);
    expect(v.peers[0]).toEqual(input.peers[0]);
    expect(v.peers[1].globalStatus).toBe('revoked');
    expect(v.peers[1].lastHandle).toBeNull();

    expect(v.incoming[0]).toEqual(input.incoming[0]);
    expect(v.outgoing[0]).toEqual(input.outgoing[0]);
    expect(v.outgoing[0].pendingRotation).toBe(true);
    expect(v.channels[0]).toEqual(input.channels[0]);
    expect(v.autotrust[0]).toEqual(input.autotrust[0]);
  });

  it('emits lowercase-hex binary fields (repartee-compatible wire format)', () => {
    const doc = buildPortable(sampleInput());
    expect(doc.identity.pubkey).toBe('01'.repeat(32));
    expect(doc.identity.fingerprint).toBe('03'.repeat(16));
    expect(doc.peers[0].fingerprint).toBe('04'.repeat(16));
    expect(doc.incomingSessions[0].sk).toBe('08'.repeat(32));
    expect(countsOf(doc)).toEqual({
      peers: 2,
      incoming: 1,
      outgoing: 1,
      channels: 1,
      autotrust: 1,
    });
  });

  it('rejects an unsupported version before decoding anything', () => {
    const doc = buildPortable(sampleInput());
    const bad = serializePortable({ ...doc, version: 99 });
    expect(() => parseAndValidate(bad)).toThrow(/unsupported export version/);
  });

  it('rejects a wrong-length hex field', () => {
    const doc = buildPortable(sampleInput());
    doc.identity.pubkey = 'aabb'; // 2 bytes, not 32
    expect(() => parseAndValidate(serializePortable(doc))).toThrow(/identity\.pubkey.*expected 32/);
  });

  it('rejects non-hex characters', () => {
    const doc = buildPortable(sampleInput());
    doc.incomingSessions[0].sk = 'z'.repeat(64);
    expect(() => parseAndValidate(serializePortable(doc))).toThrow(/invalid hex/);
  });

  it('coerces an unknown enum to the safe default (lenient, like the reference)', () => {
    const doc = buildPortable(sampleInput());
    doc.peers[0].globalStatus = 'bogus';
    doc.channels[0].mode = 'bogus';
    const v = parseAndValidate(serializePortable(doc));
    expect(v.peers[0].globalStatus).toBe('pending'); // parseTrustStatus default
    expect(v.channels[0].mode).toBe('normal'); // parseChannelMode default
  });

  it('rejects malformed JSON and non-object documents', () => {
    expect(() => parseAndValidate('{not json')).toThrow(/parse json/);
    expect(() => parseAndValidate('42')).toThrow(/not a JSON object/);
  });

  it('rejects a non-string (non-null) nullable field instead of coercing to null', () => {
    const doc = buildPortable(sampleInput()) as unknown as {
      peers: Array<Record<string, unknown>>;
    };
    doc.peers[0].lastHandle = 123; // a number, not a string|null
    expect(() => parseAndValidate(JSON.stringify(doc))).toThrow(/lastHandle.*string or null/);
  });

  it('rejects a non-integer numeric field instead of truncating it', () => {
    const doc = buildPortable(sampleInput());
    doc.identity.createdAt = 1.5;
    expect(() => parseAndValidate(serializePortable(doc))).toThrow(/createdAt.*integer/);
  });

  it('rejects an oversized payload before parsing', () => {
    expect(() => parseAndValidate('x'.repeat(MAX_IMPORT_BYTES + 1))).toThrow(/too large/);
  });

  it('rejects a non-array collection field', () => {
    const doc = buildPortable(sampleInput()) as unknown as Record<string, unknown>;
    doc.peers = 'nope';
    expect(() => parseAndValidate(JSON.stringify(doc))).toThrow(/peers must be an array/);
  });
});
