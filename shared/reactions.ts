// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 reactions (client-tags/react): what a reaction value may be, shared by
// the server (receive + send) and the client (the /react command, the picker).
//
// The spec puts no restriction on the value and leaves limits to clients. We
// take halloy's: at most 64 grapheme clusters, and an over-long value is
// DROPPED, never truncated. Truncating would mint a different reaction from the
// one everyone else sees — clicking it to agree would send the truncated text,
// which other clients count as a second, separate reaction.
export const MAX_REACTION_GRAPHEMES = 64;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemeCount(value: string, stopAfter: number): number {
  let n = 0;
  for (const _ of segmenter.segment(value)) {
    n += 1;
    if (n > stopAfter) break;
  }
  return n;
}

// Whether `value` is a reaction we store, render and send. Empty and
// whitespace-only values say nothing and render as a blank, so they're refused
// along with the over-long ones. A line break would break the line it trails.
export function isValidReactionValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value.trim()) return false;
  if (/[\r\n]/.test(value)) return false;
  return graphemeCount(value, MAX_REACTION_GRAPHEMES) <= MAX_REACTION_GRAPHEMES;
}

// A reaction as it rides a message row: who, what, and whether it's ours.
// Ordered oldest-first, so grouping by value keeps first-reacted order.
export interface MessageReaction {
  nick: string;
  value: string;
  self: boolean;
}
