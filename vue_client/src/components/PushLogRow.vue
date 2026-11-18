<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  One line of the push log (#1272), as Settings → Notifications shows a member
  their own and Admin → Notifications shows everyone's. Three lines, stacked:
  when, what it was about, and what became of it. The date used to share a line
  with the rest in a column sized per row, so "1:12 PM" and "12:59 PM" started
  the text at different places all the way down the list.
-->

<template>
  <li class="push-row" :class="row.outcome">
    <span class="when" :title="row.at">{{ formatDateTime(row.at) }}</span>
    <MetaLine
      class="what"
      :parts="[who && { text: who, class: 'who' }, kindLabel(row.kind), subjectLabel(row)]"
    />
    <span class="how">{{ outcomeLabel(row) }}</span>
  </li>
</template>

<script setup lang="ts">
import MetaLine from './MetaLine.vue';
import { formatDateTime } from '../utils/timestamp.js';
import { kindLabel, outcomeLabel, subjectLabel, type PushLogRow } from '../utils/pushLog.js';

defineProps<{
  row: PushLogRow;
  /** Whose push it was, where the log covers more than one account. */
  who?: string;
}>();
</script>

<style scoped>
.push-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4) 0;
  border-top: 1px solid var(--border);
  list-style: none;
}
.push-row:first-child {
  border-top: none;
}
.when {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
.what {
  color: var(--fg);
  overflow-wrap: anywhere;
}
.what :deep(.who) {
  font-weight: 600;
}
.how {
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
.sent .how {
  color: var(--fg);
}
.failed .how {
  color: var(--bad);
}
</style>
