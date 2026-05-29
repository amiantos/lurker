<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div ref="scroller" class="system-console" @scroll="onScroll">
    <p v-if="!lines.length" class="notice empty">No system events yet.</p>
    <div
      v-for="line in lines"
      :key="line.id"
      class="row"
      :class="['lvl-' + (line.level || 'info')]"
    >
      <span class="time">{{ formatTime(line.ts) }}</span>
      <span class="scope">{{ line.scope }}</span>
      <span class="text">{{ line.text }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useSystemLogStore } from '../stores/systemLog.js';
import { useSettingsStore } from '../stores/settings.js';
import { formatTimestamp } from '../utils/timestamp.js';

const systemLog = useSystemLogStore();
const settings = useSettingsStore();

const lines = computed(() => systemLog.lines);
const tsFormat = computed(
  () => (settings.effective('look.buffer.time_format') as string) || 'HH:mm:ss',
);

function formatTime(iso: unknown) {
  return formatTimestamp((iso as string) || '', tsFormat.value);
}

const scroller = ref<HTMLDivElement | null>(null);
// Stick-to-bottom unless the user has scrolled away from the tail. Mirrors
// the message-list pattern at a coarser granularity — we only care whether
// the user is reading history or live.
let stickToBottom = true;

function isAtBottom() {
  const el = scroller.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

function onScroll() {
  stickToBottom = isAtBottom();
}

watch(
  () => lines.value.length,
  () => {
    if (!stickToBottom) return;
    nextTick(() => {
      const el = scroller.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
  { flush: 'post' },
);
</script>

<style scoped>
.system-console {
  /* Desktop is CSS grid; mobile shell stacks the section in flex column.
     Both layouts apply — the unused property is ignored in the other
     context. */
  grid-area: messages;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3) var(--space-6);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  line-height: 1.4;
}
.notice.empty {
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-6);
}
.row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: var(--space-4);
  align-items: baseline;
}
.time {
  color: var(--fg-muted);
  white-space: nowrap;
}
.scope {
  color: var(--accent);
  white-space: nowrap;
}
.text {
  color: var(--fg);
  word-break: break-word;
}
.row.lvl-warn .text {
  color: var(--warn);
}
.row.lvl-error .text {
  color: var(--bad);
}
</style>
