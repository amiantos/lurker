// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// No real Apple/Google credentials are needed to prove this: a .p8 is just an EC
// P-256 private key and a service-account key is just an RSA one, so the tests
// generate their own and VERIFY the signature rather than asserting on shape.
// That's the difference between "we emitted three dot-separated base64 blobs" and
// "a provider would accept this".

import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import { signJwt, TokenCache } from './jwt.js';

type MintFn = () => Promise<{ token: string; lifetimeSeconds: number }>;

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const pem = (key: crypto.KeyObject): string =>
  key.export({ type: 'pkcs8', format: 'pem' }).toString();

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString()) as Record<string, unknown>;
}

describe('signJwt', () => {
  it('produces an ES256 token Apple could verify', () => {
    const token = signJwt(
      'ES256',
      { kid: 'KEY123' },
      { iss: 'TEAM456', iat: 1 },
      pem(ec.privateKey),
    );
    const [h, c, s] = token.split('.');
    expect(decodeSegment(h)).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'KEY123' });
    expect(decodeSegment(c)).toEqual({ iss: 'TEAM456', iat: 1 });

    // The actual check: verify with the public half, in the encoding APNs uses.
    const ok = crypto
      .createVerify('SHA256')
      .update(`${h}.${c}`)
      .verify({ key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });

  it('emits the raw 64-byte r||s signature, not DER', () => {
    // The detail that usually forces a JWT dependency. Node defaults to DER for
    // EC keys, which is ~70 bytes, variable-length, and rejected by APNs as a
    // malformed token — a failure that only shows up against the real service.
    const token = signJwt('ES256', { kid: 'k' }, { iss: 't', iat: 1 }, pem(ec.privateKey));
    const sig = Buffer.from(token.split('.')[2], 'base64url');
    expect(sig.length).toBe(64);
    // DER signatures start with the SEQUENCE tag 0x30. A raw one starting with
    // 0x30 by chance is possible, so this is a hint, not the assertion above.
    expect(sig.length).not.toBe(70);
  });

  it('produces an RS256 token Google could verify', () => {
    const token = signJwt(
      'RS256',
      {},
      { iss: 'svc@project.iam.gserviceaccount.com', scope: 'scope', aud: 'aud', iat: 1, exp: 2 },
      pem(rsa.privateKey),
    );
    const [h, c, s] = token.split('.');
    expect(decodeSegment(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const ok = crypto
      .createVerify('SHA256')
      .update(`${h}.${c}`)
      .verify(rsa.publicKey, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });

  it('base64url-encodes, so a token is URL/header safe', () => {
    // A '+' or '/' in a header value is a wire-level bug that only bites on the
    // fraction of tokens whose bytes happen to produce one.
    for (let i = 0; i < 20; i++) {
      const token = signJwt('ES256', { kid: `k${i}` }, { iss: 't', iat: i }, pem(ec.privateKey));
      expect(token).not.toMatch(/[+/=]/);
    }
  });
});

describe('TokenCache', () => {
  it('mints once and reuses until near expiry', async () => {
    const mint = vi.fn<MintFn>(async () => ({ token: 'tok-1', lifetimeSeconds: 3600 }));
    const cache = new TokenCache(mint);
    expect(await cache.get(0)).toBe('tok-1');
    expect(await cache.get(1000)).toBe('tok-1');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('refreshes early, so a token cannot expire in flight', async () => {
    let n = 0;
    const mint = vi.fn<MintFn>(async () => ({ token: `tok-${++n}`, lifetimeSeconds: 3600 }));
    const cache = new TokenCache(mint, 300);
    await cache.get(0);
    // 3600 - 300 skew = usable until t=3300s.
    expect(await cache.get(3_299_000)).toBe('tok-1');
    expect(await cache.get(3_300_000)).toBe('tok-2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent mints into one', async () => {
    // A push fans out to every device at once, so the first push after expiry
    // would otherwise mint one token per device — which is exactly what APNs
    // punishes with TooManyProviderTokenUpdates.
    let resolve!: (v: { token: string; lifetimeSeconds: number }) => void;
    const mint = vi.fn<MintFn>(
      () => new Promise<{ token: string; lifetimeSeconds: number }>((r) => (resolve = r)),
    );
    const cache = new TokenCache(mint);
    const all = Promise.all([cache.get(0), cache.get(0), cache.get(0), cache.get(0)]);
    resolve({ token: 'tok-1', lifetimeSeconds: 3600 });
    expect(await all).toEqual(['tok-1', 'tok-1', 'tok-1', 'tok-1']);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed mint instead of caching the failure', async () => {
    let attempt = 0;
    const mint = vi.fn<MintFn>(async () => {
      if (++attempt === 1) throw new Error('network down');
      return { token: 'tok-ok', lifetimeSeconds: 3600 };
    });
    const cache = new TokenCache(mint);
    await expect(cache.get(0)).rejects.toThrow('network down');
    // The in-flight promise must be cleared on rejection too, or every later
    // call would await a promise that already rejected and push would be dead
    // until restart.
    expect(await cache.get(0)).toBe('tok-ok');
  });

  it('re-mints after reset', async () => {
    let n = 0;
    const mint = vi.fn<MintFn>(async () => ({ token: `tok-${++n}`, lifetimeSeconds: 3600 }));
    const cache = new TokenCache(mint);
    expect(await cache.get(0)).toBe('tok-1');
    cache.reset();
    expect(await cache.get(0)).toBe('tok-2');
  });
});
