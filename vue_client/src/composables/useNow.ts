// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/**
 * The current time as a ref that moves while the component is mounted: for a
 * clock shown to the minute (someone's local time in their profile, #1450).
 */
export function useNow(everyMs = 15_000): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  onMounted(() => {
    timer = setInterval(() => {
      now.value = Date.now();
    }, everyMs);
  });
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer);
  });
  return now;
}
