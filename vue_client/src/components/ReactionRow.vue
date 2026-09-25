<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A line's reactions as one muted line of text under it, in the same register
  as the -->/<-- event lines: ↳ 👍 alice, carol · 🎉 dave · 👀 5 Names, nick-coloured (ours in the
self colour), because on IRC who reacted is the point; past NAME_LIMIT a group collapses to its
count and the names move to the tooltip (and to the picker, via the line's React action). Clicking a
reaction adds ours or takes it back. Renders nothing when no reactions stand on the line, so an
ordinary line keeps its height. -->

<template>
  <div v-if="groups.length" class="reaction-line">
    <span class="lead" aria-hidden="true">↳</span>
    <span
      v-for="g in groups"
      :key="g.value"
      class="group"
      :title="`${g.nicks.join(', ')} reacted ${g.value}`"
    >
      <button
        type="button"
        class="value"
        :class="{ mine: g.mine }"
        :disabled="!canReact"
        :aria-pressed="g.mine"
        :aria-label="`${g.value} — ${g.nicks.join(', ')}`"
        @click.stop="onValueClick(g.value)"
        @contextmenu.stop
        v-text="g.value"
      ></button>
      <span
        v-if="g.reactors.length > NAME_LIMIT"
        class="count"
        :style="g.mine ? selfStyle : null"
        v-text="g.reactors.length"
      ></span>
      <span v-else class="names">
        <span
          v-for="r in g.reactors"
          :key="r.nick"
          class="nick"
          :style="nickStyle(r)"
          v-text="r.nick"
        ></span>
      </span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import type { CSSProperties } from 'vue';
import { useReactionsStore } from '../stores/reactions.js';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNickColors } from '../composables/useNickColors.js';
import type { MessageReaction } from '../../../shared/reactions.js';

// Past this many people a group shows its count instead of their names.
const NAME_LIMIT = 3;

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
const settings = useSettingsStore();
const nicks = useNickColors();

const groups = computed(() => reactions.groupsFor(props.message.id));
const canReact = computed(() => {
  const state = networks.states[props.message.networkId];
  return state?.state === 'connected' && !!state.canReact;
});

const selfStyle = computed((): CSSProperties | null => {
  const c = settings.effective('look.nick.self_color') as string | undefined;
  return c ? { color: c } : null;
});

function nickStyle(r: MessageReaction): CSSProperties | null {
  if (r.self) return selfStyle.value;
  const c = nicks.color(r.nick);
  return c ? { color: c } : null;
}

// A reaction landing live can add the line, or wrap it onto another — the row
// grows under a reader following the live tail. Same contract as MessageBody's
// `measured`: say so once the DOM has it, and the list re-pins. Only on change;
// a row that arrives with its reactions is measured with them.
watch(
  () => groups.value.map((g) => `${g.value}:${g.nicks.join(',')}`).join('|'),
  async () => {
    await nextTick();
    emit('measured');
  },
);

function onValueClick(value: string) {
  if (!canReact.value || props.message.id == null) return;
  reactions.toggle(props.message.id, value);
}
</script>

<style scoped>
/* Separators are CSS, not text nodes, so no formatter reflow can add or drop
   a space between the pieces. */
.reaction-line {
  color: var(--fg-muted);
  white-space: normal;
}
.lead {
  margin-right: 0.5ch;
}
.group {
  white-space: nowrap;
}
.group + .group::before {
  content: '·';
  margin: 0 1ch;
}
.value {
  background: none;
  border: none;
  padding: 0;
  margin-right: 0.5ch;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.value:disabled {
  cursor: default;
}
.value:hover:not(:disabled) {
  text-decoration: underline;
}
/* Ours: a text reaction ("lol") reads in the accent; an emoji is its own
   colour, so the underline is what marks it. */
.value.mine {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-color: var(--accent);
  text-underline-offset: 0.2em;
}
.nick + .nick::before {
  content: ', ';
  color: var(--fg-muted);
}
</style>
