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
    </p>

    <template v-else>
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
      <li v-for="u in store.uploaders" :key="u.id" class="device">
        <span class="ua">
          <span class="name">{{ u.label }}</span>
          <span class="driver">{{ u.driver }}</span>
          <span v-if="u.isDefault" class="badge default">default</span>
          <span v-if="!u.enabled" class="badge off">disabled</span>
          <span v-else-if="!u.offeredToUsers" class="badge off">admin only</span>
          <span v-if="u.locked" class="badge off">managed</span>
        </span>
        <template v-if="!store.uploadersManaged && !u.locked">
          <button
            v-if="!u.isDefault"
            class="link"
            :disabled="busy || !u.enabled"
            :title="u.enabled ? '' : 'enable this uploader first'"
            @click="onSetDefault(u)"
          >
            make default
          </button>
          <button class="link" :disabled="busy" @click="onToggleEnabled(u)">
            {{ u.enabled ? 'disable' : 'enable' }}
          </button>
          <button class="link" :disabled="busy" @click="onToggleOffered(u)">
            {{ u.offeredToUsers ? 'hide from users' : 'offer to users' }}
          </button>
          <button v-if="u.config && hasFields(u)" class="link" :disabled="busy" @click="onEdit(u)">
            edit
          </button>
          <button v-if="isDeletable(u)" class="link danger" :disabled="busy" @click="onDelete(u)">
            delete
          </button>
        </template>
      </li>
    </ul>

    <template v-if="!store.uploadersManaged">
      <template v-if="editing">
        <h3 class="subhead">edit {{ editing.label }}</h3>
        <UploaderConfigForm
          :driver="driverFor(editing.driver)!"
          :existing="{
            label: editing.label,
            config: editing.config,
            secretsSet: editing.secretsSet,
          }"
          :busy="busy"
          :error="formError"
          @save="onSaveEdit"
          @cancel="closeForms"
        />
      </template>

      <template v-else-if="store.uploaderDrivers.length">
        <h3 class="subhead">add an uploader</h3>
        <template v-if="adding">
          <label class="driver-pick">
            <span>Type</span>
            <select v-model="adding" :disabled="busy">
              <option v-for="d in store.uploaderDrivers" :key="d.driver" :value="d.driver">
                {{ d.label }}
              </option>
            </select>
          </label>
          <UploaderConfigForm
            :driver="driverFor(adding)!"
            :busy="busy"
            :error="formError"
            @save="onSaveNew"
            @cancel="closeForms"
          />
        </template>
        <p v-else class="add-row">
          <button class="link" :disabled="busy" @click="adding = store.uploaderDrivers[0].driver">
            add an uploader
          </button>
        </p>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAdminStore } from '../../stores/admin.js';
import UploaderConfigForm from '../UploaderConfigForm.vue';
import type { AdminUploader, UploaderDriver } from '../../utils/uploaders.js';

const store = useAdminStore();

const busy = ref(false);
const error = ref('');
const formError = ref('');
const adding = ref<string | null>(null);
const editing = ref<AdminUploader | null>(null);

function driverFor(id: string): UploaderDriver | undefined {
  return store.uploaderDrivers.find((d) => d.driver === id);
}

/** Zero-config drivers (x0, local disk) have nothing to edit. */
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
  adding.value = null;
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

async function onSaveNew({ label, values }: { label: string; values: Record<string, string> }) {
  if (!adding.value) return;
  formError.value = '';
  busy.value = true;
  try {
    await store.createUploader({ driver: adding.value, label, values });
    closeForms();
  } catch (e: any) {
    formError.value = e.message || 'failed to add the uploader';
  } finally {
    busy.value = false;
  }
}

async function onSaveEdit({ label, values }: { label: string; values: Record<string, string> }) {
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
