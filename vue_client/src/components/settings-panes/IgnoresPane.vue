<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <section id="ignores" class="settings-pane">
    <h2>ignores</h2>
    <p class="section-desc">
      Plain nicks match the sender's nick on that network. Hostmasks
      (<code>nick!user@host</code>, with <code>*</code> wildcards) match
      against the IRC user@host so they survive nick changes. Messages,
      joins, parts, and quits from any matching identity are hidden in
      every client; remove an entry to reveal the history again.
    </p>
    <p v-if="!ignoreGroups.length" class="muted small">
      No ignores yet. Right-click a nick in the member list, or type
      <code>/ignore &lt;nick&gt;</code> in any buffer.
    </p>
    <template v-for="group in ignoreGroups" :key="group.networkId">
      <h3 class="subhead">{{ group.networkName }}</h3>
      <ul class="device-list">
        <li
          v-for="entry in group.masks"
          :key="entry.mask"
          class="device"
        >
          <span class="ua">{{ entry.mask }}</span>
          <button
            class="link danger"
            @click="onIgnoreRemove(group.networkId, entry.mask)"
          >remove</button>
        </li>
      </ul>
    </template>
    <h3 v-if="ignoreNetworkOptions.length" class="subhead">add</h3>
    <div class="rule-add" v-if="ignoreNetworkOptions.length">
      <select v-model="newIgnoreNetworkId">
        <option :value="null" disabled>network…</option>
        <option v-for="opt in ignoreNetworkOptions" :key="opt.id" :value="opt.id">{{ opt.name }}</option>
      </select>
      <input
        v-model="newIgnoreMask"
        type="text"
        placeholder="nick or nick!user@host"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        @keydown.enter="onIgnoreAdd"
      />
      <button
        class="link"
        :disabled="!newIgnoreNetworkId || !newIgnoreMask.trim()"
        @click="onIgnoreAdd"
      >add</button>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { useNetworksStore } from '../../stores/networks.js';
import { useIgnoresStore } from '../../stores/ignores.js';

const networksStore = useNetworksStore();
const ignoresStore = useIgnoresStore();

// Per-network ignore lists, sorted by network name. Each entry is
// { networkId, networkName, masks: [{mask, createdAt}, ...] }. We render
// only networks that actually have entries (no empty groups); the add form
// lets users pick any network they own.
const ignoreGroups = computed(() => {
  const byNet = new Map();
  for (const entry of ignoresStore.allEntries) {
    const list = byNet.get(entry.networkId);
    if (list) list.push({ mask: entry.mask, createdAt: entry.createdAt });
    else byNet.set(entry.networkId, [{ mask: entry.mask, createdAt: entry.createdAt }]);
  }
  const groups = [];
  for (const [networkId, masks] of byNet) {
    groups.push({
      networkId,
      networkName: networksStore.networkById(networkId)?.name || `net:${networkId}`,
      masks,
    });
  }
  return groups.sort((a, b) => a.networkName.localeCompare(b.networkName));
});

const ignoreNetworkOptions = computed(() => {
  return (networksStore.networks || [])
    .map((n) => ({ id: n.id, name: n.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

const newIgnoreNetworkId = ref(null);
const newIgnoreMask = ref('');

watch(
  ignoreNetworkOptions,
  (opts) => {
    if (opts.length === 1) {
      newIgnoreNetworkId.value = opts[0].id;
    } else if (newIgnoreNetworkId.value
        && !opts.some((o) => o.id === newIgnoreNetworkId.value)) {
      newIgnoreNetworkId.value = null;
    }
  },
  { immediate: true },
);

function onIgnoreAdd() {
  const networkId = Number(newIgnoreNetworkId.value);
  const mask = newIgnoreMask.value.trim();
  if (!networkId || !mask) return;
  ignoresStore.addMask(networkId, mask);
  newIgnoreMask.value = '';
}

function onIgnoreRemove(networkId, mask) {
  ignoresStore.removeMask(networkId, mask);
}
</script>

<style src="./panes.css"></style>
<style scoped>
.rule-add {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
}
.rule-add input[type="text"] { flex: 1; min-width: 200px; }
</style>
