// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Tracks which channels currently have an active voice call, so the UI can show
// a badge / "Join call (N)" even for users who are not in the call. Fed by the
// server's `call-presence` frame (see routes/voice.ts broadcastCallPresence),
// which is driven by LiveKit webhooks. Same-instance only.

import { defineStore } from 'pinia';
import { api } from '../api.js';

function key(networkId: number | null, target: string): string {
  return `${networkId ?? ''}::${target.toLowerCase()}`;
}

export const useCallPresenceStore = defineStore('callPresence', {
  state: () => ({
    // `${networkId}::${foldedTarget}` → participant count (absent = no call).
    counts: {} as Record<string, number>,
  }),
  getters: {
    countFor:
      (s) =>
      (networkId: number | null, target: string): number =>
        s.counts[key(networkId, target)] ?? 0,
  },
  actions: {
    set(networkId: number, target: string, count: number) {
      const k = key(networkId, target);
      if (count > 0) this.counts[k] = count;
      else delete this.counts[k];
    },

    /** Replace this network's known call counts with a fresh server snapshot.
     *  Called on each (re)connect edge to catch calls that started while we had
     *  no socket — the `call-presence` frame only carries live deltas, so without
     *  this a client that joins mid-call never sees the badge. Best-effort: on
     *  failure we keep whatever deltas have arrived. */
    async hydrate(networkId: number) {
      let calls: Array<{ target: string; count: number }>;
      try {
        const r = await api<{
          calls: Array<{ target: string; count: number }>;
        }>(`/api/voice/presence?networkId=${networkId}`);
        calls = r.calls ?? [];
      } catch {
        return;
      }
      // Drop stale entries for this network before applying the snapshot, so a
      // call that ended while we were away clears rather than lingering.
      const prefix = `${networkId}::`;
      for (const k of Object.keys(this.counts)) if (k.startsWith(prefix)) delete this.counts[k];
      for (const c of calls) this.set(networkId, c.target, c.count);
    },
  },
});
