<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="modal" @click.self="$emit('close')">
    <div class="card" tabindex="-1">
      <header class="head">
        <input
          ref="inputEl"
          v-model="query"
          class="filter"
          type="text"
          placeholder="jump to channel or DM…"
          autocomplete="off"
          spellcheck="false"
          @keydown="onKeydown"
        />
        <button class="link" @click="$emit('close')" title="close">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </header>
      <ul v-if="rows.length" ref="listEl" class="list">
        <li
          v-for="(row, i) in rows"
          :key="row.key"
          :class="{ row: true, active: i === selected }"
          @click="pick(row)"
          @mousemove="onPointerMove($event, i)"
        >
          <span class="net">{{ row.networkName }}</span>
          <span class="sep">/</span>
          <span class="target" :style="row.style">{{ row.label }}</span>
          <span v-if="row.unread > 0" class="badge">{{ row.unread }}</span>
        </li>
      </ul>
      <p v-else class="empty">No matches.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch, nextTick } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { usePinsStore } from '../stores/pins.js';
import { useFriendsStore } from '../stores/friends.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useNickColors } from '../composables/useNickColors.js';
import { flattenBufferOrder, bufferSortKey } from '../utils/bufferOrder.js';
import { smartSortRows } from '../utils/switcherSort.js';

interface Row {
  networkId: string | number;
  target: string;
  networkName: string;
  label: string;
  unread: number;
  style: { color: string } | null;
  // Smart-sort inputs (#393): identity/recency key, pin state, and the
  // alphabetical tie-break key. Carried on the row so the template's :key and
  // the sort share one source.
  key: string;
  pinned: boolean;
  sortKey: string;
}

const emit = defineEmits<{
  close: [];
}>();

const networks = useNetworksStore();
const buffers = useBuffersStore();
const pins = usePinsStore();
const friends = useFriendsStore();
const recent = useRecentBuffersStore();
const nicks = useNickColors();

const query = ref('');
const selected = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLUListElement | null>(null);

function isServerTarget(t: string) {
  return t.startsWith(':server:');
}
function isDmTarget(t: string) {
  return !isServerTarget(t) && !t.startsWith('#');
}

function netById(id: string | number) {
  return networks.networks.find((n) => n.id === id);
}

function dmStyle(networkId: string | number, target: string): { color: string } | null {
  if (!isDmTarget(target)) return null;
  const selfNick = networks.states[networkId]?.nick;
  if (selfNick && target.toLowerCase() === selfNick.toLowerCase()) return null;
  const c = nicks.color(target);
  return c ? { color: c } : null;
}

const allRows = computed<Row[]>(() => {
  const order = flattenBufferOrder({
    networks: networks.networks,
    buffers,
    pins,
    // Match the sidebar/keyboard-nav surface: surface each friend's primary DM
    // in the FRIENDS group position and exclude it from its real network so it
    // isn't listed twice. No feedKey — the overview pane isn't a quick-switch
    // target (this is for jumping to conversations), which also sidesteps having
    // to special-case activating the virtual entry here.
    friends: {
      dms: friends.primaryDmEntries,
      excludeKeys: friends.primaryDmKeys,
    },
  });
  return order.map((entry) => {
    const net = netById(entry.networkId);
    const buf = buffers.byKey(entry.key);
    const isServer = isServerTarget(entry.target as string);
    return {
      networkId: entry.networkId,
      target: entry.target,
      networkName: net?.name || `net:${entry.networkId}`,
      label: isServer ? '[server]' : entry.target,
      unread: buf?.unread || 0,
      style: dmStyle(entry.networkId, entry.target),
      key: entry.key,
      pinned: pins.isPinned(entry.networkId, entry.target),
      sortKey: bufferSortKey(entry.target as string),
    };
  });
});

const rows = computed<Row[]>(() => {
  const q = query.value.trim().toLowerCase();
  // No query: this is the alt-tab view, so drop the buffer you're already in —
  // switching to where you already are is a no-op, and dropping it puts your
  // *previous* buffer at row 0 (and pre-selected), making Cmd+K→Enter a clean
  // back toggle. With a query it's a search: keep everything matchable, since
  // you may well be looking for the current buffer by name.
  // Match only on the channel/DM label, not the network name — a bare network
  // keyword ("libera") surfacing every buffer in that network is noise, and
  // there's no multi-keyword "libera amiantos" syntax to make it useful (#153).
  const filtered = q
    ? allRows.value.filter((r) => r.label.toLowerCase().includes(q))
    : allRows.value.filter((r) => r.key !== networks.activeKey);
  // Tiered smart sort applied AFTER filtering (#393): recent → pinned → unread →
  // alphabetical, so recency/favourites survive a search instead of collapsing
  // to plain alphabetical. Reads recent.keys so this recomputes as the MRU moves.
  const ranks = recent.keys;
  return smartSortRows(filtered, {
    recencyRank: (key) => {
      const i = ranks.indexOf(key);
      return i === -1 ? Infinity : i;
    },
  });
});

watch(rows, () => {
  selected.value = 0;
});

function pick(row: Row) {
  buffers.activate(row.networkId, row.target);
  emit('close');
}

// Hover-to-select, but only on a *real* pointer move. `mouseenter`/hover also
// fires when the list paints under a stationary cursor (on open) or scrolls
// under it (arrow-key nav scrollIntoView), which would otherwise clobber the
// keyboard selection — the classic sticky-hover trap. Gating on an actual
// change in pointer coordinates ignores both: those synthetic events carry the
// same clientX/clientY, since the mouse didn't move.
const lastPointer = ref<{ x: number; y: number } | null>(null);
function onPointerMove(e: MouseEvent, i: number) {
  // Coordinate gate first (and update lastPointer regardless of the row) so a
  // later synthetic event at the cursor's true position is still recognised as
  // "no movement" — even when the pointer just slid within the current row.
  if (lastPointer.value && lastPointer.value.x === e.clientX && lastPointer.value.y === e.clientY)
    return;
  lastPointer.value = { x: e.clientX, y: e.clientY };
  // Only a change of hovered row is worth acting on; skip moves within the
  // already-selected row.
  if (selected.value === i) return;
  selected.value = i;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (rows.value.length === 0) return;
    selected.value = (selected.value + 1) % rows.value.length;
    scrollSelectedIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (rows.value.length === 0) return;
    selected.value = (selected.value - 1 + rows.value.length) % rows.value.length;
    scrollSelectedIntoView();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const row = rows.value[selected.value];
    if (row) pick(row);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

function scrollSelectedIntoView() {
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    const child = el.children[selected.value];
    child?.scrollIntoView({ block: 'nearest' });
  });
}

onMounted(() => {
  // Row 0 is the right default: the default (no-query) view excludes the active
  // buffer, so the most-recent remaining entry — your previous buffer — sits at
  // the top, making Cmd+K→Enter a back toggle. selected starts at 0 and the
  // rows watcher keeps it there as the query changes; just take focus here.
  setTimeout(() => inputEl.value?.focus(), 0);
});
</script>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  z-index: var(--z-modal);
}
.card {
  /* "A big context menu" — same floating-surface chrome as ContextMenu and the
     dialog cards (subtle --border, hair of radius, shared shadow), over the
     --scrim backdrop above (no WordBackdrop: a fast switcher should keep the
     app visible behind it). */
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  width: min(560px, 92vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  outline: none;
}
.head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-6);
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
.link {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.link:hover {
  color: var(--fg);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.row {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-6);
  cursor: pointer;
}
.row.active {
  background: var(--bg-soft);
}
.row .net {
  color: var(--accent);
}
.row .sep {
  color: var(--border);
}
.row .target {
  flex: 1;
  color: var(--fg);
}
.row .badge {
  color: var(--accent);
}

.empty {
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-9);
}
</style>
