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
    <ul v-if="visibleItems.length" class="match-list">
      <HistoryMessageRow
        v-for="m in visibleItems"
        :key="`${m.networkId}::${m.target}::${m.id}`"
        :message="m"
        @jump="onJump"
      />
    </ul>
    <p v-else-if="store.loading" class="empty">Loading…</p>
    <p v-else-if="store.items.length" class="empty">All highlights are from ignored users.</p>
    <p v-else class="empty">No highlights yet.</p>
    <footer v-if="store.hasMore || store.loading" class="foot">
      <button class="link" :disabled="store.loading || !store.hasMore" @click="store.loadMore()">
        {{ store.loading ? 'Loading…' : 'Load more' }}
      </button>
    </footer>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
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

const visibleItems = computed(() =>
  store.items.filter((m) => !ignores.isIgnored(m.networkId, m.nick, m.userhost ?? '')),
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
  padding: 0 4px;
}
.link:hover {
  color: var(--accent);
}
.link:disabled {
  opacity: 0.5;
  cursor: default;
}
.sound-toggle {
  font-size: 1.1em;
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
.empty {
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
  padding: 32px;
}
.error.inline {
  color: var(--bad);
  padding: 8px 0;
  margin: 0;
}
.foot {
  border-top: 1px solid var(--border);
  padding: 8px 0;
  display: flex;
  justify-content: center;
}
</style>
