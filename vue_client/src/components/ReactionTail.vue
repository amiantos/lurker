<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A line's reactions, trailing its text in the same dim register as the
  timestamp: `· 👍2 lol`. No pills and no row of its own. A short line has room
  to spare at its end, so most reactions cost no height at all. The whole tail
  wraps as one unit when the last line is full.

  With a mouse, clicking a reaction adds yours or takes it back, and hovering
  names who reacted. On a touch screen there's no hover to name anyone, so a
  tap opens the picker, which lists who gave what. `limit` caps how many
  distinct reactions show before a `+N` (compact/mobile, where the line is
  narrow); `+N` opens the picker too.
-->

<template>
  <span v-if="groups.length" class="reaction-tail">
    <span class="sep" aria-hidden="true">·</span>
    <button
      v-for="g in shown"
      :key="g.value"
      type="button"
      class="reaction"
      :class="{ mine: g.mine }"
      :title="`${g.nicks.join(', ')} reacted ${g.value}`"
      :aria-label="`${g.value}, ${g.nicks.length} (${g.nicks.join(', ')})`"
      @click.stop="onGroupClick(g.value)"
      @contextmenu.stop
    >
      {{ g.value }}<span v-if="g.nicks.length > 1" class="count">{{ g.nicks.length }}</span>
    </button>
    <button
      v-if="hidden > 0"
      type="button"
      class="reaction more"
      :title="`${hidden} more`"
      @click.stop="reactions.openPicker(message)"
    >
      +{{ hidden }}
    </button>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useReactionsStore } from '../stores/reactions.js';
import { useNetworksStore } from '../stores/networks.js';
import { useViewport } from '../composables/useViewport.js';

const props = withDefaults(
  defineProps<{
    message: {
      id?: number | null;
      networkId: number;
      nick?: string;
      text?: string;
    };
    limit?: number | null;
  }>(),
  { limit: null },
);

const reactions = useReactionsStore();
const networks = useNetworksStore();
const { canHover } = useViewport();

const groups = computed(() => reactions.groupsFor(props.message.id));
const shown = computed(() =>
  props.limit != null ? groups.value.slice(0, props.limit) : groups.value,
);
const hidden = computed(() => groups.value.length - shown.value.length);

function onGroupClick(value: string) {
  if (!canHover.value) {
    reactions.openPicker(props.message);
    return;
  }
  const state = networks.states[props.message.networkId];
  if (state?.state !== 'connected' || !state.canReact || props.message.id == null) return;
  reactions.toggle(props.message.id, value);
}
</script>

<style scoped>
.reaction-tail {
  display: inline-block;
  white-space: nowrap;
  margin-left: 1ch;
  color: var(--fg-muted);
}
.sep {
  margin-right: 0.5ch;
}
.reaction {
  background: none;
  border: none;
  padding: 0;
  margin-right: 0.75ch;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.reaction:last-child {
  margin-right: 0;
}
.reaction:hover .count,
.reaction.more:hover {
  color: var(--fg);
}
.reaction.mine .count,
.reaction.mine {
  color: var(--accent);
}
.count {
  margin-left: 0.2ch;
}
</style>
