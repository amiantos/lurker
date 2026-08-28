<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Redemption page for an admin-issued account recovery link (#855). Reached only
  by URL, and the token in that URL is the whole authorization — there is no
  account to sign into first, which is the point.

  Two ways out, because there are two ways in: set a password, or enroll a
  passkey. A member whose only credential was a passkey on a lost phone has no
  password to reset, so offering only the password half would strand exactly the
  case this exists for.

  Either way the account ends up with exactly ONE credential — the one chosen
  here. Recovery assumes the account may have been taken over, and a password an
  attacker set or a passkey they enrolled would otherwise outlive it.
-->

<template>
  <div class="recover">
    <WordBackdrop word="recover" />
    <div class="card">
      <h1>lurker</h1>

      <template v-if="checking">
        <p class="subtitle">Checking link…</p>
      </template>

      <template v-else-if="!status?.valid">
        <p class="subtitle">This recovery link is no longer valid.</p>
        <p class="muted">
          Links are single-use and expire after 24 hours. Ask your instance admin for a fresh one.
        </p>
        <RouterLink to="/login" class="link">go to sign-in</RouterLink>
      </template>

      <template v-else>
        <p class="subtitle">
          Recovering <strong>{{ status.username }}</strong
          >.
        </p>
        <p class="warning">
          This replaces every way into the account. Other devices are signed out, and any existing
          password and passkeys stop working.
        </p>

        <form @submit.prevent="onSetPassword">
          <label>
            <span>{{ status.hasPassword ? 'New password' : 'Password' }}</span>
            <input
              v-model="password"
              type="password"
              autocomplete="new-password"
              autofocus
              required
              minlength="8"
            />
          </label>
          <p class="hint">8+ characters.</p>
          <button type="submit" class="btn-primary" :disabled="working || !password">
            {{ passwordLabel }}
          </button>
        </form>

        <div class="divider"><span>or</span></div>

        <button class="btn-primary" :disabled="working" @click="onAddPasskey">
          {{ mode === 'passkey' && working ? 'Waiting for passkey…' : 'Register a passkey' }}
        </button>
        <p class="hint">This becomes the account's only sign-in method.</p>

        <p v-if="auth.error" class="error">{{ auth.error }}</p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import WordBackdrop from '../components/WordBackdrop.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

interface RecoveryStatus {
  valid: boolean;
  username?: string;
  hasPassword?: boolean;
  expiresAt?: string;
}

const status = ref<RecoveryStatus | null>(null);
const checking = ref(true);
const password = ref('');
const working = ref(false);
const mode = ref<'password' | 'passkey' | null>(null);

const token = computed(() => route.params.token as string);

const passwordLabel = computed(() => {
  if (mode.value === 'password' && working.value) return 'Signing in…';
  return status.value?.hasPassword ? 'Set new password' : 'Set password';
});

onMounted(async () => {
  try {
    status.value = await auth.fetchRecoveryStatus(token.value);
  } catch (_) {
    status.value = { valid: false };
  } finally {
    checking.value = false;
  }
});

async function onSetPassword() {
  if (!password.value || working.value) return;
  working.value = true;
  mode.value = 'password';
  try {
    await auth.recoverWithPassword({ token: token.value, password: password.value });
    router.replace('/');
  } catch (_) {
    // surfaced via auth.error
  } finally {
    working.value = false;
    mode.value = null;
  }
}

async function onAddPasskey() {
  if (working.value) return;
  working.value = true;
  mode.value = 'passkey';
  try {
    await auth.recoverWithPasskey({ token: token.value });
    router.replace('/');
  } catch (_) {
    // surfaced via auth.error
  } finally {
    working.value = false;
    mode.value = null;
  }
}
</script>

<style scoped>
.recover {
  position: relative;
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.card {
  position: relative;
  z-index: var(--z-base);
  width: min(380px, 92vw);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  padding: var(--space-9);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
h1 {
  margin: 0 0 var(--space-2);
  color: var(--accent);
  font-weight: 700;
  text-transform: lowercase;
  font-size: clamp(2.5rem, 5vw, 3.5rem);
  line-height: 1.15;
  letter-spacing: -0.02em;
}
.subtitle {
  margin: 0;
  color: var(--fg-muted);
}
.muted {
  margin: 0;
  color: var(--fg-muted);
  font-style: italic;
}
.warning {
  margin: 0;
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--warn, var(--accent));
  color: var(--warn, var(--accent));
  background: transparent;
}
form {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  margin: 0;
}
label {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--fg-muted);
}
label span {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
/* Two equal ways in, not a primary and a fallback — the rule says so out loud. */
.divider {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  color: var(--fg-muted);
}
.divider::before,
.divider::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border);
}
.error {
  margin: 0;
  color: var(--bad);
}
.link {
  color: var(--accent);
}
.hint {
  margin: 0;
  color: var(--fg-muted);
}
</style>
