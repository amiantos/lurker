<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="mchat">
    <!-- Screen: channel list -->
    <section v-if="screen === 'list'" class="screen list">
      <header class="bar">
        <button type="button" class="logo" title="Open system console" @click="openSystemConsole">
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
          <i class="fa-solid fa-paperclip"></i>
        </button>
        <button class="icon" title="Add network" @click="openAddNetwork">
          <i class="fa-solid fa-plus"></i>
        </button>
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
        <button class="icon back" title="Back" @click="goList">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        <!-- Channels and DMs drop the name here — the compact status bar
             carries net/#chan on mobile, so a header copy is just redundant
             clutter (#222). The server buffer (input placeholder is "try /help")
             and the system console (no input row at all) have no
             other persistent label, so they keep an explicit title. Otherwise
             the bar holds only buffer-scoped actions: search & highlights open
             pre-filtered to this buffer (in:<target> on:<network>), members
             toggles the roster, the rest folds into the kebab. The *global*
             search / highlights / saved / uploads live on the list top bar. -->
        <span v-if="isServerBuffer || isVirtual" class="title">{{ bufferLabel }}</span>
        <span class="spacer"></span>
        <template v-if="isFriendsBuffer">
          <button
            class="icon"
            title="Add friend"
            aria-label="Add friend"
            @click="friends.openEditorNew()"
          >
            <i class="fa-solid fa-person-circle-plus"></i>
          </button>
          <span
            class="friend-count"
            :title="`${friendCount} ${friendCount === 1 ? 'friend' : 'friends'}`"
          >
            <i class="fa-solid fa-users"></i> {{ friendCount }}
          </span>
        </template>
        <button v-if="!isVirtual" class="icon" title="Search this buffer" @click="openSearch(true)">
          <i class="fa-solid fa-magnifying-glass"></i>
        </button>
        <button
          v-if="!isVirtual"
          class="icon"
          title="Highlights in this buffer"
          @click="openHighlights(true)"
        >
          <i class="fa-regular fa-bell"></i>
        </button>
        <button
          v-if="isChannel"
          class="icon"
          title="Members"
          aria-label="Members"
          @click="screen = 'members'"
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
      <SystemConsole v-if="renderMode === 'console'" />
      <FriendsOverview v-else-if="renderMode === 'overview'" @view-activity="onViewActivity" />
      <MessageList v-else :pending-scroll-id="pendingScrollId" />
      <StatusBar compact />
      <div v-if="hasInput" class="composer-host" :class="{ 'keyboard-open': keyboardOpen }">
        <MessageInput ref="messageInputRef" />
      </div>
    </section>

    <!-- Screen: members -->
    <section v-else-if="screen === 'members'" class="screen members-screen">
      <header class="bar">
        <button class="icon back" title="Back" @click="screen = 'buffer'">
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
    <TopicModal
      v-if="showTopic && activeKey"
      :topic="topic"
      :label="bufferLabel"
      @close="showTopic = false"
    />
    <ChannelListModal
      v-if="channelListModal.isOpen && channelListModal.networkId !== null"
      :network-id="channelListModal.networkId!"
      @close="channelListModal.close()"
    />
    <RecentUploadsModal v-if="showUploads" @close="showUploads = false" />
    <SearchModal
      v-if="showSearch"
      :scope="searchScope"
      @close="showSearch = false"
      @jump="onJumpToMessage"
    />
    <ImageViewerModal
      v-if="imageModal.isOpen && imageModal.url !== null"
      :url="imageModal.url"
      @close="imageModal.close()"
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
    <ConfigureFriendModal v-if="friends.editor.open" />
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { Network } from '../stores/networks.js';
import type { BufferLike } from '../composables/useBufferActions.js';
import { useNetworksStore } from '../stores/networks.js';
import { useSocket } from '../composables/useSocket.js';
import { useChatBootstrap } from '../composables/useChatBootstrap.js';
import { useActiveBuffer } from '../composables/useActiveBuffer.js';
import { useBufferActions } from '../composables/useBufferActions.js';
import { useContextMenu } from '../composables/useContextMenu.js';
import type { ContextMenuItem } from '../composables/useContextMenu.js';
import BufferList from '../components/BufferList.vue';
import MessageList from '../components/MessageList.vue';
import SystemConsole from '../components/SystemConsole.vue';
import FriendsOverview from '../components/FriendsOverview.vue';
import MessageInput from '../components/MessageInput.vue';
import MemberList from '../components/MemberList.vue';
import StatusBar from '../components/StatusBar.vue';
import NetworkForm from '../components/NetworkForm.vue';
import HighlightsModal from '../components/HighlightsModal.vue';
import BookmarksModal from '../components/BookmarksModal.vue';
import TopicModal from '../components/TopicModal.vue';
import ChannelListModal from '../components/ChannelListModal.vue';
import RecentUploadsModal from '../components/RecentUploadsModal.vue';
import SearchModal from '../components/SearchModal.vue';
import NickNoteModal from '../components/NickNoteModal.vue';
import ConfigureFriendModal from '../components/ConfigureFriendModal.vue';
import UserProfileModal from '../components/UserProfileModal.vue';
import ImageViewerModal from '../components/ImageViewerModal.vue';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useFriendsStore } from '../stores/friends.js';
import { useSearchStore } from '../stores/search.js';
import { useWhoisStore } from '../stores/whois.js';
import { useChannelListModal } from '../composables/useChannelListModal.js';
import { useImageModal } from '../composables/useImageModal.js';
import { useNetworkEditor } from '../composables/useNetworkEditor.js';
import { useJumpToMessage } from '../composables/useJumpToMessage.js';
import { useVisualViewport } from '../composables/useVisualViewport.js';

const networks = useNetworksStore();
const { connected } = useSocket();
const { keyboardOpen } = useVisualViewport();
const {
  active,
  activeKey,
  activeBuf,
  isChannel,
  isServerBuffer,
  bufferLabel,
  topic,
  isSystemConsole,
  isVirtual,
  isFriendsBuffer,
  renderMode,
  hasInput,
} = useActiveBuffer();
const bufferActions = useBufferActions();
const menu = useContextMenu();
const nickNotes = useNickNotesStore();
const friends = useFriendsStore();
const friendCount = computed(() => friends.contacts.length);
const whois = useWhoisStore();

function openSystemConsole() {
  networks.activateSystem();
  // The activeKey watcher only fires on value change. If the user is
  // already on `:system:` (e.g. they hit Back to the list, then re-tap
  // the logo), the watcher won't advance them — drive the screen
  // directly so the second tap behaves like the first.
  screen.value = 'buffer';
}

// `list` (default) → tap a buffer → `buffer` → tap members icon → `members`.
// Back arrows walk the stack backwards. We don't sync this to the URL — the
// flow is short and stateful, and a URL would expose us to bookmarks that
// land on the buffer screen with no active buffer.
const channelListModal = reactive(useChannelListModal());
const imageModal = reactive(useImageModal());
const networkEditor = reactive(useNetworkEditor());
const screen = ref('list');
const showHighlights = ref(false);
const showBookmarks = ref(false);
const showTopic = ref(false);
const showUploads = ref(false);
const showSearch = ref(false);
const searchScope = ref<string | null>(null);
const highlightScope = ref<string | null>(null);
const pendingScrollId = ref<number | null>(null);
const messageInputRef = ref<{ focus: () => void } | null>(null);
const bufferCogBtn = ref<HTMLElement | null>(null);

// in:/on: filter that scopes search & highlights to the current buffer when
// they're opened from the topic bar. Null for the server buffer / system
// console (no per-buffer scope there). The network name is omitted when it
// contains whitespace — the filter parser splits tokens on spaces, so
// `on:<name>` couldn't round-trip; `in:<target>` alone still scopes by
// channel/nick in that case.
const bufferScope = computed<string | null>(() => {
  const a = active.value;
  if (!a || isServerBuffer.value || isSystemConsole.value || !a.target) return null;
  const netName = (a.network as { name?: string } | null)?.name;
  const onTok = netName && !/\s/.test(netName) ? ` on:${netName}` : '';
  return `in:${a.target}${onTok}`;
});

// Topic-bar buttons pass scoped=true so the modal opens pre-filtered to this
// buffer; the buffer-list top bar passes false for the global view. Both share
// one modal instance — the scope ref is what differentiates the two entries.
function openSearch(scoped: boolean) {
  searchScope.value = scoped ? bufferScope.value : null;
  showSearch.value = true;
}

// "View activity" from the Friends overview: open Search with the scoped query
// (from:<nick> on:<network>) and run it immediately.
function onViewActivity(query: string) {
  useSearchStore().runQuery(query);
  searchScope.value = null;
  showSearch.value = true;
}
function openHighlights(scoped: boolean) {
  highlightScope.value = scoped ? bufferScope.value : null;
  showHighlights.value = true;
}

// Mobile folds the remaining buffer/topic/server actions behind one kebab menu
// to keep the header uncluttered (Members is an inline header button — see
// template). The menu is assembled per buffer type: view-topic is a navigation
// shortcut unique to this layout, then either the shared buffer-actions menu
// (pin/notify/profile/note/close) for channels & DMs, or the server controls
// (browse/connect/edit) for server buffers. Anchored under the kebab like the
// desktop sidebar menu; ContextMenu clamps it to the viewport.
function openBufferActions() {
  const a = active.value;
  const el = bufferCogBtn.value;
  if (!a || !el) return;
  const items: ContextMenuItem[] = [];
  if (topic.value) {
    items.push({
      label: 'View topic',
      icon: 'fa-solid fa-circle-info',
      onClick: () => {
        showTopic.value = true;
      },
    });
  }
  if (isServerBuffer.value) {
    items.push(
      {
        label: 'Channel list',
        icon: 'fa-solid fa-hashtag',
        onClick: () => channelListModal.open(a.networkId),
      },
      {
        label: serverConnectActionLabel.value,
        icon: serverConnectActionIcon.value,
        onClick: toggleServerConnection,
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
// desktop logic — "Disconnect" only while we're confidently connected;
// everything else labels as "Reconnect" because a fresh connect is the
// same action and that's what the user reaches for when things look stuck.
const serverConnectionState = computed(() => {
  if (!active.value || !isServerBuffer.value) return null;
  return networks.states[active.value.networkId]?.state ?? null;
});
const serverConnectActionLabel = computed(() =>
  serverConnectionState.value === 'connected' ? 'Disconnect' : 'Reconnect',
);
const serverConnectActionIcon = computed(() =>
  serverConnectionState.value === 'connected'
    ? 'fa-solid fa-plug-circle-xmark'
    : 'fa-solid fa-plug',
);
function toggleServerConnection() {
  if (!active.value) return;
  const id = active.value.networkId;
  // Fire-and-forget — the button's label is driven by networks.states so
  // success reflects itself. A failed call stays observable via the state
  // (label doesn't flip), so we just log and let the user retry rather
  // than wiring a toast through the bar for this case.
  const p =
    serverConnectionState.value === 'connected' ? networks.disconnect(id) : networks.reconnect(id);
  p.catch((err) => console.error('[MobileChat] toggle server connection failed', err));
}

function closeNetworkForm() {
  networkEditor.close();
}

// BufferList calls buffers.activate() directly on click; we react to the
// activeKey flip rather than intercepting the click so the same store state
// drives both layouts. Auto-advance from list (the natural buffer-open
// flow) AND from members (Send DM out of the nick menu flips activeKey to a
// new DM buffer — the members screen for the old channel would otherwise be
// stranded). The buffer screen itself doesn't auto-advance — we let in-
// buffer activations (e.g. a user explicitly switching) drop the user
// straight into the new buffer without re-triggering the watcher's screen
// change since they're already on that screen.
watch(activeKey, (next) => {
  if (next && (screen.value === 'list' || screen.value === 'members')) {
    screen.value = 'buffer';
  } else if (next === null && screen.value !== 'list') {
    // The active buffer went away (closed it, or its network was removed) while
    // we were viewing it — activeKey only nulls in those "no buffer" cases, so
    // fall back to the list instead of stranding the user on an empty buffer or
    // members screen (#137). Buffer-to-buffer switches set activeKey directly
    // (no null transition), so this never flickers mid-switch.
    screen.value = 'list';
  }
});

// Re-tapping the *same* buffer the user was last in doesn't change activeKey
// so the watcher above doesn't fire. Catch the bubbled click here as a
// belt-and-suspenders advance: if a row was hit and a buffer is active, go
// to the buffer screen. Vue event bubbling runs BufferList's @click first,
// so by the time we read activeKey it's already up to date.
function onBufferListClick(e: MouseEvent) {
  const hit = (e.target as Element).closest('.channels li, .net-head');
  if (!hit) return;
  if (activeKey.value) screen.value = 'buffer';
}

function goList() {
  screen.value = 'list';
}

const onJumpToMessage = useJumpToMessage({
  pendingScrollId,
  // Mobile shell stacks list → buffer → members. Tapping a search result or
  // notification needs to forward us onto the buffer screen so the message
  // we just jumped to is actually visible.
  afterActivate: () => {
    screen.value = 'buffer';
  },
});

useChatBootstrap({ onJump: onJumpToMessage });
</script>

<style scoped>
/* Single-column flex stack sized to 100dvh. On current iOS Safari the
   dynamic-viewport unit shrinks with the soft keyboard, so the shell
   contracts and the input bar (last flex child) rides up flush against
   the keyboard with no extra plumbing. We deliberately do NOT use
   position: fixed or a JS-tracked --kb-bottom here — those approaches
   fight iOS auto-scroll, env() shifts, and a known iOS 26 visualViewport
   regression (returns phantom positive values after keyboard dismiss).
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
.friend-count {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  padding: 0 var(--space-2);
  white-space: nowrap;
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
.icon.back {
  margin-left: -4px;
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
