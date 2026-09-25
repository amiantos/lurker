<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A line's reactions as a row of chips under its text, one per value with its
  count. Square and borderless on the soft background; ours tinted in the
  accent. Clicking or tapping a chip adds our reaction or takes it back;
  hovering names who reacted. The trailing
  add chip (always shown while there are reactions, as Slack does) opens the
  picker, which is also where a touch screen sees who gave what.
  Renders nothing when no reactions stand on the line, so an ordinary line
  keeps its height.
-->

<template>
  <div v-if="groups.length" class="reaction-row">
    <button
      v-for="g in groups"
      :key="g.value"
      type="button"
      class="chip"
      :class="{ mine: g.mine }"
      :disabled="!canReact"
      :title="`${g.nicks.join(', ')} reacted ${g.value}`"
      :aria-label="`${g.value}, ${g.nicks.length} (${g.nicks.join(', ')})`"
      :aria-pressed="g.mine"
      @click.stop="onChipClick(g.value)"
      @contextmenu.stop
    >
      <span class="value">{{ g.value }}</span
      ><span class="count">{{ g.nicks.length }}</span>
    </button>
    <button
      type="button"
      class="chip add"
      title="React / see who reacted"
      aria-label="React / see who reacted"
      @click.stop="reactions.openPicker(message)"
    >
      <i class="fa-solid fa-heart-circle-plus" aria-hidden="true"></i>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import { useReactionsStore } from '../stores/reactions.js';
import { useNetworksStore } from '../stores/networks.js';

const props = defineProps<{
  message: {
    id?: number | null;
    networkId: number;
    nick?: string;
    text?: string;
  };
}>();

const emit = defineEmits<{ measured: [] }>();

const reactions = useReactionsStore();
const networks = useNetworksStore();

const groups = computed(() => reactions.groupsFor(props.message.id));

// A reaction landing live can add the row, or wrap it onto another line — the
// line grows under a reader following the live tail. Same contract as
// MessageBody's `measured`: say so once the DOM has it, and the list re-pins.
// Only on change; a line that arrives with its reactions is measured with them.
watch(
  () => groups.value.map((g) => `${g.value}:${g.nicks.length}`).join('|'),
  async () => {
    await nextTick();
    emit('measured');
  },
);
const canReact = computed(() => {
  const state = networks.states[props.message.networkId];
  return state?.state === 'connected' && !!state.canReact;
});

function onChipClick(value: string) {
  if (!canReact.value || props.message.id == null) return;
  reactions.toggle(props.message.id, value);
}
</script>

<style scoped>
.reaction-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
  white-space: normal;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--bg-soft);
  border: none;
  border-radius: 0;
  color: var(--fg-muted);
  font: inherit;
  /* Real vertical padding rather than a tall line box: an emoji's glyph sits
     low in the line, so with none its bottom met the chip's edge while its
     top floated. */
  line-height: 1.2;
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
}
.chip:hover:not(:disabled) {
  background: color-mix(in srgb, var(--fg) 8%, var(--bg-soft));
  color: var(--fg);
}
/* Offline, the reactions still read normally — just not clickable. (The
   global button:disabled would fade them to half opacity.) */
.chip:disabled {
  opacity: 1;
  color: var(--fg-muted);
  cursor: default;
}
/* Ours: an accent tint and accent text. */
.chip.mine {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
}
.chip.mine:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 25%, transparent);
}
</style>
