<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="members">
    <div v-if="canCall" class="members-head">
      <button
        type="button"
        class="call-btn"
        :disabled="voice.connecting || voice.active"
        :title="voice.active ? 'Already in a call' : 'Start or join a voice call in this channel'"
        @click="startCall"
      >
        <i class="fa-solid fa-phone"></i>
        <span>{{ callBtnLabel }}</span>
      </button>
      <div v-if="isOp" class="call-admin">
        <label class="policy" title="Who may join this channel's call">
          <span>Join</span>
          <select :value="policy" @change="onPolicyChange">
            <option value="none">anyone</option>
            <option value="voice">voiced+</option>
            <option value="halfop">halfop+</option>
            <option value="op">ops only</option>
          </select>
        </label>
        <button
          type="button"
          class="guest-btn"
          :disabled="guestBusy"
          title="Create a public link a guest can use to join without an account"
          @click="createGuestLink"
        >
          <i class="fa-solid fa-link"></i> Guest link
        </button>
      </div>
      <div v-if="guestUrl" class="guest-url">
        <input :value="guestUrl" readonly aria-label="Guest call link" @focus="selectAll" />
        <button type="button" @click="copyGuest">{{ copied ? 'Copied' : 'Copy' }}</button>
      </div>
    </div>
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
import { useConfigStore } from '../stores/config.js';
import { useVoiceStore } from '../stores/voice.js';
import { useCallPresenceStore } from '../stores/callPresence.js';
import { api } from '../api.js';
import {
  PREFIX_ORDER,
  prefixOf as modePrefixOf,
  prefixClass as modePrefixClass,
} from '../utils/memberPrefix.js';
import IgnoreModal from './IgnoreModal.vue';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const nicks = useNickColors();
const memberActions = useMemberActions();
const ignores = useIgnoresStore();
const config = useConfigStore();
const voice = useVoiceStore();
const modalMember = ref<BufferMember | null>(null);
const listEl = ref<HTMLElement | null>(null);

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));
const members = computed((): BufferMember[] => buffer.value?.members || []);

// Voice-call affordance: channels only, and only when the server advertises it.
const canCall = computed(
  () => config.voiceEnabled && buffer.value?.kind === 'channel' && buffer.value?.networkId != null,
);
function startCall() {
  const b = buffer.value;
  if (!b || b.networkId == null) return;
  // label = the channel target; the store mints its own token + room.
  voice.startCall(b.networkId, b.target, b.target);
}
const selfNick = computed(() => {
  const b = buffer.value;
  if (!b || b.networkId == null) return null;
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

// ─── Voice: join-with-count, op join policy, op guest links ─────────────────
const callPresence = useCallPresenceStore();
const OP_MODES = ['q', 'a', 'o'];
const isOp = computed(() => selfModes.value.some((m) => OP_MODES.includes(m)));

const inThisCall = computed(
  () =>
    voice.active &&
    voice.networkId === (buffer.value?.networkId ?? null) &&
    voice.target === buffer.value?.target,
);
const callCount = computed(() => {
  const b = buffer.value;
  return b?.networkId != null ? callPresence.countFor(b.networkId, b.target) : 0;
});
const callBtnLabel = computed(() => {
  if (inThisCall.value) return 'In call';
  if (callCount.value > 0) return `Join call (${callCount.value})`;
  return 'Call';
});

const policy = ref('none');
const guestUrl = ref('');
const guestBusy = ref(false);
const copied = ref(false);

// Load the channel's join policy whenever the active channel changes (any member
// may read it; only ops see/change the control).
watch(
  buffer,
  async (b) => {
    guestUrl.value = '';
    copied.value = false;
    policy.value = 'none';
    if (!config.voiceEnabled || !b || b.kind !== 'channel' || b.networkId == null) return;
    try {
      const r = await api<{ minJoinMode: string }>(
        `/api/voice/policy?networkId=${b.networkId}&target=${encodeURIComponent(b.target)}`,
      );
      policy.value = r.minJoinMode;
    } catch {
      /* leave default */
    }
  },
  { immediate: true },
);

async function onPolicyChange(e: Event) {
  const b = buffer.value;
  if (!b || b.networkId == null) return;
  const minJoinMode = (e.target as HTMLSelectElement).value;
  try {
    const r = await api<{ minJoinMode: string }>('/api/voice/policy', {
      method: 'PUT',
      body: { networkId: b.networkId, target: b.target, minJoinMode },
    });
    policy.value = r.minJoinMode;
  } catch {
    /* keep previous */
  }
}

async function createGuestLink() {
  const b = buffer.value;
  if (!b || b.networkId == null) return;
  guestBusy.value = true;
  copied.value = false;
  try {
    const r = await api<{ url: string }>('/api/voice/guest-link', {
      method: 'POST',
      body: { networkId: b.networkId, target: b.target },
    });
    guestUrl.value = r.url;
  } catch {
    /* ignore */
  } finally {
    guestBusy.value = false;
  }
}

function copyGuest() {
  if (!guestUrl.value) return;
  void navigator.clipboard?.writeText(guestUrl.value);
  copied.value = true;
}
function selectAll(e: FocusEvent) {
  (e.target as HTMLInputElement).select();
}

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
  // Left-click: pass the row as the trigger so re-clicking it toggles closed.
  memberActions.openMenuFor(m, menuContext(), e.clientX, e.clientY, e.currentTarget as Element);
}
function onRowContextMenu(e: MouseEvent, m: BufferMember): void {
  if (!buffer.value) return;
  // Right-click: no trigger — a second right-click repositions, as is conventional.
  memberActions.openMenuFor(m, menuContext(), e.clientX, e.clientY);
}
function onActionsClick(e: MouseEvent, m: BufferMember): void {
  if (!buffer.value) return;
  memberActions.openMenuFromButton(m, menuContext(), e.currentTarget as Element);
}
function prefixOf(m: BufferMember): string {
  return modePrefixOf(modesOf(m));
}
function prefixClass(m: BufferMember): string {
  return modePrefixClass(modesOf(m));
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
  const channel = buffer.value?.target ?? '';
  const list = members.value;
  // Self is always visible — guards against the corner case of a mask
  // matching the user's own nick (or a hostmask the server-side nick
  // happens to fall into) which would otherwise vanish them from their
  // own nicklist. Only whole-identity ALL rules drop a member here — a
  // content/level/NOHIGHLIGHT rule leaves them in the nicklist (#301).
  const filtered = networkId
    ? list.filter((m) => {
        if (isSelf(m)) return true;
        const nick = nickOf(m);
        const userhost = m.user && m.host ? `${nick}!${m.user}@${m.host}` : null;
        return !ignores.isMemberHidden(networkId, nick, userhost, channel);
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
.members-head {
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--border, #2c2f38);
}
.call-btn {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.35rem 0.5rem;
  border-radius: 0.35rem;
  border: 1px solid var(--border, #2c2f38);
  background: var(--button-bg, #262933);
  color: inherit;
  cursor: pointer;
}
.call-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.call-admin {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.35rem;
  font-size: 0.8rem;
}
.call-admin .policy {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--fg-muted);
}
.call-admin select {
  background: var(--button-bg, #262933);
  color: inherit;
  border: 1px solid var(--border, #2c2f38);
  border-radius: 0.25rem;
  padding: 0.1rem 0.2rem;
}
.guest-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.4rem;
  border-radius: 0.25rem;
  border: 1px solid var(--border, #2c2f38);
  background: var(--button-bg, #262933);
  color: inherit;
  cursor: pointer;
}
.guest-url {
  display: flex;
  gap: 0.3rem;
  margin-top: 0.35rem;
}
.guest-url input {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  padding: 0.2rem 0.3rem;
  border-radius: 0.25rem;
  border: 1px solid var(--border, #2c2f38);
  background: var(--bg-soft, #14161c);
  color: inherit;
}
.guest-url button {
  padding: 0.2rem 0.45rem;
  border-radius: 0.25rem;
  border: 1px solid var(--border, #2c2f38);
  background: var(--button-bg, #262933);
  color: inherit;
  cursor: pointer;
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
