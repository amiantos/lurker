// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which channel's settings modal is open (#727), if any. Module-level so every
// way in — the topic bar, the header button, a buffer's context menu (for any
// channel, not just the one on screen) — opens the one modal the chat view
// mounts. The modal is for the channel it was opened for, whatever the active
// buffer does meanwhile.

import { ref } from 'vue';

const isOpen = ref(false);
const networkId = ref<number | null>(null);
const target = ref<string | null>(null);

export function useChannelModal() {
  function open(id: number, channel: string): void {
    networkId.value = id;
    target.value = channel;
    isOpen.value = true;
  }
  function close(): void {
    isOpen.value = false;
    networkId.value = null;
    target.value = null;
  }
  return { isOpen, networkId, target, open, close };
}
