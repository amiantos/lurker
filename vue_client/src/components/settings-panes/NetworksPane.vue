<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section id="networks" class="settings-pane">
    <h2>networks</h2>
    <p class="section-desc">
      Drag to change the order networks appear in the sidebar. Edit opens a network’s settings,
      where it can also be deleted.
    </p>

    <p v-if="!networks.networks.length" class="muted small">No networks yet.</p>

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
        <li class="network" :class="{ blocked: net.blocked }">
          <span class="grip" aria-hidden="true">
            <GripVerticalIcon />
          </span>
          <span class="name">{{ net.name }}</span>
          <span class="host">{{ net.host }}</span>
          <!-- The admin restricted this instance to a list of networks and this
               one isn't on it (#298). Nothing has been deleted — it simply can't
               connect — so say so, rather than letting the user keep clicking
               Connect on a network that will never come up. -->
          <span
            v-if="net.blocked"
            class="blocked-tag"
            title="This server, or this account's restrictions, do not allow connecting here"
          >
            blocked
          </span>
          <span class="btn-bar">
            <button type="button" @click="openEditor(net)">edit</button>
          </span>
        </li>
      </template>
    </draggable>

    <p class="add-row">
      <button class="btn-secondary" @click="openEditor(null)">add network</button>
    </p>

    <p v-if="error" class="error inline">{{ error }}</p>

    <!-- The same editor the sidebar's + and a network's menu open. To body: the
         settings layout gives a fixed-position card a containing block, so
         rendered in place it would cover only the pane's column. -->
    <Teleport to="body">
      <NetworkForm v-if="editorOpen" :network="editorNetwork" @close="editorOpen = false" />
    </Teleport>

    <!-- The category's registry rows (the quit message), as Uploads embeds its own. -->
    <RegistryPane category-id="networks" embedded />
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import draggable from 'vuedraggable';
import RegistryPane from './RegistryPane.vue';
import NetworkForm from '../NetworkForm.vue';
import { useNetworksStore } from '../../stores/networks.js';
import type { Network } from '../../stores/networks.js';
import { GripVerticalIcon } from '@lucide/vue';

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

// The getter copies the array so the watch tracks its length and every slot:
// the store adds and removes networks IN PLACE (push / splice), which a watch
// on the array's identity never saw, so a network added from this pane's own
// button did not appear in the list above it.
watch(() => [...networks.networks], syncFromStore, { immediate: true });

const error = ref('');

// Local, not the chat views' network-editor store: nothing in Settings mounts
// the form that store drives.
const editorOpen = ref(false);
const editorNetwork = ref<Network | null>(null);

function openEditor(net: Network | null) {
  editorNetwork.value = net;
  editorOpen.value = true;
}

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
  /* A flex row: grip, name, the host taking the slack, then the blocked tag
     (when there is one) and the edit button at the far edge. */
  display: flex;
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
  flex: 1;
  min-width: 0;
  color: var(--fg-muted);
}
/* A network the instance admin's network restriction has taken out of service
   (#298). Dimmed to read as inert, but still draggable and still deletable — the
   row is the user's, only the connection is refused. */
.network.blocked .name,
.network.blocked .host {
  opacity: 0.55;
}
.add-row {
  margin: var(--space-4) 0 0;
}
.blocked-tag {
  margin-left: auto;
  color: var(--warn);
  white-space: nowrap;
}
.drag-ghost {
  opacity: 0.4;
  background: var(--bg-soft);
}
</style>
