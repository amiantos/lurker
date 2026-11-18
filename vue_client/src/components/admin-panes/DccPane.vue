<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel → DCC (#1080, #1125). The instance's DCC settings, and per user:
  which parts of DCC they may use (chat, receiving files and sending them
  (#1086), granted separately so an admin can allow direct chats without letting
  files land on the box), a storage limit, and what their files take now. Every part also needs
  LURKER_DCC_ENABLED. With it off the grants still list, so an admin can clear
  them before turning DCC back on.

  The table is read-only. "edit" opens one user's grants and limit in a modal,
  with one save for all of them. (It used to turn the row's own cells into
  controls, with every column sized to hold both its text and its control.)
-->

<template>
  <section id="admin-dcc" class="settings-pane">
    <h2>dcc</h2>
    <p class="section-desc">
      Direct connections between people on IRC: chats, and files sent to and from this server.
    </p>
    <p v-if="loadError" class="error inline">{{ loadError }}</p>

    <template v-if="info">
      <p v-if="!info.enabled" class="muted small">
        DCC is off for this instance. Set <code>LURKER_DCC_ENABLED</code> to turn it on; until then
        the settings below do nothing.
      </p>
      <table v-else class="facts">
        <tbody>
          <tr>
            <th scope="row">Files saved under</th>
            <td>
              <code v-if="info.directory">{{ info.directory }}</code>
              <span v-else class="warn">
                not set — set <code>LURKER_DCC_DIR</code>, or nothing can be received
              </span>
            </td>
          </tr>
          <tr>
            <th scope="row">Largest file</th>
            <td>{{ info.maxFileBytes ? formatBytes(info.maxFileBytes) : 'no limit' }}</td>
          </tr>
          <tr>
            <th scope="row">Peers on private networks</th>
            <td>{{ info.allowPrivateHosts ? 'allowed' : 'blocked' }}</td>
          </tr>
          <tr>
            <th scope="row">Free-disk floor</th>
            <td>{{ formatBytes(info.freeDiskFloorBytes) }}</td>
          </tr>
        </tbody>
      </table>

      <table class="users">
        <thead>
          <tr>
            <th scope="col">user</th>
            <th scope="col">chat</th>
            <th scope="col">receive</th>
            <th scope="col">send</th>
            <th scope="col">limit</th>
            <th scope="col">used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in info.users" :key="u.id">
            <th scope="row">{{ u.username }}</th>
            <td>{{ u.chat ? 'on' : '—' }}</td>
            <td>{{ u.receive ? 'on' : '—' }}</td>
            <td>{{ u.send ? 'on' : '—' }}</td>
            <td>{{ u.limitBytes === null ? 'none' : formatBytes(u.limitBytes) }}</td>
            <td>{{ u.usedBytes ? formatBytes(u.usedBytes) : '—' }}</td>
            <td class="act">
              <span class="btn-bar">
                <button :disabled="busy" @click="startEdit(u)">edit</button>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted small">
        Turning a part off stops what starts next. Anything already running finishes, and files
        already received stay theirs to download.
      </p>
      <p class="muted small">
        Users delete their own files in the DCC window to make room under a limit. Files they upload
        to send count against it too.
      </p>
    </template>
    <p v-else-if="!loadError" class="muted small">Loading…</p>

    <FormModal
      v-if="editing && editingUser && info"
      word="dcc"
      size="sm"
      :title="`dcc for ${editingUser.username}`"
      :busy="busy"
      :error="editError"
      @submit="save(editingUser)"
      @close="cancelEdit"
    >
      <div class="grant-form">
        <!-- With DCC off for the instance, a part can be taken away but not
             given. -->
        <label class="ck">
          <input
            v-model="editing.chat"
            type="checkbox"
            :disabled="busy || (!info.enabled && !editingUser.chat)"
          />
          <span>Chat</span>
        </label>
        <label class="ck">
          <input
            v-model="editing.receive"
            type="checkbox"
            :disabled="busy || (!info.enabled && !editingUser.receive)"
          />
          <span>Receive files</span>
        </label>
        <label class="ck">
          <input
            v-model="editing.send"
            type="checkbox"
            :disabled="busy || (!info.enabled && !editingUser.send)"
          />
          <span>Send files</span>
        </label>
        <label class="field">
          <span>Storage limit (GB)</span>
          <input
            v-model="editing.limit"
            class="limit"
            type="number"
            step="any"
            placeholder="none"
            :disabled="busy"
          />
          <span class="muted">
            Blank for no limit. Using
            {{ editingUser.usedBytes ? formatBytes(editingUser.usedBytes) : 'nothing' }} now.
          </span>
        </label>
      </div>
    </FormModal>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '../../api.js';
import { formatBytes } from '../../utils/formatBytes.js';
import FormModal from '../FormModal.vue';

interface DccUser {
  id: number;
  username: string;
  chat: boolean;
  receive: boolean;
  send: boolean;
  /** Null for no limit (#1125). */
  limitBytes: number | null;
  usedBytes: number;
}
interface DccInfo {
  enabled: boolean;
  directory: string | null;
  maxFileBytes: number;
  allowPrivateHosts: boolean;
  freeDiskFloorBytes: number;
  users: DccUser[];
}

const GB = 1024 * 1024 * 1024;

const info = ref<DccInfo | null>(null);
const loadError = ref('');
const busy = ref(false);
// The one user being edited, and what the modal holds. `limit` is in GB, ''
// for none.
const editing = ref<{
  id: number;
  chat: boolean;
  receive: boolean;
  send: boolean;
  limit: string;
} | null>(null);
const editError = ref('');
const editingUser = computed(
  () => info.value?.users.find((u) => u.id === editing.value?.id) ?? null,
);

onMounted(async () => {
  try {
    info.value = await api<DccInfo>('/api/admin/dcc');
  } catch (e: any) {
    loadError.value = e?.message || 'failed to load DCC settings';
  }
});

// Enough precision that a small limit never reads as 0.
function limitGb(bytes: number | null): string {
  return bytes === null ? '' : String(Number((bytes / GB).toPrecision(6)));
}

function startEdit(u: DccUser) {
  editError.value = '';
  editing.value = {
    id: u.id,
    chat: u.chat,
    receive: u.receive,
    send: u.send,
    limit: limitGb(u.limitBytes),
  };
}

function cancelEdit() {
  editing.value = null;
  editError.value = '';
}

async function save(u: DccUser) {
  const draft = editing.value;
  if (!draft) return;
  // v-model on a number input hands back a number, or '' when it's empty.
  const raw = String(draft.limit).trim();
  const gb = Number(raw);
  if (raw !== '' && !(Number.isFinite(gb) && gb > 0)) {
    editError.value = 'a limit is a number of GB above 0, or blank for none';
    return;
  }
  editError.value = '';
  busy.value = true;
  try {
    const next = await api<{
      chat: boolean;
      receive: boolean;
      send: boolean;
      limitBytes: number | null;
    }>(`/api/admin/dcc/users/${u.id}`, {
      method: 'PUT',
      body: {
        chat: draft.chat,
        receive: draft.receive,
        send: draft.send,
        limitBytes: raw === '' ? null : Math.max(1, Math.round(gb * GB)),
      },
    });
    u.chat = next.chat;
    u.receive = next.receive;
    u.send = next.send;
    u.limitBytes = next.limitBytes;
    editing.value = null;
  } catch (e: any) {
    // The modal stays open with what was typed: nothing changed.
    editError.value = e?.message || 'failed to save';
  } finally {
    busy.value = false;
  }
}
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
code {
  color: var(--fg);
  overflow-wrap: anywhere;
}
.facts,
.users {
  margin: var(--space-6) 0;
  border-collapse: collapse;
}
.facts th,
.facts td,
.users th,
.users td {
  text-align: left;
  font-weight: normal;
  vertical-align: top;
}
.facts th,
.facts td {
  padding: var(--space-1) var(--space-6) var(--space-1) 0;
}
.facts th,
.users thead th {
  color: var(--fg-muted);
}
/* Rows separated like the Users list (panes.css .device): a line between
   entries, the same padding, the same hover. */
.users {
  width: 100%;
}
.users th,
.users td {
  padding: var(--space-3) var(--space-6) var(--space-3) 0;
}
.users thead th {
  border-bottom: 1px solid var(--border);
}
.users tbody tr + tr {
  border-top: 1px solid var(--border);
}
.users tbody tr:hover {
  background: var(--bg-soft);
}
.users tbody th {
  color: var(--fg);
}
.users tbody th,
.users tbody td {
  vertical-align: middle;
  white-space: nowrap;
}
.users .act {
  width: 1%;
  padding-right: 0;
  text-align: right;
}
.grant-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.ck {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  cursor: pointer;
}
.ck input {
  margin: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.field .limit {
  width: 10em;
}
.warn {
  color: var(--warn);
}
</style>
