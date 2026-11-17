<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin → Uploaders (#514, absorbing #299). The instance's own upload
  destinations, plus the two levers that decide what users get:

    • which uploader is the DEFAULT — what a brand-new account uploads through
      without ever opening settings, and what anyone who hasn't chosen falls back
      to. This is #299's whole point: uploads work from first use.
    • whether an uploader is OFFERED to users at all, or admin-only.
    • the lockdown switch: may users define their own uploaders?
    • the upload ceiling (#1131): the most any account may be allowed, and the
      bound on everyone's own cap. 200 MB until raised; no upper bound here,
      the disk is the bound.

  Built-ins (x0, catbox, local disk) can be disabled but not deleted — they're
  re-created on the next boot regardless, and deleting the local-disk one would
  strand the files already on disk.
-->

<template>
  <section id="uploaders" class="settings-pane">
    <h2>Uploaders</h2>
    <p class="section-desc">
      Where files uploaded on this server are sent. The default is what new accounts use, and what
      anyone who hasn’t picked their own uploader falls back to.
    </p>
    <p v-if="error" class="error inline">{{ error }}</p>

    <p v-if="store.uploadersManaged" class="muted small">
      This server’s uploader is managed by the control plane and configured from the operator
      environment — it can’t be changed here.
      <template v-if="store.uploadCeilingMb != null">
        Uploads are capped at {{ store.uploadCeilingMb.toLocaleString() }} MB.
      </template>
    </p>

    <template v-else>
      <label class="policy ceiling">
        <span>
          <span class="name">Upload ceiling</span>
          The most anyone may upload, in MB. Each person can set a lower cap for themselves in
          Settings; an account that never did follows this number. Uploads bigger than one chunk
          cross a proxy in pieces, so this isn’t bound by what your proxy passes — only your disk
          is.
        </span>
        <span class="ceiling-edit">
          <input
            type="number"
            min="1"
            step="1"
            :value="store.uploadCeilingMb ?? ''"
            :disabled="busy || store.uploadCeilingMb == null"
            aria-label="upload ceiling in MB"
            @change="onCeilingChange"
          />
          MB
        </span>
      </label>
      <p v-if="ceilingError" class="error inline">{{ ceilingError }}</p>

      <label class="policy check">
        <input
          type="checkbox"
          :checked="store.allowUserDefined"
          :disabled="busy"
          @change="onTogglePolicy"
        />
        <span>
          Let users set up their own uploaders (their own catbox account, Zipline, S3 bucket…).
          Turning this off hides the “add an uploader” button; uploaders people already created keep
          working.
        </span>
      </label>
    </template>

    <h3 class="subhead">instance uploaders</h3>
    <p v-if="!store.uploadersLoaded" class="muted small">Loading…</p>
    <ul v-else class="device-list">
      <li v-for="u in store.uploaders" :key="u.id" class="device stacked">
        <span class="ua">
          <span class="name">{{ u.label }}</span>
          <span class="driver">{{ u.driver }}</span>
          <span v-if="u.isDefault" class="badge default">default</span>
          <span v-if="!u.enabled" class="badge off">disabled</span>
          <span v-else-if="!u.offeredToUsers" class="badge off">admin only</span>
          <span v-if="u.locked" class="badge off">managed</span>
        </span>
        <!-- Five actions is more than the default .device grid holds — hence the
             `stacked` row, with the button bar underneath. -->
        <span v-if="!store.uploadersManaged && !u.locked" class="btn-bar">
          <button
            v-if="!u.isDefault"
            :disabled="busy || !u.enabled"
            :title="u.enabled ? '' : 'enable this uploader first'"
            @click="onSetDefault(u)"
          >
            make default
          </button>
          <button :disabled="busy" @click="onToggleEnabled(u)">
            {{ u.enabled ? 'disable' : 'enable' }}
          </button>
          <button :disabled="busy" @click="onToggleOffered(u)">
            {{ u.offeredToUsers ? 'hide from users' : 'offer to users' }}
          </button>
          <button v-if="u.config && hasFields(u)" :disabled="busy" @click="onEdit(u)">edit</button>
          <button v-if="isDeletable(u)" class="bad" :disabled="busy" @click="onDelete(u)">
            delete
          </button>
        </span>
      </li>
    </ul>

    <template v-if="!store.uploadersManaged">
      <p v-if="addableDrivers.length" class="add-row">
        <button class="btn-secondary" :disabled="busy" @click="onAdd">add uploader</button>
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
          config: editing.config,
          secretsSet: editing.secretsSet,
        }"
        :busy="busy"
        :error="formError"
        @save="onSaveEdit"
        @close="closeForms"
      />
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAdminStore } from '../../stores/admin.js';
import UploaderModal from '../UploaderModal.vue';
import type { AdminUploader, UploaderDriver } from '../../utils/uploaders.js';

const store = useAdminStore();

const busy = ref(false);
const error = ref('');
const formError = ref('');
const adding = ref(false);
const editing = ref<AdminUploader | null>(null);

function driverFor(id: string): UploaderDriver | undefined {
  return store.uploaderDrivers.find((d) => d.driver === id);
}

// `uploaderDrivers` carries EVERY driver (a schema is needed to describe rows
// that already exist, not just ones you may add); the add menu is the creatable
// subset.
const addableDrivers = computed(() => store.uploaderDrivers.filter((d) => d.creatable));
const editingDriver = computed(() => (editing.value ? driverFor(editing.value.driver) : undefined));

/** A zero-config driver (x0) has nothing to edit. */
function hasFields(u: AdminUploader): boolean {
  return (driverFor(u.driver)?.configSchema.length ?? 0) > 0;
}

/** Only uploaders an admin actually created can be deleted: the built-ins come
 *  back on the next boot regardless, and the default has to be reassigned first.
 *  The server enforces both — this just keeps the button from appearing. */
function isDeletable(u: AdminUploader): boolean {
  return !u.builtIn && !u.isDefault;
}

function closeForms() {
  adding.value = false;
  editing.value = null;
  formError.value = '';
}

async function run(fn: () => Promise<unknown>, fallback: string) {
  error.value = '';
  busy.value = true;
  try {
    await fn();
  } catch (e: any) {
    error.value = e.message || fallback;
  } finally {
    busy.value = false;
  }
}

function onAdd() {
  closeForms();
  adding.value = true;
}

function onEdit(u: AdminUploader) {
  closeForms();
  editing.value = u;
}

const onSetDefault = (u: AdminUploader) =>
  run(() => store.setDefaultUploader(u.id), 'failed to set the default uploader');

const onToggleEnabled = (u: AdminUploader) =>
  run(() => store.updateUploader(u.id, { enabled: !u.enabled }), 'failed to update the uploader');

const onToggleOffered = (u: AdminUploader) =>
  run(
    () => store.updateUploader(u.id, { offeredToUsers: !u.offeredToUsers }),
    'failed to update the uploader',
  );

const onTogglePolicy = (e: Event) =>
  run(
    () => store.setAllowUserDefined((e.target as HTMLInputElement).checked),
    'failed to update the policy',
  );

// Committed on change like the switch above: one number, no form. A bad value
// is caught here so nothing round-trips just to be rejected; the server checks
// the same thing. Either way a refusal snaps the field back to what the server
// holds, so the box never shows a number that didn't take.
const ceilingError = ref('');
async function onCeilingChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const mb = Number(input.value);
  ceilingError.value = '';
  if (!Number.isInteger(mb) || mb < 1) {
    ceilingError.value = 'a whole number of MB, at least 1';
  } else {
    busy.value = true;
    try {
      await store.setUploadCeilingMb(mb);
    } catch (err: any) {
      ceilingError.value = err.message || 'failed to update the upload ceiling';
    } finally {
      busy.value = false;
    }
  }
  input.value = String(store.uploadCeilingMb ?? '');
}

interface UploaderDraft {
  driver: string;
  label: string;
  values: Record<string, string>;
}

async function onSaveNew({ driver, label, values }: UploaderDraft) {
  if (!adding.value) return;
  formError.value = '';
  busy.value = true;
  try {
    await store.createUploader({ driver, label, values });
    closeForms();
  } catch (e: any) {
    formError.value = e.message || 'failed to add the uploader';
  } finally {
    busy.value = false;
  }
}

async function onSaveEdit({ label, values }: UploaderDraft) {
  if (!editing.value) return;
  formError.value = '';
  busy.value = true;
  try {
    await store.updateUploader(editing.value.id, { label, values });
    closeForms();
  } catch (e: any) {
    formError.value = e.message || 'failed to save the uploader';
  } finally {
    busy.value = false;
  }
}

async function onDelete(u: AdminUploader) {
  if (
    !confirm(
      `Delete ${u.label}? Anyone using it will fall back to the default uploader. Files already ` +
        `uploaded through it stay where they are, but Lurker will no longer be able to delete them.`,
    )
  ) {
    return;
  }
  await run(() => store.deleteUploader(u.id), 'failed to delete the uploader');
}

onMounted(() => {
  if (!store.uploadersLoaded) {
    store.fetchUploaders().catch((e) => {
      error.value = e.message || 'failed to load uploaders';
    });
  }
});
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
.device .name {
  color: var(--fg);
}

.device .driver,
.badge {
  color: var(--fg-muted);
}

.badge.default {
  color: var(--accent);
}

.policy {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-3) 0;
}

.ceiling {
  flex-wrap: wrap;
  justify-content: space-between;
}
.ceiling .name {
  display: block;
  font-weight: 600;
}
.ceiling-edit {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
}
.ceiling-edit input {
  width: 6em;
}

.add-row {
  margin: var(--space-2) 0;
}
</style>
