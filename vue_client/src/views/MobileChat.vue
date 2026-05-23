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
        <span class="title">{{ isSystemConsole ? 'System console' : bufferLabel }}</span>
        <span class="spacer"></span>
        <button v-if="topic" class="icon" title="View topic" @click="showTopic = true">
          <i class="fa-solid fa-circle-info"></i>
        </button>
        <button
          v-if="isServerBuffer"
          class="icon"
          title="Browse channels"
          @click="showChannelList = true"
        >
          <i class="fa-solid fa-list"></i>
        </button>
        <button v-if="isServerBuffer" class="icon" title="Edit network" @click="editActiveNetwork">
          <i class="fa-solid fa-gear"></i>
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
      </header>
      <SystemConsole v-if="isSystemConsole" />
      <MessageList v-else :pending-scroll-id="pendingScrollId" />
      <StatusBar compact />
      <MessageInput v-if="!isSystemConsole" ref="messageInputRef" />
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
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useJumpToMessage } from '../composables/useJumpToMessage.js';

const networks = useNetworksStore();
const { connected } = useSocket();
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
/* Single-column flex stack sized to the dynamic viewport. iOS scrolls
   the page naturally when the keyboard opens; the textarea at the
   bottom of the shell stays visible just above the keyboard, and the
   upper content (sidebar / topic / older messages) scrolls off the
   top of the visible area until the user dismisses the keyboard. See
   issue #85 for the full investigation — multiple workarounds were
   tried and each made things worse on at least one device. */
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
.buffer :deep(.input) {
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
