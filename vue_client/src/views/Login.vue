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
            />
          </label>
          <p class="hint">Your Lurker account login — not the nick you'll use on IRC networks.</p>
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
          <button type="submit" :disabled="working">
            {{ submitLabel }}
          </button>
        </form>
      </template>

      <!-- Normal login -->
      <template v-else>
        <p class="subtitle">Sign in to your IRC client.</p>
        <button v-if="authMethods.passkey" class="primary" :disabled="working" @click="onLogin">
          {{ working && loginMode === 'passkey' ? 'Waiting for passkey…' : 'Sign in with passkey' }}
        </button>

        <button
          v-if="authMethods.passkey && !showPasswordForm"
          type="button"
          class="link toggle-link"
          @click="showPasswordForm = true"
        >
          or sign in with password
        </button>

        <form
          v-if="showPasswordForm || !authMethods.passkey"
          @submit.prevent="onPasswordLogin"
          class="password-form"
        >
          <label>
            <span>Username</span>
            <input v-model="username" autocomplete="username" required />
          </label>
          <label>
            <span>Password</span>
            <input v-model="password" type="password" autocomplete="current-password" required />
          </label>
          <button type="submit" :disabled="working">
            {{ working && loginMode === 'password' ? 'Signing in…' : 'Sign in with password' }}
          </button>
        </form>
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
import WordBackdrop from '../components/WordBackdrop.vue';

interface AuthMethods {
  passkey: boolean;
}

const username = ref('');
const password = ref('');
const working = ref(false);
const loadingStatus = ref(true);
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const setup = ref<SetupStatus | null>(null);
const authMethods = ref<AuthMethods>({ passkey: false });
const showPasswordForm = ref(false);
const loginMode = ref<'passkey' | 'password' | null>(null);

const submitLabel = computed(() => (working.value ? 'Creating account…' : 'Create account'));

// Swap the wallpaper word so the first-run sign-up screen feels distinct
// from the regular login.
const backdropWord = computed(() => (setup.value?.needsSetup ? 'welcome' : 'lurker'));

onMounted(async () => {
  setup.value = await auth.fetchSetupStatus();
  if (!setup.value?.needsSetup) {
    authMethods.value = await auth.fetchAuthMethods();
    if (!authMethods.value.passkey) showPasswordForm.value = true;
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
  background: var(--bg);
  border: 1px solid var(--accent);
  padding: var(--space-9);
  width: 360px;
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
button {
  cursor: pointer;
}
button.primary {
  padding: var(--space-4) var(--space-6);
}
.error {
  margin: 0;
  color: var(--bad);
}
.toggle-link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.toggle-link:hover {
  color: var(--fg);
}
.password-form {
  margin-top: var(--space-2);
}
.hint {
  margin: 0;
  color: var(--fg-muted);
}
</style>
