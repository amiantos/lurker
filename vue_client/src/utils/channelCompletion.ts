// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared candidate builder for channel completion — used by both Tab-completion
// in MessageInput and the `#`-triggered ChannelPicker. Returns the targets of
// joined channels matching `prefix` (case-insensitive), most-recently-visited
// first, with never-visited channels alphabetical behind them.
//
// `prefix` includes the leading '#' (it's the raw token under the cursor), and
// the '#' stays in every result — unlike nicks' '@' sugar, '#' is part of the
// channel name.
//
// Candidate source is deliberately just the buffers the user is already in:
// the point of channel completion is to quickly reference a channel you can
// tell someone else to join (the inserted `#channel` renders as a clickable
// join link for the recipient — see issue #154), so "joined channels" is
// exactly the right set. There is no /LIST-backed directory of channels you
// haven't joined.

interface ChannelBuffer {
  target?: string;
}

// `rank` is recency: 0 = most recent … Infinity = unvisited this session — i.e.
// the recentBuffers store's `rank` getter (#393), composed with bufferKey() by
// the caller. Injected rather than imported so this stays Pinia-free and the
// ordering edge cases are unit-testable in isolation.
//
// Ordering by recency gets the standard IRC `#`+Tab behavior for free:
// recentBuffers move-to-fronts on every activation, so the channel you're
// currently in is always rank 0 and therefore always offered first. Repeat-Tab
// then walks back through the channels you were just in before reaching the
// alphabetical tail — better than hoisting only the active channel and
// alphabetizing the rest, where the second Tab hands you whatever sorts first
// rather than where you actually were.
//
// The recency trail is in-memory and per-session, so on a cold load everything
// except the buffer you land on is unvisited and this degrades to exactly
// current-channel-first, then alphabetical.
//
// `rank` is required, not optional: a caller that forgets to pass an ordering
// source produces a plausible-looking alphabetical list rather than any visible
// failure, so it's worth a type error at the call site instead.
export function buildChannelCandidates(
  buffers: ChannelBuffer[],
  prefix: string,
  rank: (target: string) => number,
): string[] {
  const lower = prefix.toLowerCase();
  return (
    buffers
      .map((b) => b.target ?? '')
      .filter((t) => t.startsWith('#') && t.toLowerCase().startsWith(lower))
      // Rank each candidate once up front rather than inside the comparator: a
      // rank lookup is a linear scan of the MRU trail, and a comparator would
      // repeat it twice per comparison — on every keystroke, since the picker's
      // row list is a computed that rebuilds as you type.
      .map((target) => ({ target, rank: rank(target) }))
      .toSorted((a, b) =>
        // Equality first: two unvisited channels both rank Infinity, and
        // Infinity - Infinity is NaN — which would silently corrupt the sort.
        a.rank === b.rank ? a.target.localeCompare(b.target) : a.rank - b.rank,
      )
      .map((c) => c.target)
  );
}
