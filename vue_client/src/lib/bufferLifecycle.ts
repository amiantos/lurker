// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The one list of every store holding per-buffer state, and the two lifecycle
// sweeps over it.
//
// Why this exists: per-buffer client state is scattered across ~10 stores
// (plus module-level Maps inside them), and the old `buffer-closed` handler
// cleaned exactly four — the rest leaked stale entries keyed by a buffer
// nothing would ever reference again. That's the client-side twin of the
// server bug class the buffers registry was built to kill: state keyed by a
// name, orphaned when the name goes away. Every store that keys anything by
// buffer joins this list by implementing `dropBuffer` (and `rekeyBuffer`, the
// rename hook — consumed when `buffer-renamed` lands); adding per-buffer state
// without joining is the bug this file exists to make visible in review.
//
// The participants are getter thunks (not instances) because Pinia stores can
// only be instantiated once an active pinia exists — these run inside socket
// handlers, long after app init.

import { useBuffersStore, bufferKeyForId } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useNavHistoryStore } from '../stores/navHistory.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useDraftStore } from '../stores/drafts.js';
import { useInputHistoryStore } from '../stores/inputHistory.js';
import { usePinsStore } from '../stores/pins.js';
import { useFavoritesStore } from '../stores/favorites.js';
import { useNicklistCollapseStore } from '../stores/nicklistCollapse.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { useSplitsStore } from '../stores/splits.js';

export interface BufferLifecycleParticipant {
  /** Remove every trace of (networkId, target) from this store. */
  dropBuffer(networkId: number | string | null, target: string): void;
  /** Move every trace of (networkId, from) to (networkId, to). */
  rekeyBuffer(networkId: number | string | null, from: string, to: string): void;
}

// Deliberately NOT registered: search scope (a frozen display string, going
// stale is cosmetic), whois/nickNotes/relayBots (nick-keyed, not
// buffer-keyed — a DM rename's nick side is the rename feature's concern),
// bookmarks/highlights (message-id-keyed; rows outlive their buffer by
// design).
const participants: Array<() => BufferLifecycleParticipant> = [
  () => useBuffersStore(),
  () => useNetworksStore(),
  () => useNavHistoryStore(),
  () => useRecentBuffersStore(),
  () => useDraftStore(),
  () => useInputHistoryStore(),
  () => usePinsStore(),
  () => useFavoritesStore(),
  () => useNicklistCollapseStore(),
  () => useChannelNotifyStore(),
  // Which buffers the desktop frame has open in panes.
  () => useSplitsStore(),
];

// Most participants key exact `${networkId}::${target}` strings, but the
// server can hand us a divergently-cased name (#289/#327). The buffers store
// resolves case-insensitively — so resolve through it ONCE and sweep every
// other store with the canonical casing its keys were built from.
function canonicalTarget(networkId: number | string | null, target: string): string {
  return useBuffersStore().findByTarget(networkId, target)?.target ?? target;
}

/** The buffer is gone (buffer-closed): sweep every participating store. */
export function bufferClosed(networkId: number | string | null, target: string): void {
  const canonical = canonicalTarget(networkId, target);
  for (const get of participants) get().dropBuffer(networkId, canonical);
}

/** The buffer changed names (buffer-renamed, same id): rekey every
 *  participating store. The buffers store is first in the participant list —
 *  it must move before the others, and `from` is canonicalized BEFORE it does
 *  (afterward the old name no longer resolves). */
export function bufferRenamed(networkId: number | string | null, from: string, to: string): void {
  const canonicalFrom = canonicalTarget(networkId, from);
  for (const get of participants) get().rekeyBuffer(networkId, canonicalFrom, to);
}

/**
 * The full `buffer-renamed` frame contract (docs §9.7): the buffer keeps its
 * id and adopts the new name; on a merge the ABSORBED buffer
 * (`mergedFromBufferId`) is dropped everywhere first, so the rename lands
 * with no collision and the destination-wins fallbacks in the rekey hooks
 * never fire on an announced merge. A merged buffer's history interleaves two
 * message streams server-side, so the local slice is wiped and flagged for a
 * fresh hydrate rather than guessed at — the read-state / pins / draft
 * corrections ride in right behind the frame. Following the active buffer is
 * free: networks.rekeyBuffer moves activeKey.
 */
export function applyBufferRenamed(payload: {
  networkId: number | string | null;
  from: string;
  to: string;
  bufferId?: number | null;
  merged?: boolean;
  mergedFromBufferId?: number | null;
}): void {
  const { networkId, from, to, bufferId, merged, mergedFromBufferId } = payload;
  if (merged) {
    // The absorbed row is identified by ID, never by which of from/to it sat
    // under: the frame's two producers orient the pair differently. A DM
    // nick-collision absorbs the row already holding `to`; a casemapping
    // refold (#707) absorbs the `from` row while the survivor keeps its own
    // name — so reading orientation here ("drop `to`") swept the SURVIVOR of
    // a refold merge out of every store, vanishing the open channel the
    // reader was sitting in.
    const buffers = useBuffersStore();
    const absorbedKey = mergedFromBufferId != null ? bufferKeyForId(mergedFromBufferId) : undefined;
    const absorbed = absorbedKey ? buffers.byKey(absorbedKey) : null;
    if (absorbed) {
      bufferClosed(absorbed.networkId, absorbed.target);
    } else {
      // Absorbed id unknown locally (optimistically-created row merged before
      // any id-carrying frame): fall back to the DM orientation — but never
      // sweep a row that PROVES it is the survivor by recording the
      // surviving id.
      const atTo = buffers.findByTarget(networkId, to);
      if (atTo && !(typeof bufferId === 'number' && atTo.id === bufferId)) {
        bufferClosed(networkId, to);
      }
    }
  }
  bufferRenamed(networkId, from, to);
  const buffers = useBuffersStore();
  let buf = buffers.findByTarget(networkId, to);
  if (!buf && merged && typeof bufferId === 'number' && networkId != null) {
    // Whatever the sweep above decided, a merged frame PROVES a live buffer
    // named `to` exists server-side. If local state ended up rowless — both
    // twins held id-less and the fallback swept the wrong one — materialize
    // the survivor instead of bailing, so the buffer can never vanish from
    // the sidebar; the wipe below routes it through the ordinary hydration
    // fetch, and the read-state/pins/draft follow-ups correct the rest.
    buf = buffers.ensure(networkId, to, bufferId);
  }
  if (!buf) return;
  // Learn/confirm the id under the new key (also heals the case where the
  // rename raced ahead of the burst and we never knew the id).
  if (typeof bufferId === 'number' && networkId != null) buffers.ensure(networkId, to, bufferId);
  if (merged && !buf.detached) {
    buf.messages = [];
    buf.oldestId = null;
    buf.newestId = null;
    buf.hasMoreOlder = true;
    // The shell flag routes it through the ordinary hydration reconciler —
    // activate() (or useBufferHydration, if it's already active) fetches the
    // merged latest slice exactly like a fresh-connect shell.
    buf.unseeded = true;
  }
}
