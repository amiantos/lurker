<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Third-party apps the member approved through OAuth sign-in (#891): when each
  was approved and last used, and a revoke that signs the app out. Built from
  ApiTokensPane's list. There is no create form — an app only gets here by being
  approved on /oauth/authorize.
-->

<template>
  <section id="authorized-apps" class="settings-pane">
    <h2>authorized apps</h2>
    <p class="section-desc">
      Apps you've approved. Each has full access to your account until you revoke it.
    </p>
    <p v-if="error" class="error inline">{{ error }}</p>

    <ul v-if="rows.length" class="device-list">
      <li v-for="a in rows" :key="a.id" class="device app-row">
        <span class="ua">
          <span class="name">{{ a.name }}</span>
          <span v-if="a.host" class="host">{{ a.host }}</span>
        </span>
        <span class="last-seen">
          <span :title="a.authorizedAt">authorized {{ formatRelative(a.authorizedAt) }}</span>
          <span :title="a.lastUsedAt ?? undefined">
            {{ a.lastUsedAt ? `last used ${formatRelative(a.lastUsedAt)}` : 'never used' }}
          </span>
        </span>
        <button class="link danger" :disabled="busy" @click="onRevoke(a)">revoke</button>
      </li>
    </ul>
    <p v-else-if="loaded && !error" class="muted small">No authorized apps.</p>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '../../api.js';
import { formatRelative } from '../../utils/timestamp.js';

interface AuthorizedApp {
  id: number;
  name: string;
  clientUri: string | null;
  authorizedAt: string;
  lastUsedAt: string | null;
}

const apps = ref<AuthorizedApp[]>([]);
const loaded = ref(false);
const busy = ref(false);
const error = ref('');

// Host only, shown as plain text. The app registered this URL itself and nothing
// checks it, so it must not read as verified.
function hostOf(uri: string | null): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host || null;
  } catch {
    return null;
  }
}

const rows = computed(() => apps.value.map((app) => ({ ...app, host: hostOf(app.clientUri) })));

onMounted(() => {
  refresh();
});

async function refresh() {
  error.value = '';
  try {
    const { apps: list } = await api<{ apps: AuthorizedApp[] }>('/api/oauth/apps');
    apps.value = list;
  } catch (e: any) {
    error.value = e.message || 'failed to load apps';
  } finally {
    loaded.value = true;
  }
}

async function onRevoke(app: AuthorizedApp) {
  if (!confirm(`Revoke ${app.name}? It will lose access to your account.`)) return;
  error.value = '';
  busy.value = true;
  try {
    await api(`/api/oauth/apps/${app.id}`, { method: 'DELETE' });
    await refresh();
  } catch (e: any) {
    // 404: already revoked, e.g. from another device. The list is just stale.
    if (e.status === 404) await refresh();
    else error.value = e.message || 'revoke failed';
  } finally {
    busy.value = false;
  }
}
</script>

<style src="./panes.css"></style>
<style scoped>
.app-row .name {
  color: var(--fg);
}
.app-row .host {
  color: var(--fg-muted);
}
.app-row .last-seen {
  display: flex;
  flex-direction: column;
}
</style>
