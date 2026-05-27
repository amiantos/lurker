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
        <button class="icon" title="Search messages" @click="showSearch = true">
          <i class="fa-solid fa-magnifying-glass"></i>
        </button>
        <button class="icon" title="Highlights" @click="showHighlights = true">
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
        <button
          v-if="isDmHeader"
          type="button"
          class="title title-btn"
          title="View profile"
          @click="openDmProfile"
        >
          {{ bufferLabel }}
        </button>
        <span v-else class="title">{{ isSystemConsole ? 'System console' : bufferLabel }}</span>
        <span class="spacer"></span>
        <button v-if="topic" class="icon" title="View topic" @click="showTopic = true">
          <i class="fa-solid fa-circle-info"></i>
        </button>
        <button class="icon" title="Search messages" @click="showSearch = true">
          <i class="fa-solid fa-magnifying-glass"></i>
        </button>
        <button class="icon" title="Highlights" @click="showHighlights = true">
          <i class="fa-regular fa-bell"></i>
        </button>
        <button class="icon" title="Saved messages" @click="showBookmarks = true">
          <i class="fa-regular fa-bookmark"></i>
        </button>
        <button
          v-if="isServerBuffer"
          type="button"
          class="word-btn"
          @click="showChannelList = true"
        >
          Channel List
        </button>
        <button
          v-if="isServerBuffer"
          type="button"
          class="word-btn"
          @click="toggleServerConnection"
        >
          {{ serverConnectActionLabel }}
        </button>
        <button
          v-if="showBufferCog"
          ref="bufferCogBtn"
          class="icon"
          title="Buffer actions"
          @click="openBufferActions"
        >
          <i class="fa-solid fa-gear"></i>
        </button>
        <button v-if="isChannel" class="icon" title="Members" @click="screen = 'members'">
          <i class="fa-solid fa-users"></i>
        </button>
        <button v-if="isServerBuffer" class="icon" title="Edit network" @click="editActiveNetwork">
          <i class="fa-solid fa-gear"></i>
        </button>
      </header>
      <SystemConsole v-if="isSystemConsole" />
      <MessageList v-else :pending-scroll-id="pendingScrollId" />
      <StatusBar compact />
      <div v-if="!isSystemConsole" class="composer-host" :class="{ 'keyboard-open': keyboardOpen }">
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
      v-if="showNetworkForm"
      :network="editingNetwork ?? undefined"
      @close="closeNetworkForm"
    />
    <HighlightsModal
      v-if="showHighlights"
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
      v-if="showChannelList && active"
      :network-id="active.networkId"
      @close="showChannelList = false"
    />
    <RecentUploadsModal v-if="showUploads" @close="showUploads = false" />
    <SearchModal v-if="showSearch" @close="showSearch = false" @jump="onJumpToMessage" />
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
import { computed, ref, watch } from 'vue';
import type { Network } from '../stores/networks.js';
import type { BufferLike } from '../composables/useBufferActions.js';
import { useNetworksStore } from '../stores/networks.js';
import { useSocket } from '../composables/useSocket.js';
import { useChatBootstrap } from '../composables/useChatBootstrap.js';
import { useActiveBuffer } from '../composables/useActiveBuffer.js';
import { useBufferActions } from '../composables/useBufferActions.js';
import BufferList from '../components/BufferList.vue';
import MessageList from '../components/MessageList.vue';
import SystemConsole from '../components/SystemConsole.vue';
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
import UserProfileModal from '../components/UserProfileModal.vue';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useWhoisStore } from '../stores/whois.js';
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
} = useActiveBuffer();
const bufferActions = useBufferActions();
const nickNotes = useNickNotesStore();
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
const screen = ref('list');
const showHighlights = ref(false);
const showBookmarks = ref(false);
const showTopic = ref(false);
const showChannelList = ref(false);
const showUploads = ref(false);
const showSearch = ref(false);
const showNetworkForm = ref(false);
const editingNetwork = ref<Network | null>(null);
const pendingScrollId = ref<number | null>(null);
const messageInputRef = ref<{ focus: () => void } | null>(null);
const bufferCogBtn = ref<HTMLElement | null>(null);

// Server buffers already have a dedicated browse-channels action in the bar;
// the cog is for channel/DM buffer-level actions (pin, always-notify).
const showBufferCog = computed(() => !!active.value && !isServerBuffer.value);

// True when the active buffer is a DM. Drives the clickable title that
// opens the user profile modal — channel titles stay non-interactive.
const isDmHeader = computed(() => {
  if (!active.value) return false;
  if (isChannel.value || isServerBuffer.value || isSystemConsole.value) return false;
  return true;
});
function openDmProfile() {
  if (!active.value) return;
  whois.openViewer(active.value.networkId, active.value.target);
}

function openBufferActions() {
  if (!activeBuf.value) return;
  bufferActions.openMenuFromButton(activeBuf.value as BufferLike, bufferCogBtn.value);
}

function openAddNetwork() {
  editingNetwork.value = null;
  showNetworkForm.value = true;
}

function editActiveNetwork() {
  const net = active.value?.network as Network | undefined;
  if (!net) return;
  editingNetwork.value = net;
  showNetworkForm.value = true;
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
  showNetworkForm.value = false;
  editingNetwork.value = null;
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
  gap: 8px;
  padding: 10px 12px;
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
/* DM headers double as a "view profile" trigger — match the .title look,
   underline on tap. */
.title-btn {
  background: none;
  border: none;
  font: inherit;
  cursor: pointer;
  text-align: left;
  padding: 0;
}
.title-btn:active {
  text-decoration: underline;
}
.spacer {
  flex: 1;
}
.icon {
  background: none;
  border: none;
  color: var(--accent);
  padding: 4px 8px;
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
/* Word-button affordances for the server-buffer bar (Channel List,
   Disconnect/Reconnect). Same accent treatment as .icon but text-shaped so
   they fit alongside the global action icons without reading as another
   ambiguous gear. Min-height matches .icon so they line up on the bar. */
.word-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 4px 8px;
  min-height: 36px;
  white-space: nowrap;
}
.word-btn:hover {
  color: var(--fg);
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
