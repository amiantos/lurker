// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { buildChannelCandidates } from './channelCompletion.js';

const bufs = (...targets: string[]) => targets.map((target) => ({ target }));

describe('buildChannelCandidates', () => {
  it('returns joined channels matching the prefix, alphabetically', () => {
    expect(buildChannelCandidates(bufs('#zebra', '#apple', '#mango'), '#')).toEqual([
      '#apple',
      '#mango',
      '#zebra',
    ]);
  });

  it('filters case-insensitively on the prefix (# included)', () => {
    expect(buildChannelCandidates(bufs('#Test', '#testing', '#other'), '#te')).toEqual([
      '#Test',
      '#testing',
    ]);
  });

  it('excludes DM buffers and non-matching channels', () => {
    expect(buildChannelCandidates(bufs('#chan', 'alice', ':server:1', '#chat'), '#cha')).toEqual([
      '#chan',
      '#chat',
    ]);
  });

  it('hoists the active channel to the front when it matches', () => {
    expect(buildChannelCandidates(bufs('#apple', '#mango', '#zebra'), '#', '#zebra')).toEqual([
      '#zebra',
      '#apple',
      '#mango',
    ]);
  });

  it('hoists case-insensitively', () => {
    expect(buildChannelCandidates(bufs('#Apple', '#Mango'), '#', '#mango')).toEqual([
      '#Mango',
      '#Apple',
    ]);
  });

  it('leaves ordering alphabetical when the active channel does not match the prefix', () => {
    // Active is #zebra but the user is completing "#a" — #zebra isn't a
    // candidate, so nothing to hoist.
    expect(buildChannelCandidates(bufs('#apple', '#anchor'), '#a', '#zebra')).toEqual([
      '#anchor',
      '#apple',
    ]);
  });

  it('ignores a DM (non-#) active target', () => {
    expect(buildChannelCandidates(bufs('#apple', '#mango'), '#', 'alice')).toEqual([
      '#apple',
      '#mango',
    ]);
  });

  it('is a no-op when the active channel is already first', () => {
    expect(buildChannelCandidates(bufs('#apple', '#mango'), '#', '#apple')).toEqual([
      '#apple',
      '#mango',
    ]);
  });
});
