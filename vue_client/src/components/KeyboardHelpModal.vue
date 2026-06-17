<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="keys" title="keyboard shortcuts" size="sm" @close="$emit('close')">
    <div class="body">
      <table class="list">
        <tbody>
          <tr v-for="row in shortcuts" :key="row.label">
            <td class="keys">
              <span v-for="(k, i) in row.keys" :key="i">
                <kbd>{{ k }}</kbd>
                <span v-if="i < row.keys.length - 1" class="plus">+</span>
              </span>
            </td>
            <td class="label">{{ row.label }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AppModal from './AppModal.vue';

defineEmits<{ close: [] }>();

interface ShortcutRow {
  keys: string[];
  label: string;
}

const isMac =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
const MOD = isMac ? '⌘' : 'Ctrl';
const ALT = isMac ? '⌥' : 'Alt';

const shortcuts = computed<ShortcutRow[]>(() => [
  { keys: [MOD, 'K'], label: 'Jump to channel (quick switcher)' },
  { keys: [ALT, '↑'], label: 'Previous channel' },
  { keys: [ALT, '↓'], label: 'Next channel' },
  { keys: [ALT, 'Shift', '↑'], label: 'Previous unread channel' },
  { keys: [ALT, 'Shift', '↓'], label: 'Next unread channel' },
  { keys: ['Shift', 'Esc'], label: 'Mark all channels read' },
  { keys: ['PgUp'], label: 'Scroll messages up one page' },
  { keys: ['PgDn'], label: 'Scroll messages down one page' },
  { keys: ['Tab'], label: 'Autocomplete nicks and channels' },
  { keys: ['↑', '↓'], label: 'Browse input history' },
  { keys: [MOD, 'B'], label: 'Bold (wraps selection with mIRC code)' },
  { keys: [MOD, 'I'], label: 'Italic (wraps selection with mIRC code)' },
  { keys: [MOD, 'U'], label: 'Underline (wraps selection with mIRC code)' },
  { keys: ['||text||'], label: 'Spoiler — hidden until clicked' },
  { keys: [MOD, '/'], label: 'Show this help panel' },
]);
</script>

<style scoped>
.body {
  /* Break out of card padding so the scrollbar sits against the card
     border; padding keeps row content visually aligned with the rest. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.list {
  width: 100%;
  border-collapse: collapse;
}
.list td {
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.list tr:last-child td {
  border-bottom: none;
}
.keys {
  white-space: nowrap;
  width: 1%;
  padding-right: var(--space-7);
}
kbd {
  font: inherit;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  padding: 1px var(--space-3);
  margin: 0 1px;
  color: var(--fg-muted);
}
.plus {
  color: var(--fg-muted);
  margin: 0 var(--space-1);
}
.label {
  color: var(--fg);
}
</style>
