<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Previous-input recall menu — opened by tapping the `>` prompt (see
  MessageInput), it lists the buffer's recent submitted lines so mobile users,
  who have no arrow keys, can still reach their input history (issue #204).
  Picking a row replaces the composer outright, exactly like an Up-arrow
  recall — editable, not sent.

  Thin wrapper over VerticalPopover (issue #212): it owns only the entry list +
  row look; the shared popover owns positioning, dismissal, the iOS focus
  contract, and keyboard nav (the `>` toggle and Up/Down still recall inline
  when the menu is closed; once it's open, Up/Down move the selection). `:ignore`
  is the toggle button — its own click handler owns open/close, so a tap there
  must not also dismiss. Entries arrive oldest-first, so the newest (likeliest
  recall) renders at the bottom, nearest the input — no `reverse`.
-->

<template>
  <VerticalPopover
    ref="popover"
    :open="open"
    :rows="rows"
    :anchor="anchor"
    :ignore="[toggleEl]"
    @select="onSelect"
    @close="emit('close')"
  >
    <template #row="{ row }">
      <span class="entry" :title="row">{{ row }}</span>
    </template>
  </VerticalPopover>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import VerticalPopover from './VerticalPopover.vue';
import type { PopoverNav } from './popoverNav.js';

const props = withDefaults(
  defineProps<{
    open?: boolean;
    // Buffer history in chronological order (oldest first) — the same slice
    // Up-arrow walks. Rendered as-is so the newest line sits at the bottom,
    // nearest the input bar and matching the first Up-arrow recall.
    entries?: readonly string[];
    // The input form, used to position the panel above the bar.
    anchor?: HTMLElement | null;
    // The `>` toggle button. Taps on it must not dismiss the panel (its own
    // click handler owns open/close) — everything else outside the panel does.
    toggleEl?: HTMLElement | null;
  }>(),
  {
    open: false,
    entries: () => [],
    anchor: null,
    toggleEl: null,
  },
);

const emit = defineEmits<{
  select: [entry: string];
  close: [];
}>();

// Cap the list so a long-lived buffer doesn't render hundreds of rows. The
// newest entries are the likeliest recalls, so keep the tail (oldest first ->
// newest last) and let the panel scroll for the rest.
const rows = computed<readonly string[]>(() => (props.open ? props.entries.slice(-50) : []));

function onSelect(row: string): void {
  emit('select', row);
}

// Forward keyboard nav to the popover so MessageInput's textarea keydown
// handler can drive it (the textarea keeps focus while the menu is open).
const popover = ref<PopoverNav | null>(null);
defineExpose({
  moveActive: (delta: number) => popover.value?.moveActive(delta),
  confirmActive: () => popover.value?.confirmActive(),
  hasCandidates: () => popover.value?.hasCandidates() ?? false,
});
</script>

<style scoped>
/* Recalled lines can be long — keep each row to a single line, clipped with an
   ellipsis. The full text is in the row's title and lands in the composer on
   pick, so nothing is lost. */
.entry {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
