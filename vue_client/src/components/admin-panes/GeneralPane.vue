<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel → General: instance-wide settings with no pane of their own.
  One today, the Jitsi Meet server /jitsi starts calls on (#527). A person's
  own "Jitsi server" setting goes ahead of it.
-->

<template>
  <section id="admin-general" class="settings-pane">
    <h2>general</h2>
    <p v-if="error" class="error inline">{{ error }}</p>

    <label class="policy field">
      <span>
        <span class="name">Jitsi server</span>
        Where /jitsi starts video calls, as a URL: https://meet.example.org. Empty uses the public
        meet.jit.si. Anyone can choose a different server for themselves in Settings.
      </span>
      <input
        type="url"
        inputmode="url"
        autocomplete="off"
        spellcheck="false"
        placeholder="https://meet.jit.si"
        v-model="draft"
        :disabled="busy || store.jitsiUrl === undefined"
        aria-label="Jitsi server URL"
        @change="onJitsiChange"
      />
    </label>
    <p v-if="jitsiError" class="error inline">{{ jitsiError }}</p>
  </section>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useAdminStore } from '../../stores/admin.js';
import { useConfigStore } from '../../stores/config.js';
import { normalizeJitsiBase } from '../../../../shared/jitsi.js';

const store = useAdminStore();
const error = ref('');
const busy = ref(false);

onMounted(async () => {
  try {
    await store.fetchGeneral();
  } catch (e: any) {
    error.value = e.message || 'failed to load';
  }
});

// What is in the box. Its own ref, not the stored value: a refusal has to
// leave what was typed there, beside the reason, so it can be fixed.
const draft = ref('');
watch(
  () => store.jitsiUrl,
  (url) => {
    draft.value = url ?? '';
  },
);
// Another admin (or this one, elsewhere) changed it: the frame that tells every
// client reaches this pane too.
watch(
  () => useConfigStore().jitsiUrl,
  (url) => {
    if (store.jitsiUrl !== undefined) store.jitsiUrl = url;
  },
);

// Committed on change, like the upload ceiling: one value, no form.
const jitsiError = ref('');
async function onJitsiChange() {
  const typed = draft.value.trim();
  jitsiError.value = '';
  if (typed && !normalizeJitsiBase(typed)) {
    jitsiError.value = 'not a Jitsi address: expected https://host';
    return;
  }
  busy.value = true;
  try {
    await store.setJitsiUrl(typed);
    draft.value = store.jitsiUrl ?? '';
  } catch (err: any) {
    jitsiError.value = err.message || 'failed to update the Jitsi server';
  } finally {
    busy.value = false;
  }
}
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
.policy {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
  margin: var(--space-3) 0;
}
.field .name {
  display: block;
  font-weight: 600;
}
.field input {
  flex: 1 1 20em;
  min-width: 0;
}
</style>
