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
          <SearchIcon />
        </button>
        <button class="icon" title="Activity" @click="openHighlights(false)">
          <BellIcon />
        </button>
        <button class="icon" title="Saved messages" @click="showBookmarks = true">
          <BookmarkIcon />
        </button>
        <button
          class="icon"
          :title="auth.canUpload ? 'Shares' : auth.uploadsOffTitle"
          @click="auth.canUpload ? (showUploads = true) : limits.open()"
        >
          <ShareIcon />
        </button>
        <DccButton class="icon" />
        <button class="icon" title="Add network" @click="openAddNetwork">
          <PlusIcon />
        </button>
        <RouterLink
          v-if="showAdminEntry"
          class="icon"
          to="/admin"
          title="Admin panel"
          aria-label="Admin panel"
        >
          <ShieldCogIcon />
        </RouterLink>
        <RouterLink class="icon" to="/settings" title="Settings">
          <SettingsIcon />
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
          <ArrowLeftIcon />
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
          <SearchIcon />
        </button>
        <button
          v-if="!isVirtual && !isServerBuffer"
          class="icon"
          title="Activity in this buffer"
          @click="openHighlights(true)"
        >
          <BellIcon />
        </button>
        <template v-if="isServerBuffer">
          <button
            class="icon"
            title="Join channel"
            aria-label="Join channel"
            :disabled="serverConnectionState !== 'connected'"
            @click="active && joinChannelModal.open(active.networkId)"
          >
            <PlusIcon />
          </button>
          <button
            class="icon"
            title="Channel list"
            aria-label="Channel list"
            @click="active && channelListModal.open(active.networkId)"
          >
            <HashIcon />
          </button>
        </template>
        <button
          v-if="threadsOn && isChannel"
          class="icon threads-btn"
          :title="
            threadHighlights > 0 ? `Threads — ${threadHighlights} with a new highlight` : 'Threads'
          "
          :aria-label="
            threadHighlights > 0 ? `Threads — ${threadHighlights} with a new highlight` : 'Threads'
          "
          @click="goThreads"
        >
          <MessagesSquareIcon />
          <span v-if="threadHighlights > 0" class="hl-chip" aria-hidden="true">{{
            threadHighlights
          }}</span>
        </button>
        <button
          v-if="isChannel"
          class="icon"
          title="Members"
          aria-label="Members"
          @click="goMembers"
        >
          <UsersIcon />
        </button>
        <button
          v-if="active"
          ref="bufferCogBtn"
          class="icon"
          title="Buffer actions"
          aria-label="Buffer actions"
          @click="openBufferActions"
        >
          <EllipsisVerticalIcon />
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
          <ArrowLeftIcon />
        </button>
        <span class="title">{{ bufferLabel }} — members</span>
      </header>
      <MemberList />
    </section>

    <!-- Screen: a reply thread, or the buffer's thread list (#1225). This bar
         heads it (the panel draws none on a screen). Back pops history, so a
         thread opened from the list returns to the list and one opened from a
         chip returns to the buffer; with no history, the buffer. -->
    <section v-else-if="screen === 'thread' || screen === 'threads'" class="screen thread-screen">
      <header class="bar">
        <button class="icon back" title="Back" @click="goBufferFromMembers">
          <ArrowLeftIcon />
        </button>
        <span class="title"
          >{{ bufferLabel }} — {{ screen === 'thread' ? 'thread' : 'threads' }}</span
        >
      </header>
      <ThreadPanel screen />
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
      v-if="channelModal.current.value"
      :key="`${channelModal.current.value.networkId}::${channelModal.current.value.target}`"
      :network-id="channelModal.current.value.networkId"
      :target="channelModal.current.value.target"
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
    <AccountLimitsModal v-if="limits.isOpen" @close="limits.close()" />
    <RecentUploadsModal v-if="dcc.panelOpen" view="dcc" @close="dcc.close()" />
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
    <ProfileEditorModal
      v-if="profileEditor.networkId.value != null"
      :network-id="profileEditor.networkId.value"
    />
    <!-- NickNoteModal comes last so when both are open (edit-note-from-profile)
         it lands on top — AppModal uses a fixed z-index, so DOM order is the
         tiebreaker. -->
    <NickNoteModal
      v-if="nickNotes.editor.open && nickNotes.editor.networkId != null"
      :nick="nickNotes.editor.nick"
      :network-id="nickNotes.editor.networkId"
    />
    <ReactModal v-if="reactions.picker.open" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Network } from '../stores/networks.js';
import type { BufferLike } from '../composables/useBufferActions.js';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
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
import ThreadPanel from '../components/ThreadPanel.vue';
import { useThreadsStore } from '../stores/threads.js';
import { navigateThread, onThreadNav, requestThreadNav } from '../composables/useThreadNav.js';
import type { MobileSubScreen } from '../utils/mobileScreen.js';
import StatusBar from '../components/StatusBar.vue';
import NetworkForm from '../components/NetworkForm.vue';
import HighlightsModal from '../components/HighlightsModal.vue';
import BookmarksModal from '../components/BookmarksModal.vue';
import ChannelModal from '../components/ChannelModal.vue';
import { useChannelModal } from '../composables/useChannelModal.js';
import ChannelListModal from '../components/ChannelListModal.vue';
import JoinChannelModal from '../components/JoinChannelModal.vue';
import RecentUploadsModal from '../components/RecentUploadsModal.vue';
import AccountLimitsModal from '../components/AccountLimitsModal.vue';
import { useAccountLimits } from '../composables/useAccountLimits.js';
import DccButton from '../components/DccButton.vue';
import SearchModal from '../components/SearchModal.vue';
import NickNoteModal from '../components/NickNoteModal.vue';
import ReactModal from '../components/ReactModal.vue';
import UserProfileModal from '../components/UserProfileModal.vue';
import MediaViewerModal from '../components/MediaViewerModal.vue';
import { screenForRoute } from '../utils/mobileScreen.js';
import { backOrPush } from '../utils/routerBack.js';
import { shouldLeaveMembers } from '../utils/bufferNav.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useReactionsStore } from '../stores/reactions.js';
import { useDccStore } from '../stores/dcc.js';
import { useWhoisStore } from '../stores/whois.js';
import { useChannelListModal } from '../composables/useChannelListModal.js';
import { useJoinChannelModal } from '../composables/useJoinChannelModal.js';
import { useMediaViewer } from '../composables/useMediaViewer.js';
import { useNetworkEditor } from '../composables/useNetworkEditor.js';
import { useProfileEditor } from '../composables/useProfileEditor.js';
import ProfileEditorModal from '../components/ProfileEditorModal.vue';
import { useNetworkActions } from '../composables/useNetworkActions.js';
import { useJumpToMessage } from '../composables/useJumpToMessage.js';
import { useVisualViewport } from '../composables/useVisualViewport.js';
import { useHighlightChip } from '../composables/useHighlightChip.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useAuthStore } from '../stores/auth.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';
import {
  ArrowLeftIcon,
  BellIcon,
  BookmarkIcon,
  EllipsisVerticalIcon,
  HashIcon,
  MessagesSquareIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShareIcon,
  ShieldCogIcon,
  UserPenIcon,
  UsersIcon,
} from '@lucide/vue';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const limits = reactive(useAccountLimits());

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
const reactions = useReactionsStore();
const dcc = useDccStore();
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
const profileEditor = useProfileEditor();
const networkActions = useNetworkActions();

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

// Which of the buffer's sub-screens the route names (#200, #1225).
const subScreen = computed((): MobileSubScreen => {
  if (route.name === 'buffer-members') return 'members';
  if (route.name === 'buffer-thread') return 'thread';
  if (route.name === 'buffer-threads') return 'threads';
  return null;
});
const screen = computed(() =>
  screenForRoute(
    route.params.id,
    subScreen.value,
    !!activeKey.value,
    route.name === 'system',
    activeLacksId.value,
  ),
);

// Reply threads (#1225): the panel is a screen here, and a route like the
// members screen, so Back walks thread → buffer → list. Chips and the slash
// command ask (useThreadNav); this shell navigates.
const settings = useSettingsStore();
const threadsOn = computed(() => settings.effective('chat.threads') === true);
const offThreadNav = onThreadNav((nav) => navigateThread(router, nav));
onBeforeUnmount(offThreadNav);

// Threads here with a highlight the user hasn't seen: the badge on the button.
const threadsStore = useThreadsStore();
const threadHighlights = computed(() =>
  threadsStore.highlightedThreadsFor((activeBuf.value as { id?: number } | null)?.id),
);

function goThreads() {
  const buf = activeBuf.value as { id?: number } | null;
  if (buf?.id != null) requestThreadNav({ kind: 'list', bufferId: buf.id });
}
const showBookmarks = ref(false);
const channelModal = useChannelModal();
// Its open state is module-level: leaving the chat view (a logout, say) must
// not leave it open for whoever's session mounts the view next.
onBeforeUnmount(() => channelModal.close());
const showUploads = ref(false);
const pendingScrollId = ref<number | null>(null);
const messageInputRef = ref<{ focus: () => void } | null>(null);
const bufferCogBtn = ref<HTMLElement | null>(null);

// Search & Highlights modal state + per-buffer `in:/on:` scoping, shared with
// DesktopChat (#496).
const { showSearch, showHighlights, searchScope, highlightScope, openSearch, openHighlights } =
  useBufferSearchScope();

// Mobile folds the remaining buffer/server actions behind one kebab menu to
// keep the header uncluttered (Members is an inline header button — see
// template). The menu is assembled per buffer type: either the shared
// buffer-actions menu (pin/notify/channel settings/profile/note/close) for
// channels & DMs, or the server controls
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
      // Decided as the menu opens, so the label and the action can't disagree
      // while it sits open (#1136).
      networkActions.connectionItem(a.networkId),
      {
        label: 'Edit network',
        icon: SettingsIcon,
        onClick: () => editNetwork(a.network as Network | undefined),
      },
      {
        label: 'Edit profile',
        icon: UserPenIcon,
        disabled: !profileEditor.canOpen(a.networkId),
        onClick: () => profileEditor.open(a.networkId),
      },
    );
  } else {
    items.push(...bufferActions.buildItems(activeBuf.value as BufferLike));
  }
  if (items.length === 0) return;
  const rect = el.getBoundingClientRect();
  menu.open(items, rect.left, rect.bottom + 2, el);
}

function openAddNetwork() {
  networkEditor.open();
}

function editNetwork(net: Network | undefined) {
  if (net) networkEditor.open(net);
}

// The server buffer's connection state, for the header buttons that need a live
// socket.
const serverConnectionState = computed(() => {
  if (!active.value || !isServerBuffer.value) return null;
  return networks.states[active.value.networkId]?.state ?? null;
});

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
  if (subScreen.value == null) return;
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
.icon.back {
  margin-left: -4px;
  gap: var(--space-2);
}
/* The Threads button carries the same chip (#1225): the same gap. */
.icon.threads-btn {
  gap: var(--space-2);
}
/* Highlight total for the buffer list this button returns to. Colored text on a
   tint of the same var rather than a solid fill: --buffer-highlight is
   user-themeable (look.color.buffer.highlight), so a fixed label color could
   land on an unreadable pairing — the tint tracks their choice and the text
   keeps its contrast against it. Mixed against --bg (not transparent) so the
   pill is opaque: a see-through wash let the back arrow ghost through where the
   two overlap at larger font sizes. Matches DesktopChat's rail chip. */
.icon.back .hl-chip,
.icon.threads-btn .hl-chip {
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
/* The thread panel likewise; its composer sits at the bottom of the screen. */
.thread-screen :deep(.thread-panel) {
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
