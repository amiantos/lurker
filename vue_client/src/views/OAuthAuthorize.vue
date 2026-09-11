<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Approval page for a third-party app's OAuth sign-in (#891). The app sends the
  member here with its authorize request in the query string; the server checks
  the request and says who is asking and where an approval goes.

  Only the member's own Approve or Deny click navigates anywhere. A bad request is
  shown here and never bounced back: registration is open, so the redirect on a
  rejected request could belong to anyone.

  Inside a frame it renders nothing and calls nothing. The server's
  frame-ancestors header is the real defence; this covers a browser that ignores
  it, so a hostile page can't overlay the Approve button.
-->

<template>
  <div v-if="!framed" class="authorize">
    <WordBackdrop word="authorize" />
    <div class="card">
      <h1>lurker</h1>

      <template v-if="state === 'checking'">
        <p class="subtitle">Checking request…</p>
      </template>

      <template v-else-if="state === 'error'">
        <p class="subtitle">This app can't be authorized.</p>
        <p class="error">{{ errorText }}</p>
      </template>

      <template v-else-if="state === 'approve' && info">
        <p class="subtitle">Authorize this app?</p>
        <p class="app-name">{{ info.app.name }}</p>
        <!-- The app sets its website when it registers and nothing checks it, so
             it's shown as the app's claim rather than as who made it. -->
        <p v-if="info.app.website" class="hint">Says it's from {{ info.app.website }}</p>
        <p class="warning">It will have full access to your account.</p>
        <p class="hint">
          <template v-if="info.destination.kind === 'code'">
            You'll get a code to paste into the app
          </template>
          <template v-else-if="info.destination.kind === 'loopback'">
            Returns to an app on this computer
          </template>
          <template v-else-if="info.destination.kind === 'app'">
            Opens <code>{{ info.destination.scheme }}:</code>
          </template>
          <template v-else-if="info.destination.kind === 'web'">
            Returns to <code>{{ info.destination.host }}</code>
          </template>
        </p>
        <div class="actions">
          <button class="btn-primary" :disabled="working" @click="decide('approve')">
            Approve
          </button>
          <button class="btn-secondary" :disabled="working" @click="decide('deny')">Deny</button>
        </div>
      </template>

      <template v-else-if="state === 'code'">
        <p class="subtitle">
          Paste this code into <strong>{{ info?.app.name }}</strong
          >.
        </p>
        <div class="code-row">
          <code class="code">{{ code }}</code>
          <button class="btn-secondary" @click="onCopy">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
        <p v-if="copyError" class="error">{{ copyError }}</p>
        <p class="hint">You can close this page after pasting it.</p>
      </template>

      <template v-else-if="state === 'approved'">
        <p class="subtitle">Approved. You can close this page.</p>
      </template>

      <template v-else-if="state === 'denied'">
        <p class="subtitle">Denied. You can close this page.</p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, type ApiError } from '../api.js';
import WordBackdrop from '../components/WordBackdrop.vue';

type Destination =
  | { kind: 'code' }
  | { kind: 'loopback' }
  | { kind: 'app'; scheme: string }
  | { kind: 'web'; host: string };

interface AuthorizeInfo {
  app: { name: string; website: string | null };
  destination: Destination;
  // The authorize request exactly as the server read and checked it.
  request: Record<string, string>;
}

interface DecisionResult {
  redirect?: string;
  code?: string;
  denied?: boolean;
}

const GENERIC_ERROR = 'Something went wrong. Start again from the app.';

// Any frame counts, same-origin included. Comparing a cross-origin `top` is
// allowed; the catch is for a browser that throws on it anyway.
function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

const framed = isFramed();
const state = ref<'checking' | 'error' | 'approve' | 'code' | 'approved' | 'denied'>('checking');
const info = ref<AuthorizeInfo | null>(null);
const errorText = ref('');
const code = ref('');
const copied = ref(false);
const copyError = ref('');
const working = ref(false);

function showError(e: unknown) {
  const data = (e as ApiError | null)?.data as { error_description?: unknown } | null | undefined;
  const description = data && typeof data === 'object' ? data.error_description : undefined;
  errorText.value = typeof description === 'string' && description ? description : GENERIC_ERROR;
  state.value = 'error';
}

onMounted(async () => {
  if (framed) return;
  try {
    // The query string goes to the server untouched, exactly as the app sent it.
    info.value = await api<AuthorizeInfo>(`/api/oauth/authorize${window.location.search}`);
    state.value = 'approve';
  } catch (e) {
    showError(e);
  }
});

async function decide(decision: 'approve' | 'deny') {
  const request = info.value?.request;
  if (working.value || !request) return;
  working.value = true;
  let result: DecisionResult | null;
  try {
    // Post back the request the server described, never a fresh reading of this
    // page's URL. A second parser can read a crafted query string differently
    // (Express stops at 1000 keys, URLSearchParams doesn't), which would show one
    // app and approve another.
    result = await api<DecisionResult | null>('/api/oauth/authorize', {
      method: 'POST',
      body: { ...request, decision },
    });
  } catch (e) {
    working.value = false;
    showError(e);
    return;
  }
  if (typeof result?.redirect === 'string') {
    window.location.assign(result.redirect);
    // A custom-scheme redirect hands off to another app and leaves this tab where
    // it is, so say it's done. Web and loopback redirects navigate this tab away
    // themselves; until they do, the buttons stay disabled rather than inviting a
    // close that would cancel the redirect, or a second click that mints a second
    // code.
    if (info.value?.destination.kind === 'app') {
      state.value = decision === 'approve' ? 'approved' : 'denied';
    }
  } else if (typeof result?.code === 'string') {
    code.value = result.code;
    state.value = 'code';
  } else if (result?.denied === true) {
    state.value = 'denied';
  } else {
    showError(null);
  }
}

async function onCopy() {
  copyError.value = '';
  try {
    await navigator.clipboard.writeText(code.value);
    copied.value = true;
  } catch (_) {
    // Clipboard permission denied (rare; mostly insecure-context). The code
    // stays selectable in the rendered <code>.
    copyError.value = 'Clipboard unavailable — select and copy the code manually.';
  }
}
</script>

<style scoped>
.authorize {
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
/* The app picks its own name, so it can be long and unbroken. */
.app-name {
  margin: 0;
  color: var(--fg);
  font-weight: 700;
  overflow-wrap: anywhere;
}
.warning {
  margin: 0;
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--warn, var(--accent));
  color: var(--warn, var(--accent));
  background: transparent;
}
.hint {
  margin: 0;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  gap: var(--space-4);
}
.actions button {
  flex: 1;
}
.code-row {
  display: flex;
  align-items: center;
  gap: 1ch;
  flex-wrap: wrap;
}
.code {
  flex: 1 1 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
  user-select: all;
  background: var(--bg-soft);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border);
  min-width: 0;
}
.error {
  margin: 0;
  color: var(--bad);
}
</style>
