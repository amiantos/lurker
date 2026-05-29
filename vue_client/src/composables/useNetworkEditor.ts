// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ref } from 'vue';
import type { Network } from '../stores/networks.js';

const isOpen = ref(false);
const editingNetwork = ref<Network | null>(null);

export function useNetworkEditor() {
  // Pass null (or omit) to open in add-new-network mode.
  function open(net: Network | null = null): void {
    editingNetwork.value = net;
    isOpen.value = true;
  }
  function close(): void {
    isOpen.value = false;
    editingNetwork.value = null;
  }
  return { isOpen, editingNetwork, open, close };
}
