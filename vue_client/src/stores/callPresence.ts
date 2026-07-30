// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Tracks which channels currently have an active voice call, so the UI can show
// a badge / "Join call (N)" even for users who are not in the call. Fed by the
// server's `call-presence` frame (see routes/voice.ts broadcastCallPresence),
// which is driven by LiveKit webhooks. Same-instance only.

import { defineStore } from 'pinia';

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
  },
});
