<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="search" title="search" size="lg" align="top" @close="$emit('close')">
    <div class="search-row">
      <input
        ref="inputEl"
        v-model="queryInput"
        class="filter"
        type="text"
        placeholder="search messages — from:nick in:#channel on:network"
        autocomplete="off"
        spellcheck="false"
        @keydown="onKeydown"
      />
    </div>
    <p v-if="store.error" class="error inline">{{ store.error }}</p>
    <ul v-if="visibleResults.length" ref="listEl" class="match-list" @scroll="onScroll">
      <HistoryMessageRow
        v-for="(m, i) in visibleResults"
        :key="`${m.networkId}::${m.target}::${m.id}`"
        :message="m"
        :active="i === selected"
        @jump="onJump"
        @hover="selected = i"
      />
      <li v-if="store.loading" class="more">Loading…</li>
    </ul>
    <p v-else-if="store.loading" class="empty">Searching…</p>
    <p v-else-if="store.results.length" class="empty">All matches are from ignored users.</p>
    <p v-else-if="store.searched" class="empty">No matches.</p>
    <p v-else class="empty">Type to search your message history.</p>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import AppModal from './AppModal.vue';
import HistoryMessageRow from './HistoryMessageRow.vue';
import { useSearchStore } from '../stores/search.js';
import type { SearchResult } from '../stores/search.js';
import { useIgnoresStore } from '../stores/ignores.js';
import type { HistoryMessage } from './HistoryMessageRow.vue';

const emit = defineEmits<{
  close: [];
  jump: [payload: { networkId: number; target: string; messageId: number }];
}>();

const store = useSearchStore();
const ignores = useIgnoresStore();

// Search runs against the full message history; ignored senders are
// filtered after results arrive so /unignore restores the rows without
// re-issuing the query.
const visibleResults = computed(() =>
  store.results.filter((m) => !ignores.isIgnored(m.networkId, m.nick, m.userhost ?? '')),
);

const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLUListElement | null>(null);
// Hydrated from the store on mount so a closed-then-reopened modal lands
// on the same row the user was last on. Mirrored back into the store on
// unmount.
const selected = ref(store.selectedIndex);

// Local mirror of the store's raw query so we can debounce dispatch without
// debouncing the text field itself.
const queryInput = ref(store.query);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(queryInput, (val) => {
  store.setQuery(val);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    store.runSearch();
  }, 200);
});

// Reset the keyboard cursor whenever the visible result set is replaced
// (a fresh search), but leave it alone on pagination appends. Clamp to
// in-range when the set shrinks (e.g. a result becomes ignored) so the
// restored selectedIndex never points past the end.
watch(
  () => visibleResults.value.length,
  (len, prev) => {
    if (len === 0) {
      selected.value = 0;
      return;
    }
    if (len < prev || prev === 0) selected.value = 0;
    if (selected.value >= len) selected.value = len - 1;
  },
);

function onJump(m: HistoryMessage | SearchResult) {
  const id = typeof m.id === 'number' ? m.id : 0;
  emit('jump', { networkId: m.networkId, target: m.target, messageId: id });
  emit('close');
}

function scrollSelectedIntoView() {
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    el.children[selected.value]?.scrollIntoView({ block: 'nearest' });
  });
}

function onKeydown(e: KeyboardEvent) {
  const rows = visibleResults.value;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!rows.length) return;
    selected.value = (selected.value + 1) % rows.length;
    scrollSelectedIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!rows.length) return;
    selected.value = (selected.value - 1 + rows.length) % rows.length;
    scrollSelectedIntoView();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const row = rows[selected.value];
    if (row) onJump(row);
  }
  // Esc handled by AppModal's keydown listener on the modal root.
}

function onScroll() {
  const el = listEl.value;
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
    store.loadMore();
  }
}

onMounted(() => {
  setTimeout(() => {
    inputEl.value?.focus();
    inputEl.value?.select();
  }, 0);
  // Restore the scroll position after the list has rendered. The cursor was
  // already seeded from the store via the `selected` ref's initial value.
  nextTick(() => {
    const el = listEl.value;
    if (el && store.scrollTop > 0) el.scrollTop = store.scrollTop;
  });
});

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  // Persist DOM-only state back to the store so the next open restores it.
  // The Pinia store already keeps query, results, hasMore, nextBefore, and
  // searched across opens; this rounds out the user-perceived "where I was".
  store.scrollTop = listEl.value?.scrollTop || 0;
  store.selectedIndex = selected.value;
});
</script>

<style scoped>
.search-row {
  margin-bottom: var(--space-6);
}
.filter {
  width: 100%;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: var(--space-4) var(--space-5);
  font: inherit;
}
.filter:focus {
  outline: none;
  border-color: var(--accent);
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
