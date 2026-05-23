// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Ref } from 'vue';
import { ref } from 'vue';

// Mobile breakpoint. The desktop layout is a 220 + 1fr + 180 = 400px-of-chrome
// grid, so anything below ~720px gets squeezed beyond repair. 768px is a
// conventional tablet-portrait threshold and gives a comfortable margin.
const MOBILE_QUERY = '(max-width: 768px)';

// One shared MediaQueryList — cheaper than per-component listeners and means
// every consumer flips at the exact same moment when the viewport crosses
// the breakpoint.
let mql: MediaQueryList | null = null;
const isMobile = ref(false);
let initialized = false;

export interface ViewportState {
  isMobile: Ref<boolean>;
}

function ensureInit(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  mql = window.matchMedia(MOBILE_QUERY);
  isMobile.value = mql.matches;
  // addEventListener is the modern path; older Safari needs addListener.
  if (mql.addEventListener) mql.addEventListener('change', onChange);
  else (mql as any).addListener(onChange);
}

function onChange(e: MediaQueryListEvent): void {
  isMobile.value = e.matches;
}

export function useViewport(): ViewportState {
  ensureInit();
  return { isMobile };
}
