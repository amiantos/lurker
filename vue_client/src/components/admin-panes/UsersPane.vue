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
    <p v-if="canAssignIdents" class="section-desc">
      Each account's <strong>ident</strong> is the name networks see in
      <code>nick!ident@host</code>. Everyone here shares this server's IP, so it's what lets an
      operator tell your members apart — assigned by you, not chosen by them. It defaults to the
      account name.
    </p>
    <!-- Nothing on this server answers ident lookups, so the idents would be
         inert: one line saying how to turn one on, and the rest of the ident
         surface stays out of the way (most self-hosts never enable it). -->
    <p v-else-if="adminStore.usersLoaded && !config.isNode" class="muted small">
      Networks can't ask this server who its users are — set
      <code>LURKER_IDENTD_ENABLED</code> (or <code>LURKER_OIDENTD_FILE</code>) to run an ident
      daemon, and each account gets an ident you can assign here.
    </p>
    <p v-if="adminError" class="error inline">{{ adminError }}</p>

    <ul v-if="users.length" class="device-list">
      <li v-for="u in users" :key="u.id" class="device stacked user-row">
        <span class="ua">
          {{ u.username }}
          <span v-if="u.role === 'admin'" class="role-tag">admin</span>
          <span v-if="u.isPaused" class="paused-tag">paused</span>
          <span
            v-if="adminStore.identdEnabled && u.effectiveIdent"
            class="ident-tag"
            :title="
              u.ident
                ? 'ident assigned by an admin'
                : 'ident derived from the account name — networks see this in nick!ident@host'
            "
          >
            ident {{ u.effectiveIdent }}
          </span>
          <span
            v-if="adminStore.identdEnabled && u.identConflict"
            class="conflict-tag"
            title="another account answers this same ident — until one of them is given its own, a network can't tell these two apart"
          >
            duplicate
          </span>
          <span
            v-if="u.recoveryExpiresAt"
            class="recovery-tag"
            :title="`recovery link issued, unused, expires ${u.recoveryExpiresAt}`"
          >
            recovery pending
          </span>
          <span
            class="last-seen"
            :title="`joined ${u.createdAt}${u.lastSeenAt ? ` · last seen ${u.lastSeenAt}` : ''}`"
          >
            <template v-if="u.lastSeenAt">last seen {{ formatRelative(u.lastSeenAt) }}</template>
            <template v-else>joined {{ formatRelative(u.createdAt) }}</template>
          </span>
        </span>

        <!-- Inline ident editor for this row. Empty input = clear the override
             and go back to deriving it from the account name.

             The placeholder is the DERIVED ident, not the username: the two
             differ whenever the username isn't ident-legal ("bob smith" →
             "bobsmith", a 20-char name → 16), so showing the username would
             both misstate what clearing produces and hand the admin a string
             that 400s if they retype it. effectiveIdent equals the derived
             default whenever no override is set — exactly when it's visible. -->
        <form
          v-if="canAssignIdents && editingIdentFor === u.id"
          class="ident-edit"
          @submit.prevent="onSaveIdent(u)"
        >
          <label>
            <span>ident</span>
            <input
              v-model="identDraft"
              :placeholder="u.effectiveIdent"
              :maxlength="MAX_IDENT_LENGTH"
              spellcheck="false"
              autocapitalize="off"
            />
          </label>
          <button type="submit" class="link" :disabled="adminBusy">save</button>
          <button type="button" class="link" :disabled="adminBusy" @click="editingIdentFor = null">
            cancel
          </button>
          <small class="muted">
            Leave blank to use the account name. Applies the next time they connect.
          </small>
        </form>

        <!-- Shown once, under the row it belongs to. Only the hash is stored, so
             there is no later screen that can show this URL again — an admin who
             loses it issues another, which kills this one. -->
        <div v-if="freshRecovery && freshRecovery.userId === u.id" class="recovery-fresh">
          <code>{{ freshRecovery.url }}</code>
          <button class="link" @click="onCopyRecovery(freshRecovery.url)">
            {{ freshRecovery.copied ? 'copied' : 'copy' }}
          </button>
          <small class="muted">
            Send this to {{ u.username }} over a channel you trust. Single use, expires in 24 hours,
            and shown only now.
          </small>
          <!-- Said out loud rather than swallowed: the clipboard API is absent
               outside a secure context, which includes plain-HTTP LAN installs.
               Elsewhere a failed copy costs a convenience; here it is the only
               copy of a value nothing can re-fetch. -->
          <small v-if="freshRecovery.copyFailed" class="error">
            clipboard unavailable — select and copy the link above manually
          </small>
        </div>

        <div class="row-actions">
          <button
            v-if="canAssignIdents"
            class="link"
            :disabled="adminBusy"
            title="set the ident networks see for this account"
            @click="onEditIdent(u)"
          >
            ident
          </button>
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
            v-if="!config.isNode"
            class="link"
            :disabled="adminBusy"
            title="issue a single-use link that lets this member set a password or add a passkey"
            @click="onIssueRecovery(u)"
          >
            {{ u.recoveryExpiresAt ? 'reissue recovery' : 'recovery link' }}
          </button>
          <button
            v-if="!config.isNode && u.recoveryExpiresAt"
            class="link"
            :disabled="adminBusy"
            title="revoke the outstanding recovery link"
            @click="onRevokeRecovery(u)"
          >
            revoke recovery
          </button>
          <button
            class="link danger"
            :disabled="u.id === auth.user?.id || adminBusy"
            :title="u.id === auth.user?.id ? 'cannot delete yourself' : 'delete user'"
            @click="onDeleteUser(u)"
          >
            delete
          </button>
        </div>
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
// Same module the server derives and validates idents with, so the input's cap
// can't drift from what the route accepts.
import { MAX_IDENT_LENGTH } from '../../../../shared/ident.js';

const auth = useAuthStore();
const adminStore = useAdminStore();
// Pause/resume and the ident are self-hosted controls only — in node edition the
// control plane owns account state and derives idents from the hosted account id,
// so those buttons are hidden (their routes 409 there anyway).
const config = useConfigStore();

const users = computed(() => adminStore.users);

// Two separate questions, deliberately not collapsed into one flag:
//   • does anything answer ident lookups? — if not, the idents are inert and the
//     whole surface (per-row tag included) stays hidden.
//   • may they be ASSIGNED here? — standalone only; a hosted cell answers with
//     `lu<accountId>` from the control plane, so the tag is worth showing there
//     but the editor isn't (its route 409s).
const canAssignIdents = computed(() => adminStore.identdEnabled && !config.isNode);

const adminError = ref('');
const adminBusy = ref(false);

// id of the row whose ident is being edited (one at a time), plus its draft.
const editingIdentFor = ref<number | null>(null);
const identDraft = ref('');

// The one recovery link minted this session, if any. Held in the component
// rather than the store because it is not state — it is a value that exists for
// exactly as long as this screen is open, and nothing can fetch it back.
const freshRecovery = ref<{
  userId: number;
  url: string;
  copied: boolean;
  copyFailed: boolean;
} | null>(null);

function onEditIdent(user: AdminUser) {
  adminError.value = '';
  // Seed with the override only — showing the derived value would make "save"
  // silently pin an ident that's currently just tracking the account name.
  identDraft.value = user.ident || '';
  editingIdentFor.value = editingIdentFor.value === user.id ? null : user.id;
}

async function onSaveIdent(user: AdminUser) {
  adminError.value = '';
  adminBusy.value = true;
  try {
    await adminStore.setUserIdent(user.id, identDraft.value.trim() || null);
    editingIdentFor.value = null;
  } catch (e: any) {
    adminError.value = e.message || 'failed to set ident';
  } finally {
    adminBusy.value = false;
  }
}

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

async function onIssueRecovery(user: AdminUser) {
  // Reissuing is destructive to a link that may already be in the member's
  // hands, so say so — the copy names what breaks rather than asking "are you
  // sure".
  if (
    user.recoveryExpiresAt &&
    !confirm(`Issue a new recovery link for ${user.username}? The one already sent stops working.`)
  )
    return;
  adminError.value = '';
  adminBusy.value = true;
  freshRecovery.value = null;
  try {
    const recovery = await adminStore.createRecoveryLink(user.id);
    freshRecovery.value = { userId: user.id, url: recovery.url, copied: false, copyFailed: false };
    await onCopyRecovery(recovery.url);
  } catch (e: any) {
    adminError.value = e.message || 'failed to issue recovery link';
  } finally {
    adminBusy.value = false;
  }
}

async function onRevokeRecovery(user: AdminUser) {
  if (!confirm(`Revoke ${user.username}'s recovery link? Anyone holding it can no longer use it.`))
    return;
  adminError.value = '';
  adminBusy.value = true;
  try {
    await adminStore.revokeRecoveryLink(user.id);
    if (freshRecovery.value?.userId === user.id) freshRecovery.value = null;
  } catch (e: any) {
    adminError.value = e.message || 'failed to revoke recovery link';
  } finally {
    adminBusy.value = false;
  }
}

async function onCopyRecovery(url: string) {
  if (!freshRecovery.value) return;
  try {
    await navigator.clipboard.writeText(url);
    freshRecovery.value.copied = true;
    freshRecovery.value.copyFailed = false;
  } catch (_) {
    freshRecovery.value.copied = false;
    freshRecovery.value.copyFailed = true;
  }
}

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
.user-row .ident-tag {
  color: var(--fg-muted);
  border: 1px solid var(--border);
  padding: 0 var(--space-2);
}
.user-row .ident-edit {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-3);
}
.user-row .ident-edit label {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.user-row .ident-edit input {
  width: 12ch;
}
.user-row .role-tag {
  color: var(--accent);
  border: 1px solid var(--accent);
  padding: 0 var(--space-2);
  text-transform: uppercase;
}
.user-row .conflict-tag {
  color: var(--bad);
  border: 1px solid currentcolor;
  padding: 0 var(--space-2);
  text-transform: uppercase;
}
.user-row .recovery-tag {
  color: var(--warn);
  border: 1px solid var(--warn);
  padding: 0 var(--space-2);
  text-transform: uppercase;
}
.user-row .recovery-fresh {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-3);
}
.user-row .recovery-fresh code {
  overflow-wrap: anywhere;
}
.user-row .paused-tag {
  color: var(--warn);
  border: 1px solid var(--warn);
  padding: 0 var(--space-2);
  text-transform: uppercase;
}
</style>
