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
          :key="`${row.networkId}::${row.target}`"
          :class="{ row: true, active: i === selected }"
          @click="pick(row)"
          @mouseenter="selected = i"
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
import { useNickColors } from '../composables/useNickColors.js';
import { flattenBufferOrder } from '../utils/bufferOrder.js';

interface Row {
  networkId: string | number;
  target: string;
  networkName: string;
  label: string;
  unread: number;
  style: { color: string } | null;
}

const emit = defineEmits<{
  close: [];
}>();

const networks = useNetworksStore();
const buffers = useBuffersStore();
const pins = usePinsStore();
const friends = useFriendsStore();
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
    };
  });
});

const rows = computed<Row[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return allRows.value;
  // Match only on the channel/DM label, not the network name — a bare network
  // keyword ("libera") surfacing every buffer in that network is noise, and
  // there's no multi-keyword "libera amiantos" syntax to make it useful (#153).
  return allRows.value.filter((r) => {
    return r.label.toLowerCase().includes(q);
  });
});

watch(rows, () => {
  selected.value = 0;
});

function pick(row: Row) {
  buffers.activate(row.networkId, row.target);
  emit('close');
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
  // Pre-select the first row that isn't the currently active buffer so Enter
  // is a useful default — switching to wherever you were last vs. staying put.
  const activeKey = networks.activeKey;
  const list = rows.value;
  const idx = list.findIndex((r) => `${r.networkId}::${r.target}` !== activeKey);
  selected.value = idx >= 0 ? idx : 0;
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
  background: var(--bg);
  border: 1px solid var(--accent);
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
