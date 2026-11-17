<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Per-user bearer tokens for the MCP server and HTTP API. Mints a token,
  reveals it inline exactly once, lists active + revoked tokens, allows soft
  revoke. Mirrors AccountPane's structure for the device-list + form patterns.
-->

<template>
  <section id="api-tokens" class="settings-pane">
    <h2>api tokens</h2>
    <p class="section-desc">
      Bearer tokens grant scripts and AI agents access to your Lurker data through the MCP endpoint
      at <code>/mcp</code>. Each token belongs to your account only and can be revoked at any time.
      The token itself is shown <strong>once</strong> on creation — copy it before closing the row.
    </p>
    <p v-if="error" class="error inline">{{ error }}</p>

    <p class="add-row">
      <button class="btn-secondary" :disabled="busy" @click="openCreate">create token</button>
    </p>

    <!-- Two stages, as the invite modal: name the token, then the token itself,
         shown this once. Closing the second stage is what dismisses it. -->
    <FormModal
      v-if="creating"
      word="token"
      size="sm"
      :title="revealed ? 'api token' : 'create api token'"
      submit-label="Create token"
      :can-submit="!!newName.trim()"
      :busy="busy"
      :error="createError"
      @submit="onCreate"
      @close="closeCreate"
    >
      <div v-if="revealed" class="reveal">
        <p class="reveal-warning">
          <strong>{{ revealed.name }}</strong> — copy this token now. It will not be shown again.
        </p>
        <code class="token">{{ revealed.token }}</code>
      </div>
      <div v-else class="create-form">
        <label>
          <span>Name</span>
          <input
            :value="newName"
            @input="onNameInput"
            type="text"
            maxlength="64"
            placeholder="e.g. claude-desktop, autonotes"
          />
        </label>
        <label class="check">
          <input v-model="newAllowWrite" type="checkbox" />
          <span>Allow this token to send messages and write notes</span>
        </label>
      </div>
      <template v-if="revealed" #footer>
        <button type="button" class="btn-secondary" @click="onCopy">
          {{ copied ? 'copied' : 'copy token' }}
        </button>
        <button type="button" class="btn-primary" @click="closeCreate">Done</button>
      </template>
    </FormModal>

    <h3 class="subhead">existing tokens</h3>
    <ul v-if="tokens.length" class="device-list">
      <li v-for="t in tokens" :key="t.id" class="device token-row">
        <span class="ua">
          <span class="name">{{ t.name }}</span>
          <span class="scope">{{ t.scope }}</span>
          <span v-if="t.revokedAt" class="revoked">revoked</span>
        </span>
        <span class="last-seen" :title="t.lastUsedAt || t.createdAt">
          {{
            t.lastUsedAt
              ? `last used ${formatRelative(t.lastUsedAt)}`
              : `created ${formatRelative(t.createdAt)}`
          }}
        </span>
        <span v-if="!t.revokedAt" class="btn-bar">
          <button class="bad" :disabled="busy" @click="onRevoke(t)">revoke</button>
        </span>
        <span v-else class="placeholder" />
      </li>
    </ul>
    <p v-else class="muted small">No API tokens yet.</p>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../../api.js';
import { formatRelative } from '../../utils/timestamp.js';
import { useImeSafeInput } from '../../composables/useImeSafeInput.js';
import FormModal from '../FormModal.vue';

interface ApiToken {
  id: string;
  name: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface RevealedToken {
  name: string;
  token: string;
}

const tokens = ref<ApiToken[]>([]);
const newName = ref('');
const onNameInput = useImeSafeInput(newName);
// Settings → Bouncer links here for a token to log an IRC client in with, and
// the bouncer refuses a read-only one — so that link asks for the box to start
// ticked (?scope=read-write) rather than sending people to a form whose default
// makes a token that can't work.
const wantsWrite = useRoute().query.scope === 'read-write';
const newAllowWrite = ref(wantsWrite);
// ...and opens the form, since making a token is what that link is for.
const creating = ref(wantsWrite);
const createError = ref('');
const revealed = ref<RevealedToken | null>(null);
const copied = ref(false);
const busy = ref(false);
const error = ref('');

onMounted(() => {
  refresh();
});

async function refresh() {
  error.value = '';
  try {
    const { items } = await api('/api/api-tokens');
    tokens.value = items;
  } catch (e: any) {
    error.value = e.message || 'failed to load tokens';
  }
}

function openCreate() {
  createError.value = '';
  revealed.value = null;
  creating.value = true;
}

function closeCreate() {
  creating.value = false;
  revealed.value = null;
  createError.value = '';
  newName.value = '';
  newAllowWrite.value = false;
}

async function onCreate() {
  if (!newName.value.trim()) return;
  createError.value = '';
  busy.value = true;
  try {
    const created = await api('/api/api-tokens', {
      method: 'POST',
      body: {
        name: newName.value.trim(),
        scope: newAllowWrite.value ? 'read-write' : 'read',
      },
    });
    revealed.value = { name: created.name, token: created.token };
    copied.value = false;
    newName.value = '';
    newAllowWrite.value = false;
    await refresh();
  } catch (e: any) {
    createError.value = e.message || 'failed to create token';
  } finally {
    busy.value = false;
  }
}

async function onCopy() {
  if (!revealed.value) return;
  try {
    await navigator.clipboard.writeText(revealed.value.token);
    copied.value = true;
  } catch (_) {
    // Clipboard permission denied (rare; mostly insecure-context). The user
    // can still select+copy from the rendered <code>.
    createError.value = 'clipboard unavailable — select and copy the token manually';
  }
}

async function onRevoke(token: ApiToken) {
  if (!confirm(`Revoke ${token.name}? Scripts using this token will lose access.`)) return;
  error.value = '';
  busy.value = true;
  try {
    await api(`/api/api-tokens/${token.id}`, { method: 'DELETE' });
    await refresh();
  } catch (e: any) {
    error.value = e.message || 'revoke failed';
  } finally {
    busy.value = false;
  }
}
</script>

<style src="./panes.css"></style>
<style scoped>
.create-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-7);
}
.create-form label {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--fg-muted);
}
.create-form label.check {
  flex-direction: row;
  align-items: center;
  gap: var(--space-4);
  color: var(--fg);
}
.create-form label span {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.create-form label.check span {
  text-transform: none;
  letter-spacing: 0;
  font-size: inherit;
}
.add-row {
  margin: 0 0 var(--space-4);
}

.reveal {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.reveal-warning {
  margin: 0 0 var(--space-3);
  color: var(--fg);
}
.token {
  flex: 1 1 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
  user-select: all;
  background: var(--bg);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border);
  min-width: 0;
}

.token-row .name {
  color: var(--fg);
}
.token-row .scope {
  color: var(--fg-muted);
  font-variant: small-caps;
}
.token-row .revoked {
  color: var(--bad);
  font-variant: small-caps;
}
.token-row .placeholder {
  width: 0;
}
</style>
