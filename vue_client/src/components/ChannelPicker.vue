<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  `#`-channel completion menu. Thin wrapper over VerticalPopover (issue #212):
  it owns only the channel candidate list (joined channels, no /LIST directory —
  issue #154); the shared popover owns positioning, dismissal, the iOS focus
  contract, and keyboard nav. `:ignore` is the anchor so a tap on the input bar
  keeps the menu open. `reverse` puts the best match at the bottom, nearest the
  input.
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
      <span class="channel">{{ row }}</span>
    </template>
  </VerticalPopover>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useBuffersStore } from '../stores/buffers.js';
import { buildChannelCandidates } from '../utils/channelCompletion.js';
import VerticalPopover from './VerticalPopover.vue';
import type { PopoverNav } from './popoverNav.js';

const props = withDefaults(
  defineProps<{
    open?: boolean;
    // The raw `#`-prefixed token under the cursor; the leading '#' stays in
    // both the match filter and the inserted result.
    query?: string;
    networkId?: number | null;
    // The composer's current buffer target, so the channel you're in is
    // offered first (matches the Tab-completion order in MessageInput).
    activeTarget?: string | null;
    anchor?: HTMLElement | null;
  }>(),
  {
    open: false,
    query: '',
    networkId: null,
    activeTarget: null,
    anchor: null,
  },
);

const emit = defineEmits<{
  select: [channel: string];
  close: [];
}>();

const buffers = useBuffersStore();

const rows = computed<string[]>(() => {
  // Bail before touching the buffers store while closed so the candidate list
  // doesn't rebuild on every buffer mutation behind a closed picker. The
  // popover hides when closed anyway, so returning [] here is behavior-neutral.
  if (!props.open || props.networkId == null) return [];
  return buildChannelCandidates(
    buffers.forNetwork(props.networkId),
    props.query,
    props.activeTarget,
  ).slice(0, 50);
});

function rowKey(row: string): string {
  return row;
}
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
.channel {
  font-weight: 500;
}
</style>
