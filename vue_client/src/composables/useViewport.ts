// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Ref } from 'vue';
import { ref } from 'vue';

// Mobile breakpoint. The desktop layout is a 220 + 1fr + 180 = 400px-of-chrome
// grid, so anything below ~720px gets squeezed beyond repair. 768px is a
// conventional tablet-portrait threshold and gives a comfortable margin.
const MOBILE_QUERY = '(max-width: 768px)';
// Input-capability query: the primary pointer can hover, i.e. a desktop
// mouse/trackpad. Touch devices report `hover: none` and fail this — including
// iPad in landscape, which is wider than the mobile breakpoint but still has no
// hover. Drives the desktop-vs-touch split for the message context menu (#392),
// and is kept identical to the `@media (hover: hover)` the build wraps every
// hover rule in (#115) so CSS hover-visibility and JS interaction routing agree.
const HOVER_QUERY = '(hover: hover)';

// One shared MediaQueryList per query — cheaper than per-component listeners and
// means every consumer flips at the exact same moment when the viewport crosses
// the breakpoint.
let mql: MediaQueryList | null = null;
let hoverMql: MediaQueryList | null = null;
const isMobile = ref(false);
const canHover = ref(false);
let initialized = false;

export interface ViewportState {
  isMobile: Ref<boolean>;
  canHover: Ref<boolean>;
}

function ensureInit(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  mql = window.matchMedia(MOBILE_QUERY);
  isMobile.value = mql.matches;
  hoverMql = window.matchMedia(HOVER_QUERY);
  canHover.value = hoverMql.matches;
  // addEventListener is the modern path; older Safari needs addListener.
  if (mql.addEventListener) mql.addEventListener('change', onChange);
  else (mql as any).addListener(onChange);
  if (hoverMql.addEventListener) hoverMql.addEventListener('change', onHoverChange);
  else (hoverMql as any).addListener(onHoverChange);
}

function onChange(e: MediaQueryListEvent): void {
  isMobile.value = e.matches;
}

function onHoverChange(e: MediaQueryListEvent): void {
  canHover.value = e.matches;
}

export function useViewport(): ViewportState {
  ensureInit();
  return { isMobile, canHover };
}
