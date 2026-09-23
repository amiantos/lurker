<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="mchat">
    <!-- Screen: channel list -->
    <section v-if="screen === 'list'" class="screen list">
      <header class="bar">
        <button type="button" class="logo" title="Open system buffer" @click="openSystemConsole">
          lurker
        </button>
        <span v-if="!connected" class="status off" title="Disconnected">●</span>
        <span class="spacer"></span>
        <button class="icon" title="Search messages" @click="openSearch(false)">
          <i class="fa-solid fa-magnifying-glass"></i>
        </button>
        <button class="icon" title="Highlights" @click="openHighlights(false)">
          <i class="fa-regular fa-bell"></i>
        </button>
        <button class="icon" title="Saved messages" @click="showBookmarks = true">
          <i class="fa-regular fa-bookmark"></i>
        </button>
        <button class="icon" title="Recent uploads" @click="showUploads = true">
          <i class="fa-solid fa-arrow-up-from-bracket"></i>
        </button>
        <!-- Self-revealing DCC transfers button — see DesktopChat for rationale.
             Warn-colored while an offer awaits a decision. -->
        <button
          v-if="dcc.hasAny || dcc.panelOpen"
          class="icon dcc-btn"
          :class="{ pending: dcc.pendingCount > 0 }"
          :title="dccTitle"
          @click="dcc.open()"
        >
          <i class="fa-solid fa-download"></i>
        </button>
        <button class="icon" title="Add network" @click="openAddNetwork">
          <i class="fa-solid fa-plus"></i>
        </button>
        <RouterLink
          v-if="showAdminEntry"
          class="icon"
          to="/admin"
          title="Admin panel"
          aria-label="Admin panel"
        >
          <i class="fa-solid fa-shield-halved"></i>
        </RouterLink>
        <RouterLink class="icon" to="/settings" title="Settings">
          <i class="fa-solid fa-gear"></i>
        </RouterLink>
      </header>
      <div class="bufferlist-wrap" @click="onBufferListClick">
        <BufferList />
      </div>
    </section>

    <!-- Screen: buffer -->
    <section v-else-if="screen === 'buffer'" class="screen buffer">
      <header class="bar">
        <!-- Leaving this screen is the only way back to the buffer list, so its
             per-row highlight badges collapse onto this button while it's the
             only thing standing in for them (#636). Inline rather than a corner
             badge: .icon is already a flex row and the bar has the width, so
             "← 3" stays legible where an overlay on a 36px target would not. -->
        <button class="icon back" :title="backTitle" :aria-label="backTitle" @click="goList">
          <i class="fa-solid fa-arrow-left"></i>
          <span v-if="hlChip.show.value" class="hl-chip" aria-hidden="true">{{
            hlChip.label.value
          }}</span>
        </button>
        <!-- Channels and DMs drop the name here — the compact status bar
             carries net/#chan on mobile, so a header copy is just redundant
             clutter (#222). The server buffer (input placeholder is "try /commands")
             and the system console (no input row at all) have no
             other persistent label, so they keep an explicit title. Otherwise
             the bar holds only buffer-scoped actions: search & highlights open
             pre-filtered to this buffer (in:<target> on:<network>), members
             toggles the roster, the rest folds into the kebab. The *global*
             search / highlights / saved / uploads live on the list top bar. -->
        <span v-if="isServerBuffer || isVirtual" class="title">{{ bufferLabel }}</span>
        <span class="spacer"></span>
        <button
          v-if="!isVirtual && !isServerBuffer"
          class="icon"
          title="Search this buffer"
          @click="openSearch(true)"
        >
          <i class="fa-solid fa-magnifying-glass"></i>
        </button>
        <button
          v-if="!isVirtual && !isServerBuffer"
          class="icon"
          title="Highlights in this buffer"
          @click="openHighlights(true)"
        >
          <i class="fa-regular fa-bell"></i>
        </button>
        <template v-if="isServerBuffer">
          <button
            class="icon"
            title="Join channel"
            aria-label="Join channel"
            :disabled="serverConnectionState !== 'connected'"
            @click="active && joinChannelModal.open(active.networkId)"
          >
            <i class="fa-solid fa-plus"></i>
          </button>
          <button
            class="icon"
            title="Channel list"
            aria-label="Channel list"
            @click="active && channelListModal.open(active.networkId)"
          >
            <i class="fa-solid fa-hashtag"></i>
          </button>
        </template>
        <button
          v-if="isChannel"
          class="icon"
          title="Members"
          aria-label="Members"
          @click="goMembers"
        >
          <i class="fa-solid fa-users"></i>
        </button>
        <button
          v-if="active"
          ref="bufferCogBtn"
          class="icon"
          title="Buffer actions"
          aria-label="Buffer actions"
          @click="openBufferActions"
        >
          <i class="fa-solid fa-ellipsis-vertical"></i>
        </button>
      </header>
      <MessageList :pending-scroll-id="pendingScrollId" />
      <StatusBar compact />
      <div
        v-if="hasInput"
        class="composer-host"
        :class="{ 'keyboard-open': keyboardOpen, 'system-input': isSystemBuffer }"
      >
        <MessageInput ref="messageInputRef" />
      </div>
    </section>

    <!-- Screen: members -->
    <section v-else-if="screen === 'members'" class="screen members-screen">
      <header class="bar">
        <button class="icon back" title="Back" @click="goBufferFromMembers">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        <span class="title">{{ bufferLabel }} — members</span>
      </header>
      <MemberList />
    </section>

    <NetworkForm
      v-if="networkEditor.isOpen"
      :network="networkEditor.editingNetwork ?? undefined"
      @close="closeNetworkForm"
    />
    <HighlightsModal
      v-if="showHighlights"
      :scope="highlightScope"
      @close="showHighlights = false"
      @jump="onJumpToMessage"
    />
    <BookmarksModal v-if="showBookmarks" @close="showBookmarks = false" @jump="onJumpToMessage" />
    <!-- Opened from the shared buffer menu (Channel Settings…); keyed so
         opening another channel starts fresh. -->
    <ChannelModal
      v-if="channelModal.isOpen.value && channelModal.target.value"
      :key="`${channelModal.networkId.value}::${channelModal.target.value}`"
      :network-id="channelModal.networkId.value!"
      :target="channelModal.target.value"
      @close="channelModal.close()"
    />
    <ChannelListModal
      v-if="channelListModal.isOpen && channelListModal.networkId !== null"
      :network-id="channelListModal.networkId!"
      @close="channelListModal.close()"
    />
    <JoinChannelModal
      v-if="joinChannelModal.isOpen && joinChannelModal.networkId !== null"
      :network-id="joinChannelModal.networkId!"
      @close="joinChannelModal.close()"
    />
    <RecentUploadsModal v-if="showUploads" @close="showUploads = false" />
    <TransfersModal v-if="dcc.panelOpen" @close="dcc.close()" />
    <SearchModal
      v-if="showSearch"
      :scope="searchScope"
      @close="showSearch = false"
      @jump="onJumpToMessage"
    />
    <MediaViewerModal
      v-if="viewer.isOpen && viewer.url !== null"
      :url="viewer.url"
      :share-url="viewer.shareUrl"
      :kind="viewer.current?.kind ?? null"
      :filename="viewer.current?.filename ?? null"
      :index="viewer.index"
      :count="viewer.count"
      :has-prev="viewer.hasPrev"
      :has-next="viewer.hasNext"
      @close="viewer.close()"
      @prev="viewer.prev()"
      @next="viewer.next()"
    />
    <UserProfileModal
      v-if="whois.viewer.open && whois.viewer.networkId != null"
      :nick="whois.viewer.nick"
      :network-id="whois.viewer.networkId"
    />
    <!-- NickNoteModal comes last so when both are open (edit-note-from-profile)
         it lands on top — AppModal uses a fixed z-index, so DOM order is the
         tiebreaker. -->
    <NickNoteModal
      v-if="nickNotes.editor.open && nickNotes.editor.networkId != null"
      :nick="nickNotes.editor.nick"
      :network-id="nickNotes.editor.networkId"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Network } from '../stores/networks.js';
import type { BufferLike } from '../composables/useBufferActions.js';
import { canDisconnect, useNetworksStore } from '../stores/networks.js';
import { useSocket } from '../composables/useSocket.js';
import { useChatBootstrap } from '../composables/useChatBootstrap.js';
import { pushBuffer } from '../composables/useBufferRoute.js';
import { useActiveBuffer } from '../composables/useActiveBuffer.js';
import { useBufferSearchScope } from '../composables/useBufferSearchScope.js';
import { useBufferActions } from '../composables/useBufferActions.js';
import { useContextMenu } from '../composables/useContextMenu.js';
import type { ContextMenuItem } from '../composables/useContextMenu.js';
import BufferList from '../components/BufferList.vue';
import MessageList from '../components/MessageList.vue';
import MessageInput from '../components/MessageInput.vue';
import MemberList from '../components/MemberList.vue';
import StatusBar from '../components/StatusBar.vue';
import NetworkForm from '../components/NetworkForm.vue';
import HighlightsModal from '../components/HighlightsModal.vue';
import BookmarksModal from '../components/BookmarksModal.vue';
import ChannelModal from '../components/ChannelModal.vue';
import { useChannelModal } from '../composables/useChannelModal.js';
import ChannelListModal from '../components/ChannelListModal.vue';
import JoinChannelModal from '../components/JoinChannelModal.vue';
import RecentUploadsModal from '../components/RecentUploadsModal.vue';
import TransfersModal from '../components/TransfersModal.vue';
import SearchModal from '../components/SearchModal.vue';
import NickNoteModal from '../components/NickNoteModal.vue';
import UserProfileModal from '../components/UserProfileModal.vue';
import MediaViewerModal from '../components/MediaViewerModal.vue';
import { screenForRoute } from '../utils/mobileScreen.js';
import { backOrPush } from '../utils/routerBack.js';
import { shouldLeaveMembers } from '../utils/bufferNav.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useDccStore } from '../stores/dcc.js';
import { useWhoisStore } from '../stores/whois.js';
import { useChannelListModal } from '../composables/useChannelListModal.js';
import { useJoinChannelModal } from '../composables/useJoinChannelModal.js';
import { useMediaViewer } from '../composables/useMediaViewer.js';
import { useNetworkEditor } from '../composables/useNetworkEditor.js';
import { useJumpToMessage } from '../composables/useJumpToMessage.js';
import { useVisualViewport } from '../composables/useVisualViewport.js';
import { useHighlightChip } from '../composables/useHighlightChip.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useAuthStore } from '../stores/auth.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

// Admin panel entry in the mobile top bar.
const showAdminEntry = computed(() => auth.isAdmin);

const hlChip = useHighlightChip();
// The chip is aria-hidden in the markup — screen readers get the count here as
// words instead, so "Back" doesn't turn into "Back 3".
const backTitle = computed(() =>
  hlChip.show.value
    ? `Back — ${hlChip.label.value} highlight${hlChip.count.value === 1 ? '' : 's'}`
    : 'Back',
);
const { connected } = useSocket();
const { keyboardOpen } = useVisualViewport();
const {
  active,
  activeKey,
  activeBuf,
  isChannel,
  isServerBuffer,
  bufferLabel,
  isSystemBuffer,
  isVirtual,
  hasInput,
} = useActiveBuffer();
const bufferActions = useBufferActions();
const menu = useContextMenu();
const nickNotes = useNickNotesStore();
const dcc = useDccStore();
const dccTitle = computed(() =>
  dcc.pendingCount > 0 ? `DCC transfers — ${dcc.pendingCount} awaiting approval` : 'DCC transfers',
);
const whois = useWhoisStore();

function openSystemConsole() {
  // Route through activate() (not networks.activateSystem) so the system buffer
  // gets the full read-state lifecycle: divider snapshot + mark-read on entry.
  buffers.activate(null, SYSTEM_KEY);
  // By NAME, not id: this is the one buffer that has to open before the server
  // has answered — which is exactly when its connection log is worth reading.
  void router.push('/system');
}

const channelListModal = reactive(useChannelListModal());
const joinChannelModal = reactive(useJoinChannelModal());
const viewer = reactive(useMediaViewer());
const networkEditor = reactive(useNetworkEditor());

// `/` → list, `/buffer/<id>` → buffer, `/buffer/<id>/members` → members.
//
// DERIVED, never assigned (#744/#200). It used to be a ref nudged from four
// places, which is what made the mobile shell and the URL able to disagree: the
// list screen had no history entry of its own, so a back gesture from it popped
// to a BUFFER url and the auto-advance watcher dutifully hauled the user into
// that buffer, on top of the list they'd just asked for. With the route as the
// single source, "which screen" and "which URL" cannot come apart, and the
// platform back gesture walks members → buffer → list for free.
//
// The activeKey clause keeps a cold launch honest: `/buffer/7` is a real screen
// the instant it's routed, but the buffer behind it arrives over the WS a beat
// later, and rendering an empty buffer shell in the meantime looks broken. Wait
// on the list, exactly as the old auto-advance did. useBufferRoute owns the
// other end of that wait — it drops the URL back to `/` if the id never lands.
// True while the active buffer is a real IRC buffer the server hasn't given a
// row id yet — an optimistically opened DM. Nothing can route to it.
const activeLacksId = computed(() => {
  const buf = activeBuf.value as { id?: number; networkId?: number | null } | null;
  return !!buf && buf.networkId != null && buf.id == null;
});

const screen = computed(() =>
  screenForRoute(
    route.params.id,
    route.name === 'buffer-members',
    !!activeKey.value,
    route.name === 'system',
    activeLacksId.value,
  ),
);
const showBookmarks = ref(false);
const channelModal = useChannelModal();
const showUploads = ref(false);
const pendingScrollId = ref<number | null>(null);
const messageInputRef = ref<{ focus: () => void } | null>(null);
const bufferCogBtn = ref<HTMLElement | null>(null);

// Search & Highlights modal state + per-buffer `in:/on:` scoping, shared with
// DesktopChat (#496).
const { showSearch, showHighlights, searchScope, highlightScope, openSearch, openHighlights } =
  useBufferSearchScope();

// Mobile folds the remaining buffer/topic/server actions behind one kebab menu
// to keep the header uncluttered (Members is an inline header button — see
// template). The menu is assembled per buffer type: either the shared buffer-actions menu
// (pin/notify/profile/note/close) for channels & DMs, or the server controls
// (browse/connect/edit) for server buffers. Anchored under the kebab like the
// desktop sidebar menu; ContextMenu clamps it to the viewport.
function openBufferActions() {
  const a = active.value;
  const el = bufferCogBtn.value;
  if (!a || !el) return;
  const items: ContextMenuItem[] = [];
  if (isServerBuffer.value) {
    // Join channel / Channel list now live as top-bar buttons for server buffers,
    // so the kebab keeps just the less-frequent connect/edit actions.
    items.push(
      {
        label: serverConnectActionLabel.value,
        icon: serverConnectActionIcon.value,
        // ⚠ The decision goes WITH the label. Unlike the desktop header — whose
        // button binds the computed reactively, so the two are read at the same
        // instant — this kebab snapshots the label into a static array when the
        // menu opens, and the menu then sits there. Re-reading state at click
        // time lets the item say "Disconnect" and fire a reconnect: open it
        // during a backoff, have the retry gate refuse (paused account, host
        // dropped from the allowlist) so stopReconnecting settles the state to
        // 'disconnected', and tap. Same trap as useNetworkActions.buildItems.
        onClick: () => toggleServerConnection(serverOffersDisconnect.value),
      },
      { label: 'Edit network', icon: 'fa-solid fa-gear', onClick: editActiveNetwork },
    );
  } else {
    const bufItems = bufferActions.buildItems(activeBuf.value as BufferLike);
    if (items.length && bufItems.length) items.push({ divider: true });
    items.push(...bufItems);
  }
  if (items.length === 0) return;
  const rect = el.getBoundingClientRect();
  menu.open(items, rect.left, rect.bottom + 2, el);
}

function openAddNetwork() {
  networkEditor.open();
}

function editActiveNetwork() {
  const net = active.value?.network as Network | undefined;
  if (!net) return;
  networkEditor.open(net);
}

// State-aware connect/disconnect for the server buffer header. Mirrors the
// desktop logic, via the shared canDisconnect: "Disconnect" covers connected AND
// the in-flight states, because during a reconnect backoff it is the only thing
// that stops the loop (#785).
const serverConnectionState = computed(() => {
  if (!active.value || !isServerBuffer.value) return null;
  return networks.states[active.value.networkId]?.state ?? null;
});
const serverOffersDisconnect = computed(() => canDisconnect(serverConnectionState.value));
const serverConnectActionLabel = computed(() =>
  serverOffersDisconnect.value ? 'Disconnect' : 'Reconnect',
);
const serverConnectActionIcon = computed(() =>
  serverOffersDisconnect.value ? 'fa-solid fa-plug-circle-xmark' : 'fa-solid fa-plug',
);
function toggleServerConnection(offerDisconnect: boolean) {
  if (!active.value) return;
  const id = active.value.networkId;
  // Fire-and-forget — the button's label is driven by networks.states so
  // success reflects itself. A failed call stays observable via the state
  // (label doesn't flip), so we just log and let the user retry rather
  // than wiring a toast through the bar for this case.
  const p = offerDisconnect ? networks.disconnect(id) : networks.reconnect(id);
  p.catch((err) => console.error('[MobileChat] toggle server connection failed', err));
}

function closeNetworkForm() {
  networkEditor.close();
}

// Send DM out of a nick menu flips activeKey to a new DM buffer while the user
// is on the members screen; the route has to follow or they'd be left looking
// at the old channel's member list. Every other activation path already
// navigates (useBufferRoute's binding, or openActiveBuffer above).
//
// Guarded by shouldLeaveMembers: a cold refresh of /buffer/:id/members also
// lands here — the snapshot resolves and useBufferRoute activates the buffer
// this route already names — and navigating for THAT bounced the user to the
// chat screen before the members screen ever rendered.
watch(activeKey, () => {
  if (route.name !== 'buffer-members') return;
  const buf = activeBuf.value as { id?: number } | null;
  if (shouldLeaveMembers(buf?.id, route.params.id)) openActiveBuffer();
});

// Navigate to whichever buffer is active NOW.
//
// Needed wherever an activation might not CHANGE activeKey, because
// useBufferRoute's activeKey → URL binding is a watcher and correctly does
// nothing when there's no change: re-tapping the buffer you were last in, or
// re-tapping the Lurker logo while already on `:system:`. Both are a
// navigation from the user's point of view even though no state moved.
function openActiveBuffer() {
  const buf = activeBuf.value as { id?: number; networkId?: number | null } | null;
  if (!buf) return;
  // App-scoped (the system console) routes by name — it may have no row id yet.
  if (buf.networkId == null) {
    void router.push('/system');
    return;
  }
  if (buf.id != null) {
    pushBuffer(router, buf.id);
    return;
  }
  // Active but not addressable yet — a DM opened optimistically has no row id
  // until the server answers. Deliberately does NOT navigate: pushing `/` here
  // dropped the user on the buffer list with a DM they could not reach from it
  // (no id to route to, and the server only mints the row once a message is
  // sent — which needs the composer). `screen` shows it via activeLacksId
  // instead, until the id lands and the URL binding routes to it properly.
}

function onBufferListClick(e: MouseEvent) {
  // :not(.section-head): the FRIENDS/FAVORITES headers are inert labels — a
  // tap on one must not teleport into whatever buffer was last active.
  const hit = (e.target as Element).closest('.channels li, .net-head:not(.section-head)');
  if (!hit) return;
  // BufferList's own @click ran first (Vue event bubbling), so activeKey is
  // already up to date by the time we read it.
  openActiveBuffer();
}

function goList() {
  // Backing out of an optimistically opened buffer can't be a navigation: it
  // has no URL, so the route may already BE `/` (Send DM from the list), where
  // a push is a no-op and the screen would stay locked on the DM. Clear the
  // active pointer instead — the buffer keeps its place in the list, and the
  // URL binding normalizes whatever route we're on.
  if (activeLacksId.value) {
    networks.clearActive();
    return;
  }
  void router.push('/');
}

// The members screen has its own URL now, so it can be the FIRST entry of a
// document (refresh, or a shared link) — in which case back() either does
// nothing or leaves Lurker. Fall back to the buffer it belongs to.
function goBufferFromMembers() {
  backOrPush(router, route.params.id ? `/buffer/${route.params.id}` : '/');
}

function goMembers() {
  // The ACTIVE buffer's id, not route.params.id: the button belongs to the
  // buffer on screen, and the two can disagree — a channel shown via
  // activeLacksId before its row id lands leaves the route naming the PREVIOUS
  // buffer, so the route form opened the wrong channel's member list. While
  // the id is missing there is nothing to route to; the button no-ops.
  const buf = activeBuf.value as { id?: number } | null;
  if (buf?.id != null) void router.push(`/buffer/${buf.id}/members`);
}

const onJumpToMessage = useJumpToMessage({
  pendingScrollId,
  // A search hit or notification for the buffer the user is ALREADY in doesn't
  // move activeKey, so nothing would carry them off the list to see it.
  afterActivate: openActiveBuffer,
});

useChatBootstrap({ onJump: onJumpToMessage });
</script>

<style scoped>
/* Single-column flex stack sized to 100dvh. On current iOS Safari the
   dynamic-viewport unit shrinks with the soft keyboard, so the shell
   contracts and the input bar (last flex child) rides up flush against
   the keyboard with no extra plumbing. Chrome Android needs one assist
   to follow the same model: interactive-widget=resizes-content in the
   viewport meta (index.html, #581) — without it Chrome overlays the
   keyboard instead of shrinking the layout viewport, and its focused-
   input reveal scrolls the document our shell forbids from scrolling,
   stranding the input bar off-screen after dismiss. We deliberately do
   NOT use position: fixed or a JS-tracked --kb-bottom here — those
   approaches fight iOS auto-scroll, env() shifts, and a known iOS 26
   visualViewport regression (returns phantom positive values after
   keyboard dismiss).
   The body-level `touch-action: none` (see main.css) is what stops iOS
   from drag-scrolling the document despite overflow:hidden. Safe-area
   home-indicator clearance lives on .composer-host (below) — wrapping
   MessageInput so it can't compete with the shell's geometry. */
.mchat {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.screen {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* Header bar (top of every screen). Uses the same accent + border colors as
   the desktop sidebar so the two layouts feel like one app. */
.bar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6);
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.logo {
  color: var(--accent);
  font-weight: bold;
  background: transparent;
  border: none;
  padding: 0;
  font: inherit;
  cursor: pointer;
}
.status.off {
  color: var(--bad);
}
.title {
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.spacer {
  flex: 1;
}
.icon {
  background: none;
  border: none;
  color: var(--accent);
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
  font: inherit;
  text-decoration: none;
  /* Big enough touch target without dominating the header height. */
  min-width: 36px;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon:hover {
  color: var(--fg);
}
/* Disabled top-bar icon (e.g. Join channel while the network is disconnected):
   dimmed and non-interactive, and it must not brighten on hover. */
.icon:disabled {
  opacity: 0.4;
  cursor: default;
}
.icon:disabled:hover {
  color: var(--accent);
}
/* Transfers button turns warn-colored while an offer awaits a decision
   (color-as-signal, no count badge — matches DesktopChat). */
.icon.dcc-btn.pending {
  color: var(--warn);
}
.icon.back {
  margin-left: -4px;
  gap: var(--space-2);
}
/* Highlight total for the buffer list this button returns to. Colored text on a
   tint of the same var rather than a solid fill: --buffer-highlight is
   user-themeable (look.color.buffer.highlight), so a fixed label color could
   land on an unreadable pairing — the tint tracks their choice and the text
   keeps its contrast against it. Mixed against --bg (not transparent) so the
   pill is opaque: a see-through wash let the back arrow ghost through where the
   two overlap at larger font sizes. Matches DesktopChat's rail chip. */
.icon.back .hl-chip {
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  font-size: 0.85em;
  color: var(--buffer-highlight);
  background: color-mix(in srgb, var(--buffer-highlight) 24%, var(--bg));
}
/* The buffer screen's MessageList + StatusBar + MessageInput chain mirrors
   the desktop rows but in a vertical flex. min-height: 0 on the screen +
   flex: 1 on MessageList is what lets it scroll without pushing the input
   off the visible viewport. */
.buffer :deep(.message-list) {
  flex: 1;
  min-height: 0;
}
.buffer :deep(.status-bar) {
  flex: 0 0 auto;
}

/* iOS Safari scroll-target trick. When an input is focused, iOS scrolls
   the input's nearest scrollable ancestor to bring it into view, leaving
   a comfort margin between the input and the keyboard top. If no
   scrollable ancestor exists, iOS falls back to scrolling the
   *visualViewport* itself — that's where the previous gap came from.
   `overflow-y: scroll` here gives iOS a scrollable target. There's
   nothing actually to scroll (the inner input fits exactly), so the
   scroll is a no-op — but iOS targets this element instead of the
   viewport, so no gap appears.

   padding-bottom carries the home-indicator safe-area inset (only
   non-zero in PWA standalone) and collapses to 0 when the keyboard is
   up via the .keyboard-open class — the keyboard already covers the
   home-indicator zone. .keyboard-open is bound from the keyboardOpen
   ref in script setup, which combines three signals (visualViewport
   height delta, visualViewport offsetTop, and focused-input fallback)
   so iOS PWA — where visualViewport.resize doesn't fire reliably — is
   still caught. */
.composer-host {
  flex: 0 0 auto;
  overflow-y: scroll;
  -webkit-overflow-scrolling: touch;
  touch-action: pan-y;
  scrollbar-width: none;
}
.composer-host::-webkit-scrollbar {
  display: none;
}
/* env(safe-area-inset-bottom) only applies in PWA standalone. Mobile
   Safari's own bottom chrome already keeps content above the home
   indicator, so applying the inset there leaves a redundant gap. */
@media (display-mode: standalone) {
  .composer-host {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
}
.composer-host.keyboard-open {
  padding-bottom: 0;
}
.composer-host :deep(.input) {
  flex: 0 0 auto;
}
/* The compact status bar carries the separator border above the input, but it's
   hidden in the system buffer — give the input its own top border there. */
.composer-host.system-input :deep(.input) {
  border-top: 1px solid var(--border);
}

/* Member list takes the rest of the height on its own screen. */
.members-screen :deep(.members) {
  flex: 1;
  min-height: 0;
}

/* The wrap is the flex child that takes the rest of the list screen; the
   inner BufferList's own `flex: 1; overflow: auto` handles its scroll. */
.bufferlist-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.bufferlist-wrap :deep(.buffer-list) {
  flex: 1;
  min-height: 0;
}
</style>
