// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { nickFromUsername } from './ircNick.js';

describe('nickFromUsername', () => {
  it('passes an already-valid username straight through', () => {
    expect(nickFromUsername('alice')).toBe('alice');
    expect(nickFromUsername('Bob_the-Builder')).toBe('Bob_the-Builder');
  });

  it('keeps the RFC 2812 special characters', () => {
    expect(nickFromUsername('a[]\\`_^{|}-')).toBe('a[]\\`_^{|}-');
  });

  it('drops characters an ircd would reject', () => {
    expect(nickFromUsername('brad root')).toBe('bradroot');
    expect(nickFromUsername('user@example.com')).toBe('userexamplecom');
    expect(nickFromUsername('naïve👋')).toBe('nave');
  });

  // The bug this function exists for. A nick may not START with a digit or a
  // hyphen, so prefilling "1337h4x" verbatim would earn a 432
  // ERR_ERRONEUSNICKNAME — a failed first-ever connection, from a field the user
  // never touched because we filled it in for them.
  it('strips a leading digit or hyphen rather than seeding an invalid nick', () => {
    expect(nickFromUsername('1337h4x')).toBe('h4x');
    expect(nickFromUsername('-dash')).toBe('dash');
    expect(nickFromUsername('42')).toBe('');
  });

  it('returns empty when nothing usable survives, leaving the field for the user', () => {
    expect(nickFromUsername('👋🎉')).toBe('');
    expect(nickFromUsername('')).toBe('');
    expect(nickFromUsername(undefined)).toBe('');
    expect(nickFromUsername(null)).toBe('');
  });

  it('caps the seed below the common NICKLEN floor', () => {
    expect(nickFromUsername('a'.repeat(40))).toHaveLength(16);
  });
});
