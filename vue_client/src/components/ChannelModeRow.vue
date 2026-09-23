<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  One mode in the channel modal's Settings tab (#727): a checkbox with the
  mode's name, a value field for a param mode (the key masked, with a reveal),
  and the letter as a quiet tag on the right. State lives in ChannelModal; this
  only draws it and reports edits.
-->

<template>
  <label class="toggle">
    <input
      type="checkbox"
      :checked="state.on"
      :disabled="disabled"
      @change="$emit('toggle', ($event.target as HTMLInputElement).checked)"
    />
    <span class="name">{{ row.name ?? `+${row.letter}` }}</span>
  </label>
  <template v-if="row.kind !== 'flag'">
    <input
      class="param"
      :type="row.kind === 'key' && !revealed ? 'password' : 'text'"
      :value="state.value"
      :placeholder="row.kind === 'key' && state.on ? 'Key is set' : ''"
      :disabled="disabled || !state.on"
      :aria-label="`+${row.letter} value`"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      @input="$emit('value', ($event.target as HTMLInputElement).value)"
      @keydown.enter="blockImeEnter"
    />
    <!-- Every value row keeps this slot, so the fields line up in one column. -->
    <span class="reveal-slot">
      <button
        v-if="row.kind === 'key' && canReveal"
        type="button"
        class="link"
        :title="revealed ? 'Hide key' : 'Show key'"
        :aria-label="revealed ? 'Hide key' : 'Show key'"
        @click="$emit('reveal')"
      >
        <i :class="revealed ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'"></i>
      </button>
    </span>
  </template>
  <span class="tag">{{ row.name ? `+${row.letter}` : '' }}</span>
</template>

<script setup lang="ts">
import { blockImeEnter } from '../composables/useImeSafeInput.js';
import type { DraftRow, ModeRow } from '../utils/channelModeForm.js';

withDefaults(
  defineProps<{
    row: ModeRow;
    state: DraftRow;
    disabled: boolean;
    revealed?: boolean;
    canReveal?: boolean;
  }>(),
  { revealed: false, canReveal: false },
);
defineEmits<{ toggle: [on: boolean]; value: [value: string]; reveal: [] }>();
</script>

<style scoped>
.toggle {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.toggle input {
  accent-color: var(--accent);
}
.param {
  width: 12em;
  max-width: 45%;
  background: var(--bg-soft);
}
.tag {
  color: var(--fg-muted);
  min-width: 2.5em;
  text-align: right;
}
/* A key or a limit is short; on a phone the name needs the room more. */
@media (max-width: 768px) {
  .param {
    width: 7em;
  }
}
.reveal-slot {
  width: 1.75em;
  display: flex;
  justify-content: center;
}
.link {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.link:hover {
  color: var(--accent);
}
</style>
