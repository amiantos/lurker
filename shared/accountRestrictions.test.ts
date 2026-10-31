// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  hostListProblem,
  parseAccountRestrictions,
  readAccountRestrictions,
  restrictionsFromStored,
  sameRestrictions,
  serializeAccountRestrictions,
  UNRESTRICTED,
} from './accountRestrictions.js';

describe('parseAccountRestrictions', () => {
  it('folds, de-duplicates and sorts hosts', () => {
    expect(
      parseAccountRestrictions({
        networks: [' IRC.Lurker.Chat ', 'irc.lurker.chat', 'a.b'],
        uploads: true,
      }),
    ).toStrictEqual({ networks: ['a.b', 'irc.lurker.chat'], uploads: true });
  });

  it('reads null as any host and accepts the unrestricted norm', () => {
    expect(parseAccountRestrictions({ networks: null, uploads: true })).toStrictEqual({
      networks: null,
      uploads: true,
    });
  });

  // Whole set or nothing: a body missing a field is never "the rest is allowed".
  it('refuses a body missing either field', () => {
    for (const partial of [{}, { uploads: false }, { networks: [] }, { networks: null }]) {
      expect([partial, parseAccountRestrictions(partial)]).toStrictEqual([partial, null]);
    }
  });

  it('keeps an empty list as "no networks at all"', () => {
    expect(parseAccountRestrictions({ networks: [], uploads: true })?.networks).toStrictEqual([]);
  });

  it('refuses anything that is not the documented shape', () => {
    for (const bad of [
      null,
      'x',
      [],
      { networks: 'irc.lurker.chat' },
      { networks: [1] },
      { networks: [''] },
      { networks: ['a b'] },
      { networks: ['a,b'] },
      { networks: ['x'.repeat(254)], uploads: true },
      { networks: ['irc.example.org:6697'], uploads: true },
      { networks: ['https://irc.example.org'], uploads: true },
      { networks: null, uploads: 'no' },
    ]) {
      expect([bad, parseAccountRestrictions(bad)]).toStrictEqual([bad, null]);
    }
  });

  // The cell and the control plane are released separately; a field this
  // version does not know is not a reason to refuse the ones it does.
  it('ignores keys it does not know', () => {
    expect(parseAccountRestrictions({ networks: null, uploads: true, dcc: false })).toStrictEqual({
      networks: null,
      uploads: true,
    });
  });

  it('says which host is wrong, and why', () => {
    expect(readAccountRestrictions({ networks: ['irc.example.org:6697'], uploads: true })).toEqual({
      error: 'irc.example.org:6697: hostnames only, no port',
    });
    expect(readAccountRestrictions({ networks: ['irc.example.org/x'], uploads: true })).toEqual({
      error: 'irc.example.org/x: hostnames only, no scheme or path',
    });
    expect(readAccountRestrictions({ uploads: true })).toEqual({
      error: 'body must be { networks: string[] | null, uploads: boolean }',
    });
    expect(hostListProblem(['irc.lurker.chat', ' '])).toBe('a host is empty');
    expect(hostListProblem(['irc.lurker.chat'])).toBeNull();
  });
});

describe('stored form', () => {
  it('stores the unrestricted norm as NULL and reads NULL back as unrestricted', () => {
    expect(serializeAccountRestrictions({ networks: null, uploads: true })).toBeNull();
    expect(restrictionsFromStored(null)).toBe(UNRESTRICTED);
    expect(restrictionsFromStored(undefined)).toBe(UNRESTRICTED);
  });

  it('round-trips a restriction', () => {
    const r = { networks: ['irc.lurker.chat'], uploads: false };
    expect(restrictionsFromStored(serializeAccountRestrictions(r))).toStrictEqual(r);
  });

  // Only our own validated writes reach the column, so garbage is corruption,
  // and a restriction that cannot be read must not read as "no restriction".
  it('fails closed on a value it cannot read', () => {
    expect(restrictionsFromStored('{not json')).toStrictEqual({ networks: [], uploads: false });
    expect(restrictionsFromStored('')).toStrictEqual({ networks: [], uploads: false });
    expect(restrictionsFromStored('{"uploads":false}')).toStrictEqual({
      networks: [],
      uploads: false,
    });
    expect(restrictionsFromStored('{"networks":"x"}')).toStrictEqual({
      networks: [],
      uploads: false,
    });
  });
});

describe('sameRestrictions', () => {
  it('ignores the order hosts were listed in', () => {
    const a = parseAccountRestrictions({ networks: ['b.example', 'a.example'], uploads: true })!;
    const b = parseAccountRestrictions({ networks: ['a.example', 'b.example'], uploads: true })!;
    expect(sameRestrictions(a, b)).toBe(true);
    expect(sameRestrictions(a, { ...a, uploads: false })).toBe(false);
  });
});
