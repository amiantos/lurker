<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="friend" :title="title" size="md" @close="onClose">
    <form class="body" @submit.prevent="confirm">
      <label class="field">
        <span class="label">Display name</span>
        <input v-model="displayName" type="text" maxlength="128" placeholder="e.g. Darc" />
      </label>

      <fieldset class="networks">
        <legend>Watch on</legend>
        <p v-if="!rows.length" class="meta">Add a network first to watch a friend.</p>
        <div v-for="row in rows" :key="row.networkId" class="net-row">
          <label class="net-toggle">
            <input v-model="row.enabled" type="checkbox" />
            <span class="net-name">{{ row.name }}</span>
          </label>
          <input
            v-model="row.nick"
            type="text"
            class="net-nick"
            :disabled="!row.enabled"
            placeholder="nick on this network"
          />
          <label class="net-primary" :class="{ dim: !row.enabled }" title="Open this DM on click">
            <input
              v-model="primaryNetworkId"
              type="radio"
              name="primary-net"
              :value="row.networkId"
              :disabled="!row.enabled"
            />
            <span>primary</span>
          </label>
        </div>
        <p class="meta">The primary network is the DM that opens when you click the friend.</p>
      </fieldset>

      <label class="notify">
        <input v-model="notifyOnline" type="checkbox" />
        <span>Notify me when they come online</span>
      </label>

      <p class="meta">
        Presence shows in real time on networks that support MONITOR; elsewhere it updates when you
        share a channel.
      </p>

      <div class="actions">
        <button type="button" class="btn-secondary" @click="onClose">Cancel</button>
        <button v-if="isEditing" type="button" class="btn-secondary danger" @click="onDelete">
          Remove
        </button>
        <button type="submit" class="btn-primary" :disabled="!canSave">Save</button>
      </div>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import AppModal from './AppModal.vue';
import { useFriendsStore } from '../stores/friends.js';
import { useNetworksStore } from '../stores/networks.js';

const friends = useFriendsStore();
const networks = useNetworksStore();

const editorContact = friends.editor.contact;
const prefill = friends.editor.prefill;
const isEditing = computed(() => editorContact != null);
const title = computed(() => (isEditing.value ? 'Edit friend' : 'Add friend'));

// Seed the form from the contact being edited, or from the nick we were opened
// on. Each network gets a row; a row is "watched" when its checkbox is on and
// it carries a nick.
interface NetRow {
  networkId: number;
  name: string;
  enabled: boolean;
  nick: string;
}
const rows = reactive<NetRow[]>(
  networks.networks.map((n) => {
    const fromContact = editorContact?.targets.find((t) => t.networkId === n.id);
    const fromPrefill = prefill && prefill.networkId === n.id ? prefill.nick : '';
    const nick = fromContact?.nick ?? fromPrefill ?? '';
    return { networkId: n.id, name: n.name, enabled: !!nick, nick };
  }),
);

const displayName = ref(editorContact?.displayName ?? prefill?.nick ?? '');
const notifyOnline = ref(editorContact?.notifyOnline ?? false);
// Which network's DM opens on click. Seed from the existing primary, else the
// nick we were opened on, else the first watched network.
const primaryNetworkId = ref<number | null>(
  editorContact?.targets.find((t) => t.isPrimary)?.networkId ?? prefill?.networkId ?? null,
);

const targets = computed(() =>
  rows
    .filter((r) => r.enabled && r.nick.trim())
    .map((r) => ({ networkId: r.networkId, nick: r.nick.trim() })),
);
const canSave = computed(() => !!displayName.value.trim() && targets.value.length > 0);

function confirm() {
  if (!canSave.value) return;
  // Resolve the primary to an actually-watched target (the chosen one may have
  // been unchecked); fall back to the first. The server defaults too.
  const tgts = targets.value;
  const primaryNetworkIdResolved =
    tgts.find((t) => t.networkId === primaryNetworkId.value)?.networkId ??
    tgts[0]?.networkId ??
    null;
  friends.saveContact({
    contactId: editorContact?.id ?? null,
    displayName: displayName.value.trim(),
    notifyOnline: notifyOnline.value,
    targets: tgts,
    primaryNetworkId: primaryNetworkIdResolved,
  });
  friends.closeEditor();
}

function onDelete() {
  if (editorContact) friends.removeContact(editorContact.id);
  friends.closeEditor();
}

function onClose() {
  friends.closeEditor();
}
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.label {
  color: var(--fg-muted);
}
input[type='text'] {
  background: var(--bg-soft);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: var(--space-3) var(--space-4);
  font: inherit;
}
input[type='text']:focus {
  outline: 1px solid var(--accent);
}
input[type='text']:disabled {
  opacity: 0.5;
}
.networks {
  border: 1px solid var(--border);
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.networks legend {
  color: var(--fg-muted);
  padding: 0 var(--space-2);
}
.net-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.net-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 9em;
  cursor: pointer;
}
.net-nick {
  flex: 1;
}
.net-primary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  cursor: pointer;
  white-space: nowrap;
}
.net-primary.dim {
  opacity: 0.4;
}
.notify {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
}
.meta {
  margin: 0;
  color: var(--fg-muted);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-4);
  margin-top: var(--space-2);
}
.btn-primary,
.btn-secondary {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg);
  padding: var(--space-3) var(--space-6);
  cursor: pointer;
  font: inherit;
}
.btn-primary {
  border-color: var(--accent);
  color: var(--accent);
}
.btn-primary:disabled {
  opacity: 0.4;
  cursor: default;
}
.btn-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}
.btn-secondary:hover {
  background: var(--bg-soft);
}
.btn-secondary.danger {
  color: var(--bad);
  border-color: var(--bad);
}
.btn-secondary.danger:hover {
  background: color-mix(in srgb, var(--bad) 15%, transparent);
}
</style>
