// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ref } from 'vue';
import type { Network } from '../stores/networks.js';
import { useAccountLimits } from './useAccountLimits.js';

const isOpen = ref(false);
const editingNetwork = ref<Network | null>(null);

export function useNetworkEditor() {
  const limits = useAccountLimits();
  // Pass null (or omit) to open in add-new-network mode. Decided here rather
  // than at each + so no caller can forget it: a held account that already
  // reaches every host it may use gets the limits modal, not a picker that
  // could only add a second connection to one of them. Editing is untouched.
  function open(net: Network | null = null): void {
    if (net === null && limits.addNetworkHeld.value) {
      limits.open();
      return;
    }
    editingNetwork.value = net;
    isOpen.value = true;
  }
  function close(): void {
    isOpen.value = false;
    editingNetwork.value = null;
  }
  return { isOpen, editingNetwork, open, close };
}
