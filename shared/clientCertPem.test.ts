// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Pulling the two halves out of PEM text (#459). Both ends of the app rely on
// this: the form fills its fields from a file someone picked, and the server
// splits what arrives because it can't trust that the client did.

import { describe, it, expect } from 'vitest';
import { splitCombinedPem, partsFromPem } from './clientCertPem.js';

const CERT = '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----';
const RSA_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----';

describe('splitCombinedPem', () => {
  it('reads a client.pem in either order', () => {
    expect(splitCombinedPem(`${KEY}\n${CERT}\n`)).toEqual({ cert: CERT, key: KEY });
    expect(splitCombinedPem(`${CERT}\n${KEY}\n`)).toEqual({ cert: CERT, key: KEY });
  });

  it('reads the labels other tools write', () => {
    expect(splitCombinedPem(`${CERT}\n${RSA_KEY}`)?.key).toBe(RSA_KEY);
  });

  // A bundle with a chain in it presents the leaf — the certificate whose
  // fingerprint services hold — so the FIRST block is the right one.
  it('takes the leaf out of a chain', () => {
    const leaf = CERT;
    const issuer = '-----BEGIN CERTIFICATE-----\nISSUER\n-----END CERTIFICATE-----';
    expect(splitCombinedPem(`${leaf}\n${issuer}\n${KEY}`)?.cert).toBe(leaf);
  });

  it('answers null unless both halves are there', () => {
    expect(splitCombinedPem(CERT)).toBe(null);
    expect(splitCombinedPem(KEY)).toBe(null);
    expect(splitCombinedPem('nothing of the sort')).toBe(null);
  });

  // A truncated file must not match a BEGIN against some later, unrelated END.
  it('does not match across mismatched labels', () => {
    expect(splitCombinedPem(`${CERT}\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n`)).toBe(null);
  });
});

describe('partsFromPem', () => {
  // Unlike the all-or-nothing split: someone who picked only their certificate
  // should see it land in the certificate box and add the key themselves,
  // rather than be told the file was no good.
  it('answers with whichever halves it found', () => {
    expect(partsFromPem(CERT)).toEqual({ cert: CERT, key: '' });
    expect(partsFromPem(KEY)).toEqual({ cert: '', key: KEY });
    expect(partsFromPem(`${CERT}\n${KEY}`)).toEqual({ cert: CERT, key: KEY });
    expect(partsFromPem('junk')).toEqual({ cert: '', key: '' });
  });
});
