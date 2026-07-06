// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { ensureChannelPrefix } from './channelTarget.js';

describe('ensureChannelPrefix', () => {
  it('prepends # to a bare name', () => {
    expect(ensureChannelPrefix('lurker')).toBe('#lurker');
  });

  it('leaves any RFC 2811 channel prefix untouched', () => {
    expect(ensureChannelPrefix('#chan')).toBe('#chan');
    expect(ensureChannelPrefix('&local')).toBe('&local');
    expect(ensureChannelPrefix('+modeless')).toBe('+modeless');
    expect(ensureChannelPrefix('!12345chan')).toBe('!12345chan');
  });

  it('does not validate — a lone prefix or empty string passes through / gets prefixed', () => {
    // Prefix-only concern: input validation (empty, whitespace, lone prefix)
    // stays with the caller, so these are intentionally not rejected here.
    expect(ensureChannelPrefix('#')).toBe('#');
    expect(ensureChannelPrefix('')).toBe('#');
  });
});
