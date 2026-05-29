<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Single row for a historical message shown out of buffer context
  (search results, highlights list, etc). Header strip shows where
  and when the message happened ("network/channel" matching the
  status bar, plus the time); the body reads like a real chat line —
  nick with its standard color, then the message text.
-->

<template>
  <li :class="{ row: true, active }" @click="$emit('jump', message)" @mouseenter="$emit('hover')">
    <div class="head">
      <div class="where">
        <template v-if="targetLabel"
          ><span class="net">{{ networkLabel }}/</span
          ><span class="target">{{ targetLabel }}</span></template
        >
        <span v-else class="net">{{ networkLabel }}</span>
      </div>
      <span class="time">{{ time }}</span>
    </div>
    <div class="body">
      <span class="nick" :style="nickStyle">{{ message.nick }}</span>
      <span class="sep">|</span>
      <span class="text"><LinkedText :text="message.text ?? ''" /></span>
    </div>
    <button
      v-if="removable"
      type="button"
      class="remove"
      title="Remove"
      aria-label="Remove"
      @click.stop="$emit('remove', message)"
    >
      <i class="fa-solid fa-xmark"></i>
    </button>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CSSProperties } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNickColors } from '../composables/useNickColors.js';
import { formatTimestamp, formatDate } from '../utils/timestamp.js';
import LinkedText from './LinkedText.vue';

// Shared row shape from search/highlights/bookmarks. All callers pass at
// minimum { id, networkId, target, nick, time, text }; `self` and
// `networkName` are optional extras some callers include.
export interface HistoryMessage {
  id?: number | string | null;
  networkId: number;
  target: string;
  nick: string;
  text?: string;
  time?: string;
  self?: boolean;
  networkName?: string;
  [key: string]: unknown;
}

const props = withDefaults(
  defineProps<{
    message: HistoryMessage;
    active?: boolean;
    removable?: boolean;
  }>(),
  { active: false, removable: false },
);

defineEmits<{
  jump: [message: HistoryMessage];
  hover: [];
  remove: [message: HistoryMessage];
}>();

const networks = useNetworksStore();
const settings = useSettingsStore();
const nicks = useNickColors();

const tsFormat = computed(() => settings.effective('look.buffer.time_format'));
const selfColor = computed(() => settings.effective('look.nick.self_color'));

// History rows are out-of-buffer (search/highlights), so a bare HH:mm is
// ambiguous — prepend the calendar date. Skipped if the user's format
// already includes a year token to avoid doubling up.
const time = computed(() => {
  const fmt = tsFormat.value as string;
  const iso = props.message.time ?? '';
  const t = formatTimestamp(iso, fmt);
  if (fmt && /YYYY/.test(fmt)) return t;
  const d = formatDate(iso);
  if (!d) return t;
  return t ? `${d} ${t}` : d;
});

const networkLabel = computed((): string => {
  const m = props.message;
  return (
    (m.networkName as string | undefined) ||
    networks.networks.find((n) => n.id === m.networkId)?.name ||
    `net:${m.networkId}`
  );
});

// Drop the `:server:<id>` pseudo-target so server messages render as just
// the network name (matches StatusBar.vue's buffer segment).
const targetLabel = computed(() => {
  const t = props.message.target;
  if (!t || t.startsWith(':server:')) return '';
  return t;
});

const nickStyle = computed((): CSSProperties | null => {
  if (props.message.self) return { color: selfColor.value as string };
  const c = nicks.color(props.message.nick);
  return c ? { color: c } : null;
});
</script>

<style scoped>
.row {
  position: relative;
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.row:hover,
.row.active {
  background: var(--bg-soft);
}

.remove {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  padding: 0;
  border-radius: var(--radius-sm);
}
.row:hover .remove {
  opacity: 1;
}
.remove:hover {
  color: var(--bad);
}
@media (hover: none) {
  .remove {
    opacity: 1;
  }
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
  color: var(--fg-muted);
  margin-bottom: var(--space-3);
}
.where {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.net {
  color: var(--fg-muted);
}
.target {
  color: var(--accent);
}
.time {
  flex-shrink: 0;
}

.body {
  white-space: pre-wrap;
  word-break: break-word;
}
.nick {
  font-weight: 600;
}
.sep {
  color: var(--border);
  margin: 0 0.5ch;
}
</style>
