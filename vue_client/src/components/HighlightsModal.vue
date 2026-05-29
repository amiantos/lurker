<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="highlights" title="highlights" size="lg" align="top" @close="$emit('close')">
    <template #actions>
      <button
        class="link sound-toggle"
        :title="soundEnabled ? 'mute highlight sound' : 'unmute highlight sound'"
        @click="toggleSound"
      >
        <i :class="soundEnabled ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark'"></i>
      </button>
    </template>

    <p v-if="store.error" class="error inline">{{ store.error }}</p>
    <ul v-if="visibleItems.length" ref="listEl" class="match-list" @scroll="onScroll">
      <HistoryMessageRow
        v-for="m in visibleItems"
        :key="`${m.networkId}::${m.target}::${m.id}`"
        :message="m"
        @jump="onJump"
      />
      <li v-if="store.loading" class="more">Loading…</li>
    </ul>
    <p v-else-if="store.loading" class="empty">Loading…</p>
    <p v-else-if="store.items.length" class="empty">All highlights are from ignored users.</p>
    <p v-else class="empty">No highlights yet.</p>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import HistoryMessageRow, { type HistoryMessage } from './HistoryMessageRow.vue';
import { useSettingsStore } from '../stores/settings.js';
import { useHighlightsStore } from '../stores/highlights.js';
import { useIgnoresStore } from '../stores/ignores.js';

const emit = defineEmits<{
  close: [];
  jump: [payload: { networkId: number; target: string; messageId: number }];
}>();

const settings = useSettingsStore();
const store = useHighlightsStore();
const ignores = useIgnoresStore();

const listEl = ref<HTMLUListElement | null>(null);

const visibleItems = computed(() =>
  store.items.filter((m) => !ignores.isIgnored(m.networkId, m.nick, m.userhost ?? '')),
);

function onScroll(): void {
  const el = listEl.value;
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
    store.loadMore();
  }
}

// If the entire loaded page is from ignored users the scroll container is not
// rendered, so the user can't trigger pagination themselves — quietly fetch
// the next page in their stead. Capped so a single very prolific ignored
// source can't drag the modal into an unbounded fetch loop.
const AUTO_FILL_MAX_PAGES = 5;
let autoFillFetched = 0;
watch(
  () => [visibleItems.value.length, store.loading, store.hasMore] as const,
  ([visible, loading, hasMore]) => {
    if (visible === 0 && hasMore && !loading && autoFillFetched < AUTO_FILL_MAX_PAGES) {
      autoFillFetched += 1;
      store.loadMore();
    }
  },
);

const soundEnabled = computed(() => !!settings.effective('notifications.highlight.sound.enabled'));

async function toggleSound(): Promise<void> {
  try {
    await settings.setValue('notifications.highlight.sound.enabled', !soundEnabled.value);
  } catch (_) {
    /* setting writes are best-effort from the modal */
  }
}

onMounted(() => {
  store.loadInitial();
});

function onJump(m: HistoryMessage): void {
  emit('jump', { networkId: m.networkId, target: m.target, messageId: Number(m.id) });
  emit('close');
}
</script>

<style scoped>
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
.link:disabled {
  opacity: 0.5;
  cursor: default;
}
.sound-toggle {
  font-weight: 600;
}

.match-list {
  list-style: none;
  /* Break out of card padding so the scrollbar sits against the card
     border; padding keeps row content visually aligned with the rest. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.more {
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-4);
}
.empty {
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-10);
}
.error.inline {
  color: var(--bad);
  padding: var(--space-4) 0;
  margin: 0;
}
</style>
