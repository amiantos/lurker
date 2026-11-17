<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel → DCC (#1080, #1125). The instance's DCC settings, and per user:
  which parts of DCC they may use (chat, receiving files and sending them
  (#1086), granted separately so an admin can allow direct chats without letting
  files land on the box), a storage limit, and what their files take now. Every part also needs
  LURKER_DCC_ENABLED. With it off the grants still list, so an admin can clear
  them before turning DCC back on.

  The rows are text until "edit", which turns that row's cells into controls
  under their own headers, with one save for the row and a "saved" after. The
  columns are sized for both, so editing moves nothing.
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

      <p v-if="editError" class="error inline">{{ editError }}</p>
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
          <!-- "edit" turns the row's own cells into controls, each under its
               header; nothing saves until "save" (or Enter), and Escape puts
               the row back. Every column is wide enough for both its text and
               its control, so editing moves nothing. -->
          <tr
            v-for="u in info.users"
            :key="u.id"
            :class="{ editing: editing?.id === u.id }"
            @keydown.esc="cancelEdit"
          >
            <th scope="row">{{ u.username }}</th>
            <template v-if="editing?.id === u.id">
              <!-- With DCC off for the instance, a part can be taken away but
                   not given. -->
              <td class="ctl">
                <input
                  v-model="editing.chat"
                  type="checkbox"
                  :aria-label="`chat for ${u.username}`"
                  :disabled="busy || (!info.enabled && !u.chat)"
                  @keydown.enter.prevent="save(u)"
                />
              </td>
              <td class="ctl">
                <input
                  v-model="editing.receive"
                  type="checkbox"
                  :aria-label="`receive files for ${u.username}`"
                  :disabled="busy || (!info.enabled && !u.receive)"
                  @keydown.enter.prevent="save(u)"
                />
              </td>
              <td class="ctl">
                <input
                  v-model="editing.send"
                  type="checkbox"
                  :aria-label="`send files for ${u.username}`"
                  :disabled="busy || (!info.enabled && !u.send)"
                  @keydown.enter.prevent="save(u)"
                />
              </td>
              <td class="ctl">
                <input
                  v-model="editing.limit"
                  class="limit"
                  type="number"
                  step="any"
                  placeholder="none"
                  title="In GB. Blank for no limit."
                  :aria-label="`storage limit in GB for ${u.username}`"
                  :disabled="busy"
                  @keydown.enter.prevent="save(u)"
                />
                GB
              </td>
              <td>{{ u.usedBytes ? formatBytes(u.usedBytes) : '—' }}</td>
              <td class="act">
                <span class="btn-bar">
                  <button :disabled="busy" @click="save(u)">save</button>
                  <button :disabled="busy" @click="cancelEdit">cancel</button>
                </span>
              </td>
            </template>
            <template v-else>
              <td>{{ u.chat ? 'on' : '—' }}</td>
              <td>{{ u.receive ? 'on' : '—' }}</td>
              <td>{{ u.send ? 'on' : '—' }}</td>
              <td>{{ u.limitBytes === null ? 'none' : formatBytes(u.limitBytes) }}</td>
              <td>{{ u.usedBytes ? formatBytes(u.usedBytes) : '—' }}</td>
              <td class="act">
                <span v-if="savedFor === u.id" class="muted" role="status">saved</span>
                <span v-else class="btn-bar">
                  <button :disabled="busy" @click="startEdit(u)">edit</button>
                </span>
              </td>
            </template>
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
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../../api.js';
import { formatBytes } from '../../utils/formatBytes.js';

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
// The one row being edited, and what its editor holds. `limit` is in GB, ''
// for none.
const editing = ref<{
  id: number;
  chat: boolean;
  receive: boolean;
  send: boolean;
  limit: string;
} | null>(null);
const editError = ref('');
// The row that just saved, for a moment of "saved".
const savedFor = ref<number | null>(null);
let savedTimer: ReturnType<typeof setTimeout> | undefined;

onMounted(async () => {
  try {
    info.value = await api<DccInfo>('/api/admin/dcc');
  } catch (e: any) {
    loadError.value = e?.message || 'failed to load DCC settings';
  }
});
onUnmounted(() => clearTimeout(savedTimer));

// Enough precision that a small limit never reads as 0.
function limitGb(bytes: number | null): string {
  return bytes === null ? '' : String(Number((bytes / GB).toPrecision(6)));
}

function startEdit(u: DccUser) {
  editError.value = '';
  savedFor.value = null;
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
    savedFor.value = u.id;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      if (savedFor.value === u.id) savedFor.value = null;
    }, 2000);
  } catch (e: any) {
    // The row stays in edit with what was typed: nothing changed.
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
/* Every row is as tall as a row of controls, so going into edit moves
   nothing. An input is its line of text plus 4px padding and a 1px border
   each side (main.css), so a text cell carries those 5px as padding instead,
   and a cell holding a control (.ctl) gets the plain padding. */
.users tbody th,
.users tbody td {
  padding-block: calc(var(--space-3) + 5px);
  vertical-align: middle;
}
.users tbody td.ctl {
  padding-block: var(--space-3);
}
/* Sized for both a column's text and its control, so a row going into edit
   moves nothing: a checkbox or "on", the limit field or "50.00 GB", and
   "save · cancel" or "edit". */
.users td:nth-of-type(1),
.users td:nth-of-type(2) {
  width: 5em;
}
.users td:nth-of-type(3) {
  width: 10em;
  white-space: nowrap;
}
.users .act {
  width: 10em;
  padding-right: 0;
  text-align: right;
  white-space: nowrap;
}
.users input[type='checkbox'] {
  margin: 0;
}
.users .limit {
  width: 6em;
}
.users tr.editing {
  background: var(--bg-soft);
}
.warn {
  color: var(--warn);
}
</style>
