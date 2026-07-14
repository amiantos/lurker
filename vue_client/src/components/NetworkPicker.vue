<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  First step of the add-network flow (#169): a searchable, tag-filterable list
  of well-known IRC networks. Picking one prefills NetworkForm with its verified
  host/port/TLS so a new user just enters a nick; "enter details manually" drops
  to the blank form. Content-only (no modal shell) — NetworkForm hosts it.
-->

<template>
  <div class="picker">
    <div class="search-row">
      <input
        v-model="query"
        class="search"
        type="search"
        placeholder="Search networks…"
        autocomplete="off"
        spellcheck="false"
        aria-label="Search networks"
      />
      <!-- The tag chips are a facet over the builtin catalogue's metadata. With
           the builtins hidden (locked-down instance) they'd filter nothing. -->
      <button
        v-if="showTagFilter"
        type="button"
        class="filter-toggle"
        :class="{ on: showFilters || !!active }"
        :aria-expanded="showFilters"
        :aria-label="active ? `Filtering by ${active}` : 'Filter by tag'"
        :title="active ? `Filtering by ${active}` : 'Filter by tag'"
        @click="showFilters = !showFilters"
      >
        <i class="fa-solid fa-filter"></i>
      </button>
    </div>

    <div v-if="showFilters && showTagFilter" class="tags" role="group" aria-label="Filter by tag">
      <button
        v-for="tag in builtinNetworkTags"
        :key="tag"
        type="button"
        class="tag-chip"
        :class="{ on: active === tag }"
        :aria-pressed="active === tag"
        @click="toggleTag(tag)"
      >
        {{ tag }}
      </button>
    </div>

    <ul class="list">
      <!-- Instance presets key on their row id, not their host: nothing enforces
           host uniqueness on instance_network, and an admin may reasonably list
           the same server twice (two ports, or TLS and plaintext). Builtins key
           on name, which the catalogue does keep unique. -->
      <li v-for="net in filtered" :key="net.isInstance ? `i:${net.instanceId}` : net.name">
        <button type="button" class="net-card" @click="$emit('select', net)">
          <span class="net-head">
            <span class="net-name">{{ net.name }}</span>
            <span v-if="net.isInstance" class="net-instance">recommended here</span>
            <span v-else-if="displayTags(net).length" class="net-tags">
              {{ displayTags(net).join(', ') }}
            </span>
          </span>
          <span class="net-statsrow">
            <span class="net-stats">
              <span
                v-if="net.users != null"
                class="stat"
                :title="`~${net.users.toLocaleString()} users (netsplit.de average)`"
              >
                <i class="fa-solid fa-users"></i> {{ formatCount(net.users) }}
              </span>
              <span
                v-if="net.channels != null"
                class="stat"
                :title="`~${net.channels.toLocaleString()} channels (netsplit.de average)`"
              >
                <i class="fa-solid fa-hashtag"></i> {{ formatCount(net.channels) }}
              </span>
            </span>
            <span v-if="hasLurker(net)" class="net-lurker">#lurker available</span>
          </span>
        </button>
      </li>
      <li v-if="!filtered.length" class="none">No networks match.</li>
    </ul>

    <!-- Locked down: no manual entry, because the server would refuse the host
         anyway (403). Say why rather than leaving a dead end where the escape
         hatch used to be. -->
    <button v-if="presets.allowUserDefined" type="button" class="manual" @click="$emit('manual')">
      Enter details manually →
    </button>
    <p v-else class="locked">This server only allows the networks listed above.</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  builtinNetworks,
  builtinNetworkTags,
  LURKER_TAG,
  type NetworkPreset,
} from '../utils/builtinNetworks.js';
import { useNetworkPresetsStore } from '../stores/networkPresets.js';

defineEmits<{ select: [net: NetworkPreset]; manual: [] }>();

const presets = useNetworkPresetsStore();
// Idempotent (the store coalesces in-flight fetches), and failing is fine: the
// store stays permissive and empty, so the picker degrades to exactly the
// builtins-only list it showed before this feature existed.
onMounted(() => {
  if (!presets.loaded) presets.fetchAll().catch(() => {});
});

// The lurker marker is shown as a badge, not in the card's tag list.
function displayTags(net: NetworkPreset): string[] {
  return net.tags.filter((t) => t !== LURKER_TAG);
}
function hasLurker(net: NetworkPreset): boolean {
  return net.tags.includes(LURKER_TAG);
}

const showTagFilter = computed(() => presets.allowUserDefined && builtinNetworkTags.length > 0);

const query = ref('');
// Single-select tag filter: clicking a chip selects it (clearing any other);
// clicking the active chip again clears the filter. The chip tray is collapsed
// behind the Filter button by default.
const active = ref<string | null>(null);
const showFilters = ref(false);

function toggleTag(tag: string): void {
  active.value = active.value === tag ? null : tag;
}

// Compact popularity label: 32976 -> "33k", 9208 -> "9.2k", 100 -> "100".
function formatCount(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

// Text search matches network name OR any tag (partial), so typing "gam" finds
// gaming networks too; the (single) selected chip narrows by exact category.
// The two AND together.
// Everything on offer, admin-defined presets first (#298). When the instance is
// locked down the builtins aren't merely deprioritized, they're gone: a private
// or corporate instance would otherwise show a brand-new user a wall of 95
// public networks they are not permitted to connect to. The server enforces this
// independently (services/networkPolicy) — this is the UI keeping its promise
// not to offer what the connect path would refuse.
const offered = computed<NetworkPreset[]>(() =>
  presets.allowUserDefined ? [...presets.presets, ...builtinNetworks] : [...presets.presets],
);

const filtered = computed<NetworkPreset[]>(() => {
  const q = query.value.trim().toLowerCase();
  const tag = active.value;
  return offered.value.filter((n) => {
    if (q && !n.name.toLowerCase().includes(q) && !n.tags.some((t) => t.toLowerCase().includes(q)))
      return false;
    // Tag chips are a facet over the builtin catalogue's metadata; instance
    // presets carry no tags, so a tag filter would silently hide the admin's own
    // networks. Keep them pinned through it.
    if (tag && !n.isInstance && !n.tags.includes(tag)) return false;
    return true;
  });
});
</script>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  flex: 1;
  min-height: 0;
}
.search-row {
  display: flex;
  gap: var(--space-3);
  align-items: stretch;
}
.search {
  color: var(--fg);
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
}
.filter-toggle {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
}
.filter-toggle:hover {
  color: var(--fg);
  border-color: var(--fg-muted);
}
.filter-toggle.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}
/* Squared tray of toggle buttons, styled after the message-list hover action
   bar (.row-actions): bordered container, square corners, subtle --bg-soft
   hover, --accent when on. */
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-1);
}
.tag-chip {
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg-muted);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  text-transform: lowercase;
}
.tag-chip:hover {
  color: var(--fg);
}
.tag-chip.on {
  background: var(--accent);
  color: var(--bg);
}
/* Breakout so the scrollbar sits against the card edge, matching net-form. */
.list {
  list-style: none;
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
/* Whole card selects the network. No border — a filled background distinguishes
   each card, with a brighter wash on hover. */
.net-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: var(--radius);
  padding: var(--space-7);
  background: var(--bg-soft);
  cursor: pointer;
}
.net-card:hover {
  background: color-mix(in srgb, var(--accent) 14%, var(--bg-soft));
}
.net-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  justify-content: space-between;
}
.net-name {
  color: var(--fg);
  font-weight: 600;
  flex-shrink: 0;
}
/* Plain comma-separated tags, top-right opposite the name; one line, ellipsis
   if they can't fit (never wrap). */
.net-tags {
  flex: 1;
  min-width: 0;
  color: var(--fg-muted);
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Counts (left) and the #lurker badge (right) share the line under the name. */
.net-statsrow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}
.net-stats {
  display: flex;
  gap: var(--space-3);
  color: var(--fg-muted);
  white-space: nowrap;
}
.net-lurker {
  color: var(--warn);
  white-space: nowrap;
}
/* Marks a network the instance's admin defined, distinguishing it from the
   bundled catalogue it's pinned above. */
.net-instance {
  flex: 1;
  min-width: 0;
  color: var(--accent);
  text-align: right;
  white-space: nowrap;
}
.stat i {
  opacity: 0.75;
}
.none {
  color: var(--fg-muted);
  padding: var(--space-4);
  text-align: center;
}
/* Stands where "enter details manually" would be on an unrestricted instance. */
.locked {
  margin: 0;
  padding: var(--space-2) 0;
  color: var(--fg-muted);
}
.manual {
  align-self: flex-start;
  background: transparent;
  border: 0;
  padding: var(--space-2) 0;
  color: var(--accent);
  cursor: pointer;
  text-transform: lowercase;
}
.manual:hover {
  text-decoration: underline;
}

/* Phones: drop the tags and the #lurker badge — too cramped to be worth it —
   leaving just the name and the counts. */
@media (max-width: 480px) {
  .net-tags,
  .net-lurker {
    display: none;
  }
}
</style>
