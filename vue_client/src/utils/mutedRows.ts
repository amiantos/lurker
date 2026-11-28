// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// "Hide Muted Channels" (#1034), switched per network from its menu and
// stored on the server (`hide_muted` on the network): a muted channel or DM
// leaves the sidebar until something highlights it. The buffer
// you are in always stays, and so does anything pinned or favorited: those
// were put where they are on purpose.
//
// One rule for the sidebar and for Alt+arrow, so the keyboard never steps
// into a row the list is not showing. The quick switcher still finds them.

export function hidesMutedRow(row: {
  // The network's switch.
  hideMuted: boolean;
  muted: boolean;
  highlighted: number;
  active: boolean;
  // Pinned, or under FRIENDS / FAVORITES.
  kept: boolean;
}): boolean {
  if (!row.hideMuted || !row.muted) return false;
  return row.highlighted === 0 && !row.active && !row.kept;
}
