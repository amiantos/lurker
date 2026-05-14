<template>
  <div class="login">
    <div class="card">
      <h1>Lurker</h1>

      <template v-if="loadingStatus">
        <p class="subtitle">Checking setup…</p>
      </template>

      <!-- First-run bootstrap: empty DB, ask for admin username -->
      <template v-else-if="setup?.needsSetup">
        <p class="subtitle">First run — pick a username, then a sign-in method.</p>
        <p class="warning">
          Only use a Lurker instance belonging to yourself or a close friend!
        </p>
        <div class="method-toggle">
          <button
            type="button"
            class="link toggle-btn"
            :class="{ active: setupMethod === 'passkey' }"
            @click="setupMethod = 'passkey'"
          >passkey</button>
          <button
            type="button"
            class="link toggle-btn"
            :class="{ active: setupMethod === 'password' }"
            @click="setupMethod = 'password'"
          >password</button>
        </div>
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
          <template v-if="setupMethod === 'password'">
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
          </template>
          <button type="submit" :disabled="working">
            {{ submitLabel }}
          </button>
        </form>
      </template>

      <!-- Normal login -->
      <template v-else>
        <p class="subtitle">Sign in to your IRC client.</p>
        <button
          v-if="authMethods.passkey"
          class="primary"
          :disabled="working"
          @click="onLogin"
        >
          {{ working && loginMode === 'passkey' ? 'Waiting for passkey…' : 'Sign in with passkey' }}
        </button>

        <button
          v-if="authMethods.passkey && !showPasswordForm"
          type="button"
          class="link toggle-link"
          @click="showPasswordForm = true"
        >or sign in with password</button>

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

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const username = ref('');
const password = ref('');
const working = ref(false);
const loadingStatus = ref(true);
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const setup = ref(null);
const authMethods = ref({ passkey: false });
const setupMethod = ref('passkey');
const showPasswordForm = ref(false);
const loginMode = ref(null);

const submitLabel = computed(() => {
  if (!working.value) return 'Create account';
  return setupMethod.value === 'password' ? 'Creating account…' : 'Creating passkey…';
});

onMounted(async () => {
  setup.value = await auth.fetchSetupStatus();
  if (!setup.value?.needsSetup) {
    authMethods.value = await auth.fetchAuthMethods();
    if (!authMethods.value.passkey) showPasswordForm.value = true;
  }
  loadingStatus.value = false;
});

function nextDestination() {
  return route.query.next || '/';
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
  if (!username.value.trim()) return;
  working.value = true;
  try {
    if (setupMethod.value === 'password') {
      if (!password.value) return;
      await auth.setupFirstPassword({
        username: username.value.trim(),
        password: password.value,
      });
    } else {
      await auth.setupFirstPasskey({ username: username.value.trim() });
    }
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
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.card {
  border: 1px solid var(--accent);
  padding: 20px 24px;
  width: 360px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
h1 { margin: 0; color: var(--accent); font-weight: 600; }
.subtitle { margin: 0; color: var(--fg-muted); }
.warning {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--warn, var(--accent));
  color: var(--warn, var(--accent));
  background: transparent;
}
form { display: flex; flex-direction: column; gap: 12px; margin: 0; }
label { display: flex; flex-direction: column; gap: 3px; color: var(--fg-muted); }
label span { text-transform: uppercase; letter-spacing: 0.04em; }
button { cursor: pointer; }
button.primary { padding: 8px 12px; }
.error { margin: 0; color: var(--bad); }
.method-toggle {
  display: flex;
  gap: 8px;
  align-items: center;
}
.toggle-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  padding: 4px 10px;
  text-transform: lowercase;
}
.toggle-btn.active {
  color: var(--accent);
  border-color: var(--accent);
}
.toggle-link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.toggle-link:hover { color: var(--fg); }
.password-form { margin-top: 4px; }
.hint { margin: 0; color: var(--fg-muted); font-size: 0.9em; }
</style>
