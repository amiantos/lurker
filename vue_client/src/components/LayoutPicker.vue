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
      :class="[choice, { on: choice === modelValue }]"
      :aria-checked="choice === modelValue"
      :disabled="disabled"
      @click="emit('update:modelValue', choice)"
    >
      <span class="sample" :class="choice" aria-hidden="true">
        <template v-if="choice === 'traditional'">
          <span v-for="(row, i) in ROWS" :key="i" class="row">
            <span class="time">{{ time(row.at, 'look.buffer.time_format') }}</span>
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
                <span class="time">{{ time(run.at, 'look.buffer.time_format_modern') }}</span>
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
import { useSettingsStore } from '../stores/settings.js';
import { formatTimestamp } from '../utils/timestamp.js';
import { useViewport } from '../composables/useViewport.js';
import { LAYOUT_CHOICE_LABELS, layoutChoices, type LayoutChoice } from '../lib/layoutChoice.js';

defineProps<{
  modelValue: LayoutChoice;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [choice: LayoutChoice] }>();

const nicks = useNickColors();
const settings = useSettingsStore();
const { isMobile } = useViewport();
const choices = computed(() => layoutChoices(isMobile.value));

// On a phone both looks are modern, so the cards say what differs.
function labelFor(choice: LayoutChoice): string {
  if (!isMobile.value) return LAYOUT_CHOICE_LABELS[choice];
  return choice === 'modern-avatars' ? 'With avatars' : 'Without avatars';
}

// The same exchange in each card: two authors, one of them twice in a row,
// which is where the layouts differ most. Lines long enough to read as chat,
// short enough to fit a modern card beside its avatar gutter. Local times, so
// the cards read 12:01 wherever the reader is.
const RUNS = [
  {
    nick: 'ann',
    at: new Date(2026, 0, 1, 12, 1, 7),
    texts: ['anyone seen the build?', 'never mind, fixed it'],
  },
  { nick: 'bob', at: new Date(2026, 0, 1, 12, 2, 43), texts: ['nice, ship it tonight'] },
];
// A line later in a run was sent a little after the one before: the grid
// hides a time that repeats the row above's (look.message.collapse_timestamps,
// on by default), and two rows stamped alike would show a time the list would not.
//
// The grid spends one row on a line where a modern run spends a head and a
// line, so the same exchange is over in three rows. It carries on for two
// more, enough to show the columns holding from row to row.
const GRID_RUNS = [
  ...RUNS,
  { nick: 'ann', at: new Date(2026, 0, 1, 12, 3, 18), texts: ['tagging it now'] },
  { nick: 'bob', at: new Date(2026, 0, 1, 12, 4, 2), texts: ['thanks!'] },
];
const ROWS = GRID_RUNS.flatMap((run) =>
  run.texts.map((text, i) => ({
    nick: run.nick,
    at: new Date(run.at.getTime() + i * 24_000),
    text,
  })),
);

// Each layout's own timestamp setting, as MessageList reads them: the grid's
// (to the second out of the box) and the modern head's (to the minute). An
// empty format hides the time, here as there.
function time(at: Date, key: string): string {
  return formatTimestamp(at.toISOString(), String(settings.effective(key) ?? ''));
}
</script>

<style scoped>
/* Two columns: the two modern cards side by side, and Traditional across
   both. The grid is the wide layout (a time to the second, the nick column's
   16ch floor, then the text on one line), so half a row cannot show it as it
   is. A width too narrow for two modern cards, a phone's, stacks them. */
.layout-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(25ch, 100%), 1fr));
  gap: var(--space-6);
}
.look.traditional {
  grid-column: 1 / -1;
}
.look {
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
   the card's muted or accent text. A fixed height keeps the two modern cards
   level; the grid, on a row of its own, is as tall as its lines.

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

/* Traditional: time | nick | text. The nick column keeps the list's 16ch
   floor, nicks set against its right edge. The gaps are each cell's padding,
   with a separator down the text column's left edge, continuous from row to
   row. */
.sample.traditional {
  display: grid;
  min-height: 0;
  grid-template-columns: max-content minmax(16ch, max-content) minmax(0, 1fr);
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
  line-height: var(--modern-line-height);
}
.sample .run {
  position: relative;
  min-width: 0;
}
.sample .run + .run {
  margin-top: var(--modern-group-gap);
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
  padding-left: var(--modern-indent);
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
