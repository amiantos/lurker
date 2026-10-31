// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The one place the client answers a held account's "why not?" (an account
// restriction, shared/accountRestrictions.ts). Three controls lead here: the
// add-network + once every host the account may use already has a connection,
// and attach and Shares while uploads are off. Each opens AccountLimitsModal
// instead of going dead, so the account reads what it can't do and, on a hosted
// cell, where paying lifts it. The shells render the modal off `isOpen`, the
// same shape useNetworkEditor has.
//
// Only the client decides this. The server refuses an off-list host and an
// upload (networkPolicy.ts, processUpload); a second connection to an allowed
// host it permits, so hiding the + is a nudge, not a gate (Brad's call: not an
// abuse worth a rule).

import { computed, ref } from 'vue';
import { useAuthStore } from '../stores/auth.js';
import { useNetworksStore } from '../stores/networks.js';
import { foldHost } from '../../../shared/accountRestrictions.js';

const isOpen = ref(false);

export function useAccountLimits() {
  const auth = useAuthStore();
  const networks = useNetworksStore();

  // Every host the account is held to already has a network row, so a new
  // one could only be a second connection to a place it already reaches.
  // False under no list (the picker is the right answer), and false while a
  // listed host is still unused (the picker offers exactly that host).
  const addNetworkHeld = computed<boolean>(() => {
    const allowed = auth.allowedNetworkHosts;
    if (allowed === null || allowed.length === 0) return false;
    const have = new Set(networks.networks.map((n) => foldHost(n.host)));
    return allowed.every((h) => have.has(foldHost(h)));
  });

  function open(): void {
    isOpen.value = true;
  }
  function close(): void {
    isOpen.value = false;
  }
  return { isOpen, addNetworkHeld, open, close };
}
