// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { buildChannelCandidates } from './channelCompletion.js';

const bufs = (...targets: string[]) => targets.map((target) => ({ target }));

// Stands in for the recentBuffers store's `rank` getter composed with
// bufferKey(). Mirrors recencyRank's contract: 0 = most recent … Infinity =
// unvisited this session.
const rank =
  (...recent: string[]) =>
  (target: string) => {
    const i = recent.indexOf(target);
    return i === -1 ? Infinity : i;
  };

const unvisited = rank();

describe('buildChannelCandidates', () => {
  it('returns joined channels matching the prefix', () => {
    expect(buildChannelCandidates(bufs('#zebra', '#apple', '#mango'), '#', unvisited)).toEqual([
      '#apple',
      '#mango',
      '#zebra',
    ]);
  });

  it('filters case-insensitively on the prefix (# included)', () => {
    expect(buildChannelCandidates(bufs('#Test', '#testing', '#other'), '#te', unvisited)).toEqual([
      '#Test',
      '#testing',
    ]);
  });

  it('excludes DM buffers and non-matching channels', () => {
    expect(
      buildChannelCandidates(bufs('#chan', 'alice', ':server:1', '#chat'), '#cha', unvisited),
    ).toEqual(['#chan', '#chat']);
  });

  it('offers the channel you are in first — it is always rank 0', () => {
    // recentBuffers move-to-fronts on every activation, so the buffer you're in
    // is the most recent one. This is the `#`+Tab headline behavior, and it
    // beats the alphabetical order it displaces (#zebra sorts last).
    expect(buildChannelCandidates(bufs('#apple', '#mango', '#zebra'), '#', rank('#zebra'))).toEqual(
      ['#zebra', '#apple', '#mango'],
    );
  });

  it('orders by recency, then alphabetically for never-visited channels', () => {
    // #zebra is where you are, #mango where you just were; #anchor and #apple
    // are unvisited this session and fall to the alphabetical tail. Repeat-Tab
    // therefore walks your recent channels before anything else.
    expect(
      buildChannelCandidates(
        bufs('#apple', '#anchor', '#mango', '#zebra'),
        '#',
        rank('#zebra', '#mango'),
      ),
    ).toEqual(['#zebra', '#mango', '#anchor', '#apple']);
  });

  it('sorts an all-unvisited list alphabetically without NaN-corrupting', () => {
    // Every rank here is Infinity, and Infinity - Infinity is NaN — a comparator
    // that subtracted blindly would return a garbage, engine-defined order.
    expect(
      buildChannelCandidates(bufs('#delta', '#bravo', '#charlie', '#alpha'), '#', unvisited),
    ).toEqual(['#alpha', '#bravo', '#charlie', '#delta']);
  });

  it('ignores recency for channels that do not match the prefix', () => {
    // You're in #zebra but completing "#a" — #zebra isn't a candidate at all, so
    // the matches stay alphabetical.
    expect(buildChannelCandidates(bufs('#apple', '#anchor'), '#a', rank('#zebra'))).toEqual([
      '#anchor',
      '#apple',
    ]);
  });

  it('is unaffected by a recently-visited DM', () => {
    // Composing from a DM must not perturb channel order: a DM is never a
    // candidate, so its rank is never consulted.
    expect(buildChannelCandidates(bufs('#apple', '#mango'), '#', rank('alice'))).toEqual([
      '#apple',
      '#mango',
    ]);
  });

  it('ranks the target verbatim, as stored on the buffer', () => {
    // The caller composes rank with bufferKey() over the stored target, and
    // activate() canonicalizes casing to that same stored target before
    // recording it as activeKey — so both sides agree without folding. Guards a
    // future caller against folding case on one side only, which would silently
    // rank the active channel Infinity and lose the whole feature.
    expect(buildChannelCandidates(bufs('#Apple', '#mango'), '#', rank('#Apple'))).toEqual([
      '#Apple',
      '#mango',
    ]);
  });
});
