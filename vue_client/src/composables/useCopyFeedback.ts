// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// "Copy, and flash a tick for a moment so the user knows it worked."
//
// Scoped deliberately narrowly. The app copies to the clipboard in several places and
// they are NOT all this: the invite link and the copy-message action are
// fire-and-forget, and the API-token pane holds a persistent "copied" state and raises
// a visible error when the clipboard is unavailable (it has to — that token is shown
// exactly once). This is only the transient-confirmation shape: the uploads browser's
// per-tile copy button, and the image viewer's.
//
// `key` exists so a LIST can share one instance: pass the row's id and only that row's
// button ticks. Callers with a single button pass nothing and read `copied`.

import { getCurrentInstance, onBeforeUnmount, ref, computed } from 'vue';

const RESET_MS = 1500;

export type CopyKey = string | number;

export function useCopyFeedback(resetMs = RESET_MS) {
  const copiedKey = ref<CopyKey | null>(null);
  const copied = computed(() => copiedKey.value !== null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy(text: string, key: CopyKey = 'default'): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      // The Clipboard API can reject without a user-gesture context, and is absent
      // outside secure contexts entirely (Lurker's LAN dev mode serves plain HTTP).
      // Nothing to report: the user can still open the file and copy the address, and
      // a failed convenience is not an error worth a banner.
      return false;
    }
    copiedKey.value = key;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copiedKey.value = null;
      timer = null;
    }, resetMs);
    return true;
  }

  /** True iff THIS key is the one that was just copied. */
  function isCopied(key: CopyKey = 'default'): boolean {
    return copiedKey.value === key;
  }

  /** Drop the confirmation early — for when the thing it referred to is gone. */
  function reset(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    copiedKey.value = null;
  }

  // Guarded: Vue warns when a lifecycle hook is registered with no active component
  // instance, which is exactly the case in a unit test calling the composable directly.
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      if (timer) clearTimeout(timer);
    });
  }

  return { copiedKey, copied, copy, isCopied, reset };
}
