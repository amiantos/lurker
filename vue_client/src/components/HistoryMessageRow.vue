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
  <li class="row" @click="$emit('jump', message)">
    <div class="head">
      <div class="where">
        <template v-if="targetLabel"
          ><span class="net">{{ networkLabel }}/</span
          ><span class="target">{{ targetLabel }}</span></template
        >
        <span v-else class="net">{{ networkLabel }}</span>
      </div>
      <div class="meta">
        <span class="time">{{ time }}</span>
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
      </div>
    </div>
    <div class="body">
      <span class="nick" :style="nickStyle">{{ message.nick }}</span>
      <span class="sep">|</span>
      <span class="text"><LinkedText :text="message.text ?? ''" /></span>
    </div>
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
    removable?: boolean;
  }>(),
  { removable: false },
);

defineEmits<{
  jump: [message: HistoryMessage];
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
  /* No horizontal padding — the list already insets to the card's content edge
     (padding: 0 var(--card-pad-x) on its scroll container), so the row content
     sits flush with its full-width separators rather than adding a second inset.
     Roomy padding-bottom above the separator plus a margin below it space the
     rows well apart. */
  padding: var(--space-4) 0 var(--space-8);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--space-4);
  cursor: pointer;
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
  color: var(--fg-muted);
  margin-bottom: var(--space-3);
}
/* Time + remove icon, grouped at the right edge of the header strip — the
   xmark sits in the top-right corner and the date is nudged left to clear it. */
.meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-5);
  flex-shrink: 0;
}
.remove {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}
.remove:hover {
  color: var(--bad);
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
.sep {
  color: var(--border);
  margin: 0 0.5ch;
}
/* Mirror the channel-list rows: the message text sits at the secondary fg and
   lifts to full fg on row hover, so the row still has a hover tell even though
   the nick keeps its own color. */
.text {
  color: var(--fg-muted);
}
.row:hover .text {
  color: var(--fg);
}
</style>
