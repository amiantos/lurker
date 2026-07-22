<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel → Users. Member management (delete / pause / resume) for the
  instance. Split out of the old combined settings-panes/UsersPane so the admin
  panel can give members and invites their own tabs (#299 milestone). Drives the
  same `admin` Pinia store; the route/sidebar already gate this to admins.
-->

<template>
  <section id="admin-users" class="settings-pane">
    <h2>users</h2>
    <p class="section-desc">
      Everyone with an account on this instance. The last admin and your own account can't be
      deleted.
    </p>
    <p v-if="adminError" class="error inline">{{ adminError }}</p>

    <ul v-if="users.length" class="device-list">
      <li v-for="u in users" :key="u.id" class="device user-row">
        <span class="ua">
          {{ u.username }}
          <span v-if="u.role === 'admin'" class="role-tag">admin</span>
          <span v-if="u.isPaused" class="paused-tag">paused</span>
        </span>
        <span
          class="last-seen"
          :title="`joined ${u.createdAt}${u.lastSeenAt ? ` · last seen ${u.lastSeenAt}` : ''}`"
        >
          <template v-if="u.lastSeenAt">last seen {{ formatRelative(u.lastSeenAt) }}</template>
          <template v-else>joined {{ formatRelative(u.createdAt) }}</template>
        </span>
        <button
          v-if="!config.isNode"
          class="link"
          :disabled="u.id === auth.user?.id || adminBusy"
          :title="
            u.id === auth.user?.id
              ? 'cannot pause yourself'
              : u.isPaused
                ? 'resume — reconnect to IRC'
                : 'pause — disconnect from IRC and make read-only'
          "
          @click="u.isPaused ? onResumeUser(u) : onPauseUser(u)"
        >
          {{ u.isPaused ? 'resume' : 'pause' }}
        </button>
        <button
          class="link danger"
          :disabled="u.id === auth.user?.id || adminBusy"
          :title="u.id === auth.user?.id ? 'cannot delete yourself' : 'delete user'"
          @click="onDeleteUser(u)"
        >
          delete
        </button>
      </li>
    </ul>
    <p v-else-if="adminStore.usersLoaded" class="muted small">No users.</p>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { useAdminStore } from '../../stores/admin.js';
import { useConfigStore } from '../../stores/config.js';
import type { AdminUser } from '../../stores/admin.js';
import { formatRelative } from '../../utils/timestamp.js';

const auth = useAuthStore();
const adminStore = useAdminStore();
// Pause/resume is a self-hosted control only — in node edition the control plane
// owns account state, so the buttons are hidden.
const config = useConfigStore();

const users = computed(() => adminStore.users);

const adminError = ref('');
const adminBusy = ref(false);

onMounted(() => {
  // Refetch on every pane activation. The store cache stays correct for THIS
  // session's own mutations (delete/pause/resume), but an invite accepted
  // elsewhere — or another admin's change — leaves it stale until a full browser
  // reload. The admin panel route-swaps panes, so re-mount is the natural place
  // to re-sync; the request is cheap and keeps the screen honest (#613).
  adminStore.fetchUsers().catch((e: any) => {
    adminError.value = e.message;
  });
});

async function onDeleteUser(user: AdminUser) {
  if (!confirm(`Delete user ${user.username}? This is irreversible.`)) return;
  adminError.value = '';
  adminBusy.value = true;
  try {
    await adminStore.deleteUser(user.id);
  } catch (e: any) {
    adminError.value = e.message || 'failed to delete user';
  } finally {
    adminBusy.value = false;
  }
}

async function onPauseUser(user: AdminUser) {
  if (
    !confirm(
      `Pause ${user.username}? They'll be disconnected from IRC and read-only until resumed.`,
    )
  )
    return;
  adminError.value = '';
  adminBusy.value = true;
  try {
    await adminStore.pauseUser(user.id);
  } catch (e: any) {
    adminError.value = e.message || 'failed to pause user';
  } finally {
    adminBusy.value = false;
  }
}

async function onResumeUser(user: AdminUser) {
  adminError.value = '';
  adminBusy.value = true;
  try {
    await adminStore.resumeUser(user.id);
  } catch (e: any) {
    adminError.value = e.message || 'failed to resume user';
  } finally {
    adminBusy.value = false;
  }
}
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
.user-row .role-tag {
  color: var(--accent);
  border: 1px solid var(--accent);
  padding: 0 var(--space-2);
  margin-left: var(--space-3);
  text-transform: uppercase;
}
.user-row .paused-tag {
  color: var(--warn);
  border: 1px solid var(--warn);
  padding: 0 var(--space-2);
  margin-left: var(--space-3);
  text-transform: uppercase;
}
</style>
