<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="bookmarks" title="bookmarks" size="lg" align="top" @close="$emit('close')">
    <p v-if="store.error" class="error inline">{{ store.error }}</p>
    <ul v-if="visibleItems.length" class="match-list">
      <HistoryMessageRow
        v-for="m in visibleItems"
        :key="`${m.networkId}::${m.target}::${m.id}`"
        :message="m"
        removable
        @jump="onJump"
        @remove="onRemove"
      />
    </ul>
    <p v-else-if="store.loading" class="empty">Loading…</p>
    <p v-else-if="store.items.length" class="empty">All bookmarks are from ignored users.</p>
    <p v-else class="empty">No saved messages yet. Use the message context menu to save one.</p>
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
import { useBookmarksStore } from '../stores/bookmarks.js';
import { useIgnoresStore } from '../stores/ignores.js';

const emit = defineEmits<{
  close: [];
  jump: [payload: { networkId: number; target: string; messageId: number }];
}>();

const store = useBookmarksStore();
const ignores = useIgnoresStore();

const visibleItems = computed(() =>
  store.items.filter((m) => !ignores.isIgnored(m.networkId, m.nick, m.userhost ?? '')),
);

onMounted(() => {
  // ensureLoaded refetches if the snapshot marked the list as dirty (e.g., an
  // echo arrived while the modal was closed), otherwise reuses what's loaded.
  store.ensureLoaded();
});

function onJump(m: HistoryMessage): void {
  emit('jump', { networkId: m.networkId, target: m.target, messageId: Number(m.id) });
  emit('close');
}

function onRemove(m: HistoryMessage): void {
  store.remove(Number(m.id));
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

.match-list {
  list-style: none;
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
