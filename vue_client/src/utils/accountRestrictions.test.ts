// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { describeRestrictions, describeRestrictionsForMember } from './accountRestrictions.js';

describe('describeRestrictions', () => {
  it('says nothing for the unrestricted norm', () => {
    expect(describeRestrictions({ networks: null, uploads: true })).toBe('');
    expect(describeRestrictions(undefined)).toBe('');
  });

  it('names each knob that is set', () => {
    expect(describeRestrictions({ networks: ['a.example', 'b.example'], uploads: false })).toBe(
      'networks: a.example, b.example · no uploads',
    );
    expect(describeRestrictions({ networks: [], uploads: true })).toBe('no networks');
  });
});

describe('describeRestrictionsForMember', () => {
  it('reads as a sentence to the person it applies to', () => {
    expect(describeRestrictionsForMember({ networks: ['irc.lurker.chat'], uploads: false })).toBe(
      'This account can connect to irc.lurker.chat only. File uploads are off for this account.',
    );
    expect(
      describeRestrictionsForMember({ networks: ['a.example', 'b.example'], uploads: true }),
    ).toBe('This account can connect to a.example and b.example only.');
    expect(describeRestrictionsForMember({ networks: [], uploads: true })).toBe(
      'This account cannot connect to any IRC network yet.',
    );
    expect(describeRestrictionsForMember({ networks: null, uploads: true })).toBe('');
  });
});
