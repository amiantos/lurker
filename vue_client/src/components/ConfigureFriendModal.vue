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

      <fieldset class="targets-field">
        <legend>Watch nicks</legend>
        <p v-if="!networks.networks.length" class="meta">Add a network first to watch a friend.</p>
        <template v-else>
          <div v-for="(row, i) in rows" :key="row.key" class="target-row">
            <select v-model.number="row.networkId" class="net-select" aria-label="Network">
              <option v-for="n in networks.networks" :key="n.id" :value="n.id">
                {{ n.name }}
              </option>
            </select>
            <input v-model="row.nick" type="text" class="nick-input" placeholder="nick" />
            <label class="primary-toggle" title="Open this DM when the friend is clicked">
              <input
                type="radio"
                name="primary-target"
                :value="row.key"
                v-model.number="primaryKey"
              />
              <span>primary</span>
            </label>
            <button
              type="button"
              class="row-remove"
              title="Remove nick"
              aria-label="Remove nick"
              @click="removeRow(i)"
            >
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <button type="button" class="add-row" @click="addRow">
            <i class="fa-solid fa-plus"></i> Add nick
          </button>
          <p class="meta">The primary nick is the DM that opens when you click the friend.</p>
        </template>
      </fieldset>

      <label class="notify">
        <input v-model="notifyOnline" type="checkbox" />
        <span>Notify me when they come online</span>
      </label>

      <p class="meta">
        Due to differences in network support for MONITOR and AWAY, presence tracking may be
        unreliable. Away state tracking depends on sharing a channel with your friend.
      </p>

      <div class="actions">
        <button
          v-if="isEditing"
          type="button"
          class="btn-secondary danger remove"
          @click="onDelete"
        >
          Remove
        </button>
        <button type="button" class="btn-secondary" @click="onClose">Cancel</button>
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

// A repeater of (network, nick) rows so a friend can have multiple nicks on one
// network (alts/ghosts) or across networks. Each row has a stable `key` so the
// primary selection survives add/remove. Seed from the contact being edited,
// the nick we were opened on, or one blank row on the first network.
interface TargetRow {
  key: number;
  networkId: number;
  nick: string;
}
let keySeq = 0;
const nextKey = () => (keySeq += 1);
const firstNetworkId = networks.networks[0]?.id ?? 0;

function seedRows(): TargetRow[] {
  if (editorContact && editorContact.targets.length) {
    return editorContact.targets.map((t) => ({
      key: nextKey(),
      networkId: t.networkId,
      nick: t.nick,
    }));
  }
  if (prefill) return [{ key: nextKey(), networkId: prefill.networkId, nick: prefill.nick }];
  return networks.networks.length ? [{ key: nextKey(), networkId: firstNetworkId, nick: '' }] : [];
}
const rows = reactive<TargetRow[]>(seedRows());

const displayName = ref(editorContact?.displayName ?? prefill?.nick ?? '');
const notifyOnline = ref(editorContact?.notifyOnline ?? false);

// Primary tracked by row key (not index) so it doesn't drift on add/remove.
const seededPrimaryIdx = editorContact ? editorContact.targets.findIndex((t) => t.isPrimary) : -1;
const primaryKey = ref<number>(
  (seededPrimaryIdx >= 0 ? rows[seededPrimaryIdx]?.key : undefined) ?? rows[0]?.key ?? 0,
);

const canSave = computed(
  () => !!displayName.value.trim() && rows.some((r) => r.networkId && r.nick.trim()),
);

function addRow() {
  const row = {
    key: nextKey(),
    networkId: networks.networks[0]?.id ?? 0,
    nick: '',
  };
  rows.push(row);
  if (!rows.some((r) => r.key === primaryKey.value)) primaryKey.value = row.key;
}
function removeRow(i: number) {
  rows.splice(i, 1);
  if (!rows.some((r) => r.key === primaryKey.value)) primaryKey.value = rows[0]?.key ?? 0;
}

function confirm() {
  if (!canSave.value) return;
  const primaryRow = rows.find((r) => r.key === primaryKey.value);
  const tgts = rows
    .filter((r) => r.networkId && r.nick.trim())
    .map((r) => ({
      networkId: r.networkId,
      nick: r.nick.trim(),
      isPrimary: r === primaryRow,
    }));
  // If the chosen primary row was left blank it's filtered out above, so no
  // target carries the flag — the server then promotes the first to primary
  // (setContact's `wanted ?? cleaned[0]`), so we don't re-assert it here.
  friends.saveContact({
    contactId: editorContact?.id ?? null,
    displayName: displayName.value.trim(),
    notifyOnline: notifyOnline.value,
    targets: tgts,
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
  /* A friend can have many watch nicks; on the full-height mobile sheet (and a
     short desktop window) let the form scroll inside the card instead of
     overflowing it and pushing Save out of reach. */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
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
.targets-field {
  border: 1px solid var(--border);
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.targets-field legend {
  color: var(--fg-muted);
  padding: 0 var(--space-2);
}
.target-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.net-select {
  background: var(--bg-soft);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: var(--space-3) var(--space-4);
  font: inherit;
  min-width: 8em;
}
.nick-input {
  flex: 1;
  min-width: 0;
}
.primary-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  cursor: pointer;
  white-space: nowrap;
}
.row-remove {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.row-remove:hover {
  color: var(--bad);
}
.add-row {
  align-self: flex-start;
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
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
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-4);
  margin-top: var(--space-2);
}
/* Push Remove to the far left, away from Cancel/Save, so the destructive action
   isn't adjacent to the positive ones. */
.actions .remove {
  margin-right: auto;
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

/* The four target controls don't fit one line on a phone (the network select's
   8em min + the "primary" label + the nick input + the remove button overflow
   the sheet). Lay them out as a 2x2 grid: network + nick on top, the primary
   selector and remove button beneath. min-width:0 lets the select shrink into
   its track instead of forcing a wider-than-screen row. */
@media (max-width: 768px) {
  .target-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-areas:
      'net  nick'
      'prim remove';
    align-items: center;
    column-gap: var(--space-4);
    row-gap: var(--space-3);
  }
  .net-select {
    grid-area: net;
    min-width: 0;
  }
  .nick-input {
    grid-area: nick;
  }
  .primary-toggle {
    grid-area: prim;
  }
  .row-remove {
    grid-area: remove;
    justify-self: end;
  }
}
</style>
