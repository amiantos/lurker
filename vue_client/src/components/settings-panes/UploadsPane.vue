<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Uploads (#514). Two halves in one pane, deliberately:

    • DESTINATION — which configured uploader your files go to, and the personal
      uploaders you've set up (your catbox account, your Zipline, your S3 bucket).
      This is table-backed (uploader_config rows), so it's bespoke.
    • IMAGE PIPELINE — still ordinary registry settings, embedded below via
      RegistryPane rather than re-implemented here.

  This replaces the old `uploads.provider` dropdown + the flat per-provider
  credential fields. Those keys are gone; anything they held was folded into real
  uploaders by the boot migration.
-->

<template>
  <section id="uploads" class="settings-pane">
    <h2>Uploads</h2>
    <p class="section-desc">
      Where pasted and picked files are uploaded. Lurker pastes a link into the message — the file
      itself is hosted by whichever uploader you choose here.
    </p>
    <p v-if="error" class="error inline">{{ error }}</p>

    <h3 class="subhead">destination</h3>
    <p v-if="loading && !loaded" class="muted small">Loading…</p>
    <ul v-else class="device-list">
      <li
        v-for="u in uploaders"
        :key="u.id"
        class="device"
        :class="{ selected: u.id === selectedId }"
      >
        <span class="ua">
          <span class="name">{{ u.label }}</span>
          <span class="driver">{{ u.driver }}</span>
          <span v-if="u.scope === 'user'" class="badge">yours</span>
        </span>
        <button v-if="u.id !== selectedId" class="link" :disabled="busy" @click="onSelect(u.id)">
          use
        </button>
        <span v-else class="muted small">selected</span>
        <!-- Editable AND describable: a row whose driver we have no schema for
             can't be rendered as a form, so offer removal but not editing. -->
        <button
          v-if="u.editable && driverFor(u.driver)"
          class="link"
          :disabled="busy"
          @click="onEdit(u)"
        >
          edit
        </button>
        <button v-if="u.editable" class="link danger" :disabled="busy" @click="onDelete(u)">
          remove
        </button>
      </li>
      <li class="device" :class="{ selected: selectedId === null }">
        <span class="ua">
          <span class="name">Server default</span>
          <span class="driver">follow whatever the admin has set</span>
        </span>
        <button v-if="selectedId !== null" class="link" :disabled="busy" @click="onSelect(null)">
          use
        </button>
        <span v-else class="muted small">selected</span>
      </li>
    </ul>

    <template v-if="editing && editingDriver">
      <h3 class="subhead">edit {{ editing.label }}</h3>
      <UploaderConfigForm
        :key="`edit-${editing.id}`"
        :driver="editingDriver"
        :existing="{
          label: editing.label,
          config: editing.config ?? {},
          secretsSet: editing.secretsSet ?? {},
        }"
        :busy="busy"
        :error="formError"
        @save="onSaveEdit"
        @cancel="closeForms"
      />
    </template>

    <template v-else-if="allowUserDefined && addableDrivers.length">
      <h3 class="subhead">add your own uploader</h3>
      <template v-if="addingDriver">
        <label class="driver-pick">
          <span>Type</span>
          <select v-model="adding" :disabled="busy">
            <option v-for="d in addableDrivers" :key="d.driver" :value="d.driver">
              {{ d.label }}
            </option>
          </select>
        </label>
        <UploaderConfigForm
          :key="`add-${addingDriver.driver}`"
          :driver="addingDriver"
          :busy="busy"
          :error="formError"
          @save="onSaveNew"
          @cancel="closeForms"
        />
      </template>
      <p v-else class="add-row">
        <button class="link" :disabled="busy" @click="adding = addableDrivers[0].driver">
          add an uploader
        </button>
      </p>
    </template>
    <p v-else-if="!allowUserDefined" class="muted small">
      This server doesn’t allow personal uploaders — you can pick from the ones above.
    </p>

    <!-- The rest of the category is still plain registry settings. -->
    <RegistryPane category-id="uploads" embedded :only="['pipeline']" />
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '../../api.js';
import RegistryPane from './RegistryPane.vue';
import UploaderConfigForm from '../UploaderConfigForm.vue';
import type { Uploader, UploaderDriver } from '../../utils/uploaders.js';

const uploaders = ref<Uploader[]>([]);
const drivers = ref<UploaderDriver[]>([]);
const selectedId = ref<number | null>(null);
const allowUserDefined = ref(true);

const loading = ref(false);
const loaded = ref(false);
const busy = ref(false);
const error = ref('');
const formError = ref('');

/** Driver id currently being added (null = the add form is closed). */
const adding = ref<string | null>(null);
const editing = ref<Uploader | null>(null);

function driverFor(id: string): UploaderDriver | undefined {
  return drivers.value.find((d) => d.driver === id);
}

// The "add" menu is the CREATABLE subset — `drivers` also carries the drivers we
// only need in order to describe rows the user already owns (a `hoarder` row
// migrated off the legacy settings is editable but not creatable).
const addableDrivers = computed(() => drivers.value.filter((d) => d.creatable));

// Resolved driver objects, so the template never hands the form an undefined
// driver (which would blow up on `.configSchema`).
const addingDriver = computed(() => (adding.value ? driverFor(adding.value) : undefined));
const editingDriver = computed(() => (editing.value ? driverFor(editing.value.driver) : undefined));

async function refresh() {
  loading.value = true;
  try {
    const data = await api('/api/uploaders');
    uploaders.value = data.uploaders || [];
    drivers.value = data.drivers || [];
    selectedId.value = data.selectedId ?? null;
    allowUserDefined.value = data.allowUserDefined !== false;
    loaded.value = true;
  } catch (e: any) {
    error.value = e.message || 'failed to load uploaders';
  } finally {
    loading.value = false;
  }
}

function closeForms() {
  adding.value = null;
  editing.value = null;
  formError.value = '';
}

async function onSelect(id: number | null) {
  error.value = '';
  busy.value = true;
  try {
    await api('/api/uploaders/selection', { method: 'PUT', body: { id } });
    selectedId.value = id;
  } catch (e: any) {
    error.value = e.message || 'failed to select uploader';
  } finally {
    busy.value = false;
  }
}

function onEdit(u: Uploader) {
  closeForms();
  editing.value = u;
}

async function onSaveNew({ label, values }: { label: string; values: Record<string, string> }) {
  if (!adding.value) return;
  formError.value = '';
  busy.value = true;
  try {
    await api('/api/uploaders', {
      method: 'POST',
      body: { driver: adding.value, label, values },
    });
    closeForms();
    await refresh();
  } catch (e: any) {
    formError.value = e.message || 'failed to add uploader';
  } finally {
    busy.value = false;
  }
}

async function onSaveEdit({ label, values }: { label: string; values: Record<string, string> }) {
  if (!editing.value) return;
  formError.value = '';
  busy.value = true;
  try {
    await api(`/api/uploaders/${editing.value.id}`, { method: 'PATCH', body: { label, values } });
    closeForms();
    await refresh();
  } catch (e: any) {
    formError.value = e.message || 'failed to save uploader';
  } finally {
    busy.value = false;
  }
}

async function onDelete(u: Uploader) {
  if (
    !confirm(
      `Remove ${u.label}? Files you already uploaded through it stay where they are, but Lurker ` +
        `will no longer be able to delete them from the host.`,
    )
  ) {
    return;
  }
  error.value = '';
  busy.value = true;
  try {
    await api(`/api/uploaders/${u.id}`, { method: 'DELETE' });
    closeForms();
    await refresh();
  } catch (e: any) {
    error.value = e.message || 'failed to remove uploader';
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);
</script>

<style src="./panes.css"></style>
<style scoped>
.device.selected {
  border-color: var(--accent);
}

.device .name {
  color: var(--fg);
}

.device .driver {
  color: var(--fg-muted);
}

.badge {
  color: var(--fg-muted);
}

.driver-pick {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
}

.add-row {
  margin: var(--space-2) 0;
}
</style>
