<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section id="networks" class="settings-pane">
    <h2>networks</h2>
    <p class="section-desc">
      Drag to change the order networks appear in the sidebar. Adding, editing, and removing
      networks still happens from the
      <strong>+</strong> button at the top of the sidebar.
    </p>

    <p v-if="!networks.networks.length" class="muted small">
      No networks yet — add one with the + button in the sidebar.
    </p>

    <draggable
      v-else
      :list="localOrder"
      item-key="id"
      tag="ul"
      class="network-list"
      handle=".grip"
      :animation="120"
      ghost-class="drag-ghost"
      @start="dragging = true"
      @end="onDragEnd"
    >
      <template #item="{ element: net }">
        <li class="network">
          <span class="grip" aria-hidden="true">
            <i class="fa-solid fa-grip-vertical"></i>
          </span>
          <span class="name">{{ net.name }}</span>
          <span class="host">{{ net.host }}</span>
        </li>
      </template>
    </draggable>

    <p v-if="error" class="error inline">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import draggable from 'vuedraggable';
import { useNetworksStore } from '../../stores/networks.js';
import type { Network } from '../../stores/networks.js';

const networks = useNetworksStore();

// vuedraggable mutates the bound list in place; mirror the store into a local
// array so the store's `networks` stays authoritative and the drag library can
// freely splice. We refresh the mirror from the store unless the user is mid-
// drag — that would yank rows out from under their cursor.
const localOrder = ref<Network[]>([]);
const dragging = ref(false);

function syncFromStore() {
  if (dragging.value) return;
  localOrder.value = [...networks.networks];
}

watch(() => networks.networks, syncFromStore, { immediate: true, deep: false });

const error = ref('');

async function onDragEnd() {
  dragging.value = false;
  const ids = localOrder.value.map((n) => n.id);
  const currentIds = networks.networks.map((n) => n.id);
  // No-op if the drag didn't actually move anything (same order).
  if (ids.length === currentIds.length && ids.every((id, i) => id === currentIds[i])) {
    return;
  }
  error.value = '';
  try {
    await networks.reorder(ids);
  } catch (err: any) {
    error.value = err?.message || 'failed to save order';
    syncFromStore();
  }
}
</script>

<style src="./panes.css"></style>
<style scoped>
.network-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.network {
  display: grid;
  grid-template-columns: max-content max-content 1fr;
  gap: var(--space-6);
  align-items: center;
  padding: var(--space-4) var(--space-2);
  border-top: 1px solid var(--border);
}
.network:first-child {
  border-top: none;
}
.network:hover {
  background: var(--bg-soft);
}
.grip {
  color: var(--fg-muted);
  cursor: grab;
  padding: 0 var(--space-1);
}
.grip:active {
  cursor: grabbing;
}
.name {
  color: var(--fg);
}
.host {
  color: var(--fg-muted);
}
.drag-ghost {
  opacity: 0.4;
  background: var(--bg-soft);
}
</style>
