<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section id="users" class="settings-pane">
    <h2>users</h2>
    <p class="section-desc">
      Invite friends with a one-time link, or remove an account. The last admin and your own account
      can't be deleted.
    </p>
    <p v-if="adminError" class="error inline">{{ adminError }}</p>

    <h3 class="subhead">members</h3>
    <ul v-if="users.length" class="device-list">
      <li v-for="u in users" :key="u.id" class="device user-row">
        <span class="ua">
          {{ u.username }}
          <span v-if="u.role === 'admin'" class="role-tag">admin</span>
        </span>
        <span
          class="last-seen"
          :title="`joined ${u.createdAt}${u.lastSeenAt ? ` · last seen ${u.lastSeenAt}` : ''}`"
        >
          <template v-if="u.lastSeenAt">last seen {{ formatRelative(u.lastSeenAt) }}</template>
          <template v-else>joined {{ formatRelative(u.createdAt) }}</template>
        </span>
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
    <ul v-if="invites.length" class="device-list">
      <li v-for="inv in invites" :key="inv.token" class="device invite-row">
        <span class="ua">
          <code class="invite-url">{{ inv.url }}</code>
          <span class="invite-status" :class="`status-${inv.status}`">{{ inv.status }}</span>
          <span v-if="inv.usedByUsername" class="invite-used"> → {{ inv.usedByUsername }}</span>
        </span>
        <span class="last-seen" :title="inv.expiresAt ?? undefined">
          <template v-if="inv.status === 'consumed' && inv.usedAt"
            >used {{ formatRelative(inv.usedAt) }}</template
          >
          <template v-else-if="inv.expiresAt">expires {{ formatRelative(inv.expiresAt) }}</template>
          <template v-else>no expiry</template>
        </span>
        <button
          v-if="inv.status !== 'consumed'"
          class="link danger"
          :disabled="adminBusy"
          @click="onRevokeInvite(inv)"
        >
          revoke
        </button>
        <button v-else class="link" disabled title="consumed invites are kept as an audit trail">
          —
        </button>
      </li>
    </ul>
    <p v-else-if="adminStore.invitesLoaded" class="muted small">No invites yet.</p>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { useAdminStore } from '../../stores/admin.js';
import type { AdminUser, AdminInvite } from '../../stores/admin.js';
import { formatRelative } from '../../utils/timestamp.js';

// The store's AdminUser covers core fields; the server also returns `role`
// and `lastSeenAt` which the template displays.
interface AdminUserRow extends AdminUser {
  role?: string;
  lastSeenAt?: string | null;
}

// The store's AdminInvite covers core fields; the server also returns `url`,
// `status`, and `usedByUsername`.
interface AdminInviteRow extends AdminInvite {
  url: string;
  status: string;
  usedByUsername?: string | null;
}

const auth = useAuthStore();
const adminStore = useAdminStore();

// The store types these as the base interfaces; cast to the extended rows that
// include fields the server returns but the interfaces don't declare yet.
const users = computed(() => adminStore.users as AdminUserRow[]);
const invites = computed(() => adminStore.invites as AdminInviteRow[]);

const adminError = ref('');
const adminBusy = ref(false);
const lastCreatedInviteUrl = ref('');

onMounted(() => {
  adminStore.fetchUsers().catch((e: any) => {
    adminError.value = e.message;
  });
  adminStore.fetchInvites().catch((e: any) => {
    adminError.value = e.message;
  });
});

async function onCreateInvite() {
  adminError.value = '';
  adminBusy.value = true;
  lastCreatedInviteUrl.value = '';
  try {
    const invite = (await adminStore.createInvite()) as AdminInviteRow;
    lastCreatedInviteUrl.value = invite.url;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(invite.url).catch(() => {
        /* clipboard is best-effort */
      });
    }
  } catch (e: any) {
    adminError.value = e.message || 'failed to create invite';
  } finally {
    adminBusy.value = false;
  }
}

async function onRevokeInvite(invite: AdminInviteRow) {
  if (!confirm(`Revoke this invite?`)) return;
  adminError.value = '';
  adminBusy.value = true;
  try {
    await adminStore.deleteInvite(invite.token);
  } catch (e: any) {
    adminError.value = e.message || 'failed to revoke invite';
  } finally {
    adminBusy.value = false;
  }
}

async function onDeleteUser(user: AdminUserRow) {
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

function copyInviteUrl(url: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).catch(() => {
      /* ignore */
    });
  }
}
</script>

<style src="./panes.css"></style>
<style scoped>
.user-row .role-tag {
  color: var(--accent);
  border: 1px solid var(--accent);
  padding: 0 var(--space-2);
  margin-left: var(--space-3);
  text-transform: uppercase;
}
.invite-actions {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  padding: 0 0 var(--space-5);
  flex-wrap: wrap;
}
.invite-fresh {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--fg-muted);
}
.invite-fresh code {
  background: var(--bg-soft);
  padding: 1px var(--space-2);
  word-break: break-all;
}
.invite-row .ua {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.invite-url {
  background: var(--bg-soft);
  padding: 1px var(--space-2);
  word-break: break-all;
  color: var(--fg-muted);
}
.invite-status {
  text-transform: uppercase;
  color: var(--fg-muted);
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
}
.invite-status.status-pending {
  color: var(--accent);
  border-color: var(--accent);
}
.invite-status.status-consumed {
  color: var(--fg-muted);
}
.invite-status.status-expired {
  color: var(--bad);
  border-color: var(--bad);
}
.invite-used {
  color: var(--fg-muted);
}
</style>
