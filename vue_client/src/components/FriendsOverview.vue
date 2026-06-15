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
          <button
            type="button"
            class="name"
            title="Edit friend"
            @click="friends.openEditorForContact(c)"
          >
            {{ c.displayName }}
          </button>
          <span class="spacer"></span>
          <button
            type="button"
            class="icon-btn"
            title="Search all activity"
            aria-label="Search all activity"
            @click="emit('view-activity', searchAllQuery(c))"
          >
            <i class="fa-solid fa-magnifying-glass"></i>
          </button>
        </div>

        <ul class="targets">
          <li v-for="t in c.targets" :key="`${t.networkId}::${t.nick}`" class="target">
            <span class="dot small" :class="friends.presenceForTarget(t.networkId, t.nick)"></span>
            <span class="target-label"
              ><span class="net">{{ networkName(t.networkId) }}/</span
              ><span class="nick" :class="nickClass(t)">{{ t.nick }}</span></span
            >
            <span class="spacer"></span>
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
import { useFriendsStore, type Contact, type ContactTarget } from '../stores/friends.js';
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

// Search every one of the friend's nicks (OR), no network filter — "all their
// activity across identities". Dedupes nicks case-insensitively.
function searchAllQuery(c: Contact): string {
  const seen = new Set<string>();
  const nicks: string[] = [];
  for (const t of c.targets) {
    const lower = t.nick.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    nicks.push(t.nick);
  }
  return nicks.map((n) => `from:${n}`).join(' ');
}

// Dim the nick when away/offline (presence is also carried by the dot). No
// bold/italic — kept plain.
function nickClass(t: ContactTarget): Record<string, boolean> {
  const state = friends.presenceForTarget(t.networkId, t.nick);
  return { away: state === 'away', offline: state === 'offline' };
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
}
/* On mobile the chat pane is already a narrow full-width column, so drop the
   desktop reading-column cap and let the cards fill it. */
@media (max-width: 768px) {
  .cards {
    max-width: none;
  }
}
/* No card border — a thin separator between cards instead, with generous
   breathing room on either side of it. */
.card {
  padding: var(--space-8) 0;
  display: flex;
  flex-direction: column;
  /* Match the inter-target gap so the name row and the per-network rows are
     evenly spaced — the search buttons line up at a uniform vertical rhythm. */
  gap: var(--space-2);
}
/* First card sits up near the topic bar — only the container padding above it. */
.card:first-child {
  padding-top: 0;
}
.card + .card {
  border-top: 1px solid var(--border);
}
.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
/* The friend's name is the edit affordance — a buffer-style link: normal text,
   pointer + hover underline, no pencil icon. */
.card-head .name {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 700;
  color: var(--fg);
  cursor: pointer;
  text-align: left;
}
.card-head .name:hover {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.card-head .name:focus-visible {
  outline: 2px solid var(--accent);
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
/* network/nick motif, like a DM in the status bar — network (with slash) muted. */
.target-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.target .net {
  color: var(--fg-muted);
}
/* Nick dims by presence (away/offline); the dot carries the rest. */
.target .nick {
  color: var(--fg);
}
.target .nick.away,
.target .nick.offline {
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
</style>
