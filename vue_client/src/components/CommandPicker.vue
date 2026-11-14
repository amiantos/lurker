<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Slash-command completion menu (#533): commands while the verb is typed, then
  whatever the command's grammar says the argument under the caret takes — a
  subcommand, an option, a setting key, a theme. Thin wrapper over
  VerticalPopover, like NickPicker and ChannelPicker: it owns only how a row
  looks. The rows themselves come from lib/commands/completion.ts, computed by
  MessageInput, which also needs them to decide what Enter means.

  Nick and channel arguments don't come here; they open the nick and channel
  pickers, which already know how to list those.
-->

<template>
  <VerticalPopover
    ref="popover"
    :open="open"
    :rows="rows"
    :anchor="anchor"
    :ignore="[anchor]"
    reverse
    :row-key="rowKey"
    @select="onSelect"
    @close="emit('close')"
  >
    <template #row="{ row }">
      <span class="value">{{ row.label ?? row.value }}</span>
      <span v-if="row.detail" class="detail">{{ row.detail }}</span>
    </template>
  </VerticalPopover>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import VerticalPopover from './VerticalPopover.vue';
import type { PopoverNav } from './popoverNav.js';
import type { Candidate } from '../lib/commands/completion.js';

withDefaults(
  defineProps<{
    open?: boolean;
    rows?: readonly Candidate[];
    anchor?: HTMLElement | null;
  }>(),
  {
    open: false,
    rows: () => [],
    anchor: null,
  },
);

const emit = defineEmits<{
  select: [row: Candidate];
  close: [];
}>();

function rowKey(row: Candidate): string {
  return `${row.kind}:${row.value}`;
}
function onSelect(row: Candidate): void {
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
.value {
  font-weight: 500;
  white-space: nowrap;
}
/* The summary gives way first: the usage is what you came to read. */
.detail {
  color: var(--fg-muted);
  margin-left: var(--space-6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
</style>
