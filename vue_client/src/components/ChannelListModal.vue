<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal
    word="channels"
    :title="`channels — ${networkLabel}`"
    size="xl"
    fill-height
    @close="$emit('close')"
  >
    <div class="controls">
      <input
        ref="filterEl"
        v-model="filterInput"
        class="filter"
        type="text"
        placeholder="filter (name or topic)"
        autocomplete="off"
        spellcheck="false"
      />
      <button class="btn" :disabled="state.inProgress" @click="refresh">
        {{ state.inProgress ? `Streaming… ${state.totalCount}` : 'Refresh' }}
      </button>
      <span class="meta">{{ headerLabel }}</span>
    </div>
    <div class="sort-bar">
      <span class="sort-label">sort by</span>
      <button class="sort" :class="{ active: state.sortBy === 'name' }" @click="setSort('name')">
        name<span v-if="state.sortBy === 'name'" class="sort-arrow">{{
          state.sortDir === 'asc' ? ' ▲' : ' ▼'
        }}</span>
      </button>
      <button class="sort" :class="{ active: state.sortBy === 'users' }" @click="setSort('users')">
        users<span v-if="state.sortBy === 'users'" class="sort-arrow">{{
          state.sortDir === 'asc' ? ' ▲' : ' ▼'
        }}</span>
      </button>
    </div>
    <div ref="listEl" class="list-wrap" @scroll="onScroll">
      <ul v-if="state.rows.length" class="list-stack">
        <li
          v-for="ch in state.rows"
          :key="ch.channel"
          class="list-item"
          @click="onJoin(ch)"
          :title="`Join ${ch.channel}`"
        >
          <div class="list-item-head">
            <span class="list-item-title">{{ ch.channel }}</span>
            <span class="list-item-meta"
              >{{ ch.num_users }} {{ ch.num_users === 1 ? 'user' : 'users' }}</span
            >
          </div>
          <div v-if="ch.topic" class="list-item-sub">{{ ch.topic }}</div>
        </li>
        <li v-if="state.loading" class="list-item-loading">Loading…</li>
      </ul>
      <p v-else-if="state.loading || state.inProgress" class="empty">
        {{ state.inProgress ? `Streaming channels… ${state.totalCount}` : 'Loading…' }}
      </p>
      <p v-else-if="!state.totalCount" class="empty">No channels cached yet — Refresh to fetch.</p>
      <p v-else class="empty">No matches.</p>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch, onBeforeUnmount } from 'vue';
import AppModal from './AppModal.vue';
import { useChanlistStore, resultKey, type ChanlistRow } from '../stores/chanlist.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { socketSend } from '../composables/useSocket.js';
import { formatRelative } from '../utils/timestamp.js';

const PAGE_LIMIT = 200;
const FILTER_DEBOUNCE_MS = 200;

const props = defineProps<{ networkId: number }>();
const emit = defineEmits<{ close: [] }>();

const chanlist = useChanlistStore();
const networks = useNetworksStore();
const buffers = useBuffersStore();

const filterEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const filterInput = ref('');
let filterTimer: ReturnType<typeof setTimeout> | null = null;
let prevInProgress = false;

// Lazy-init the store entry so v-if/.rows reads don't return null.
chanlist.ensure(props.networkId);
// ensure() guarantees forNetwork returns non-null; cast away the null.
const state = computed(() => chanlist.forNetwork(props.networkId)!);

// Seed the filter input from any prior session so reopening the modal doesn't
// silently throw away a search the user had typed before they closed it.
filterInput.value = state.value.query;

const networkLabel = computed(() => {
  const net = networks.networks.find((n) => n.id === props.networkId);
  return net?.name || `net:${props.networkId}`;
});

const headerLabel = computed(() => {
  const s = state.value;
  if (s.inProgress) return `streaming · ${s.totalCount}`;
  if (s.fetchedAt) {
    return `${s.total.toLocaleString()} match · ${s.totalCount.toLocaleString()} total · fetched ${formatRelative(s.fetchedAt)}`;
  }
  return '';
});

function sendSearch(offset: number): void {
  const s = state.value;
  const key = resultKey({ query: s.query, sortBy: s.sortBy, sortDir: s.sortDir });
  chanlist.setLoading(props.networkId, true, key);
  socketSend({
    type: 'chanlist-search',
    networkId: props.networkId,
    query: s.query,
    sortBy: s.sortBy,
    sortDir: s.sortDir,
    offset,
    limit: PAGE_LIMIT,
  });
}

function refresh() {
  socketSend({ type: 'list-channels', networkId: props.networkId });
}

function setSort(key: string): void {
  const s = state.value;
  let dir: string;
  if (s.sortBy === key) {
    dir = s.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    dir = key === 'users' ? 'desc' : 'asc';
  }
  chanlist.setSort(props.networkId, key, dir);
  sendSearch(0);
}

watch(filterInput, (next) => {
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    chanlist.setQuery(props.networkId, next);
    sendSearch(0);
  }, FILTER_DEBOUNCE_MS);
});

// When a refresh completes (inProgress flips true→false), re-pull page 1 so
// the just-cached rows replace whatever was on screen. The transition matters
// — running on every false reading would also fire on initial open.
watch(
  () => state.value.inProgress,
  (next) => {
    if (prevInProgress && !next) sendSearch(0);
    prevInProgress = next;
  },
);

function onScroll() {
  const el = listEl.value;
  if (!el || state.value.loading) return;
  const s = state.value;
  const haveAll = s.rows.length >= s.total;
  if (haveAll) return;
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (dist < 240) sendSearch(s.rows.length);
}

function onJoin(ch: ChanlistRow): void {
  // If we're already in the channel (or have its buffer parted), just switch to
  // it; otherwise join and wait for the channel-joined confirmation before
  // focusing, so a refused join doesn't strand the user in a blank buffer
  // (#260). joinOrToast handles both, plus rejection toasts, and warns if the
  // socket is closed so the click isn't a silent no-op (the modal still closes).
  buffers.joinOrToast(props.networkId, ch.channel);
  emit('close');
}

onMounted(() => {
  prevInProgress = state.value.inProgress;
  // Always pull a fresh first page on open so the rows match whatever the
  // current search snapshot is, and so a stale `rows` list left over from a
  // prior session is replaced by current cache state.
  sendSearch(0);
  // If we've never refreshed for this network, kick a LIST so the user sees
  // results without an explicit click. fetchedAt is null until the first
  // chanlist-end persists.
  if (!state.value.fetchedAt && !state.value.inProgress && state.value.totalCount === 0) {
    refresh();
  }
  setTimeout(() => filterEl.value?.focus(), 0);
});

onBeforeUnmount(() => {
  if (filterTimer) clearTimeout(filterTimer);
});
</script>

<style scoped>
.controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
  margin-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}
.filter {
  flex: 1;
  min-width: 0;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: var(--space-2) var(--space-4);
  font: inherit;
}
.filter:focus {
  outline: none;
  border-color: var(--accent);
}
.btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--accent);
  font: inherit;
  padding: var(--space-2) var(--space-5);
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--fg);
}
.btn:disabled {
  opacity: 0.6;
  color: var(--fg-muted);
  cursor: default;
}
.meta {
  color: var(--fg-muted);
}

/* On mobile the filter + refresh button consume the full row; push the
   match/total/fetched line under them rather than letting it squeeze in
   and overflow. */
@media (max-width: 768px) {
  .meta {
    flex-basis: 100%;
  }
}

.sort-bar {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  padding-bottom: var(--space-4);
  margin-bottom: var(--space-2);
}
.sort-label {
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.sort {
  background: none;
  border: none;
  color: var(--fg-muted);
  font: inherit;
  padding: 0;
  cursor: pointer;
}
.sort:hover {
  color: var(--fg);
}
.sort.active {
  color: var(--accent);
}
.sort-arrow {
  opacity: 0.7;
}

.list-wrap {
  /* Break out of card padding so the scrollbar sits against the card
     border; padding keeps row content visually aligned with the rest. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

/* Stacked list-item format: title + right-aligned meta on the first
   row, optional sub line beneath. Built here for the channel list but
   intentionally generic — same shape should slot in anywhere we list
   selectable rows with a primary + secondary line. */
.list-stack {
  list-style: none;
  margin: 0;
  padding: 0;
}
.list-item {
  padding: var(--space-4) var(--space-4);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.list-item:hover {
  background: var(--bg-soft);
}
.list-item-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-6);
}
.list-item-title {
  color: var(--accent);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.list-item-meta {
  color: var(--fg-muted);
  white-space: nowrap;
  flex-shrink: 0;
}
.list-item-sub {
  color: var(--fg-muted);
  margin-top: var(--space-1);
  line-height: 1.4;
  word-break: break-word;
}
.list-item:hover .list-item-sub {
  color: var(--fg);
}
.list-item-loading {
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-4);
  list-style: none;
}
.empty {
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-10);
}
</style>
