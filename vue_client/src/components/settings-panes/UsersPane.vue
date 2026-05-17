<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <section id="users" class="settings-pane">
    <h2>users</h2>
    <p class="section-desc">
      Invite friends with a one-time link, or remove an account. The last admin
      and your own account can't be deleted.
    </p>
    <p v-if="adminError" class="error inline">{{ adminError }}</p>

    <h3 class="subhead">members</h3>
    <ul v-if="adminStore.users.length" class="device-list">
      <li v-for="u in adminStore.users" :key="u.id" class="device user-row">
        <span class="ua">
          {{ u.username }}
          <span v-if="u.role === 'admin'" class="role-tag">admin</span>
        </span>
        <span class="last-seen" :title="`joined ${u.createdAt}${u.lastSeenAt ? ` · last seen ${u.lastSeenAt}` : ''}`">
          <template v-if="u.lastSeenAt">last seen {{ formatRelative(u.lastSeenAt) }}</template>
          <template v-else>joined {{ formatRelative(u.createdAt) }}</template>
        </span>
        <button
          class="link danger"
          :disabled="u.id === auth.user?.id || adminBusy"
          :title="u.id === auth.user?.id ? 'cannot delete yourself' : 'delete user'"
          @click="onDeleteUser(u)"
        >delete</button>
      </li>
    </ul>
    <p v-else-if="adminStore.usersLoaded" class="muted small">No users.</p>

    <h3 class="subhead">invites</h3>
    <div class="invite-actions">
      <button class="link" :disabled="adminBusy" @click="onCreateInvite">
        generate invite link
      </button>
      <span v-if="lastCreatedInviteUrl" class="invite-fresh" title="copied to clipboard">
        <code>{{ lastCreatedInviteUrl }}</code>
        <button class="link" @click="copyInviteUrl(lastCreatedInviteUrl)">copy</button>
      </span>
    </div>
    <ul v-if="adminStore.invites.length" class="device-list">
      <li v-for="inv in adminStore.invites" :key="inv.token" class="device invite-row">
        <span class="ua">
          <code class="invite-url">{{ inv.url }}</code>
          <span class="invite-status" :class="`status-${inv.status}`">{{ inv.status }}</span>
          <span v-if="inv.usedByUsername" class="invite-used"> → {{ inv.usedByUsername }}</span>
        </span>
        <span class="last-seen" :title="inv.expiresAt">
          <template v-if="inv.status === 'consumed' && inv.usedAt">used {{ formatRelative(inv.usedAt) }}</template>
          <template v-else-if="inv.expiresAt">expires {{ formatRelative(inv.expiresAt) }}</template>
          <template v-else>no expiry</template>
        </span>
        <button
          v-if="inv.status !== 'consumed'"
          class="link danger"
          :disabled="adminBusy"
          @click="onRevokeInvite(inv)"
        >revoke</button>
        <button
          v-else
          class="link"
          disabled
          title="consumed invites are kept as an audit trail"
        >—</button>
      </li>
    </ul>
    <p v-else-if="adminStore.invitesLoaded" class="muted small">No invites yet.</p>
  </section>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { useAdminStore } from '../../stores/admin.js';
import { formatRelative } from '../../utils/timestamp.js';

const auth = useAuthStore();
const adminStore = useAdminStore();

const adminError = ref('');
const adminBusy = ref(false);
const lastCreatedInviteUrl = ref('');

onMounted(() => {
  adminStore.fetchUsers().catch((e) => { adminError.value = e.message; });
  adminStore.fetchInvites().catch((e) => { adminError.value = e.message; });
});

async function onCreateInvite() {
  adminError.value = '';
  adminBusy.value = true;
  lastCreatedInviteUrl.value = '';
  try {
    const invite = await adminStore.createInvite();
    lastCreatedInviteUrl.value = invite.url;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(invite.url).catch(() => { /* clipboard is best-effort */ });
    }
  } catch (e) {
    adminError.value = e.message || 'failed to create invite';
  } finally {
    adminBusy.value = false;
  }
}

async function onRevokeInvite(invite) {
  if (!confirm(`Revoke this invite?`)) return;
  adminError.value = '';
  adminBusy.value = true;
  try {
    await adminStore.deleteInvite(invite.token);
  } catch (e) {
    adminError.value = e.message || 'failed to revoke invite';
  } finally {
    adminBusy.value = false;
  }
}

async function onDeleteUser(user) {
  if (!confirm(`Delete user ${user.username}? This is irreversible.`)) return;
  adminError.value = '';
  adminBusy.value = true;
  try {
    await adminStore.deleteUser(user.id);
  } catch (e) {
    adminError.value = e.message || 'failed to delete user';
  } finally {
    adminBusy.value = false;
  }
}

function copyInviteUrl(url) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).catch(() => { /* ignore */ });
  }
}
</script>

<style src="./panes.css"></style>
<style scoped>
.user-row .role-tag {
  color: var(--accent);
  border: 1px solid var(--accent);
  padding: 0 4px;
  margin-left: 6px;
  font-size: 0.85em;
  text-transform: uppercase;
}
.invite-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 10px;
  flex-wrap: wrap;
}
.invite-fresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-muted);
  font-size: 0.95em;
}
.invite-fresh code {
  background: var(--bg-soft);
  padding: 1px 4px;
  word-break: break-all;
}
.invite-row .ua {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.invite-url {
  background: var(--bg-soft);
  padding: 1px 4px;
  word-break: break-all;
  font-size: 0.9em;
}
.invite-status {
  text-transform: uppercase;
  font-size: 0.8em;
  padding: 0 4px;
  border: 1px solid var(--border);
}
.invite-status.status-pending { color: var(--accent); border-color: var(--accent); }
.invite-status.status-consumed { color: var(--fg-muted); }
.invite-status.status-expired { color: var(--bad); border-color: var(--bad); }
.invite-used { color: var(--fg-muted); }
</style>
