<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel → Invites. Generate one-time invite links, revoke pending ones, and
  clear out spent ones once they're just clutter (#590). A spent invite belongs to
  the member it let in and is removed with them, so this list tracks live accounts
  rather than standing as a permanent record. Split out of the old combined
  settings-panes/UsersPane so members and invites get their own admin tabs.
  Drives the same `admin` Pinia store; the route/sidebar gate this to admins.
-->

<template>
  <section id="admin-invites" class="settings-pane">
    <h2>invites</h2>
    <p class="section-desc">
      Invite friends with a one-time link. A link works once. Used ones stay listed showing who
      joined, until you remove the invite or the member.
    </p>
    <p v-if="adminError" class="error inline">{{ adminError }}</p>

    <div class="invite-actions">
      <!-- Configure first, then create: the link's expiry and what its account
           is born with are decided in the modal, so nothing about a link can
           be changed after it exists. -->
      <button class="link" :disabled="adminBusy" @click="composing = true">
        generate invite link
      </button>
      <span v-if="lastCreatedInviteUrl" class="invite-fresh" title="copied to clipboard">
        <code>{{ lastCreatedInviteUrl }}</code>
        <button class="link" @click="copyInviteUrl(lastCreatedInviteUrl)">copy</button>
      </span>
    </div>
    <NewInviteModal v-if="composing" @close="composing = false" @created="onCreated" />
    <ul v-if="invites.length" class="device-list">
      <li v-for="inv in invites" :key="inv.token" class="device invite-row">
        <span class="ua">
          <code class="invite-url">{{ inv.url }}</code>
          <span class="invite-status" :class="`status-${inv.status}`">{{ inv.status }}</span>
          <span
            v-if="describeRestrictions(inv.restrictions)"
            class="invite-limited"
            :title="describeRestrictions(inv.restrictions)"
            >limited</span
          >
          <span v-if="inv.usedByUsername" class="invite-used"> → {{ inv.usedByUsername }}</span>
        </span>
        <span class="last-seen" :title="inv.expiresAt ?? undefined">
          <template v-if="inv.status === 'consumed' && inv.usedAt"
            >used {{ formatRelative(inv.usedAt) }}</template
          >
          <template v-else-if="inv.expiresAt">expires {{ formatRelative(inv.expiresAt) }}</template>
          <template v-else>no expiry</template>
        </span>
        <!-- Two words for two different acts: revoking kills a link someone could
             still redeem, removing only clears the record of one already spent. -->
        <button
          class="link danger"
          :disabled="adminBusy"
          :title="
            inv.status === 'consumed'
              ? 'remove this record — the link is already spent'
              : 'revoke this link so it can no longer be redeemed'
          "
          @click="onDeleteInvite(inv)"
        >
          {{ inv.status === 'consumed' ? 'remove' : 'revoke' }}
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
import { describeRestrictions } from '../../utils/accountRestrictions.js';
import NewInviteModal from './NewInviteModal.vue';

const adminStore = useAdminStore();

const invites = computed(() => adminStore.invites);

const adminError = ref('');
const adminBusy = ref(false);
const lastCreatedInviteUrl = ref('');
const composing = ref(false);

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

function onCreated(invite: AdminInvite) {
  composing.value = false;
  adminError.value = '';
  lastCreatedInviteUrl.value = invite.url;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(invite.url).catch(() => {
      /* clipboard is best-effort */
    });
  }
}

async function onDeleteInvite(invite: AdminInvite) {
  // Take the decision from the row we were handed, not by re-reading the store
  // at click time — the same label/action drift the menu work kept hitting.
  const spent = invite.status === 'consumed';
  const prompt = spent
    ? `Remove this used invite? ${invite.usedByUsername ?? 'The member'} stays; only the record goes.`
    : 'Revoke this invite? Anyone holding the link will no longer be able to use it.';
  if (!confirm(prompt)) return;
  adminError.value = '';
  adminBusy.value = true;
  try {
    await adminStore.deleteInvite(invite.token);
  } catch (e: any) {
    adminError.value = e.message || (spent ? 'failed to remove invite' : 'failed to revoke invite');
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
.invite-limited {
  text-transform: uppercase;
  color: var(--warn);
  border: 1px solid var(--warn);
  padding: 0 var(--space-2);
}
</style>
