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
      <button class="btn-secondary" :disabled="adminBusy" @click="composing = true">
        generate invite link
      </button>
    </div>
    <NewInviteModal v-if="composing" @close="composing = false" />
    <ul v-if="invites.length" class="device-list">
      <!-- Two lines: what state the invite is in, with its actions at the far
           edge, then the link. The link used to lead the row in a box that broke
           wherever its width fell, with the state as a boxed tag beneath it,
           which read as a button once every button had a box. -->
      <li v-for="inv in invites" :key="inv.token" class="device invite-row">
        <span class="invite-head">
          <span class="invite-status" :class="`status-${inv.status}`">{{ inv.status }}</span>
          <span
            v-if="describeRestrictions(inv.restrictions)"
            class="invite-limited"
            :title="describeRestrictions(inv.restrictions)"
            >limited</span
          >
          <MetaLine class="invite-meta" :parts="metaFor(inv)" :title="inv.expiresAt ?? undefined" />
        </span>
        <!-- Two words for two different acts: revoking kills a link someone could
             still redeem, removing only clears the record of one already spent. -->
        <span class="btn-bar">
          <button v-if="inv.status === 'pending'" @click="copy(inv.url, inv.token)">
            {{ copiedKey === inv.token ? 'copied' : 'copy link' }}
          </button>
          <button
            class="bad"
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
        </span>
        <code class="invite-url" :title="inv.url">{{ inv.url }}</code>
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
import MetaLine from '../MetaLine.vue';
import type { MetaPart } from '../../utils/metaLine.js';
import { useCopyFeedback } from '../../composables/useCopyFeedback.js';

const adminStore = useAdminStore();

const invites = computed(() => adminStore.invites);

const adminError = ref('');
const adminBusy = ref(false);
const composing = ref(false);
// One instance for the list: only the row whose link was copied ticks.
const { copiedKey, copy } = useCopyFeedback();

/** Who used it, and when it was used or runs out. */
function metaFor(inv: AdminInvite): MetaPart[] {
  return [
    inv.usedByUsername && `joined as ${inv.usedByUsername}`,
    inv.status === 'consumed' && inv.usedAt
      ? `used ${formatRelative(inv.usedAt)}`
      : inv.expiresAt
        ? `expires ${formatRelative(inv.expiresAt)}`
        : 'no expiry',
  ];
}

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
/* State and actions on one line, the link under them across the full width. */
.invite-row {
  grid-template-columns: 1fr max-content;
  row-gap: var(--space-3);
  padding: var(--space-5) 0 var(--space-6);
}
.invite-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 1ch;
  min-width: 0;
}
/* Colored words, not boxes: a box is a button. */
.invite-status,
.invite-limited {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.invite-status {
  color: var(--fg-muted);
}
.invite-status.status-pending {
  color: var(--accent);
}
.invite-status.status-expired {
  color: var(--bad);
}
.invite-limited {
  color: var(--warn);
}
.invite-meta {
  color: var(--fg-muted);
}
/* One line, cut with an ellipsis: the whole link is in the title and in "copy
   link", and a token wrapped mid-word helped nobody read it. */
.invite-url {
  grid-column: 1 / -1;
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: all;
}
</style>
