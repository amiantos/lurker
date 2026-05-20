// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Derive UX state from a peer presence entry. An entry records the most
// recent transition; these helpers translate its `state` into the boolean
// states BufferList / StatusBar care about.

import type { PeerPresenceEntry } from '../stores/networks.js';

// Only `state` is consulted here — narrow to it so callers can pass a full
// PeerPresenceEntry without the two shapes drifting apart.
type PeerPresenceRow = Pick<PeerPresenceEntry, 'state'>;

export function isPeerOffline(peer: PeerPresenceRow | null | undefined): boolean {
  return peer?.state === 'offline';
}

export function isPeerAway(peer: PeerPresenceRow | null | undefined): boolean {
  return peer?.state === 'away';
}

// "Online" in the UX sense covers 'online' and 'back' — the peer is
// reachable and not flagged AFK. Unknown peers (null) aren't called online.
export function isPeerOnline(peer: PeerPresenceRow | null | undefined): boolean {
  return peer?.state === 'online' || peer?.state === 'back';
}
