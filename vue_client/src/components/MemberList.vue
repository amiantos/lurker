<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="members">
    <ul ref="listEl">
      <li
        v-for="m in sorted"
        :key="nickOf(m)"
        :class="liClass(m)"
        @click="onRowClick($event, m)"
        @contextmenu.prevent="onRowContextMenu($event, m)"
      >
        <span class="prefix">{{ prefixOf(m) }}</span>
        <span class="nick" :style="nickStyle(m)" :title="nickOf(m)">{{ nickOf(m) }}</span>
        <button
          type="button"
          class="row-actions"
          title="Actions"
          aria-label="Member actions"
          @click.stop="onActionsClick($event, m)"
          @contextmenu.stop.prevent
        >
          <i class="fa-solid fa-ellipsis-vertical"></i>
        </button>
      </li>
    </ul>
    <IgnoreModal
      v-if="modalMember"
      :nick="nickOf(modalMember)"
      :user="userOf(modalMember)"
      :host="hostOf(modalMember)"
      :network-id="buffer?.networkId ?? null"
      @close="modalMember = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore, type BufferMember } from '../stores/buffers.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useMemberActions } from '../composables/useMemberActions.js';
import { useIgnoresStore } from '../stores/ignores.js';
import IgnoreModal from './IgnoreModal.vue';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const nicks = useNickColors();
const memberActions = useMemberActions();
const ignores = useIgnoresStore();
const modalMember = ref<BufferMember | null>(null);
const listEl = ref<HTMLElement | null>(null);

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));
const members = computed((): BufferMember[] => buffer.value?.members || []);
const selfNick = computed(() => {
  const b = buffer.value;
  if (!b) return null;
  return networks.states[b.networkId]?.nick || null;
});
// The current user's own modes in this channel, used to gate the operator
// actions in the member context menu.
const selfModes = computed<string[]>(() => {
  const sn = selfNick.value;
  if (!sn) return [];
  const me = members.value.find((m) => nickOf(m).toLowerCase() === sn.toLowerCase());
  return me && Array.isArray(me.modes) ? me.modes : [];
});

watch(
  () => networks.activeKey,
  () => {
    if (listEl.value) listEl.value.scrollTop = 0;
  },
  { flush: 'post' },
);

function isSelf(m: BufferMember): boolean {
  const sn = selfNick.value;
  return !!sn && nickOf(m).toLowerCase() === sn.toLowerCase();
}
function nickStyle(m: BufferMember): { color: string } | null {
  // Away members render in a flat muted color — the .away CSS rule wins
  // regardless of inline style, but skipping the inline color keeps the DOM
  // honest.
  if (isAway(m)) return null;
  if (isSelf(m)) return { color: nicks.selfColor.value };
  const c = nicks.color(nickOf(m));
  return c ? { color: c } : null;
}

const PREFIX_ORDER = ['~', '&', '@', '%', '+', ''];

function nickOf(m: BufferMember): string {
  return m.nick;
}
function userOf(m: BufferMember): string | null {
  return m.user ?? null;
}
function hostOf(m: BufferMember): string | null {
  return m.host ?? null;
}
function modesOf(m: BufferMember): string[] {
  return Array.isArray(m?.modes) ? m.modes : [];
}

// Click handlers funnel through one builder so right-click, row-click
// (mobile tap, desktop click — member rows have no other action), and the
// hover three-dots all open the same menu. Anchor by event coords for the
// row paths and by button rect for the three-dots so the popup drops out
// from the affordance the user actually pointed at.
function menuContext() {
  return {
    networkId: buffer.value?.networkId ?? 0,
    isSelf,
    onIgnore: (m: BufferMember) => {
      modalMember.value = m;
    },
    channel: buffer.value?.target ?? null,
    selfModes: selfModes.value,
  };
}
function onRowClick(e: MouseEvent, m: BufferMember): void {
  if (!buffer.value) return;
  memberActions.openMenuFor(m, menuContext(), e.clientX, e.clientY);
}
function onRowContextMenu(e: MouseEvent, m: BufferMember): void {
  if (!buffer.value) return;
  memberActions.openMenuFor(m, menuContext(), e.clientX, e.clientY);
}
function onActionsClick(e: MouseEvent, m: BufferMember): void {
  if (!buffer.value) return;
  memberActions.openMenuFromButton(m, menuContext(), e.currentTarget as Element);
}
function prefixOf(m: BufferMember): string {
  const modes = modesOf(m);
  if (modes.includes('q')) return '~';
  if (modes.includes('a')) return '&';
  if (modes.includes('o')) return '@';
  if (modes.includes('h')) return '%';
  if (modes.includes('v')) return '+';
  return '';
}
function prefixClass(m: BufferMember): string {
  const p = prefixOf(m);
  return p ? `mode-${p}` : '';
}
function isAway(m: BufferMember): boolean {
  return !!m?.away;
}
function liClass(m: BufferMember): string[] {
  const classes: string[] = [];
  const p = prefixClass(m);
  if (p) classes.push(p);
  if (isAway(m)) classes.push('away');
  return classes;
}

const sorted = computed(() => {
  const networkId = buffer.value?.networkId;
  const list = members.value;
  // Self is always visible — guards against the corner case of a mask
  // matching the user's own nick (or a hostmask the server-side nick
  // happens to fall into) which would otherwise vanish them from their
  // own nicklist.
  const filtered = networkId
    ? list.filter((m) => {
        if (isSelf(m)) return true;
        const nick = nickOf(m);
        const userhost = m.user && m.host ? `${nick}!${m.user}@${m.host}` : null;
        return !ignores.isIgnored(networkId, nick, userhost ?? '');
      })
    : list;
  return filtered.toSorted((a, b) => {
    const pa = PREFIX_ORDER.indexOf(prefixOf(a));
    const pb = PREFIX_ORDER.indexOf(prefixOf(b));
    if (pa !== pb) return pa - pb;
    return nickOf(a).localeCompare(nickOf(b), undefined, { sensitivity: 'base' });
  });
});
</script>

<style scoped>
.members {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
ul {
  list-style: none;
  margin: 0;
  padding: var(--space-2) 0;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
li {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  padding: 1px var(--space-5);
  min-width: 0;
  user-select: none;
  cursor: pointer;
  position: relative;
}
li:hover {
  background: var(--bg-soft);
}

/* Hover affordance — floats over the right edge of the row instead of taking
   a flex slot, so long nicks aren't pushed into a narrower column when the
   button is hidden. A short gradient fade behind the icon (matched to the
   row's hover background) keeps the glyph readable on top of any nick that
   gets truncated under it. Hidden entirely on touch breakpoints; mobile uses
   tap-anywhere-on-row to open the same menu. */
.row-actions {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  padding: 0 var(--space-4) 0 var(--space-7);
  background: linear-gradient(to right, transparent 0, var(--bg-soft) 12px);
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  line-height: 1;
  opacity: 0;
  transition: opacity 80ms linear;
}
li:hover .row-actions,
.row-actions:focus-visible {
  opacity: 1;
}
.row-actions:hover {
  color: var(--fg);
}
@media (max-width: 768px) {
  .row-actions {
    display: none;
  }
}
.prefix {
  width: 10px;
  flex: 0 0 auto;
  text-align: center;
  color: var(--fg-muted);
}
li.mode-\~ .prefix {
  color: var(--member-owner);
}
li.mode-\& .prefix {
  color: var(--member-admin);
}
li.mode-\@ .prefix {
  color: var(--member-op);
}
li.mode-\% .prefix {
  color: var(--member-halfop);
}
li.mode-\+ .prefix {
  color: var(--member-voice);
}
.nick {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
}
/* Away nicks lose all per-user color and render in a flat muted gray. The
   rule overrides the inline nickStyle (which is suppressed for away anyway)
   and the prefix mode colors so the whole row reads as inert. */
li.away .nick,
li.away .prefix {
  color: var(--fg-muted) !important;
}
</style>
