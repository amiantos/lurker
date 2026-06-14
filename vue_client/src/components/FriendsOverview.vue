<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The FRIENDS buffer body: a management/overview pane (replacing the old
  cross-channel message feed — search covers "what are they saying"). One card
  per friend, the key feature being the PER-NETWORK reachability breakdown you
  can't see anywhere else. Actions: open the primary DM, jump to a search
  pre-filtered to their nick ("view activity"), or edit.
-->

<template>
  <div class="friends-overview">
    <p v-if="!friends.contacts.length" class="empty">
      No friends yet. Add someone from a nick's menu (channel member list, DM, or profile), or with
      “Add Friend” above.
    </p>

    <ul v-else class="cards">
      <li v-for="c in friends.contacts" :key="c.id" class="card">
        <div class="card-head">
          <span class="dot" :class="friends.primaryPresence(c.id)"></span>
          <span class="name">{{ c.displayName }}</span>
          <span class="summary">{{ summary(c) }}</span>
          <span class="spacer"></span>
          <button
            type="button"
            class="link"
            title="Edit friend"
            @click="friends.openEditorForContact(c)"
          >
            <i class="fa-solid fa-user-pen"></i>
          </button>
        </div>

        <ul class="targets">
          <li v-for="t in c.targets" :key="`${t.networkId}::${t.nick}`" class="target">
            <span class="dot small" :class="friends.presenceForTarget(t.networkId, t.nick)"></span>
            <span class="net">{{ networkName(t.networkId) }}</span>
            <span class="nick">{{ t.nick }}</span>
            <span v-if="t.isPrimary" class="primary" title="Primary — opens on click">★</span>
            <span class="tstate">{{ friends.presenceForTarget(t.networkId, t.nick) }}</span>
            <span class="row-actions">
              <button
                type="button"
                class="icon-btn"
                :disabled="friends.presenceForTarget(t.networkId, t.nick) === 'offline'"
                :title="
                  friends.presenceForTarget(t.networkId, t.nick) === 'offline'
                    ? 'Offline'
                    : 'Open DM'
                "
                aria-label="Open DM"
                @click="friends.openDmTarget(t.networkId, t.nick)"
              >
                <i class="fa-solid fa-envelope"></i>
              </button>
              <button
                type="button"
                class="icon-btn"
                title="View activity"
                aria-label="View activity"
                @click="emit('view-activity', searchQueryFor(t))"
              >
                <i class="fa-solid fa-magnifying-glass"></i>
              </button>
            </span>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import {
  useFriendsStore,
  primaryTargetOf,
  type Contact,
  type ContactTarget,
} from '../stores/friends.js';
import { useNetworksStore } from '../stores/networks.js';

// Emits the raw search query string for "view activity" — the parent opens the
// search modal with it.
const emit = defineEmits<{ 'view-activity': [query: string] }>();

const friends = useFriendsStore();
const networks = useNetworksStore();

function networkName(networkId: number): string {
  return networks.networkById(networkId)?.name ?? `net:${networkId}`;
}

// Scope activity search to this nick on this network. `on:` only round-trips
// for whitespace-free names, so fall back to nick-only otherwise.
function searchQueryFor(t: ContactTarget): string {
  const name = networkName(t.networkId);
  const onTok = name && !/\s/.test(name) ? ` on:${name}` : '';
  return `from:${t.nick}${onTok}`;
}

// One-line summary under the name, describing the PRIMARY target (the DM Open DM
// opens) and naming its network. The per-network breakdown below shows the rest.
function summary(c: Contact): string {
  const state = friends.primaryPresence(c.id);
  const net = primaryTargetOf(c) ? networkName(primaryTargetOf(c)!.networkId) : '';
  if (state === 'online') return net ? `Online on ${net}` : 'Online';
  if (state === 'away') return 'Away';
  if (state === 'offline') return net ? `Offline on ${net}` : 'Offline';
  return 'Presence unknown';
}
</script>

<style scoped>
.friends-overview {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.empty {
  color: var(--fg-muted);
  margin: 0;
  max-width: 30rem;
}
.spacer {
  flex: 1;
}
/* Mobile-sized column, left-aligned (cap width, let the right margin grow) —
   like the settings panes, so cards don't stretch across a wide window. */
.cards {
  list-style: none;
  margin: 0 auto 0 0;
  padding: 0;
  width: 100%;
  max-width: 30rem;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.card {
  border: 1px solid var(--border);
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.card-head .name {
  font-weight: 700;
}
.card-head .summary {
  color: var(--fg-muted);
  margin-left: var(--space-2);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-muted);
  flex: 0 0 auto;
}
.dot.small {
  width: 6px;
  height: 6px;
}
.dot.online {
  background: var(--good);
}
.dot.away {
  background: var(--warn);
}
.dot.offline {
  background: var(--bad);
}
.dot.unknown {
  background: var(--fg-muted);
}
.targets {
  list-style: none;
  margin: 0;
  padding: 0 0 0 var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.target {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.target .net {
  min-width: 8em;
}
.target .nick {
  color: var(--fg-muted);
}
.target .primary {
  color: var(--accent);
}
.target .tstate {
  margin-left: auto;
  color: var(--fg-muted);
}
.target .row-actions {
  display: inline-flex;
  gap: var(--space-2);
}
.icon-btn {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-1);
}
.icon-btn:hover:not(:disabled) {
  color: var(--fg);
}
.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.link {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.link:hover {
  color: var(--fg);
}
</style>
