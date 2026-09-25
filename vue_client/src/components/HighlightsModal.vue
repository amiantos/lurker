<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="highlights" title="highlights" size="lg" fill-height @close="$emit('close')">
    <template #actions>
      <button
        class="link sound-toggle"
        :title="soundEnabled ? 'mute highlight sound' : 'unmute highlight sound'"
        @click="toggleSound"
      >
        <i :class="soundEnabled ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark'"></i>
      </button>
    </template>

    <!-- The reactions tab lists other people's reactions to your own lines. Not
         offered on a buffer-scoped open, which is about that buffer's highlights. -->
    <div v-if="!scoped" class="tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t"
        type="button"
        role="tab"
        class="tab"
        :class="{ active: tab === t }"
        :aria-selected="tab === t"
        @click="setTab(t)"
      >
        {{ t }}
      </button>
    </div>
    <div class="search-row">
      <input
        :value="queryInput"
        @input="onQueryInput"
        class="filter"
        type="text"
        :placeholder="`filter ${tab} — from:nick in:#channel on:network`"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <p v-if="feed.error" class="error inline">{{ feed.error }}</p>
    <ul v-if="visibleItems.length" ref="listEl" class="match-list" @scroll="onScroll">
      <template v-if="tab === 'reactions'">
        <HistoryMessageRow
          v-for="m in visibleItems"
          :key="`r::${m.reactionId}`"
          :message="m"
          :reaction="m.value as string"
          @jump="onJump"
        />
      </template>
      <template v-else>
        <HistoryMessageRow
          v-for="m in visibleItems"
          :key="`${m.networkId}::${m.target}::${m.id}`"
          :message="m"
          @jump="onJump"
        />
      </template>
      <li v-if="feed.loading" class="more">Loading…</li>
    </ul>
    <p v-else-if="feed.loading" class="empty">Loading…</p>
    <p v-else-if="feed.items.length" class="empty">All {{ tab }} are from ignored users.</p>
    <p v-else-if="hasFilter" class="empty">No {{ tab }} match your filter.</p>
    <p v-else-if="tab === 'reactions'" class="empty">No reactions to your messages yet.</p>
    <p v-else class="empty">No highlights yet.</p>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import HistoryMessageRow, { type HistoryMessage } from './HistoryMessageRow.vue';
import { useSettingsStore } from '../stores/settings.js';
import { useHighlightsStore } from '../stores/highlights.js';
import { useReactionsStore } from '../stores/reactions.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useImeSafeInput } from '../composables/useImeSafeInput.js';

const emit = defineEmits<{
  close: [];
  jump: [payload: { networkId: number; target: string; messageId: number }];
}>();

// `scope` (set when opened from a buffer's topic bar) runs the highlights feed
// filtered to this buffer. Unlike search this loads immediately — highlights is
// a filtered feed, not a type-to-search box, so the channel's highlights should
// be visible at a glance. The global session is snapshotted and restored on
// close so the list-bar highlights modal is unaffected.
const props = defineProps<{ scope?: string | null }>();
const scoped = !!props.scope;

const settings = useSettingsStore();
const store = useHighlightsStore();
const reactionsFeed = useReactionsStore();
const ignores = useIgnoresStore();

const TABS = ['highlights', 'reactions'] as const;
type Tab = (typeof TABS)[number];
const tab = ref<Tab>('highlights');
// The feed the list, filter and pager are driving. Both stores share the
// from:/in:/on: filter contract, so one input serves either.
const feed = computed(() => (tab.value === 'reactions' ? reactionsFeed : store));
let scopedSnapshot: typeof store.$state | null = null;

const listEl = ref<HTMLUListElement | null>(null);

const visibleItems = computed(() =>
  (feed.value.items as HistoryMessage[]).filter((m) => !ignores.isMessageHidden(m.networkId, m)),
);

const hasFilter = computed(() => feed.value.query.trim().length > 0);

function setTab(next: Tab): void {
  if (tab.value === next) return;
  tab.value = next;
  autoFillFetched = 0;
  // Carry the filter across, and load fresh — each tab is a live feed.
  feed.value.setQuery(queryInput.value);
  feed.value.loadInitial();
}

// If the entire loaded page is from ignored users the scroll container is not
// rendered, so the user can't trigger pagination themselves — quietly fetch
// the next page in their stead. Capped so a single very prolific ignored
// source can't drag the modal into an unbounded fetch loop; reset whenever the
// filter changes so a fresh result set gets its own budget.
const AUTO_FILL_MAX_PAGES = 5;
let autoFillFetched = 0;

// Local mirror of the store's raw filter so we can debounce the reload without
// debouncing the text field itself. Seeded from the store so a closed-then-
// reopened modal keeps the active filter.
const queryInput = ref(scoped ? `${props.scope} ` : store.query);
const onQueryInput = useImeSafeInput(queryInput);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(queryInput, (val) => {
  feed.value.setQuery(val);
  autoFillFetched = 0; // New filter — let auto-fill work again.
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    // skipIfSameFilter: this watcher fires on no-op input changes too (a
    // trailing space, a half-typed filter token) — don't blank + refetch.
    feed.value.loadInitial(true);
  }, 200);
});
onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  // Discard the scoped session, restoring the store for the global modal.
  if (scoped && scopedSnapshot) store.$patch(scopedSnapshot);
});

function onScroll(): void {
  const el = listEl.value;
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
    feed.value.loadMore();
  }
}

watch(
  () => [visibleItems.value.length, feed.value.loading, feed.value.hasMore] as const,
  ([visible, loading, hasMore]) => {
    if (visible === 0 && hasMore && !loading && autoFillFetched < AUTO_FILL_MAX_PAGES) {
      autoFillFetched += 1;
      feed.value.loadMore();
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
  if (scoped) {
    // Snapshot the global session, then seed the scoped filter before the
    // initial load so the feed opens showing this buffer's highlights.
    scopedSnapshot = { ...store.$state };
    store.setQuery(queryInput.value);
  }
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
  /* Icon-only button — size the glyph (fa-solid is already weight 900, so
     font-weight here would be a no-op). */
  font-size: var(--icon-md);
}

.tabs {
  display: flex;
  gap: var(--space-6);
  margin-bottom: var(--space-5);
}
.tab {
  background: none;
  border: none;
  border-bottom: 1px solid transparent;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 0 var(--space-2);
}
.tab:hover {
  color: var(--fg);
}
.tab.active {
  color: var(--fg);
  border-bottom-color: var(--accent);
}

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
