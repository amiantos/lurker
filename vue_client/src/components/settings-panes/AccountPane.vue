<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <section id="account" class="settings-pane">
    <h2>account</h2>
    <p class="section-desc">
      You can sign in with a passkey, a password, or both. Removing your last
      sign-in method would lock you out, so it's blocked.
    </p>
    <p v-if="passkeyError" class="error inline">{{ passkeyError }}</p>

    <h3 class="subhead">passkeys</h3>
    <ul v-if="passkeys.length" class="device-list">
      <li v-for="pk in passkeys" :key="pk.id" class="device passkey">
        <span class="ua">
          <input
            type="text"
            :value="pk.label || ''"
            :placeholder="defaultPasskeyLabel(pk)"
            @change="onRenamePasskey(pk, $event.target.value)"
          />
        </span>
        <span class="last-seen" :title="pk.lastUsedAt || pk.createdAt">
          {{ pk.lastUsedAt ? `last used ${formatRelative(pk.lastUsedAt)}` : `added ${formatRelative(pk.createdAt)}` }}
        </span>
        <button
          class="link danger"
          :disabled="!canRemovePasskey || passkeyBusy"
          :title="removePasskeyTitle"
          @click="onRemovePasskey(pk)"
        >remove</button>
      </li>
    </ul>
    <p v-else class="muted small">No passkeys registered.</p>
    <div class="passkey-add">
      <button class="link" :disabled="passkeyBusy" @click="onAddPasskey">add passkey</button>
    </div>

    <h3 class="subhead">password</h3>
    <p v-if="passwordError" class="error inline">{{ passwordError }}</p>
    <p v-if="passwordNotice" class="muted small">{{ passwordNotice }}</p>
    <p v-if="!hasPassword" class="muted small">No password set.</p>
    <p v-else class="muted small">Password is set.</p>
    <form class="password-form" @submit.prevent="onSavePassword">
      <label v-if="hasPassword">
        <span>Current password</span>
        <input v-model="currentPasswordInput" type="password" autocomplete="current-password" />
      </label>
      <label>
        <span>{{ hasPassword ? 'New password' : 'Password' }}</span>
        <input
          v-model="newPasswordInput"
          type="password"
          autocomplete="new-password"
          minlength="8"
        />
      </label>
      <div class="password-actions">
        <button
          class="link"
          type="submit"
          :disabled="passwordBusy || !newPasswordInput || (hasPassword && !currentPasswordInput)"
        >{{ hasPassword ? 'change password' : 'set password' }}</button>
        <button
          v-if="hasPassword"
          type="button"
          class="link danger"
          :disabled="passwordBusy || passkeys.length === 0"
          :title="passkeys.length === 0 ? 'add a passkey before removing your password' : 'remove password'"
          @click="onRemovePassword"
        >remove password</button>
      </div>
    </form>

    <div class="signout-row">
      <button class="link danger" @click="signOut">sign out</button>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth.js';
import { formatRelative } from '../../utils/timestamp.js';

const auth = useAuthStore();
const router = useRouter();

const passkeys = ref([]);
const passkeyError = ref('');
const passkeyBusy = ref(false);
const hasPassword = ref(false);
const passwordError = ref('');
const passwordNotice = ref('');
const passwordBusy = ref(false);
const currentPasswordInput = ref('');
const newPasswordInput = ref('');

const canRemovePasskey = computed(() => {
  // Server blocks removing the last sign-in method. So removing a passkey is
  // safe when there's another passkey, OR when a password exists.
  if (passkeys.value.length > 1) return true;
  return hasPassword.value;
});
const removePasskeyTitle = computed(() => {
  if (canRemovePasskey.value) return 'remove this passkey';
  return 'set a password first — this is your only sign-in method';
});

onMounted(() => {
  refreshPasskeys();
  refreshPasswordStatus();
});

async function refreshPasskeys() {
  try {
    passkeys.value = await auth.listPasskeys();
  } catch (e) {
    passkeyError.value = e.message || 'failed to load passkeys';
  }
}

function defaultPasskeyLabel(pk) {
  const where = pk.backedUp ? 'synced' : 'this device';
  return `passkey (${where})`;
}

async function onAddPasskey() {
  passkeyError.value = '';
  passkeyBusy.value = true;
  try {
    await auth.addPasskey({});
    await refreshPasskeys();
  } catch (e) {
    if (e.name !== 'NotAllowedError') {
      passkeyError.value = e.message || 'failed to add passkey';
    }
  } finally {
    passkeyBusy.value = false;
  }
}

async function onRenamePasskey(pk, label) {
  passkeyError.value = '';
  try {
    await auth.renamePasskey(pk.id, label);
    await refreshPasskeys();
  } catch (e) {
    passkeyError.value = e.message || 'rename failed';
  }
}

async function onRemovePasskey(pk) {
  if (!confirm(`Remove ${pk.label || 'this passkey'}?`)) return;
  passkeyError.value = '';
  passkeyBusy.value = true;
  try {
    await auth.deletePasskey(pk.id);
    await refreshPasskeys();
  } catch (e) {
    passkeyError.value = e.message || 'remove failed';
  } finally {
    passkeyBusy.value = false;
  }
}

async function refreshPasswordStatus() {
  hasPassword.value = await auth.fetchPasswordStatus();
}

async function onSavePassword() {
  passwordError.value = '';
  passwordNotice.value = '';
  if (!newPasswordInput.value) return;
  passwordBusy.value = true;
  try {
    await auth.setPassword({
      password: newPasswordInput.value,
      currentPassword: hasPassword.value ? currentPasswordInput.value : undefined,
    });
    currentPasswordInput.value = '';
    newPasswordInput.value = '';
    await refreshPasswordStatus();
    passwordNotice.value = 'Password saved.';
  } catch (e) {
    passwordError.value = e.message || 'failed to save password';
  } finally {
    passwordBusy.value = false;
  }
}

async function onRemovePassword() {
  if (!confirm('Remove your password? You will only be able to sign in with a passkey.')) return;
  passwordError.value = '';
  passwordNotice.value = '';
  passwordBusy.value = true;
  try {
    await auth.removePassword();
    currentPasswordInput.value = '';
    newPasswordInput.value = '';
    await refreshPasswordStatus();
    passwordNotice.value = 'Password removed.';
  } catch (e) {
    passwordError.value = e.message || 'failed to remove password';
  } finally {
    passwordBusy.value = false;
  }
}

async function signOut() {
  await auth.logout();
  router.replace('/login');
}
</script>

<style src="./panes.css"></style>
<style scoped>
.passkey .ua input[type="text"] {
  width: 100%;
  background: transparent;
  border: 1px solid transparent;
  color: var(--fg);
  padding: 2px 4px;
}
.passkey .ua input[type="text"]:hover,
.passkey .ua input[type="text"]:focus {
  border-color: var(--border);
}
.passkey-add { padding-top: 8px; }

.password-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
  max-width: 360px;
}
.password-form label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--fg-muted);
}
.password-form label span {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.85em;
}
.password-actions {
  display: flex;
  gap: 1ch;
  align-items: center;
  margin-top: 2px;
}
.signout-row {
  margin-top: 16px;
  display: flex;
  justify-content: flex-start;
}
</style>
