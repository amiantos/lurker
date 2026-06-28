<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Desktop `:shortcode:` emoji completion menu (issue #348) — the vertical
  counterpart to the mobile suggestion strip, giving `:` the same panel UX as
  `@` (NickPicker) and `#` (ChannelPicker). Thin wrapper over VerticalPopover:
  it owns only the candidate list + row look; the shared popover owns
  positioning, dismissal, the iOS focus contract, and keyboard nav.

  Opens once a 2+ character `:shortcode` query is typed (issue #402) and
  filters as the user types — a lone `:` or a one-char emoticon like `:D`
  never pops it. `reverse` puts the best match at the bottom, nearest the
  input, matching the other pickers.
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
      <span class="emoji-line">
        <span class="emoji-glyph">{{ row.emoji }}</span>
        <span class="emoji-name">:{{ row.name }}:</span>
      </span>
    </template>
  </VerticalPopover>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { searchEmojiSync } from '../utils/emojiShortcodes.js';
import { emojiFn } from '../composables/useEmoji.js';
import VerticalPopover from './VerticalPopover.vue';
import type { PopoverNav } from './popoverNav.js';
import type { EmojiMatch } from '../utils/emojiData.js';

const props = withDefaults(
  defineProps<{
    open?: boolean;
    // The shortcode body under the caret (no colons); 2+ chars (issue #402).
    query?: string;
    anchor?: HTMLElement | null;
  }>(),
  {
    open: false,
    query: '',
    anchor: null,
  },
);

const emit = defineEmits<{
  select: [item: EmojiMatch];
  close: [];
}>();

const rows = computed<EmojiMatch[]>(() => {
  // emojiFn() reads the reactive emoji-ready signal (and is null until the
  // lazily-loaded table lands), so rows recompute once it's available. The
  // table is preloaded at app start, so it's normally ready by the first `:`.
  if (!props.open || !emojiFn()) return [];
  return searchEmojiSync(props.query.trim(), 30);
});

function rowKey(row: EmojiMatch): string {
  return row.name;
}
function onSelect(row: EmojiMatch): void {
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
/* Group the glyph + shortcode on the left. VerticalPopover's .row uses
   justify-content: space-between (for NickPicker's right-aligned badge); a
   single wrapper child keeps the pair left-aligned without restyling .row. */
.emoji-line {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  min-width: 0;
}
.emoji-glyph {
  flex: none;
}
.emoji-name {
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
