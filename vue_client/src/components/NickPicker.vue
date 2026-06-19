<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  `@`-mention completion menu. Thin wrapper over VerticalPopover (issue #212):
  it owns only the nick candidate list + row look; the shared popover owns
  positioning, dismissal, the iOS focus contract, and keyboard nav. `:ignore`
  is the anchor so a tap on the input bar (where the user is typing) keeps the
  menu open. `reverse` puts the best match at the bottom, nearest the input.
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
      <span class="nick" :style="row.color ? { color: row.color } : null">{{ row.nick }}</span>
      <span v-if="row.recent" class="badge">recent</span>
    </template>
  </VerticalPopover>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { buildNickCandidates } from '../utils/nickCompletion.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useNickColors } from '../composables/useNickColors.js';
import VerticalPopover from './VerticalPopover.vue';
import type { PopoverNav } from './popoverNav.js';
import type { Buffer } from '../stores/buffers.js';

interface NickRow {
  nick: string;
  lc: string;
  recent: boolean;
  color: string | null;
}

const props = withDefaults(
  defineProps<{
    open?: boolean;
    query?: string;
    buffer?: Buffer | null;
    selfNick?: string;
    anchor?: HTMLElement | null;
  }>(),
  {
    open: false,
    query: '',
    buffer: null,
    selfNick: '',
    anchor: null,
  },
);

const emit = defineEmits<{
  select: [nick: string];
  close: [];
}>();

const ignores = useIgnoresStore();
const nickColors = useNickColors();

const rows = computed<NickRow[]>(() => {
  // Bail before touching buffer/query/ignores while closed: a computed only
  // tracks the deps it reads, so this early return keeps the candidate list
  // from rebuilding (and re-coloring every nick) on each speakers/members
  // update behind a closed picker. The popover hides when closed anyway, so
  // returning [] here is behavior-neutral.
  if (!props.open) return [];
  const networkId = props.buffer?.networkId;
  const isIgnored = networkId
    ? (nick: string, userhost: string | null) => ignores.isIgnored(networkId, nick, userhost ?? '')
    : null;
  return buildNickCandidates(props.buffer, props.selfNick, props.query, isIgnored)
    .slice(0, 50)
    .map((c) => ({
      nick: c.nick,
      lc: c.nick.toLowerCase(),
      recent: c.recent,
      color: nickColors.color(c.nick),
    }));
});

function rowKey(row: NickRow): string {
  return row.lc;
}
function onSelect(row: NickRow): void {
  emit('select', row.nick);
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
.nick {
  font-weight: 500;
}
.badge {
  color: var(--fg-muted);
  font-style: italic;
}
</style>
