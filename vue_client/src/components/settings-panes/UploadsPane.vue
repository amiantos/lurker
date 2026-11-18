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
    <!-- Three variants, because `allowUserDefined` defaults to true before the fetch
         lands: without the `loaded` gate a hosted user is briefly told they can
         choose an uploader, which isn't true. -->
    <p v-if="!loaded" class="section-desc">
      Where pasted and picked files are uploaded. Lurker pastes a link into the message — the file
      itself is hosted by an uploader, not by Lurker.
    </p>
    <p v-else-if="canChoose" class="section-desc">
      Where pasted and picked files are uploaded. Lurker pastes a link into the message — the file
      itself is hosted by whichever uploader you choose here.
    </p>
    <p v-else class="section-desc">
      Where pasted and picked files are uploaded. Lurker pastes a link into the message — the file
      itself is hosted by
      <strong>{{ soleUploaderLabel }}</strong
      >, which this server provides.
    </p>
    <p v-if="error" class="error inline">{{ error }}</p>

    <!-- The destination picker only exists to make a CHOICE. On the hosted service
         there is exactly one uploader and personal ones are off, so it rendered the
         same destination twice — once as itself and once as "Server default" — and
         asked you to pick between them. Nothing to choose → no chooser; the line
         above says where the files go instead. -->
    <template v-if="canChoose">
      <h3 class="subhead">destination</h3>
      <p v-if="loading && !loaded" class="muted small">Loading…</p>
      <!-- One of these is where files go, so the list IS the control: a radio
           per row. It used to be a "use this one" text button per row and an
           "in use" badge on whichever had been pressed last. Keyed on a tick so
           a refused selection re-renders the radios: the browser has already
           moved the dot by the time the request fails. -->
      <ul
        v-else
        :key="pickTick"
        class="device-list"
        role="radiogroup"
        aria-label="upload destination"
      >
        <li v-for="u in uploaders" :key="u.id" class="device">
          <label class="pick">
            <input
              type="radio"
              name="upload-destination"
              :checked="u.id === selectedId"
              :disabled="busy"
              @change="onSelect(u.id)"
            />
            <span class="ua">
              <span class="name">{{ u.label }}</span>
              <span class="driver">{{ u.driver }}</span>
              <span v-if="u.scope === 'user'" class="badge">yours</span>
            </span>
          </label>
          <!-- Editable AND describable: a row whose driver we have no schema for
               can't be rendered as a form, so offer removal but not editing. -->
          <span v-if="u.editable" class="btn-bar">
            <button v-if="driverFor(u.driver)" :disabled="busy" @click="onEdit(u)">edit</button>
            <button class="bad" :disabled="busy" @click="onDelete(u)">remove</button>
          </span>
        </li>
        <li class="device">
          <label class="pick">
            <input
              type="radio"
              name="upload-destination"
              :checked="selectedId === null"
              :disabled="busy"
              @change="onSelect(null)"
            />
            <span class="ua">
              <span class="name">Server default</span>
              <span class="driver">follow whatever the admin has set</span>
            </span>
          </label>
        </li>
      </ul>
    </template>

    <template v-if="allowUserDefined && addableDrivers.length">
      <!-- #919: the server's catbox row has no edit, and nothing said where a
           userhash goes instead. -->
      <p class="muted small">
        To upload to your own account (a catbox userhash, a Zipline token), add it here. The
        server’s uploaders can’t be edited.
      </p>
      <p class="add-row">
        <button class="btn-secondary" :disabled="busy" @click="onAdd">add uploader</button>
      </p>
    </template>
    <p v-else-if="!allowUserDefined && canChoose" class="muted small">
      This server doesn’t allow personal uploaders — you can pick from the ones above.
    </p>

    <UploaderModal
      v-if="adding"
      :drivers="addableDrivers"
      :busy="busy"
      :error="formError"
      @save="onSaveNew"
      @close="closeForms"
    />
    <UploaderModal
      v-else-if="editing && editingDriver"
      :key="editing.id"
      :drivers="[editingDriver]"
      :existing="{
        label: editing.label,
        config: editing.config ?? {},
        secretsSet: editing.secretsSet ?? {},
      }"
      :busy="busy"
      :error="formError"
      @save="onSaveEdit"
      @close="closeForms"
    />

    <!-- The rest of the category is still plain registry settings. -->
    <RegistryPane category-id="uploads" embedded :only="['pipeline']" />
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '../../api.js';
import RegistryPane from './RegistryPane.vue';
import UploaderModal from '../UploaderModal.vue';
import { hasUploaderChoice } from '../../utils/uploaders.js';
import type { Uploader, UploaderDriver, UploaderDraft } from '../../utils/uploaders.js';

const uploaders = ref<Uploader[]>([]);
const drivers = ref<UploaderDriver[]>([]);
const selectedId = ref<number | null>(null);
const allowUserDefined = ref(true);

const canChoose = computed(() => hasUploaderChoice(uploaders.value.length, allowUserDefined.value));

/** Where files actually go when there's nothing to choose. */
const soleUploaderLabel = computed(() => uploaders.value[0]?.label ?? 'this server’s uploader');

const loading = ref(false);
const loaded = ref(false);
const busy = ref(false);
const error = ref('');
const formError = ref('');

/** The add modal is open. */
const adding = ref(false);
/** The uploader the edit modal is open on. */
const editing = ref<Uploader | null>(null);
/** Bumped when a selection is refused, to redraw the radios (see the template). */
const pickTick = ref(0);

function driverFor(id: string): UploaderDriver | undefined {
  return drivers.value.find((d) => d.driver === id);
}

// The "add" menu is the CREATABLE subset — `drivers` also carries the drivers we
// only need in order to describe rows the user already owns (a `hoarder` row
// migrated off the legacy settings is editable but not creatable).
const addableDrivers = computed(() => drivers.value.filter((d) => d.creatable));

// Resolved, so the template never hands the form an undefined driver (which
// would blow up on `.configSchema`).
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
  adding.value = false;
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
    pickTick.value++;
  } finally {
    busy.value = false;
  }
}

function onAdd() {
  closeForms();
  adding.value = true;
}

function onEdit(u: Uploader) {
  closeForms();
  editing.value = u;
}

async function onSaveNew({ driver, label, values }: UploaderDraft) {
  if (!adding.value) return;
  formError.value = '';
  busy.value = true;
  try {
    await api('/api/uploaders', {
      method: 'POST',
      body: { driver, label, values },
    });
    closeForms();
    await refresh();
  } catch (e: any) {
    formError.value = e.message || 'failed to add uploader';
  } finally {
    busy.value = false;
  }
}

async function onSaveEdit({ label, values }: UploaderDraft) {
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
        `will no longer be able to delete them from the host, only take them off your uploads list.`,
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
/* Inset from the row's edges, as a registry row is: the hover background runs
   the row's full width, and a radio or a button bar flush against its edge
   looks clipped. */
.device {
  padding-inline: var(--space-4);
}

/* The whole identity is the radio's label, so the row is the click target. */
.pick {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  min-width: 0;
  cursor: pointer;
}
.pick input {
  flex: none;
  margin: 0;
  accent-color: var(--accent);
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

.add-row {
  margin: var(--space-2) 0;
}
</style>
