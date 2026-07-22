<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel → Invites. Generate one-time invite links and revoke pending ones;
  consumed invites are kept as an audit trail. Split out of the old combined
  settings-panes/UsersPane so members and invites get their own admin tabs.
  Drives the same `admin` Pinia store; the route/sidebar gate this to admins.
-->

<template>
  <section id="admin-invites" class="settings-pane">
    <h2>invites</h2>
    <p class="section-desc">
      Invite friends with a one-time link. Consumed invites are kept below as an audit trail.
    </p>
    <p v-if="adminError" class="error inline">{{ adminError }}</p>

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
import { useAdminStore } from '../../stores/admin.js';
import type { AdminInvite } from '../../stores/admin.js';
import { formatRelative } from '../../utils/timestamp.js';

const adminStore = useAdminStore();

const invites = computed(() => adminStore.invites);

const adminError = ref('');
const adminBusy = ref(false);
const lastCreatedInviteUrl = ref('');

onMounted(() => {
  // Refetch on every pane activation. The store cache stays correct for THIS
  // session's own mutations (create/revoke), but an invite accepted elsewhere —
  // or another admin's change — leaves it stale until a full browser reload. The
  // admin panel route-swaps panes, so re-mount is the natural place to re-sync;
  // the request is cheap and keeps the screen honest (#613).
  adminStore.fetchInvites().catch((e: any) => {
    adminError.value = e.message;
  });
});

async function onCreateInvite() {
  adminError.value = '';
  adminBusy.value = true;
  lastCreatedInviteUrl.value = '';
  try {
    const invite = await adminStore.createInvite();
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

async function onRevokeInvite(invite: AdminInvite) {
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

function copyInviteUrl(url: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).catch(() => {
      /* ignore */
    });
  }
}
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
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
