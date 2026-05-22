<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div v-if="open" class="mirc-picker" @pointerdown.stop @mousedown.prevent.stop>
    <!-- iOS keyboard preservation: same trick as NickSuggestionStrip — div
         role=button + @mousedown.prevent keeps focus on the textarea so the
         soft keyboard stays up while the user picks a colour. Action fires on
         `click` (end of touch), not pointerdown, so closing the popover
         mid-touch can't redirect the second event to whatever's underneath. -->
    <!-- The picker stages a foreground and a background and stays open while
         it does, so both can be set before "apply" inserts one combined
         \x03fg,bg code. Picking a swatch fills whichever slot is selected. -->
    <div class="row slots">
      <div
        role="button"
        class="slot"
        :class="{ active: slot === 'fg' }"
        :aria-pressed="slot === 'fg'"
        title="Pick the text colour"
        @mousedown.prevent
        @click="slot = 'fg'"
      >
        <span class="chip" :style="chipStyle(staged.fg)"></span>
        fg
      </div>
      <div
        role="button"
        class="slot"
        :class="{ active: slot === 'bg' }"
        :aria-pressed="slot === 'bg'"
        title="Pick the background colour"
        @mousedown.prevent
        @click="slot = 'bg'"
      >
        <span class="chip" :style="chipStyle(staged.bg)"></span>
        bg
      </div>
    </div>
    <div class="swatch-grid">
      <div
        v-for="entry in swatches"
        :key="entry.code"
        role="button"
        class="swatch"
        :class="{ picked: staged[slot] === entry.code }"
        :style="{ backgroundColor: entry.hex }"
        :title="`mIRC ${entry.code}`"
        @mousedown.prevent
        @click="pick(entry.code)"
      ></div>
    </div>
    <div class="row">
      <div
        role="button"
        class="action apply"
        :class="{ disabled: !hasPick }"
        :aria-disabled="!hasPick"
        title="Insert the picked colour"
        @mousedown.prevent
        @click="apply"
      >
        apply
      </div>
      <div
        role="button"
        class="action"
        title="Clear formatting (inserts reset)"
        @mousedown.prevent
        @click="emit('reset')"
      >
        clear
      </div>
      <div role="button" class="action" title="Close" @mousedown.prevent @click="emit('close')">
        close
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue';

// 'fg' is the text colour slot, 'bg' the background colour slot.
type ColorTarget = 'fg' | 'bg';

// The 16-color palette here mirrors MIRC_PALETTE in utils/nickColor.js — those
// are the only codes our renderer styles, so anything outside 0-15 wouldn't
// round-trip visibly anyway.
const PALETTE = [
  { code: '00', hex: '#ffffff' },
  { code: '01', hex: '#000000' },
  { code: '02', hex: '#00007f' },
  { code: '03', hex: '#009300' },
  { code: '04', hex: '#ff0000' },
  { code: '05', hex: '#7f0000' },
  { code: '06', hex: '#9c009c' },
  { code: '07', hex: '#fc7f00' },
  { code: '08', hex: '#ffff00' },
  { code: '09', hex: '#00fc00' },
  { code: '10', hex: '#009393' },
  { code: '11', hex: '#00ffff' },
  { code: '12', hex: '#0000fc' },
  { code: '13', hex: '#ff00ff' },
  { code: '14', hex: '#7f7f7f' },
  { code: '15', hex: '#d2d2d2' },
];

const props = withDefaults(
  defineProps<{
    open?: boolean;
  }>(),
  { open: false },
);

const emit = defineEmits<{
  // The staged foreground / background codes ("00".."15"), either of which
  // may be null when that slot was left untouched.
  apply: [fg: string | null, bg: string | null];
  reset: [];
  close: [];
}>();

const swatches = PALETTE;
const slot = ref<ColorTarget>('fg');
const staged = reactive<{ fg: string | null; bg: string | null }>({ fg: null, bg: null });
const hasPick = computed(() => !!staged.fg || !!staged.bg);

// A fresh open starts with nothing staged — last session's picks shouldn't
// silently ride along into the next message.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    staged.fg = null;
    staged.bg = null;
    slot.value = 'fg';
  },
);

// A filled chip when the slot holds a colour, a hollow one (border only) when
// it doesn't — so the slot buttons double as a preview of the staged colour.
function chipStyle(code: string | null): Record<string, string> {
  const hex = code ? PALETTE.find((p) => p.code === code)?.hex : undefined;
  return hex ? { backgroundColor: hex } : {};
}

function pick(code: string): void {
  staged[slot.value] = code;
  // After choosing a text colour, advance to the background slot so the
  // common "pick both" flow is just click-click-apply. A background pick
  // stays put — there's nowhere left to advance to.
  if (slot.value === 'fg') slot.value = 'bg';
}

function apply(): void {
  if (!hasPick.value) return;
  emit('apply', staged.fg, staged.bg);
}
</script>

<style scoped>
.mirc-picker {
  position: absolute;
  right: 12px;
  bottom: 100%;
  margin-bottom: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 6;
}
.swatch-grid {
  display: grid;
  grid-template-columns: repeat(8, 1.4em);
  grid-auto-rows: 1.4em;
  gap: 4px;
}
.swatch {
  border: 1px solid var(--border);
  cursor: pointer;
  touch-action: manipulation;
}
.swatch:hover {
  outline: 1px solid var(--accent);
}
.swatch.picked {
  outline: 2px solid var(--accent);
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.slots {
  gap: 4px;
}
.slot {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 1px 0;
  color: var(--fg-muted);
  border: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
}
.slot:hover {
  color: var(--accent);
}
.slot.active {
  color: var(--fg);
  border-color: var(--accent);
}
.chip {
  width: 0.9em;
  height: 0.9em;
  border: 1px solid var(--border);
  border-radius: 2px;
}
.action {
  color: var(--fg-muted);
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
}
.action:hover {
  color: var(--accent);
}
.action.apply {
  color: var(--accent);
}
.action.apply.disabled {
  color: var(--fg-muted);
  cursor: default;
}
</style>
