// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { computed, type ComputedRef } from 'vue';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { unreadLabel } from '../utils/unreadLabel.js';

export interface HighlightChip {
  count: ComputedRef<number>;
  label: ComputedRef<string>;
  show: ComputedRef<boolean>;
}

// The highlight-count chip for the controls that reveal a hidden buffer list:
// the desktop rail's expand button and the mobile buffer screen's back button
// (#636). Both hosts exist ONLY while the list is hidden, so the chip stands in
// for the highlighted rows the collapse took off-screen rather than adding a
// new app-wide indicator — nothing to surface when the list is up.
//
// Highlights only, deliberately. The count is `totalHighlights` verbatim — the
// same getter behind the PWA app-icon badge (useAppBadge) — so the chip and the
// badge can never report different NUMBERS. It is NOT the per-row unread total
// that `full` mode draws on each row: a collapsed rail with unread-but-
// unhighlighted traffic shows no chip, which is correct precisely because it
// matches the app badge (also highlights-only). The active buffer always
// contributes 0 (the store forces it), so the number means "highlights waiting
// somewhere I can't see" without any subtraction.
//
// The one thing the chip does NOT share with the app badge is the `off` gate
// below: that's an in-app buffer-list display preference the OS badge has no
// business reading. So the value stays in lockstep with the badge; only
// visibility can differ, and only for that one setting.
export function useHighlightChip(): HighlightChip {
  const buffers = useBuffersStore();
  const settings = useSettingsStore();

  const count = computed(() => buffers.totalHighlights);
  // `off` means "row color/weight is the only cue" — a chip is exactly the
  // numeric cue that mode turns down, so it goes too. The other three modes all
  // show it: the chip is highlights-only, which makes `full`, `highlights` and
  // `badge` equivalent here (they differ only in how per-row counts are drawn).
  const show = computed(
    () => count.value > 0 && settings.effective('look.buffer_list.unread_display') !== 'off',
  );

  return { count, label: computed(() => unreadLabel(count.value)), show };
}
