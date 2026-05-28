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
        tabindex="0"
        :class="{ active: slot === 'fg' }"
        :aria-pressed="slot === 'fg'"
        title="Pick the text colour"
        @mousedown.prevent
        @click="slot = 'fg'"
        @keydown.enter.prevent="slot = 'fg'"
        @keydown.space.prevent="slot = 'fg'"
      >
        <span class="chip" :style="chipStyle(staged.fg)"></span>
        fg
      </div>
      <div
        role="button"
        class="slot"
        tabindex="0"
        :class="{ active: slot === 'bg' }"
        :aria-pressed="slot === 'bg'"
        title="Pick the background colour"
        @mousedown.prevent
        @click="slot = 'bg'"
        @keydown.enter.prevent="slot = 'bg'"
        @keydown.space.prevent="slot = 'bg'"
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
        tabindex="0"
        :class="{ picked: staged[slot] === entry.code }"
        :style="{ backgroundColor: entry.color }"
        :title="`mIRC ${entry.code}`"
        :aria-label="`mIRC colour ${entry.code}`"
        @mousedown.prevent
        @click="pick(entry.code)"
        @keydown.enter.prevent="pick(entry.code)"
        @keydown.space.prevent="pick(entry.code)"
      ></div>
    </div>
    <div class="row">
      <div
        role="button"
        class="action apply"
        tabindex="0"
        :class="{ disabled: !hasPick }"
        :aria-disabled="!hasPick"
        title="Insert the picked colour"
        @mousedown.prevent
        @click="apply"
        @keydown.enter.prevent="apply"
        @keydown.space.prevent="apply"
      >
        apply
      </div>
      <div
        role="button"
        class="action"
        tabindex="0"
        title="Clear formatting (inserts reset)"
        @mousedown.prevent
        @click="emit('reset')"
        @keydown.enter.prevent="emit('reset')"
        @keydown.space.prevent="emit('reset')"
      >
        clear
      </div>
      <div
        role="button"
        class="action"
        tabindex="0"
        title="Close"
        @mousedown.prevent
        @click="emit('close')"
        @keydown.enter.prevent="emit('close')"
        @keydown.space.prevent="emit('close')"
      >
        close
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue';
import { mircColor } from '../utils/nickColor.js';
import { useMircPalette } from '../composables/useNickColors.js';

// 'fg' is the text colour slot, 'bg' the background colour slot.
type ColorTarget = 'fg' | 'bg';

// Swatches reflect the user-overridable mIRC palette so what they pick here
// matches what the renderer will draw. The wire format is still the standard
// mIRC code ("00".."15") — only the local preview colour changes.
const mircPalette = useMircPalette();
const swatches = computed(() =>
  Array.from({ length: 16 }, (_, i) => ({
    code: i.toString().padStart(2, '0'),
    // Any CSS colour value the user's palette resolves to — hex, rgb(),
    // var(--name), color-mix(...). Falls back to white only if the lookup
    // returns null, which shouldn't happen for indices 0-15.
    color: mircColor(i, mircPalette.value) ?? '#ffffff',
  })),
);

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
  if (!code) return {};
  const c = swatches.value.find((p) => p.code === code)?.color;
  return c ? { backgroundColor: c } : {};
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
/* Anchored to StatusBar's bottom-right, so the picker pops up out of the
   bar toward the message list (extending upward, since the bar's content
   area is short). The 6px bottom offset gives a small gap between the
   picker and the composer underneath. */
.mirc-picker {
  position: absolute;
  right: 12px;
  bottom: 6px;
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
.swatch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
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
.slot:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
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
.action:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}
.action.apply {
  color: var(--accent);
}
.action.apply.disabled {
  color: var(--fg-muted);
  cursor: default;
}
</style>
