<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="buffer-list-frame">
    <!-- LURKER: the system buffer (#355) as a proper fixed header — it does not
         scroll with the list (the list scrolls beneath it), matching the pinned
         sidebar footer. Corner controls: + adds a network, << collapses the
         sidebar; both always visible (not hover-gated). When the row itself has
         an unread/highlight badge the + yields the corner to it (the << stays);
         hovering brings the + back. -->
    <div class="net system-net">
      <div
        class="net-head"
        :class="{ active: isSystemActive }"
        title="Open Lurker system buffer"
        @click="selectSystem"
      >
        <span
          class="indicator"
          :class="lurkerConnected ? 'good' : 'bad'"
          :title="lurkerConnected ? 'Connected to Lurker' : 'Disconnected from Lurker'"
        ></span>
        <span class="name">LURKER</span>
        <span
          v-if="systemHighlights > 0 && showHighlightBadge"
          class="badge highlight"
          title="unread"
          >●</span
        >
        <span v-if="systemUnread > 0" class="badge">{{ unreadLabel(systemUnread) }}</span>
        <div class="net-actions">
          <button
            type="button"
            class="net-action net-add"
            title="Add network"
            aria-label="Add network"
            @click.stop="openAddNetwork"
            @contextmenu.stop.prevent
          >
            <i class="fa-solid fa-plus"></i>
          </button>
          <button
            v-if="showAdminEntry"
            type="button"
            class="net-action net-admin"
            title="Admin panel"
            aria-label="Admin panel"
            @click.stop="openAdmin"
            @contextmenu.stop.prevent
          >
            <i class="fa-solid fa-shield-halved"></i>
          </button>
          <button
            type="button"
            class="net-action net-settings"
            title="Settings"
            aria-label="Settings"
            @click.stop="openSettings"
            @contextmenu.stop.prevent
          >
            <i class="fa-solid fa-gear"></i>
          </button>
          <button
            type="button"
            class="net-action"
            title="Hide channel list"
            aria-label="Hide channel list"
            @click.stop="collapseSidebar"
            @contextmenu.stop.prevent
          >
            <i class="fa-solid fa-angles-left"></i>
          </button>
        </div>
      </div>
    </div>

    <div class="buffer-list-scroll">
      <nav
        ref="scroller"
        class="buffer-list"
        :class="{ 'unread-bold': unreadBold }"
        @scroll="scheduleRecompute"
      >
        <!-- FRIENDS pseudo-network: a cross-network gathering of DM shortcuts. The
           header opens the compilation feed (:friends:); each row opens that
           friend's DM on their primary network. -->
        <div v-if="friends.contacts.length || isFriendsActive" class="net friends-net">
          <div
            class="net-head"
            :class="{ active: isFriendsActive }"
            title="Open Friends feed"
            @click="selectFriends"
          >
            <span class="indicator" :class="friendsPresence" :title="friendsStatusTitle"></span>
            <span class="name">FRIENDS</span>
            <div class="net-actions">
              <button
                type="button"
                class="net-action net-add"
                title="Add friend"
                aria-label="Add friend"
                @click.stop="friends.openEditorNew()"
                @contextmenu.stop.prevent
              >
                <i class="fa-solid fa-plus"></i>
              </button>
            </div>
          </div>
          <ul v-if="friends.contacts.length" class="channels">
            <li
              v-for="c in friends.contacts"
              :key="c.id"
              :class="friendRowClasses(c)"
              :title="`Open DM with ${c.displayName}`"
              @click="openFriendDm(c)"
              @contextmenu.prevent="openFriendActions($event, c)"
            >
              <span class="label">{{ c.displayName }}</span>
              <span
                v-if="friendHighlights(c) > 0 && showHighlightBadge"
                class="badge highlight"
                title="unread highlight"
                >●</span
              >
              <span v-if="friendUnread(c) > 0" class="badge">{{
                unreadLabel(friendUnread(c))
              }}</span>
              <button
                type="button"
                class="row-actions"
                title="Edit friend"
                aria-label="Edit friend"
                @click.stop="friends.openEditorForContact(c)"
                @contextmenu.stop.prevent
              >
                <i class="fa-solid fa-user-pen"></i>
              </button>
            </li>
          </ul>
        </div>

        <div v-for="net in networks.networks" :key="net.id" class="net">
          <div
            class="net-head"
            :class="netHeadClasses(net.id)"
            :title="`Open ${net.name} server buffer`"
            @click="select(net.id, serverTarget(net.id))"
            @contextmenu.prevent="
              networkActions.onNetworkContextMenu(net, $event.clientX, $event.clientY)
            "
          >
            <span class="indicator" :class="stateClass(net.id)"></span>
            <span class="name">{{ net.name }}</span>
            <span
              v-if="serverHighlights(net.id) > 0 && showHighlightBadge"
              class="badge highlight"
              :title="`${serverHighlights(net.id)} highlight${serverHighlights(net.id) === 1 ? '' : 's'}`"
              >●</span
            >
            <span
              v-if="countFor(serverUnread(net.id), serverHighlights(net.id)) > 0"
              class="badge"
              >{{ unreadLabel(countFor(serverUnread(net.id), serverHighlights(net.id))) }}</span
            >
            <div class="net-actions">
              <button
                type="button"
                class="net-action net-add"
                :disabled="!isNetworkConnected(net)"
                title="Add channel"
                aria-label="Add channel"
                @click.stop="joinChannelModal.open(net.id)"
                @contextmenu.stop.prevent
              >
                <i class="fa-solid fa-plus"></i>
              </button>
              <button
                type="button"
                class="net-action"
                title="Network options"
                aria-label="Network options"
                @click.stop="
                  networkActions.openMenuFromButton(net, $event.currentTarget as Element)
                "
                @contextmenu.stop.prevent
              >
                <i class="fa-solid fa-ellipsis-vertical"></i>
              </button>
            </div>
          </div>

          <!-- Touch delay (200ms, touch-only) so a quick swipe over the pinned
             section scrolls the channel list instead of starting a reorder.
             Press-and-hold still initiates drag — the iOS/Discord/Slack
             reorder convention. touchStartThreshold cancels the pending drag
             if the finger moves more than 5px during the delay, so scroll
             intent is recognised early. Desktop mouse drag stays instant. -->
          <draggable
            v-if="(pinnedBufsByNet[net.id] || []).length"
            :list="pinnedBufsByNet[net.id]"
            item-key="target"
            tag="ul"
            class="channels pinned"
            :animation="120"
            ghost-class="drag-ghost"
            :delay="200"
            :delay-on-touch-only="true"
            :touch-start-threshold="5"
            @start="dragging = true"
            @end="onPinDragEnd(net.id)"
          >
            <template #item="{ element: buf }">
              <li
                :class="rowClasses(buf, net.id)"
                :title="dmTitle(buf)"
                @click="select(net.id, buf.target)"
                @contextmenu.prevent="onBufferContextMenu($event, buf)"
              >
                <span class="label">{{ labelFor(buf) }}</span>
                <span
                  v-if="hasDraft(buf)"
                  class="badge draft"
                  title="unsent draft"
                  aria-label="unsent draft"
                  ><i class="fa-solid fa-pencil"></i
                ></span>
                <span
                  v-if="buf.highlighted > 0 && showHighlightBadge"
                  class="badge highlight"
                  :title="`${buf.highlighted} highlight${buf.highlighted === 1 ? '' : 's'}`"
                  >●</span
                >
                <span v-if="displayCount(buf) > 0" class="badge">{{
                  unreadLabel(displayCount(buf))
                }}</span>
                <button
                  v-if="!isServerBuffer(buf)"
                  type="button"
                  class="row-actions"
                  title="Actions"
                  aria-label="Buffer actions"
                  @click.stop="onRowActionsClick($event, buf)"
                  @contextmenu.stop.prevent
                >
                  <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
              </li>
            </template>
          </draggable>

          <div
            v-if="(pinnedBufsByNet[net.id] || []).length && unpinnedBufs(net.id).length"
            class="pin-divider"
            aria-hidden="true"
          ></div>

          <ul v-if="unpinnedBufs(net.id).length" class="channels">
            <li
              v-for="buf in unpinnedBufs(net.id)"
              :key="buf.target"
              :class="rowClasses(buf, net.id)"
              :title="dmTitle(buf)"
              @click="select(net.id, buf.target)"
              @contextmenu.prevent="onBufferContextMenu($event, buf)"
            >
              <span class="label">{{ labelFor(buf) }}</span>
              <span
                v-if="hasDraft(buf)"
                class="badge draft"
                title="unsent draft"
                aria-label="unsent draft"
                ><i class="fa-solid fa-pencil"></i
              ></span>
              <span
                v-if="buf.highlighted > 0 && showHighlightBadge"
                class="badge highlight"
                :title="`${buf.highlighted} highlight${buf.highlighted === 1 ? '' : 's'}`"
                >●</span
              >
              <span v-if="displayCount(buf) > 0" class="badge">{{
                unreadLabel(displayCount(buf))
              }}</span>
              <button
                v-if="!isServerBuffer(buf)"
                type="button"
                class="row-actions"
                title="Actions"
                aria-label="Buffer actions"
                @click.stop="onRowActionsClick($event, buf)"
                @contextmenu.stop.prevent
              >
                <i class="fa-solid fa-ellipsis-vertical"></i>
              </button>
            </li>
          </ul>
        </div>
        <p v-if="!networks.networks.length" class="empty">
          No networks yet — add one with the + button.
        </p>
      </nav>
      <button
        v-if="unreadAbove"
        type="button"
        class="unread-edge top"
        :class="{ 'is-highlight': highlightAbove }"
        title="Unread buffers above — click to scroll into view"
        aria-label="Scroll to unread buffers above"
        @click="scrollToUnread('up')"
      ></button>
      <button
        v-if="unreadBelow"
        type="button"
        class="unread-edge bottom"
        :class="{ 'is-highlight': highlightBelow }"
        title="Unread buffers below — click to scroll into view"
        aria-label="Scroll to unread buffers below"
        @click="scrollToUnread('down')"
      ></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  reactive,
  ref,
  watch,
} from 'vue';
import { useRouter } from 'vue-router';
import draggable from 'vuedraggable';
import { useNetworksStore, type Network, type PeerPresenceEntry } from '../stores/networks.js';
import { useBuffersStore, type Buffer } from '../stores/buffers.js';
import { useFriendsStore, primaryTargetOf, type Contact } from '../stores/friends.js';
import { FRIENDS_KEY, SYSTEM_KEY } from '../lib/virtualBuffers.js';
import { connected as lurkerConnected } from '../composables/useSocket.js';
import { useDraftStore } from '../stores/drafts.js';
import { usePinsStore } from '../stores/pins.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useSettingsStore } from '../stores/settings.js';
import { useAuthStore } from '../stores/auth.js';
import { useBufferActions } from '../composables/useBufferActions.js';
import { useNetworkActions } from '../composables/useNetworkActions.js';
import { useNetworkEditor } from '../composables/useNetworkEditor.js';
import { useJoinChannelModal } from '../composables/useJoinChannelModal.js';
import { useContextMenu } from '../composables/useContextMenu.js';
import { unreadLabel } from '../utils/unreadLabel.js';
import {
  isPeerOffline as derivePeerOffline,
  isPeerAway as derivePeerAway,
} from '../utils/peerPresence.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const friends = useFriendsStore();
const drafts = useDraftStore();
const pins = usePinsStore();
const ignores = useIgnoresStore();
const settings = useSettingsStore();
const auth = useAuthStore();
const bufferActions = useBufferActions();
const networkActions = useNetworkActions();
const networkEditor = useNetworkEditor();
const joinChannelModal = useJoinChannelModal();
const friendMenu = useContextMenu();
const router = useRouter();

// The + in the LURKER header opens the add-network editor (the button moved off
// the sidebar footer — #411). The modal itself is rendered by the chat shell
// (Desktop/MobileChat), which already watches networkEditor.isOpen.
function openAddNetwork(): void {
  networkEditor.open();
}

// The LURKER header's sliders is the app-scoped "settings" affordance — the
// system buffer's scope is the whole app, so its settings are the global ones
// (#411). Moved here off the sidebar footer; the collapsed rail keeps its own
// copy since this header is unmounted while collapsed (see DesktopChat).
function openSettings(): void {
  router.push('/settings').catch((err) => console.error('[BufferList] open settings failed', err));
}

// The shield next to the gear opens the dedicated admin panel. Admin-only: it's
// the sole entry to instance administration, which no longer lives in Settings.
const showAdminEntry = computed(() => auth.isAdmin);
function openAdmin(): void {
  router.push('/admin').catch((err) => console.error('[BufferList] open admin failed', err));
}

function isNetworkConnected(net: Network): boolean {
  return networks.states[net.id]?.state === 'connected';
}

// LURKER system buffer (#355): a real top-of-list row. Its status light tracks
// the Lurker connection; its unread badge is server-computed (notable lines
// only). selectSystem routes through activate() so the read-state lifecycle runs.
const isSystemActive = computed(() => networks.activeKey === SYSTEM_KEY);
const systemBuf = computed(() => buffers.byKey(SYSTEM_KEY));
const systemUnread = computed(() =>
  countFor(systemBuf.value?.unread || 0, systemBuf.value?.highlighted || 0),
);
const systemHighlights = computed(() => systemBuf.value?.highlighted || 0);
function selectSystem(): void {
  buffers.activate(null, SYSTEM_KEY);
}
// The LURKER header's corner control collapses the channel list. (Settings
// moved to the sidebar footer; the expand control returns to the top of the
// collapsed rail — see DesktopChat.)
function collapseSidebar(): void {
  settings.setValue('look.layout.show_channel_list', false);
}

// Buffer-list display settings — feed both the row CSS (bold gate) and the
// badge logic. `unread_display` picks between four modes:
//   full       → highlight ● + total unread count (default, current behavior)
//   highlights → highlight ● + highlight-only count (hides noisy totals)
//   badge      → highlight ● only, no numbers
//   off        → nothing — row color/weight is the only cue
const unreadBold = computed(() => !!settings.effective('look.buffer_list.unread_bold'));
const unreadDisplay = computed(() => String(settings.effective('look.buffer_list.unread_display')));
const showHighlightBadge = computed(() => unreadDisplay.value !== 'off');
function countFor(unread: number, highlights: number): number {
  if (unreadDisplay.value === 'full') return unread;
  if (unreadDisplay.value === 'highlights') return highlights;
  return 0;
}

// A muted buffer drops the plain-unread signal from the buffer list: a "full"
// count downgrades to highlights-only so ordinary traffic stops incrementing
// the badge, and the `unread` row class (color + bold + off-screen arrow) is
// withheld below. Highlights pass through untouched — they still color the row
// and show the ● per the global display mode, which is the whole point of
// muting a busy-but-followed room. Mute is now an ignore rule carrying NOUNREAD
// (issue #359): channel, DM, or a network-wide rule that covers every child.
function isChannelMuted(buf: Buffer | null): boolean {
  return !!buf && buf.networkId != null && ignores.bufferMutesUnread(buf.networkId, buf.target);
}
function displayCount(buf: Buffer): number {
  const mode =
    isChannelMuted(buf) && unreadDisplay.value === 'full' ? 'highlights' : unreadDisplay.value;
  if (mode === 'full') return buf.unread;
  if (mode === 'highlights') return buf.highlighted;
  return 0;
}

// Per-network local mirror of the pinned buffer list, kept as concrete buffer
// objects so vuedraggable can render them directly. We mutate the inner arrays
// (splice) rather than replace them so vuedraggable's bound array reference
// stays stable across syncs.
const pinnedBufsByNet = reactive<Record<number, Buffer[]>>({});
const dragging = ref(false);

function isServerBuffer(buf: Buffer): boolean {
  return buf.target.startsWith(':server:');
}

function isDmBuffer(buf: Buffer): boolean {
  return !isServerBuffer(buf) && !buf.target.startsWith('#');
}

function serverTarget(networkId: number): string {
  return `:server:${networkId}`;
}

function serverBuf(networkId: number): Buffer | null {
  return buffers.byKey(`${networkId}::${serverTarget(networkId)}`);
}

function serverUnread(networkId: number): number {
  return serverBuf(networkId)?.unread || 0;
}

function serverHighlights(networkId: number): number {
  return serverBuf(networkId)?.highlighted || 0;
}

function hasDraft(buf: Buffer): boolean {
  return buf.networkId != null && drafts.hasDraft(buf.networkId, buf.target);
}

function labelFor(buf: Buffer): string {
  return buf.target;
}

function bufferOrder(buf: Buffer): number {
  if (buf.target.startsWith('#')) return 0;
  return 1;
}

// Strip leading hashes so ##anime sorts next to #anime, not before #aardvark
// (raw localeCompare would weight every leading '#' as sort-significant).
function sortKey(target: string): string {
  return target.replace(/^#+/, '').toLowerCase();
}

function unpinnedBufs(networkId: number): Buffer[] {
  const pinnedSet = new Set(pins.forNetwork(networkId));
  return buffers
    .forNetwork(networkId)
    .filter(
      (b) =>
        !isServerBuffer(b) && !pinnedSet.has(b.target) && !isFriendPrimaryDm(b.networkId, b.target),
    )
    .toSorted((a, b) => {
      const oa = bufferOrder(a);
      const ob = bufferOrder(b);
      if (oa !== ob) return oa - ob;
      return sortKey(a.target).localeCompare(sortKey(b.target));
    });
}

// Mirror pins.byNetwork into a local reactive map of concrete buffer objects.
// Pinned targets without a matching open buffer (e.g. closed/parted, pin row
// persists on the server) are filtered out so we don't render empty rows.
function syncPinned(): void {
  if (dragging.value) return;
  for (const net of networks.networks) {
    const targets = pins.forNetwork(net.id);
    const bufByTarget = new Map<string, Buffer>();
    for (const b of buffers.forNetwork(net.id)) bufByTarget.set(b.target, b);
    const list = targets
      .map((t) => bufByTarget.get(t))
      .filter((b): b is Buffer => !!b && !isFriendPrimaryDm(b.networkId, b.target));
    if (!pinnedBufsByNet[net.id]) {
      pinnedBufsByNet[net.id] = list;
    } else {
      const arr = pinnedBufsByNet[net.id];
      arr.splice(0, arr.length, ...list);
    }
  }
  // Drop entries for networks that no longer exist.
  const live = new Set(networks.networks.map((n) => n.id));
  for (const k of Object.keys(pinnedBufsByNet)) {
    if (!live.has(Number(k))) delete pinnedBufsByNet[Number(k)];
  }
}

// Only re-sync when something structurally relevant changes — pin order, the
// set of networks, the set of buffer keys, or the friend primary DMs the mirror
// filters out (so flipping a friend/primary doesn't leave a stale duplicate row
// in the pinned section). Per-buffer state churn (unread counts, member list,
// messages) doesn't affect which buffers belong in the pinned list and shouldn't
// re-walk this whole map on every keystroke.
watch(
  () => [
    pins.byNetwork,
    networks.networks.map((n) => n.id),
    Object.keys(buffers.buffers),
    [...friends.primaryDmKeys],
  ],
  syncPinned,
  { deep: true, immediate: true },
);

function onPinDragEnd(networkId: number): void {
  dragging.value = false;
  const list = pinnedBufsByNet[networkId] || [];
  pins.reorder(
    networkId,
    list.map((b) => b.target),
  );
}

function onBufferContextMenu(e: MouseEvent, buf: Buffer): void {
  bufferActions.openMenuFor(buf, e.clientX, e.clientY);
}

// The per-row kebab (channel/DM rows) — opens the buffer's context menu anchored
// to the button, the same menu a right-click on the row gives.
function onRowActionsClick(e: MouseEvent, buf: Buffer): void {
  bufferActions.openMenuFromButton(buf, e.currentTarget as Element);
}

function rowClasses(buf: Buffer, networkId: number): Record<string, boolean> {
  return {
    active: isActive(networkId, buf.target),
    // Muted channels withhold the plain-unread cue (color/bold/edge arrow all
    // key off this class). `highlighted` is left untouched so mentions still
    // light the row up in the highlight color.
    unread: buf.unread > 0 && !isChannelMuted(buf),
    highlighted: buf.highlighted > 0,
    'not-joined': isUnjoined(buf, networkId),
    'peer-away': isPeerAway(buf),
    'peer-offline': isPeerOffline(buf),
  };
}

function select(networkId: number, target: string): void {
  buffers.activate(networkId, target);
}

function isActive(networkId: number, target: string): boolean {
  return networks.activeKey === `${networkId}::${target}`;
}

const isFriendsActive = computed(() => networks.activeKey === FRIENDS_KEY);
// The FRIENDS dot is green only when friends are actually reachable: the lurker
// service is up AND at least one IRC network is connected. If every network is
// down, it's red even though the lurker session itself is fine.
const anyNetworkConnected = computed(() =>
  networks.networks.some((n) => networks.states[n.id]?.state === 'connected'),
);
const friendsConnected = computed(() => lurkerConnected.value && anyNetworkConnected.value);
// FRIENDS dot reflects friend presence, not just connectivity (#367-adjacent
// polish): green if any friend is actively online, yellow (warn) if friends are
// present but all away, red otherwise (none online, or we're disconnected so
// every peer reads offline).
const friendsPresence = computed<'good' | 'warn' | 'bad'>(() => {
  if (!friendsConnected.value) return 'bad';
  let online = 0;
  let away = 0;
  for (const c of friends.contacts) {
    const state = friends.primaryPresence(c.id);
    if (state === 'online') online += 1;
    else if (state === 'away') away += 1;
  }
  return online > 0 ? 'good' : away > 0 ? 'warn' : 'bad';
});
const friendsStatusTitle = computed(() => {
  if (!lurkerConnected.value) return 'Disconnected from Lurker';
  if (!anyNetworkConnected.value) return 'Not connected to any network';
  return friendsPresence.value === 'good'
    ? 'Friends online'
    : friendsPresence.value === 'warn'
      ? 'Online friends are away'
      : 'No friends online';
});
function selectFriends(): void {
  friends.open();
}
// Clicking a friend opens their DM on the primary network — the FRIENDS group
// is a cross-network launcher/pin list for DMs. A target-less contact (none
// watched) falls back to opening its editor.
//
// Resolve to an EXISTING DM buffer case-insensitively so we never fork a second
// buffer that differs from the open one only by nick case. Computed once per
// render as a contactId → buffer map so the per-row getters below (presence,
// unread, highlight, active) don't each re-scan the network's buffers.
const dmBufByContact = computed<Map<number, Buffer | null>>(() => {
  const map = new Map<number, Buffer | null>();
  for (const c of friends.contacts) {
    const t = primaryTargetOf(c);
    map.set(c.id, t ? buffers.findDm(t.networkId, t.nick) : null);
  }
  return map;
});
function friendDmBuffer(c: Contact): Buffer | null {
  return dmBufByContact.value.get(c.id) ?? null;
}
function openFriendDm(c: Contact): void {
  friends.openDm(c);
}
function isFriendDmActive(c: Contact): boolean {
  const t = primaryTargetOf(c);
  if (!t) return false;
  const existing = friendDmBuffer(c);
  return networks.activeKey === `${t.networkId}::${existing ? existing.target : t.nick}`;
}
function friendRowClasses(c: Contact): Record<string, boolean> {
  // Reflect the PRIMARY DM's presence — that's the buffer this row opens, so an
  // alt being online elsewhere must not make the row look reachable.
  const state = friends.primaryPresence(c.id);
  // Mirror rowClasses so an unread/highlighted friend DM colors its name like
  // any other buffer (DMs are never muted, so no mute gate). An offline/away
  // friend with unread still dims to gray — the peer-state rule wins on source
  // order — but the accent-colored unread badge still flags it. (#307)
  const buf = friendDmBuffer(c);
  return {
    active: isFriendDmActive(c),
    unread: !!buf && buf.unread > 0,
    highlighted: !!buf && buf.highlighted > 0,
    'peer-offline': state === 'offline',
    'peer-away': state === 'away',
  };
}
function friendUnread(c: Contact): number {
  const buf = friendDmBuffer(c);
  return buf ? countFor(buf.unread, buf.highlighted) : 0;
}
function friendHighlights(c: Contact): number {
  return friendDmBuffer(c)?.highlighted ?? 0;
}
// Kebab / right-click menu on a friend row. Edit only — removal lives behind
// the modal's Remove button so a destructive action isn't one stray click away.
function openFriendActions(e: MouseEvent, c: Contact): void {
  const el = e.currentTarget as Element;
  const rect = el.getBoundingClientRect();
  friendMenu.open(
    [
      {
        label: 'Edit Friend…',
        icon: 'fa-solid fa-user-pen',
        onClick: () => friends.openEditorForContact(c),
      },
    ],
    rect.right,
    rect.bottom,
    el,
  );
}
// A friend's primary DM is shown under FRIENDS, so hide it from its real
// network's buffer list (dedupe).
function isFriendPrimaryDm(networkId: number | null, target: string): boolean {
  if (networkId == null) return false;
  return friends.primaryDmKeys.has(`${networkId}::${target.toLowerCase()}`);
}

function stateClass(networkId: number): string {
  const s = networks.states[networkId]?.state;
  if (s === 'connected') return 'good';
  if (s === 'connecting' || s === 'reconnecting') return 'warn';
  return 'bad';
}

// Channels render dimmed when we're either explicitly parted (joined=false)
// or when the network itself isn't connected — in both cases the buffer is
// just a history view, not a live channel. DMs and server buffers have no
// "joined" concept and are never dimmed by this rule.
function isUnjoined(buf: Buffer, networkId: number): boolean {
  if (!buf.target.startsWith('#')) return false;
  if (buf.joined === false) return true;
  return networks.states[networkId]?.state !== 'connected';
}

function peerOf(buf: Buffer): PeerPresenceEntry | null {
  if (buf.networkId == null) return null;
  return networks.peerFor(buf.networkId, buf.target);
}
function isPeerOffline(buf: Buffer): boolean {
  return isDmBuffer(buf) && derivePeerOffline(peerOf(buf));
}
function isPeerAway(buf: Buffer): boolean {
  return isDmBuffer(buf) && derivePeerAway(peerOf(buf));
}
function dmTitle(buf: Buffer): string | undefined {
  if (!isDmBuffer(buf)) return undefined;
  if (isPeerOffline(buf)) return `${buf.target} is offline`;
  if (isPeerAway(buf)) return `${buf.target} is away`;
  return undefined;
}

// The network header doubles as the server buffer's row, so it carries the
// same unread/highlighted hooks the channel rows do — both the styling and
// the out-of-view detection below treat it as just another unread row.
function netHeadClasses(networkId: number): Record<string, boolean> {
  return {
    active: isActive(networkId, serverTarget(networkId)),
    unread: serverUnread(networkId) > 0,
    highlighted: serverHighlights(networkId) > 0,
  };
}

// ── Out-of-view unread indicator ───────────────────────────────────────────
// When unread buffers are scrolled past the top or bottom edge of the list, a
// thin accent bar appears at that edge (IRCCloud-style). Detection walks the
// rendered unread rows and compares each against the scroller's viewport box.
const scroller = ref<HTMLElement | null>(null);
const unreadAbove = ref(false);
const unreadBelow = ref(false);
const highlightAbove = ref(false);
const highlightBelow = ref(false);

// A row counts as out of view only when it's *fully* past an edge — a
// partially visible unread row is considered seen and raises no bar. The bar
// takes the highlight colour when any of the off-screen unread rows that way
// is a highlight, mirroring the row label colours.
function recomputeEdges(): void {
  const sc = scroller.value;
  if (!sc) {
    unreadAbove.value = unreadBelow.value = false;
    highlightAbove.value = highlightBelow.value = false;
    return;
  }
  const view = sc.getBoundingClientRect();
  let above = false;
  let below = false;
  let hlAbove = false;
  let hlBelow = false;
  for (const el of sc.querySelectorAll('.unread, .highlighted')) {
    const r = el.getBoundingClientRect();
    const isHighlight = el.classList.contains('highlighted');
    if (r.bottom <= view.top + 1) {
      above = true;
      hlAbove = hlAbove || isHighlight;
    } else if (r.top >= view.bottom - 1) {
      below = true;
      hlBelow = hlBelow || isHighlight;
    }
  }
  unreadAbove.value = above;
  unreadBelow.value = below;
  highlightAbove.value = hlAbove;
  highlightBelow.value = hlBelow;
}

// Coalesce the scroll / resize / re-render triggers into one measure per
// frame — getBoundingClientRect forces layout, so we don't want it per event.
let rafId = 0;
function scheduleRecompute(): void {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    recomputeEdges();
  });
}

// Bring the unread row nearest the clicked edge into view; repeated clicks
// then walk through the rest.
function scrollToUnread(dir: 'up' | 'down'): void {
  const sc = scroller.value;
  if (!sc) return;
  const view = sc.getBoundingClientRect();
  let target: Element | null = null;
  let best = dir === 'up' ? -Infinity : Infinity;
  for (const el of sc.querySelectorAll('.unread, .highlighted')) {
    const r = el.getBoundingClientRect();
    if (dir === 'up' && r.bottom <= view.top + 1) {
      if (r.bottom > best) {
        best = r.bottom;
        target = el;
      }
    } else if (dir === 'down' && r.top >= view.bottom - 1) {
      if (r.top < best) {
        best = r.top;
        target = el;
      }
    }
  }
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// Keep a "scrolloff" zone of context around the active buffer when it changes
// from outside the list — Alt+arrow, quick switcher, jump-to-message, etc. Like
// vim's `scrolloff` or weechat's buffer list, we keep SCROLLOFF_ROWS buffers of
// context visible both above and below the active row — a symmetric margin, no
// notion of travel direction — so single-step nav always previews what's coming
// instead of jamming the selection flush against an edge.
//
// We compute the target scrollTop explicitly rather than leaning on
// scrollIntoView({ block: 'nearest' }) + a CSS scroll-margin (the old #182
// approach). `nearest` only ever buys the minimum scroll on the leading edge,
// and with smooth behavior a burst of Alt+arrow presses keeps cancelling the
// in-flight animation and recomputing from a position where the row is still at
// the edge — so the look-ahead collapsed to ~1 row (#388). A one-shot scrollTo
// to a measured target is immune to that, and reading the live row height keeps
// the zone honest across the 14px desktop / 16px mobile (≤768px) font sizes.
const SCROLLOFF_ROWS = 3;

function scrollActiveIntoZone(behavior: ScrollBehavior): void {
  const sc = scroller.value;
  if (!sc) return;
  const el = sc.querySelector<HTMLElement>('.net-head.active, .channels li.active');
  if (!el) return;
  const scRect = sc.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const rowH = elRect.height;
  if (rowH <= 0) return;
  // The LURKER row now lives in a fixed header *outside* this scroller (#411), so
  // the scroller's own top is the usable top of the viewport — no sticky-header
  // inset to subtract anymore. The system buffer's header can never be `.active`
  // inside `sc` (it isn't a descendant), so the query above returns null for it
  // and we've already bailed; no special-case needed here.
  const topEdge = scRect.top;
  const bottomEdge = scRect.bottom;
  // Never demand more room than centering would, so a viewport too short for the
  // full zone degrades to "centered" instead of fighting between the two edges.
  const margin = Math.min(SCROLLOFF_ROWS * rowH, Math.max(0, (bottomEdge - topEdge - rowH) / 2));
  let delta = 0;
  if (elRect.top < topEdge + margin) {
    delta = elRect.top - (topEdge + margin); // negative → scroll up
  } else if (elRect.bottom > bottomEdge - margin) {
    delta = elRect.bottom - (bottomEdge - margin); // positive → scroll down
  }
  // Already comfortably inside the zone — don't jitter the list on a click or a
  // same-row reactivation. The browser clamps the target to the scroll range.
  if (Math.abs(delta) < 1) return;
  sc.scrollTo({ top: sc.scrollTop + delta, behavior });
}

async function ensureActiveVisible(): Promise<void> {
  await nextTick();
  scrollActiveIntoZone('smooth');
}
watch(
  () => networks.activeKey,
  () => {
    // Wrap the async call so the watcher gets a sync callback — Vue doesn't
    // await the returned Promise either way, and explicit catch keeps any
    // future rejection from becoming an unhandled rejection.
    ensureActiveVisible().catch((err) => console.error('[BufferList] scroll active failed', err));
  },
);

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  // Cold-mount path: when the sidebar re-expands or the page first loads,
  // bring the previously-selected buffer into its scrolloff zone without
  // animation.
  void (async () => {
    await nextTick();
    scrollActiveIntoZone('auto');
  })();
  // Guard like MessageList does: ResizeObserver is missing in some SSR/test
  // contexts. The onUpdated remeasure still covers content changes there.
  if (typeof ResizeObserver !== 'undefined' && scroller.value) {
    resizeObserver = new ResizeObserver(scheduleRecompute);
    resizeObserver.observe(scroller.value);
  }
  recomputeEdges();
});
// The list re-renders on every unread-count change — that's the cue to
// remeasure which unread rows are now off-screen. recomputeEdges only writes
// refs, and same-value writes don't re-render, so this can't loop.
onUpdated(scheduleRecompute);
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (rafId) cancelAnimationFrame(rafId);
});
</script>

<style scoped>
/* The frame is the component root: a column of [fixed LURKER header] + [scroll
   region]. The header never scrolls (#411); the scroll region holds the
   scrollable nav plus the absolutely-pinned out-of-view unread bars. */
.buffer-list-frame {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* Positioned wrapper so the out-of-view unread bars pin to the top/bottom of the
   scroll viewport (below the fixed header), not the whole frame. */
.buffer-list-scroll {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}
.buffer-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  /* No top padding: the first network group sits flush under the fixed LURKER
     header so it lines up with the topic bar across the sidebar boundary. */
  padding: 0 0 var(--space-2);
}
/* IRCCloud-style affordance: a thin accent bar pinned to the top or bottom
   edge of the list when unread buffers are scrolled out of view that way.
   Clicking it scrolls the nearest off-screen unread buffer into view.
   The visible bar is drawn by a 3px ::before stripe — the surrounding
   button is taller (and transparent) purely to give the affordance an
   easy-to-click/tap hit area without making the visual any thicker. */
.unread-edge {
  position: absolute;
  left: 0;
  right: 0;
  height: 12px;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  z-index: var(--z-raised);
}
/* The global `button:hover` paints `--bg-soft`, which would show as a 12px
   strip over the buffer list. Keep the button transparent — the ::before
   stripe is the only visual. */
.unread-edge:hover {
  background: transparent;
}
.unread-edge.top {
  top: 0;
}
.unread-edge.bottom {
  bottom: 0;
}
.unread-edge::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--buffer-unread);
}
.unread-edge.top::before {
  top: 0;
}
.unread-edge.bottom::before {
  bottom: 0;
}
.unread-edge.is-highlight::before {
  background: var(--buffer-highlight);
}
/* Grow the visible stripe a touch on hover/focus so the affordance reads as
   interactive — the button's own hit area is already comfortably large. */
.unread-edge:hover::before {
  height: 5px;
}
.unread-edge:focus-visible::before {
  height: 5px;
  outline: 1px solid var(--fg);
  outline-offset: -1px;
}
.net {
  padding: var(--space-2) 0 var(--space-3);
}
.net + .net {
  border-top: 1px solid var(--border);
  margin-top: var(--space-2);
}
/* The LURKER row is the sidebar's header — a real fixed header now (#411): it's
   a flex child of the frame that sits above the scroll region and never scrolls,
   the same way the sidebar footer is pinned. Size it to the topic bar beside it:
   strip the group padding so it sits flush, give its head the topic bar's 8px
   block padding, and cap it with a 1px rule that lines up with the topic
   divider. (#355) */
.system-net {
  padding: 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.system-net .net-head {
  padding-block: var(--space-4);
  /* Trim the right padding to var(--space-2) so the always-visible inline
     + / gear / << line up with the absolutely-positioned + that the network /
     FRIENDS headers reveal at right: var(--space-2). Without this the LURKER
     controls, being in normal flow, end at the wider var(--space-5) content edge
     and read ~6px too far left. (#411) */
  padding-inline-end: var(--space-2);
}
.net-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-5);
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  border-left: 2px solid transparent;
  position: relative;
}
/* Gate :hover behind (hover: hover) so iPad-in-desktop-layout (width > 768px,
   touch-only) doesn't get the iOS sticky-hover two-tap: with bare :hover the
   first tap is consumed as a hover preview, only the second activates. See
   issue #11. */
@media (hover: hover) {
  .net-head:hover {
    background: var(--bg-soft);
  }
}
.net-head.active {
  background: var(--bg-soft);
  border-left-color: var(--accent);
}

/* Network-row header actions (+ add channel/network/friend, kebab). Hidden by
   default and revealed only when the row is engaged — hovered, selected
   (active), or keyboard-focused (#411) — so the corner stays quiet. At rest it
   shows the unread/highlight badge (or nothing); when the actions appear the
   badge steps aside so the two never stack.
   pointer-events:none while hidden is essential, not cosmetic: the actions are
   absolutely positioned over the badge, so an opacity:0 (but still hit-testable)
   overlay would swallow taps meant for the row. On a touch device in desktop
   layout (iPad, width>768) there's no hover, so without this a tap on a network
   row's right edge could fire "add channel"/options instead of opening it. */
.net-actions {
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  background: none;
  opacity: 0;
  pointer-events: none;
  transition: opacity 80ms linear;
}
.net-action {
  padding: 0 var(--space-2);
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  line-height: 1;
}
/* Reveal triggers. Selected (active) and keyboard focus work on every device;
   hover is desktop-only (gated below) so touch doesn't get a sticky-hover
   reveal. Each also hides the badge so it doesn't sit under the actions. */
.net-head.active .net-actions,
.net-head:focus-within .net-actions {
  opacity: 1;
  pointer-events: auto;
}
/* Only the network/FRIENDS headers hide their badge when the actions reveal —
   their actions are absolute and would overlap it. The LURKER header keeps its
   actions inline and always-visible (below), so its count never needs to hide. */
.net:not(.system-net) .net-head.active .badge,
.net:not(.system-net) .net-head:focus-within .badge {
  visibility: hidden;
}
@media (hover: hover) {
  .net-head:hover .net-actions {
    opacity: 1;
    pointer-events: auto;
  }
  .net:not(.system-net) .net-head:hover .badge {
    visibility: hidden;
  }
  .net-head:hover .net-action:disabled {
    opacity: 0.35;
  }
  .net-action:hover {
    color: var(--fg);
  }
}
.net-action:disabled {
  pointer-events: none;
}
@media (max-width: 768px) {
  .net-actions {
    display: none;
  }
}

/* LURKER header (#411): its actions ride the normal flex flow (static, not
   absolute) so they sit beside the unread count without overlapping it (which is
   also why the count never has to step aside here). The container stays visible
   because the << collapse control is a persistent affordance — but the + (add
   network), shield (admin panel) and gear (settings) reveal only on hover /
   selection / focus, like the other headers' actions. */
.system-net .net-actions {
  position: static;
  transform: none;
  opacity: 1;
  pointer-events: auto;
}
/* On pointer (hover-capable) devices, declutter the header: hide the +, shield
   and gear until the row is hovered, selected, or focused. Touch devices have no
   hover to reveal them (and display:none would make them unfocusable, so
   :focus-within couldn't help either) — so there the whole block is skipped and
   they stay visible. The collapse << is always visible on every device. */
@media (hover: hover) {
  .system-net .net-add,
  .system-net .net-admin,
  .system-net .net-settings {
    display: none;
  }
  .system-net .net-head:hover .net-add,
  .system-net .net-head:hover .net-admin,
  .system-net .net-head:hover .net-settings,
  .system-net .net-head.active .net-add,
  .system-net .net-head.active .net-admin,
  .system-net .net-head.active .net-settings,
  .system-net .net-head:focus-within .net-add,
  .system-net .net-head:focus-within .net-admin,
  .system-net .net-head:focus-within .net-settings {
    display: inline-flex;
  }
}

.name {
  flex: 1;
  color: var(--fg);
  /* Ellipsize like .label so a long network name clips instead of wrapping the
     row to two lines or running under the revealed + / kebab glyphs. min-width:0
     lets the flex item shrink below its content width so the ellipsis engages. */
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--bad);
  flex: 0 0 auto;
}
.indicator.good {
  background: var(--good);
}
.indicator.warn {
  background: var(--warn);
}
.indicator.bad {
  background: var(--bad);
}

.channels {
  list-style: none;
  margin: 0;
  padding: 0;
}
.channels li {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-5) var(--space-1) var(--space-9);
  cursor: pointer;
  border-left: 2px solid transparent;
  position: relative;
  user-select: none;
}
/* Tree guide: top-half vertical + horizontal arm. The arm meets the row's
   vertical centerline and stops short of the label, producing ├─ / └─. */
.channels li::before {
  content: '';
  position: absolute;
  left: var(--space-6);
  top: 0;
  height: 50%;
  width: 8px;
  border-left: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  pointer-events: none;
}
/* Bottom-half vertical: only when there's a sibling below — turns └─ into ├─. */
.channels li:not(:last-child)::after {
  content: '';
  position: absolute;
  left: var(--space-6);
  top: 50%;
  bottom: 0;
  width: 0;
  border-left: 1px solid var(--border);
  pointer-events: none;
}
/* When the pinned section is followed by a divider (i.e. there are unpinned
   buffers below), the last pinned row's spine must continue down through the
   divider — otherwise the └─ terminator would break the line. :has() scopes
   the override so an all-pinned network still terminates with └─ correctly. */
.channels.pinned:has(+ .pin-divider) li:last-child::after {
  content: '';
  position: absolute;
  left: var(--space-6);
  top: 50%;
  bottom: 0;
  width: 0;
  border-left: 1px solid var(--border);
  pointer-events: none;
}
@media (hover: hover) {
  .channels li:hover {
    background: var(--bg-soft);
  }
}
.channels li.active {
  background: var(--bg-soft);
  border-left-color: var(--accent);
}
.channels li.unread .label {
  color: var(--buffer-unread);
}
.channels li.highlighted .label {
  color: var(--buffer-highlight);
}
/* Bold is opt-in via look.buffer_list.unread_bold — applies to plain unread
   and highlighted rows alike (highlighted implies unread on the data side). */
.buffer-list.unread-bold .channels li.unread .label,
.buffer-list.unread-bold .channels li.highlighted .label {
  font-weight: 600;
}
/* Parted/disconnected channels render as a history view rather than a live
   buffer. Apply opacity to the whole row so badges, labels, and tree guides
   all dim together; unread/highlight colors still come through. */
.channels li.not-joined {
  opacity: 0.5;
}
/* DM/friend peer state. Both away and offline render in muted gray (matching
   away members in the channel nicklist); offline is additionally italicized,
   which is the offline tell. */
.channels li.peer-away .label,
.channels li.peer-offline .label {
  color: var(--fg-muted);
}
.channels li.peer-offline .label {
  font-style: italic;
}
.label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  color: var(--accent);
  padding: 0 var(--space-1);
}
.badge.highlight {
  color: var(--buffer-highlight);
}
/* Draft pencil is a passive "you've got unsent text here" cue, not an alert —
   render it in the muted text color so it doesn't compete with unread/
   highlight badges for attention. */
.badge.draft {
  color: var(--fg-muted);
}

/* Per-row settings affordance (the sliders on channel/DM rows, the kebab on
   friend rows). Absolute so it overlays the badges rather than displacing them.
   Same reveal model as the header + buttons (#411): hidden at rest, surfaced
   when the row is hovered, selected (active), or keyboard-focused, with the
   badge stepping aside so the two never stack. Background matches the row's
   hover/active shade so the overlay reads as part of the row. Hidden on phones
   (mobile uses the topic-bar cog / single-tap); on tablets the active row and
   long-press cover it. */
.channels .row-actions {
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
  padding: 0 var(--space-2);
  background: var(--bg-soft);
  border: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  line-height: 1;
  opacity: 0;
  /* pointer-events:none while hidden so the invisible overlay can't swallow taps
     on the row's right edge — on iPad (width>768) an inactive row's control
     never reveals, and long-press on the row opens the same menu, so it must
     never be tappable in its own right. */
  pointer-events: none;
  transition: opacity 80ms linear;
}
/* Reveal on select (active) or keyboard focus — works on every device. */
.channels li.active .row-actions,
.channels .row-actions:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
.channels li.active .badge {
  visibility: hidden;
}
/* Reveal on hover — desktop only, so touch doesn't get a sticky-hover reveal. */
@media (hover: hover) {
  .channels li:hover .row-actions {
    opacity: 1;
    pointer-events: auto;
  }
  .channels li:hover .badge {
    visibility: hidden;
  }
  .channels .row-actions:hover {
    color: var(--fg);
  }
}
@media (max-width: 768px) {
  .channels .row-actions {
    display: none;
  }
}

.empty {
  padding: var(--space-6);
  color: var(--fg-muted);
  font-style: italic;
}

/* Separator between the pinned section and the auto-sorted section. The
   vertical tree spine continues through the divider (so pinned and unpinned
   read as one connected tree); a short dashed horizontal arm marks the
   section boundary — like a phantom row that says "section break". */
.pin-divider {
  position: relative;
  height: 10px;
  pointer-events: none;
  /* Channel rows carry `border-left: 2px solid transparent` (reserved for the
     active-row accent), which shifts their content box 2px right. Mirror that
     here so the divider's left:12px spine lines up with the channel rows'. */
  border-left: 2px solid transparent;
}
.pin-divider::before {
  content: '';
  position: absolute;
  left: var(--space-6);
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--border);
}
.pin-divider::after {
  content: '';
  position: absolute;
  left: var(--space-6);
  right: var(--space-6);
  top: 50%;
  border-top: 1px solid var(--border);
}
/* The placeholder vuedraggable inserts during a drag — keep it visually
   subtle so it doesn't fight with the row hover state. */
.drag-ghost {
  opacity: 0.4;
  background: var(--bg-soft);
}
</style>
