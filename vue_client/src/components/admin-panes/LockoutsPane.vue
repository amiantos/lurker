<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel → Lockouts (#1039). Addresses refused for too many failed logins.
  The web sign-in and the IRC bouncer each keep their own count; both lift on
  their own after 15 minutes, and "clear all" lifts them now — before this the
  only early way out was restarting the server.
-->

<template>
  <section id="admin-lockouts" class="settings-pane">
    <h2>lockouts</h2>
    <p class="section-desc">
      <template v-if="policy">
        {{ policy.maxFailures }} failed logins from one address within
        {{ policy.windowMinutes }} minutes lock it out of signing in for
        {{ policy.backoffMinutes }} minutes.
      </template>
      The web sign-in and the bouncer count separately.
    </p>
    <p v-if="error" class="error inline">{{ error }}</p>

    <ul v-if="adminStore.loginLockouts.length" class="device-list">
      <li
        v-for="l in adminStore.loginLockouts"
        :key="`${l.source}:${l.address}`"
        class="device lockout-row"
      >
        <span class="ua">
          {{ l.address }}
          <span class="source-tag">{{ l.source }}</span>
        </span>
        <span class="last-seen">lifts at {{ formatDateTime(l.liftsAt) }}</span>
      </li>
    </ul>
    <p v-else-if="loaded" class="muted small">No addresses are locked out.</p>

    <div class="actions">
      <span class="btn-bar">
        <button :disabled="busy" @click="load">refresh</button>
        <button v-if="adminStore.loginLockouts.length" :disabled="busy" @click="onClear">
          clear all
        </button>
      </span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAdminStore } from '../../stores/admin.js';
import { formatDateTime } from '../../utils/timestamp.js';

const adminStore = useAdminStore();
const policy = computed(() => adminStore.loginLockoutPolicy);
const error = ref('');
const busy = ref(false);
const loaded = ref(false);

async function load() {
  error.value = '';
  busy.value = true;
  try {
    await adminStore.fetchLoginLockouts();
    loaded.value = true;
  } catch (e: any) {
    error.value = e.message || 'failed to load lockouts';
  } finally {
    busy.value = false;
  }
}

async function onClear() {
  error.value = '';
  busy.value = true;
  try {
    await adminStore.clearLoginLockouts();
  } catch (e: any) {
    error.value = e.message || 'failed to clear lockouts';
  } finally {
    busy.value = false;
  }
}

// Refetch on every activation, like the other admin panes: lockouts come and go
// on their own, so a cached list is wrong within minutes.
onMounted(load);
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
.lockout-row .source-tag {
  color: var(--fg-muted);
  border: 1px solid var(--border);
  padding: 0 var(--space-2);
  text-transform: uppercase;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}
</style>
