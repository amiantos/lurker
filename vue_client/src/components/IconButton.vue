<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Compact icon-only action button (edit / remove / …) shared by the settings
  panes' row lists. Icon-only buttons need an accessible name, so `label` drives
  both the tooltip and aria-label; the glyph itself is aria-hidden. @click falls
  through to the underlying <button>.
-->
<template>
  <button
    type="button"
    class="icon-btn"
    :class="{ danger }"
    :disabled="disabled"
    :title="label"
    :aria-label="label"
  >
    <component :is="icon" />
  </button>
</template>

<script setup lang="ts">
import type { LucideIcon } from '@lucide/vue';

defineProps<{
  /** Lucide icon component, e.g. PenIcon. */
  icon: LucideIcon;
  /** Accessible name (tooltip + aria-label), e.g. 'edit'. */
  label: string;
  /** Render in the destructive color. */
  danger?: boolean;
  disabled?: boolean;
}>();
</script>

<style scoped>
/* An outlined square like every other button, sized to stand in a .btn-bar
   beside text buttons: the glyph is shorter than a text line, so the height is
   stated. */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-height: calc(1lh + 2 * var(--space-2) + 2px);
  background: none;
  border: 1px solid var(--border);
  color: var(--accent);
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
  font: inherit;
}
.icon-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--fg);
}
.icon-btn.danger {
  color: var(--bad);
}
.icon-btn.danger:hover:not(:disabled) {
  border-color: var(--bad);
  color: var(--bad);
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
