// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared candidate builder for channel completion — used by both Tab-completion
// in MessageInput and the `#`-triggered ChannelPicker. Returns the targets of
// joined channels matching `prefix` (case-insensitive), sorted alphabetically,
// except the channel you're currently in is hoisted to the front when it
// matches (see `activeTarget`).
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

// `activeTarget` is the buffer the composer is in. When it's a channel that
// also matches `prefix`, it's moved to the front so `#`+Tab offers the channel
// you're currently in FIRST — the standard IRC-client behavior. The rest keep
// their alphabetical order behind it. A nick target (a DM) or an unset value
// leaves the list purely alphabetical.
export function buildChannelCandidates(
  buffers: ChannelBuffer[],
  prefix: string,
  activeTarget?: string | null,
): string[] {
  const lower = prefix.toLowerCase();
  const matches = buffers
    .map((b) => b.target ?? '')
    .filter((t) => t.startsWith('#') && t.toLowerCase().startsWith(lower))
    .toSorted((a, b) => a.localeCompare(b));
  if (activeTarget && activeTarget.startsWith('#')) {
    const activeLower = activeTarget.toLowerCase();
    const idx = matches.findIndex((t) => t.toLowerCase() === activeLower);
    if (idx > 0) {
      const [current] = matches.splice(idx, 1);
      matches.unshift(current);
    }
  }
  return matches;
}
