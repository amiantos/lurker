<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="login">
    <WordBackdrop :word="backdropWord" />
    <div class="card">
      <h1>lurker</h1>

      <template v-if="loadingStatus">
        <p class="subtitle">Checking setup…</p>
      </template>

      <!-- First-run bootstrap: empty DB, ask for admin username -->
      <template v-else-if="setup?.needsSetup">
        <p class="subtitle">First run — pick a username and password.</p>
        <p class="warning">Only use a Lurker instance belonging to yourself or a close friend!</p>
        <form @submit.prevent="onCreateUser">
          <label>
            <span>Username</span>
            <input
              v-model="username"
              autocomplete="username"
              autofocus
              required
              placeholder="lurker username"
              :pattern="USERNAME_PATTERN"
              :maxlength="MAX_USERNAME_LENGTH"
              title="Letters, numbers, and . _ - — no spaces"
            />
          </label>
          <p class="hint">
            Your Lurker account login — not the nick you'll use on IRC networks. Letters, numbers
            and
            <code>. _ -</code>, no spaces; it isn't case-sensitive.
          </p>
          <label>
            <span>Password</span>
            <input
              v-model="password"
              type="password"
              autocomplete="new-password"
              required
              minlength="8"
            />
          </label>
          <p class="hint">8+ characters. You can add a passkey later in settings.</p>
          <button type="submit" class="btn-primary" :disabled="working">
            {{ submitLabel }}
          </button>
        </form>
      </template>

      <!-- Normal login -->
      <template v-else>
        <p class="subtitle">Sign in to your IRC client.</p>
        <button v-if="authMethods.passkey" class="btn-primary" :disabled="working" @click="onLogin">
          {{ working && loginMode === 'passkey' ? 'Waiting for passkey…' : 'Sign in with passkey' }}
        </button>

        <form @submit.prevent="onPasswordLogin" class="password-form">
          <label>
            <span>Username</span>
            <input v-model="username" autocomplete="username" required />
          </label>
          <label>
            <span>Password</span>
            <input v-model="password" type="password" autocomplete="current-password" required />
          </label>
          <button type="submit" class="btn-primary" :disabled="working">
            {{ working && loginMode === 'password' ? 'Signing in…' : 'Sign in with password' }}
          </button>
        </form>

        <!-- There is no self-service reset to link to: accounts here carry no
             email address, so nothing could verify the request. Recovery runs
             through the admin (#855).
             Shown by DEFAULT and hidden once /api/config resolves as node, not
             the other way round: `edition` defaults to 'standalone', so a cell
             flashes this line for the length of that fetch. Deliberate — gating
             on config.checked would instead hide it on every standalone login,
             which is the common case and the one that needs it. A hosted cell
             signs in through the control plane anyway. -->
        <p v-if="!config.isNode" class="hint">
          Locked out? Accounts here have no email address — ask your instance admin for a recovery
          link.
        </p>
      </template>

      <p v-if="auth.error" class="error">{{ auth.error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import type { SetupStatus } from '../stores/auth.js';
import { useAuthStore } from '../stores/auth.js';
import { useConfigStore } from '../stores/config.js';
import WordBackdrop from '../components/WordBackdrop.vue';
import { USERNAME_PATTERN, MAX_USERNAME_LENGTH } from '../../../shared/username.js';

interface AuthMethods {
  passkey: boolean;
}

const username = ref('');
const password = ref('');
const working = ref(false);
const loadingStatus = ref(true);
const auth = useAuthStore();
// Defaults to standalone, so a config fetch that hasn't landed shows the line —
// the right default, since standalone is the only edition that self-hosts.
const config = useConfigStore();
const router = useRouter();
const route = useRoute();
const setup = ref<SetupStatus | null>(null);
const authMethods = ref<AuthMethods>({ passkey: false });
const loginMode = ref<'passkey' | 'password' | null>(null);

const submitLabel = computed(() => (working.value ? 'Creating account…' : 'Create account'));

// Swap the wallpaper word so the first-run sign-up screen feels distinct
// from the regular login.
const backdropWord = computed(() => (setup.value?.needsSetup ? 'welcome' : 'lurker'));

onMounted(async () => {
  setup.value = await auth.fetchSetupStatus();
  if (!setup.value?.needsSetup) {
    authMethods.value = await auth.fetchAuthMethods();
  }
  loadingStatus.value = false;
});

function nextDestination(): string {
  const next = route.query.next;
  return typeof next === 'string' && next ? next : '/';
}

async function onLogin() {
  working.value = true;
  loginMode.value = 'passkey';
  try {
    await auth.loginWithPasskey();
    router.replace(nextDestination());
  } catch (_) {
    // displayed via auth.error
  } finally {
    working.value = false;
    loginMode.value = null;
  }
}

async function onPasswordLogin() {
  if (!username.value.trim() || !password.value) return;
  working.value = true;
  loginMode.value = 'password';
  try {
    await auth.loginWithPassword({
      username: username.value.trim(),
      password: password.value,
    });
    router.replace(nextDestination());
  } catch (_) {
    // displayed via auth.error
  } finally {
    working.value = false;
    loginMode.value = null;
  }
}

async function onCreateUser() {
  if (!username.value.trim() || !password.value) return;
  working.value = true;
  try {
    await auth.setupFirstPassword({
      username: username.value.trim(),
      password: password.value,
    });
    router.replace(nextDestination());
  } catch (_) {
    // displayed via auth.error
    setup.value = await auth.fetchSetupStatus();
  } finally {
    working.value = false;
  }
}
</script>

<style scoped>
.login {
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
  /* Floating-surface chrome shared with the modals (AppModal .card): a subtle
     --border (not the old loud accent frame), a hair of radius, and the shared
     drop shadow — the card floats on the WordBackdrop. */
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
.error {
  margin: 0;
  color: var(--bad);
}
.password-form {
  margin-top: var(--space-2);
}
.hint {
  margin: 0;
  color: var(--fg-muted);
}
</style>
