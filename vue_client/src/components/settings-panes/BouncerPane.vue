<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  How to attach an IRC client to this instance's bouncer. The category only
  exists where the instance runs one (features.bouncer), so this pane never has
  to explain a bouncer nobody has.
-->

<template>
  <section id="bouncer" class="settings-pane">
    <h2>bouncer</h2>
    <p class="section-desc">
      Lurker has an IRC bouncer built in that you can connect to with any IRC client instead of
      using the Lurker clients.
    </p>

    <table v-if="info" class="connect">
      <tbody>
        <tr>
          <th scope="row">Server</th>
          <td>
            <code>{{ host }}</code>
          </td>
        </tr>
        <tr>
          <th scope="row">Port</th>
          <td>
            <code>{{ port }}</code>
          </td>
        </tr>
        <tr>
          <th scope="row">TLS</th>
          <td>{{ tls ? 'Yes' : 'No' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="muted small">
      The server and port couldn’t be read just now — reload the page.
    </p>

    <h3 class="subhead">signing in</h3>
    <p class="muted small">
      Clients that support <code>soju.im/bouncer-networks</code> — Goguma, gamja, Halloy, SeraphIRC
      and more — take every network at once: sign in as <code>{{ username }}</code> with your
      password, and pick the network in the client.
    </p>
    <p class="muted small">
      Any other client attaches to one network at a time: sign in as
      <code>{{ username }}/{{ exampleNetwork }}</code>, with the network’s name as it appears in
      <RouterLink to="/settings/networks">Networks</RouterLink>.
    </p>
    <p class="muted small">
      For the password, a
      <RouterLink :to="{ path: '/settings/api-tokens', query: { scope: 'read-write' } }"
        >read-write API token</RouterLink
      >
      beats your account password: IRC clients store it in plain text, and a token can be revoked on
      its own.
    </p>

    <p v-if="certificate?.selfSigned" class="muted small fingerprint">
      Self-signed certificate, SHA-256 <code>{{ certificate.fingerprint }}</code>
    </p>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../../api.js';
import { useAuthStore } from '../../stores/auth.js';
import { useNetworksStore } from '../../stores/networks.js';

const auth = useAuthStore();
const networks = useNetworksStore();

// What the server says to connect to. `host` is null when the operator hasn't
// pinned an address (LURKER_BOUNCER_PUBLIC_URL): the bouncer can't sit behind
// the HTTP reverse proxy — it terminates its own TLS — so the web origin isn't
// reliably its address, and the host this page is on is the better guess.
interface BouncerInfo {
  host: string | null;
  port: number;
  tls: boolean;
  certificate: { selfSigned: boolean; fingerprint: string } | null;
}
const info = ref<BouncerInfo | null>(null);
onMounted(async () => {
  // The networks are fetched by the chat socket, which a direct load of
  // /settings/bouncer — a bookmark, or a reload while setting a client up —
  // never opens.
  if (!networks.loaded) networks.fetchAll().catch(() => {});
  try {
    info.value = await api<BouncerInfo>('/api/bouncer');
  } catch {
    /* the sign-in forms are the same either way; only the address is unknown */
  }
});

// Only read with `info` set: a guessed port, or a guessed "use TLS", is a
// sign-in that doesn't work — worse than saying the address couldn't be read.
const host = computed(() => info.value?.host || window.location.hostname);
const port = computed(() => info.value?.port);
const tls = computed(() => info.value?.tls !== false);
const certificate = computed(() => info.value?.certificate ?? null);
const username = computed(() => auth.user?.username || 'username');
// One of the user's own networks, so the form can be copied as it stands.
const exampleNetwork = computed(() => networks.networks[0]?.name || 'network');
</script>

<style src="./panes.css"></style>
<style scoped>
/* The prose is muted like every other pane; the values a member copies out of
   it are not, so they stay legible inside it. */
code {
  color: var(--fg);
}
.connect {
  margin: var(--space-6) 0;
  border-collapse: collapse;
}
.connect th,
.connect td {
  padding: var(--space-1) var(--space-6) var(--space-1) 0;
  text-align: left;
  font-weight: normal;
}
.connect th {
  color: var(--fg-muted);
}
.fingerprint {
  margin-top: var(--space-8);
  overflow-wrap: anywhere;
}
</style>
