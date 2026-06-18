<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Helper pane for configuring WeeChat/Irssi against Lurker's built-in IRC
  bouncer. Tokens are still normal read-write API tokens; this pane just mints
  them with the right scope and shows the network-id suffixes clients need.
-->

<template>
  <section id="bouncer" class="settings-pane">
    <h2>bouncer</h2>
    <p class="section-desc">
      Connect WeeChat, Irssi, or another IRC client to Lurker's built-in bouncer. Create a bouncer
      token here, then use it as the IRC server password with the network id suffix. The built-in
      listener is plain TCP; enable TLS here only if you put it behind a TLS-capable TCP proxy.
    </p>
    <p v-if="error" class="error inline">{{ error }}</p>

    <h3 class="subhead">server</h3>
    <div class="server-grid">
      <label>
        <span>Host</span>
        <input v-model="host" type="text" spellcheck="false" />
      </label>
      <label>
        <span>Port</span>
        <input v-model="port" type="text" inputmode="numeric" spellcheck="false" />
      </label>
      <label class="check">
        <input v-model="tls" type="checkbox" />
        <span>TLS</span>
      </label>
    </div>

    <h3 class="subhead">create bouncer token</h3>
    <form class="create-form" @submit.prevent="onCreate">
      <label>
        <span>Name</span>
        <input v-model="newName" type="text" maxlength="64" placeholder="e.g. weechat" />
      </label>
      <div class="create-actions">
        <button class="link" type="submit" :disabled="busy || !newName.trim()">
          create bouncer token
        </button>
      </div>
    </form>

    <div v-if="revealed" class="reveal">
      <p class="reveal-warning">
        <strong>{{ revealed.name }}</strong> — copy this token now. It will not be shown again.
      </p>
      <div class="reveal-row">
        <code class="token">{{ revealed.token }}</code>
        <button class="link" type="button" @click="copyText(revealed.token, 'token')">
          {{ copied === 'token' ? 'copied' : 'copy' }}
        </button>
        <button class="link" type="button" @click="revealed = null">dismiss</button>
      </div>
    </div>

    <h3 class="subhead">network ids</h3>
    <p v-if="!networks.networks.length" class="muted small">
      No networks yet — add one from the chat sidebar first.
    </p>
    <ul v-else class="network-list">
      <li v-for="net in networks.networks" :key="net.id" class="network-row">
        <span class="network-name">{{ net.name }}</span>
        <span class="network-host">{{ net.host }}</span>
        <code class="network-id">:{{ net.id }}</code>
      </li>
    </ul>

    <template v-if="revealed && networks.networks.length">
      <h3 class="subhead">weechat</h3>
      <div class="command-list">
        <div v-for="net in networks.networks" :key="`weechat-${net.id}`" class="command-row">
          <span class="command-name">{{ net.name }}</span>
          <code>{{ weechatCommand(net) }}</code>
          <button class="link" type="button" @click="copyText(weechatCommand(net), `w-${net.id}`)">
            {{ copied === `w-${net.id}` ? 'copied' : 'copy' }}
          </button>
        </div>
      </div>

      <h3 class="subhead">irssi</h3>
      <div class="command-list">
        <div v-for="net in networks.networks" :key="`irssi-${net.id}`" class="command-row">
          <span class="command-name">{{ net.name }}</span>
          <code>{{ irssiCommand(net) }}</code>
          <button class="link" type="button" @click="copyText(irssiCommand(net), `i-${net.id}`)">
            {{ copied === `i-${net.id}` ? 'copied' : 'copy' }}
          </button>
        </div>
      </div>
    </template>

    <p v-else class="muted small">Create a bouncer token to show ready-to-copy client commands.</p>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../../api.js';
import { useNetworksStore } from '../../stores/networks.js';
import type { Network } from '../../stores/networks.js';

interface RevealedToken {
  name: string;
  token: string;
}

const networks = useNetworksStore();
const host = ref(window.location.hostname || 'localhost');
const port = ref('6667');
const tls = ref(false);
const newName = ref('weechat bouncer');
const revealed = ref<RevealedToken | null>(null);
const copied = ref('');
const busy = ref(false);
const error = ref('');

onMounted(() => {
  if (!networks.networks.length) {
    networks.fetchAll().catch((e: any) => {
      error.value = e.message || 'failed to load networks';
    });
  }
});

async function onCreate() {
  if (!newName.value.trim()) return;
  error.value = '';
  busy.value = true;
  try {
    const created = await api('/api/api-tokens', {
      method: 'POST',
      body: {
        name: newName.value.trim(),
        scope: 'read-write',
      },
    });
    revealed.value = { name: created.name, token: created.token };
    copied.value = '';
  } catch (e: any) {
    error.value = e.message || 'failed to create token';
  } finally {
    busy.value = false;
  }
}

async function copyText(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = key;
  } catch (_) {
    error.value = 'clipboard unavailable — select and copy manually';
  }
}

function passwordFor(net: Network): string {
  return `${revealed.value?.token || '<token>'}:${net.id}`;
}

function safeServerName(net: Network): string {
  const base = `lurker-${net.name}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  return base.replace(/^-+|-+$/g, '') || `lurker-${net.id}`;
}

function weechatCommand(net: Network): string {
  const tlsFlag = tls.value ? ' -tls' : '';
  return `/server add ${safeServerName(net)} ${host.value}/${port.value}${tlsFlag} -password=${passwordFor(net)}`;
}

function irssiCommand(net: Network): string {
  const tlsFlag = tls.value ? ' -ssl' : '';
  return `/server add -network ${safeServerName(net)}${tlsFlag} -port ${port.value} -password ${passwordFor(net)} ${host.value}`;
}
</script>

<style src="./panes.css"></style>
<style scoped>
.server-grid,
.create-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin-top: var(--space-2);
  max-width: 420px;
}
.server-grid label,
.create-form label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: var(--fg-muted);
}
.server-grid label.check {
  flex-direction: row;
  align-items: center;
  gap: var(--space-4);
  color: var(--fg);
}
.server-grid label span,
.create-form label span {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.server-grid label.check span {
  text-transform: none;
  letter-spacing: 0;
}
.create-actions {
  display: flex;
  gap: 1ch;
  align-items: center;
  margin-top: var(--space-1);
}

.reveal {
  margin: var(--space-6) 0;
  padding: var(--space-5) var(--space-6);
  border: 1px solid var(--accent);
  background: var(--bg-soft);
}
.reveal-warning {
  margin: 0 0 var(--space-3);
  color: var(--fg);
}
.reveal-row {
  display: flex;
  align-items: center;
  gap: 1ch;
  flex-wrap: wrap;
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

.network-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.network-row {
  display: grid;
  grid-template-columns: minmax(10ch, max-content) 1fr max-content;
  gap: var(--space-6);
  align-items: center;
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border);
}
.network-row:first-child {
  border-top: none;
}
.network-row:hover {
  background: var(--bg-soft);
}
.network-name {
  color: var(--fg);
}
.network-host {
  color: var(--fg-muted);
  min-width: 0;
  overflow-wrap: anywhere;
}
.network-id {
  color: var(--accent);
}

.command-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.command-row {
  display: grid;
  grid-template-columns: minmax(8ch, max-content) minmax(0, 1fr) max-content;
  gap: var(--space-4);
  align-items: center;
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border);
}
.command-row:first-child {
  border-top: none;
}
.command-name {
  color: var(--fg);
}
.command-row code {
  min-width: 0;
  overflow-wrap: anywhere;
  user-select: all;
}

@media (max-width: 720px) {
  .network-row,
  .command-row {
    grid-template-columns: 1fr;
    gap: var(--space-2);
  }
}
</style>
