<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="invite">
    <WordBackdrop word="welcome" />
    <div class="card">
      <h1>lurker</h1>

      <template v-if="checking">
        <p class="subtitle">Checking invite…</p>
      </template>

      <template v-else-if="!status?.valid">
        <p class="subtitle">
          {{ status?.expired ? 'This invite has expired.' : 'This invite is not valid.' }}
        </p>
        <p class="muted">Ask the operator for a fresh link.</p>
        <RouterLink to="/login" class="link">go to sign-in</RouterLink>
      </template>

      <template v-else>
        <p class="subtitle">Welcome — pick a username and password.</p>
        <p class="warning">Only use a Lurker instance belonging to yourself or a close friend!</p>
        <p v-if="limitsNote" class="hint">{{ limitsNote }}</p>
        <form @submit.prevent="onAccept">
          <label>
            <span>Username</span>
            <input
              :value="username"
              @input="onUsernameInput"
              @keydown.enter="blockImeEnter"
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
          <button type="submit" class="btn-primary" :disabled="working || !canSubmit">
            {{ submitLabel }}
          </button>
        </form>
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
import { USERNAME_PATTERN, MAX_USERNAME_LENGTH } from '../../../shared/username.js';
import type { AccountRestrictions } from '../../../shared/accountRestrictions.js';
import { describeRestrictionsForMember } from '../utils/accountRestrictions.js';
import { blockImeEnter, useImeSafeInput } from '../composables/useImeSafeInput.js';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

interface InviteStatus {
  valid: boolean;
  expired?: boolean;
  // What the account will be held to (shared/accountRestrictions.ts), present
  // only when the invite carries a restriction.
  restrictions?: AccountRestrictions;
}

const status = ref<InviteStatus | null>(null);
const checking = ref(true);
const username = ref('');
const onUsernameInput = useImeSafeInput(username);
const password = ref('');
const working = ref(false);

const canSubmit = computed(() => {
  if (!username.value.trim()) return false;
  if (!password.value) return false;
  return true;
});

const submitLabel = computed(() => (working.value ? 'Creating account…' : 'Create account'));
const limitsNote = computed(() => describeRestrictionsForMember(status.value?.restrictions));

onMounted(async () => {
  try {
    status.value = await auth.fetchInviteStatus(route.params.token as string);
  } catch (_) {
    status.value = { valid: false };
  } finally {
    checking.value = false;
  }
});

async function onAccept() {
  const name = username.value.trim();
  if (!canSubmit.value) return;
  working.value = true;
  try {
    await auth.acceptInviteWithPassword({
      token: route.params.token as string,
      username: name,
      password: password.value,
    });
    router.replace('/');
  } catch (_) {
    // surfaced via auth.error
  } finally {
    working.value = false;
  }
}
</script>

<style scoped>
.invite {
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
