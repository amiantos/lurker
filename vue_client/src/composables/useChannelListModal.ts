// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ref } from 'vue';

const isOpen = ref(false);
const networkId = ref<number | null>(null);

export function useChannelListModal() {
  function open(id: number): void {
    networkId.value = id;
    isOpen.value = true;
  }
  function close(): void {
    isOpen.value = false;
    networkId.value = null;
  }
  return { isOpen, networkId, open, close };
}
