// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll } from 'vitest';
import type * as WebauthnModule from './webauthn.js';

let mod: typeof WebauthnModule;

beforeAll(async () => {
  mod = await import('./webauthn.js');
});

describe('rpConfig', () => {
  it('returns the configured RP id, name, and expected origins', () => {
    const { rpID, rpName, expectedOrigin } = mod.rpConfig();
    expect(typeof rpID).toBe('string');
    expect(typeof rpName).toBe('string');
    expect(Array.isArray(expectedOrigin)).toBe(true);
    expect(expectedOrigin.length).toBeGreaterThan(0);
  });
});

describe('saveChallenge / consumeChallenge', () => {
  it('round-trips a challenge payload exactly once', () => {
    const token = mod.saveChallenge({ purpose: 'login', challenge: 'abc' });
    expect(typeof token).toBe('string');
    const entry = mod.consumeChallenge(token);
    expect(entry).toMatchObject({ purpose: 'login', challenge: 'abc' });
    // Second consume returns null — single-use semantics.
    expect(mod.consumeChallenge(token)).toBeNull();
  });

  it('returns null for missing/unknown tokens', () => {
    expect(mod.consumeChallenge('no-such')).toBeNull();
    expect(mod.consumeChallenge('')).toBeNull();
    expect(mod.consumeChallenge(null)).toBeNull();
  });
});

describe('userIdToHandle / handleToUserId', () => {
  it('round-trips a numeric user id', () => {
    const handle = mod.userIdToHandle(42);
    expect(handle.toString('utf8')).toBe('caint-user-42');
    expect(mod.handleToUserId(handle)).toBe(42);
  });

  it('handleToUserId returns null for malformed handles', () => {
    expect(mod.handleToUserId(Buffer.from('not-a-handle', 'utf8'))).toBeNull();
    expect(mod.handleToUserId(Buffer.from('caint-user-NaN', 'utf8'))).toBeNull();
  });
});
