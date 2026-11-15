<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The message layout, picked by looking at it: one card per look this screen
  can draw (lib/layoutChoice.ts), each a few lines of chat laid out that way in
  the live theme, nick colours and avatar set. Three on a desktop (Traditional,
  Modern, Modern with avatars), the two modern ones on a phone.

  Controlled: the parent holds the choice and decides what picking writes. The
  Appearance pane writes on every pick; the first run writes on Continue.

  The cards are drawn here rather than by MessageList: a sample needs none of
  its machinery (history, scroll, menus), only its shapes, and a preview that
  pulled in the list would preview the user's current layout three times.
-->

<template>
  <div class="layout-picker" role="radiogroup" aria-label="Message layout">
    <button
      v-for="choice in choices"
      :key="choice"
      type="button"
      role="radio"
      class="look"
      :class="{ on: choice === modelValue }"
      :aria-checked="choice === modelValue"
      :disabled="disabled"
      @click="emit('update:modelValue', choice)"
    >
      <span class="sample" :class="choice" aria-hidden="true">
        <template v-if="choice === 'traditional'">
          <span v-for="(row, i) in ROWS" :key="i" class="row">
            <span class="time">{{ row.time }}</span>
            <span class="nick" :style="{ color: nicks.color(row.nick) ?? undefined }">{{
              row.nick
            }}</span>
            <span class="text">{{ row.text }}</span>
          </span>
        </template>
        <template v-else>
          <span v-for="(run, i) in RUNS" :key="i" class="run">
            <NickAvatar v-if="choice === 'modern-avatars'" class="tile" :nick="run.nick" plain />
            <span class="lines">
              <span class="head">
                <span class="nick" :style="{ color: nicks.color(run.nick) ?? undefined }">{{
                  run.nick
                }}</span>
                <span class="time">{{ run.time }}</span>
              </span>
              <span v-for="(text, j) in run.texts" :key="j" class="text">{{ text }}</span>
            </span>
          </span>
        </template>
      </span>
      <span class="name">{{ labelFor(choice) }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import NickAvatar from './NickAvatar.vue';
import { useNickColors } from '../composables/useNickColors.js';
import { useViewport } from '../composables/useViewport.js';
import { LAYOUT_CHOICE_LABELS, layoutChoices, type LayoutChoice } from '../lib/layoutChoice.js';

defineProps<{
  modelValue: LayoutChoice;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [choice: LayoutChoice] }>();

const nicks = useNickColors();
const { isMobile } = useViewport();
const choices = computed(() => layoutChoices(isMobile.value));

// On a phone both looks are modern, so the cards say what differs.
function labelFor(choice: LayoutChoice): string {
  if (!isMobile.value) return LAYOUT_CHOICE_LABELS[choice];
  return choice === 'modern-avatars' ? 'With avatars' : 'Without avatars';
}

// The same short exchange in each card: two authors, one of them twice in a
// row, which is where the layouts differ most. Short enough that three cards
// fit side by side in a settings pane.
const RUNS = [
  { nick: 'ann', time: '12:01', texts: ['hi all', 'fixed'] },
  { nick: 'bob', time: '12:02', texts: ['nice!'] },
];
const ROWS = RUNS.flatMap((run) =>
  run.texts.map((text) => ({ nick: run.nick, time: run.time, text })),
);
</script>

<style scoped>
.layout-picker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
}
.look {
  flex: 1 1 16ch;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--fg-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.look:hover:not(:disabled) {
  border-color: var(--fg-muted);
}
.look.on {
  border-color: var(--accent);
  color: var(--accent);
}
.look:disabled {
  cursor: default;
}
.name {
  text-align: center;
}
.look.on .name {
  font-weight: 600;
}

/* The sample: chat, not chrome, so it takes the chat's foreground and never
   the card's muted or accent text. A fixed height keeps the three cards level
   whichever look has more lines.

   ⚠ Each look below restates MessageList's own rules for it (the paddings,
   the separator, the indent, the gutter), in the same tokens, so a card reads
   as the list will. A change to how a layout is drawn there belongs here too. */
.sample {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 9.5em;
  overflow: hidden;
  color: var(--fg);
  white-space: nowrap;
  pointer-events: none;
}
.sample .time {
  color: var(--fg-muted);
}
.sample .text {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Traditional: time | nick | text. The gaps are each cell's padding, with a
   separator down the text column's left edge, continuous from row to row. */
.sample.traditional {
  display: grid;
  grid-template-columns: max-content max-content minmax(0, 1fr);
  align-content: center;
  column-gap: 0;
  line-height: 1.55;
}
.sample.traditional .row {
  display: contents;
}
.sample.traditional .time {
  padding-right: 1ch;
}
.sample.traditional .nick {
  justify-self: end;
  padding-right: 1ch;
}
.sample.traditional .text {
  position: relative;
  padding-left: 1ch;
}
.sample.traditional .text::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 1px;
  background: var(--border);
}

/* Modern: a head line (nick, then time) over the text, at the density the
   user set (#1186): the line height, the gap before each run, and the text's
   indent under the nick. No separator. */
.sample.modern,
.sample.modern-avatars {
  line-height: var(--compact-line-height);
}
.sample .run {
  position: relative;
  min-width: 0;
}
.sample .run + .run {
  margin-top: var(--compact-group-gap);
}
.sample .lines {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.sample .head {
  display: flex;
  align-items: baseline;
  gap: 0.75ch;
}
.sample.modern .text {
  padding-left: var(--compact-indent);
}

/* With avatars: a gutter holding the tile on a run's first row, a hairline
   down its right edge through the gaps between runs, and the text flush
   beside it. The gutter is the indent, and weight tells the nick from the
   text. */
.sample.modern-avatars {
  --avatar-size: min(2.7em, 2lh);
  --avatar-gutter: calc(var(--avatar-size) + var(--space-4));
}
.sample.modern-avatars::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: round(var(--avatar-gutter), 1px);
  width: 1px;
  background: var(--border);
}
.sample.modern-avatars .run {
  padding-left: calc(var(--avatar-gutter) + var(--space-5));
}
.sample.modern-avatars .tile {
  position: absolute;
  left: 0;
  top: calc((2lh - var(--avatar-size)) / 2);
}
.sample.modern-avatars .nick {
  font-weight: 600;
}
@media (max-width: 768px) {
  .sample.modern-avatars {
    --avatar-size: min(2.25em, 2lh);
  }
}
</style>
