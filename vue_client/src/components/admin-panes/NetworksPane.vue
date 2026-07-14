<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Admin: the networks this instance recommends, plus the lockdown (#298).
  Modelled on UploadersPane — two independent knobs: a list of presets, and a
  checkbox deciding whether users may go anywhere else.
-->

<template>
  <section class="settings-pane">
    <h2>Networks</h2>
    <p class="section-desc">
      Networks you list here are pinned to the top of every user’s network picker, with their
      recommended channels pre-checked during first-run setup.
    </p>

    <p v-if="store.error" class="error">{{ store.error }}</p>

    <ul v-if="store.networkPresets.length" class="rows">
      <li v-for="preset in store.networkPresets" :key="preset.id" class="row">
        <div class="row-main">
          <span class="row-name">{{ preset.name }}</span>
          <span class="row-host">
            {{ preset.host }}:{{ preset.port }}{{ preset.tls ? ' · TLS' : '' }}
            {{ preset.saslLikelyRequired ? ' · account required' : '' }}
          </span>
          <span v-if="preset.channels.length" class="row-channels">
            {{ preset.channels.join(', ') }}
          </span>
          <span v-else class="row-channels muted">no recommended channels</span>
        </div>
        <div class="row-actions">
          <label class="check">
            <input
              type="checkbox"
              :checked="preset.enabled"
              :disabled="busy"
              @change="toggleEnabled(preset)"
            />
            <span>Offered</span>
          </label>
          <button type="button" class="link danger" :disabled="busy" @click="remove(preset)">
            Delete
          </button>
        </div>
      </li>
    </ul>
    <p v-else-if="store.networksLoaded" class="muted small">
      No networks listed — users see the built-in catalogue of public networks.
    </p>

    <form class="add" @submit.prevent="add">
      <h3>Add a network</h3>
      <div class="grid">
        <label>
          <span>Name</span>
          <input v-model="draft.name" placeholder="Our IRC" required />
        </label>
        <label>
          <span>Host</span>
          <input v-model="draft.host" placeholder="irc.example.org" required />
        </label>
        <label class="port">
          <span>Port</span>
          <input v-model.number="draft.port" type="number" min="1" max="65535" />
        </label>
      </div>
      <label>
        <span>Recommended channels</span>
        <input v-model="draft.channels" placeholder="#general, #random" />
        <small>Comma-separated. Pre-checked for new users during setup.</small>
      </label>
      <label class="check">
        <input v-model="draft.tls" type="checkbox" />
        <span>TLS</span>
      </label>
      <label class="check">
        <input v-model="draft.saslLikelyRequired" type="checkbox" />
        <span>Requires an account (prompt users for SASL credentials)</span>
      </label>
      <button type="submit" class="btn-primary" :disabled="busy">Add network</button>
    </form>

    <label class="policy check">
      <input
        type="checkbox"
        :checked="!store.allowUserDefinedNetworks"
        :disabled="
          busy || (!store.networkPresets.some((p) => p.enabled) && store.allowUserDefinedNetworks)
        "
        @change="togglePolicy"
      />
      <span>
        Only let users connect to the networks listed above. Turning this on hides the built-in
        catalogue and the “enter details manually” option. Networks people already added to hosts
        that aren’t listed will stop connecting — nothing is deleted, and they come straight back if
        you turn this off or add the host above.
      </span>
    </label>
    <p v-if="!store.networkPresets.some((p) => p.enabled)" class="muted small">
      Add at least one network before you can restrict users to the listed ones.
    </p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useAdminStore, type AdminNetworkPreset } from '../../stores/admin.js';

const store = useAdminStore();
const busy = ref(false);

const draft = reactive({
  name: '',
  host: '',
  port: 6697,
  tls: true,
  saslLikelyRequired: false,
  channels: '',
});

onMounted(() => {
  if (!store.networksLoaded) store.fetchNetworkPresets().catch(() => {});
});

// The server owns every rule here (can't lock down with no presets, can't delete
// the last one while locked down), so a rejected write must not leave the UI
// showing the attempt. Every action refetches, and errors land in store.error.
async function run(fn: () => Promise<void>): Promise<void> {
  busy.value = true;
  try {
    await fn();
  } catch {
    // store.error is already set by the action.
  } finally {
    busy.value = false;
  }
}

async function add(): Promise<void> {
  await run(async () => {
    await store.createNetworkPreset({
      name: draft.name.trim(),
      host: draft.host.trim(),
      port: draft.port,
      tls: draft.tls,
      saslLikelyRequired: draft.saslLikelyRequired,
      channels: draft.channels
        .split(/[,\s]+/)
        .map((c) => c.trim())
        .filter(Boolean),
      enabled: true,
    });
    draft.name = '';
    draft.host = '';
    draft.port = 6697;
    draft.tls = true;
    draft.saslLikelyRequired = false;
    draft.channels = '';
  });
}

async function toggleEnabled(preset: AdminNetworkPreset): Promise<void> {
  await run(() => store.updateNetworkPreset(preset.id, { enabled: !preset.enabled }));
}

async function remove(preset: AdminNetworkPreset): Promise<void> {
  if (!confirm(`Remove "${preset.name}" from the recommended networks?`)) return;
  await run(() => store.deleteNetworkPreset(preset.id));
}

async function togglePolicy(): Promise<void> {
  await run(() => store.setAllowUserDefinedNetworks(!store.allowUserDefinedNetworks));
}
</script>

<style scoped>
.rows {
  list-style: none;
  margin: 0 0 var(--space-6);
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.row-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.row-name {
  color: var(--fg);
}
.row-host,
.row-channels {
  color: var(--fg-muted);
}
.row-actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-shrink: 0;
}
.add {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-6);
}
.add h3 {
  margin: 0;
}
.grid {
  display: flex;
  gap: var(--space-4);
  align-items: end;
}
.grid label {
  flex: 1;
  min-width: 0;
}
.grid .port {
  flex: 0 0 90px;
}
label {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--fg-muted);
}
label input {
  color: var(--fg);
  width: 100%;
  box-sizing: border-box;
}
label small {
  color: var(--fg-muted);
}
.check {
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
}
.check input {
  width: auto;
}
.policy {
  align-items: flex-start;
  gap: var(--space-4);
}
.link.danger {
  background: transparent;
  border: 0;
  padding: 0;
  color: var(--bad);
  cursor: pointer;
}
.link.danger:hover {
  text-decoration: underline;
}
.error {
  color: var(--bad);
}
.muted {
  color: var(--fg-muted);
}
</style>
