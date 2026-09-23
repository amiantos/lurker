// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which channel's settings modal is open (#727), if any. Module-level so every
// way in — the topic bar, the header button, a buffer's context menu (for any
// channel, not just the one on screen) — opens the one modal the chat view
// mounts. The modal is for the channel it was opened for, whatever the active
// buffer does meanwhile.

import { ref } from 'vue';

export interface OpenChannel {
  networkId: number;
  target: string;
}

const current = ref<OpenChannel | null>(null);

export function useChannelModal() {
  function open(networkId: number, target: string): void {
    current.value = { networkId, target };
  }
  function close(): void {
    current.value = null;
  }
  return { current, open, close };
}
