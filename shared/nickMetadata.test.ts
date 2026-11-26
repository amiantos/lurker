// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { effectiveMetadata, parseColorSlot } from './nickMetadata.js';

describe('effectiveMetadata', () => {
  const wire = { displayName: 'Bobby', avatarUrl: '/a.png', pronouns: 'he/him', color: '#ff0000' };

  it('is the wire record when nothing is set on the nick', () => {
    expect(effectiveMetadata(wire, null)).toBe(wire);
    expect(effectiveMetadata(wire, {})).toBe(wire);
    expect(effectiveMetadata(null, {})).toBeNull();
  });

  it('puts a set value in front of theirs and leaves the rest', () => {
    expect(effectiveMetadata(wire, { 'display-name': 'Robert' })).toEqual({
      ...wire,
      displayName: 'Robert',
    });
    expect(wire.displayName).toBe('Bobby');
  });

  it('hides a display name or an avatar', () => {
    expect(effectiveMetadata(wire, { 'display-name': null, avatar: null })).toEqual({
      pronouns: 'he/him',
      color: '#ff0000',
    });
  });

  it('carries a colour slot beside their colour, never in its place', () => {
    expect(effectiveMetadata(wire, { color: '3' })).toEqual({ ...wire, colorSlot: 3 });
    expect(effectiveMetadata(wire, { color: 'red' })).toEqual(wire);
  });

  it('gives metadata to a nick that has none', () => {
    expect(effectiveMetadata(null, { 'lurker.chat/tz': 'Europe/Berlin', color: '0' })).toEqual({
      tz: 'Europe/Berlin',
      colorSlot: 0,
    });
  });

  it('is nothing when all that was set is a hide of nothing', () => {
    expect(effectiveMetadata(null, { avatar: null })).toBeNull();
  });
});

describe('parseColorSlot', () => {
  it('reads a slot and nothing else', () => {
    expect(parseColorSlot('0')).toBe(0);
    expect(parseColorSlot('15')).toBe(15);
    expect(parseColorSlot('-1')).toBeNull();
    expect(parseColorSlot('#ff0000')).toBeNull();
    expect(parseColorSlot('1.5')).toBeNull();
    expect(parseColorSlot(null)).toBeNull();
  });
});
