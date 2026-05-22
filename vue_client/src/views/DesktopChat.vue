<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div
    class="chat"
    :class="{
      'sidebar-collapsed': !showChannels,
      'members-collapsed': !showMembers,
      'system-active': isSystemConsole,
    }"
    @click="onChatClick"
  >
    <aside class="sidebar" :class="{ collapsed: !showChannels }">
      <div class="sidebar-head">
        <template v-if="showChannels">
          <button
            type="button"
            class="logo"
            :class="{ active: isSystemConsole }"
            title="Open system console"
            @click="openSystemConsole"
          >
            lurker
          </button>
          <span v-if="!connected" class="status off" title="Disconnected">●</span>
          <span class="head-spacer"></span>
        </template>
        <button
          class="link toggle"
          :title="showChannels ? 'Hide channel list' : 'Show channel list'"
          @click="toggleChannels"
        >
          <i :class="showChannels ? 'fa-solid fa-angles-left' : 'fa-solid fa-angles-right'"></i>
        </button>
      </div>
      <BufferList v-if="showChannels" />
      <div class="sidebar-foot">
        <RouterLink class="link" to="/settings" title="Settings"
          ><i class="fa-solid fa-gear"></i
        ></RouterLink>
        <button class="link" @click="showSearch = true" title="Search messages">
          <i class="fa-solid fa-magnifying-glass"></i>
        </button>
        <button class="link" @click="showHighlights = true" title="Highlights">
          <i class="fa-regular fa-bell"></i>
        </button>
        <button class="link" @click="showBookmarks = true" title="Saved messages">
          <i class="fa-regular fa-bookmark"></i>
        </button>
        <button class="link" @click="showUploads = true" title="Recent uploads">
          <i class="fa-solid fa-paperclip"></i>
        </button>
        <button class="link" @click="openAddNetwork" title="Add network">
          <i class="fa-solid fa-plus"></i>
        </button>
      </div>
    </aside>

    <header v-if="isSystemConsole" class="topic">
      <span class="buffer">System console</span>
    </header>
    <header v-else-if="active" class="topic">
      <span class="buffer">{{ bufferLabel }}</span>
      <button v-if="isServerBuffer" class="link" title="Edit network" @click="editActiveNetwork">
        <i class="fa-solid fa-gear"></i>
      </button>
      <button
        v-if="isServerBuffer"
        class="link"
        title="Browse channels"
        @click="showChannelList = true"
      >
        <i class="fa-solid fa-list"></i>
      </button>
      <template v-if="topic">
        <span class="sep">│</span>
        <button type="button" class="topic-text" title="View full topic" @click="showTopic = true">
          <LinkedText :text="topic" />
        </button>
      </template>
      <button
        v-if="showBufferCog"
        ref="bufferCogBtn"
        class="link buffer-cog"
        title="Buffer actions"
        @click="openBufferActions"
      >
        <i class="fa-solid fa-gear"></i>
      </button>
      <button
        v-if="isChannel"
        class="link members-toggle"
        :title="showMembers ? 'Hide members' : 'Show members'"
        @click="toggleMembers"
      >
        <i class="fa-solid fa-users"></i>
      </button>
      <span
        v-if="isChannel && memberCount != null"
        class="member-count"
        :title="`${memberCount} ${memberCount === 1 ? 'user' : 'users'} in channel`"
        >{{ memberCount }}</span
      >
    </header>
    <div v-if="active || isSystemConsole" class="topic-divider"></div>

    <SystemConsole v-if="isSystemConsole" />
    <MessageList v-else ref="messageListRef" :pending-scroll-id="pendingScrollId" />
    <MemberList v-if="showMembers && !isSystemConsole" />
    <StatusBar />
    <MessageInput v-if="!isSystemConsole" ref="messageInputRef" />

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
      v-if="showTopic && active"
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
    <QuickSwitcher v-if="showSwitcher" @close="showSwitcher = false" />
    <SearchModal v-if="showSearch" @close="showSearch = false" @jump="onJumpToMessage" />
    <KeyboardHelpModal v-if="showKbdHelp" @close="showKbdHelp = false" />
    <NickNoteModal
      v-if="nickNotes.editor.open && nickNotes.editor.networkId != null"
      :nick="nickNotes.editor.nick"
      :network-id="nickNotes.editor.networkId"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Network } from '../stores/networks.js';
import type { BufferLike } from '../composables/useBufferActions.js';
import type { Buffer } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useSocket } from '../composables/useSocket.js';
import { useChatBootstrap } from '../composables/useChatBootstrap.js';
import { useActiveBuffer } from '../composables/useActiveBuffer.js';
import { useSettingsStore } from '../stores/settings.js';
import BufferList from '../components/BufferList.vue';
import MessageList from '../components/MessageList.vue';
import SystemConsole from '../components/SystemConsole.vue';
import MessageInput from '../components/MessageInput.vue';
import MemberList from '../components/MemberList.vue';
import StatusBar from '../components/StatusBar.vue';
import NetworkForm from '../components/NetworkForm.vue';
import HighlightsModal from '../components/HighlightsModal.vue';
import BookmarksModal from '../components/BookmarksModal.vue';
import LinkedText from '../components/LinkedText.vue';
import TopicModal from '../components/TopicModal.vue';
import ChannelListModal from '../components/ChannelListModal.vue';
import RecentUploadsModal from '../components/RecentUploadsModal.vue';
import QuickSwitcher from '../components/QuickSwitcher.vue';
import SearchModal from '../components/SearchModal.vue';
import KeyboardHelpModal from '../components/KeyboardHelpModal.vue';
import NickNoteModal from '../components/NickNoteModal.vue';
import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts.js';
import { useNicklistCollapseStore } from '../stores/nicklistCollapse.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useBufferActions } from '../composables/useBufferActions.js';
import { useJumpToMessage } from '../composables/useJumpToMessage.js';

const networks = useNetworksStore();
const { connected } = useSocket();
const { active, activeBuf, topic, isServerBuffer, isChannel, bufferLabel, isSystemConsole } =
  useActiveBuffer();

function openSystemConsole() {
  networks.activateSystem();
}
const settings = useSettingsStore();
const nicklistCollapse = useNicklistCollapseStore();
const nickNotes = useNickNotesStore();
const bufferActions = useBufferActions();

const showNetworkForm = ref(false);
const editingNetwork = ref<Network | null>(null);
const showHighlights = ref(false);
const showBookmarks = ref(false);
const showTopic = ref(false);
const showChannelList = ref(false);
const showUploads = ref(false);
const showSwitcher = ref(false);
const showSearch = ref(false);
const showKbdHelp = ref(false);
const pendingScrollId = ref<number | null>(null);
const messageInputRef = ref<{ focus: () => void } | null>(null);
const messageListRef = ref<{ scrollByPage: (dir: number) => void } | null>(null);
const bufferCogBtn = ref<HTMLElement | null>(null);

// The cog opens the same menu as right-clicking the sidebar row — exposed
// here so the actions are reachable for the currently-open buffer without a
// trip to the sidebar (and so mobile users, who have no right-click, can get
// at them at all). Server buffers already have dedicated controls in this
// bar, so the cog is for channels and DMs only.
const showBufferCog = computed(() => !!active.value && !isServerBuffer.value);

function openBufferActions() {
  if (!activeBuf.value) return;
  bufferActions.openMenuFromButton(activeBuf.value as BufferLike, bufferCogBtn.value);
}

// Any modal open? Type-ahead must not steal focus from a modal's own fields.
const anyModalOpen = computed(
  () =>
    showNetworkForm.value ||
    showHighlights.value ||
    showBookmarks.value ||
    showTopic.value ||
    showChannelList.value ||
    showUploads.value ||
    showSwitcher.value ||
    showSearch.value ||
    showKbdHelp.value,
);

useKeyboardShortcuts({
  onOpenSwitcher: () => {
    showSwitcher.value = true;
  },
  onOpenHelp: () => {
    showKbdHelp.value = true;
  },
  onOpenSearch: () => {
    showSearch.value = true;
  },
  onTypeAhead: () => {
    if (anyModalOpen.value || !active.value) return;
    messageInputRef.value?.focus();
  },
  onScrollMessages: (dir) => {
    if (anyModalOpen.value) return;
    messageListRef.value?.scrollByPage(dir);
  },
});

const showChannels = computed(() => settings.effective('look.layout.show_channel_list'));

// User count for the active channel buffer. Sits in the topic bar (next to
// the members-toggle button) rather than the status bar — the count is a
// property of the channel, so the channel header is the natural home.
const memberCount = computed(() => {
  if (!isChannel.value) return null;
  return (activeBuf.value as Buffer | null)?.members?.length ?? null;
});

// Per-channel nicklist visibility. A channel the user has explicitly toggled
// carries an override (true = collapsed); otherwise the global
// look.layout.show_member_list default applies. DMs and server buffers have no
// member list at all, so the toggle and panel are hidden for them entirely.
const showMembers = computed(() => {
  if (!isChannel.value || !active.value) return false;
  const { networkId, target } = active.value;
  const override = nicklistCollapse.override(networkId, target);
  if (override !== undefined) return !override;
  return settings.effective('look.layout.show_member_list');
});

function toggleChannels() {
  settings.setValue('look.layout.show_channel_list', !showChannels.value);
}
function toggleMembers() {
  if (!isChannel.value || !active.value) return;
  const { networkId, target } = active.value;
  // Pass the current visibility through as the new collapsed flag — it flips.
  nicklistCollapse.setCollapsed(networkId, target, !!showMembers.value);
}

// Forward stray clicks anywhere in the chat frame (topic bar, message list,
// member list, sidebar gutter, etc.) into the message input. The selector
// excludes anything genuinely interactive — buttons, links, form controls,
// and modal contents — and we bail if the user is in the middle of selecting
// text so we don't kill their selection.
function onChatClick(e: MouseEvent) {
  if (
    (e.target as Element).closest(
      'button, a, input, textarea, select, label, .modal, [contenteditable=true]',
    )
  )
    return;
  const sel = window.getSelection();
  if (sel && sel.toString().length > 0) return;
  messageInputRef.value?.focus();
}

const onJumpToMessage = useJumpToMessage({ pendingScrollId });

function openAddNetwork() {
  editingNetwork.value = null;
  showNetworkForm.value = true;
}
function openEditNetwork(net: Network) {
  editingNetwork.value = net;
  showNetworkForm.value = true;
}
function closeNetworkForm() {
  showNetworkForm.value = false;
  editingNetwork.value = null;
}

function editActiveNetwork() {
  const net = active.value?.network as Network | undefined;
  if (net) openEditNetwork(net);
}

useChatBootstrap({ onJump: onJumpToMessage });
</script>

<style scoped>
/* WeeChat-style frame: the sidebar runs full height on the left; the topic
   and input bars span the full width to the right of it; and the message
   list + nicklist sit between them.

   The sidebar and member-list columns are sized via CSS custom properties
   so the .sidebar-collapsed / .members-collapsed modifier classes can shrink
   either side to a 36px rail without touching the rest of the grid. */
.chat {
  --sidebar-w: 220px;
  --members-w: 180px;
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr var(--members-w);
  /* The 1px row owns the topic/messages divider as its own grid track,
     outside the scroll container. Putting the line inside .message-list
     (border-top, inset box-shadow) lets row backgrounds and hover states
     paint over it as content scrolls past — the line appears to be eaten
     by the scrolling rows. A dedicated row sits between the two children
     and nothing can paint on top of it. */
  grid-template-rows: auto auto 1fr auto auto;
  grid-template-areas:
    'sidebar topic    topic'
    'sidebar divider  divider'
    'sidebar messages members'
    'sidebar status   status'
    'sidebar input    input';
  height: 100vh;
  overflow: hidden;
}
.chat.sidebar-collapsed {
  --sidebar-w: 36px;
}
/* Members column fully collapses — no rail. The reopen toggle lives in the
   topic bar on the right, so there's nothing to leave behind. */
.chat.members-collapsed {
  --members-w: 0px;
}
/* System console has no member list — collapse the rail so the log pane
   spans the full content width instead of leaving an empty column. */
.chat.system-active {
  --members-w: 0px;
}
/* min-height/min-width 0 lets flex/scrolling children stay inside their row. */
.chat > * {
  min-width: 0;
  min-height: 0;
}

.sidebar {
  grid-area: sidebar;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.sidebar-head {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.head-spacer {
  flex: 1;
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
.logo:hover {
  text-decoration: underline;
}
.logo.active {
  text-decoration: underline;
}
.status.off {
  color: var(--bad);
}
/* Pin the cog (settings) flush-left and the plus (add network) flush-right;
   the middle icons distribute evenly between them. Flex with space-between
   scales to any number of middle icons without re-tuning the column count.
   Matches the input bar's single-line height (8px padding + 1lh content +
   1px border) so the sidebar-foot's top border lines up with the input
   bar's top border. flex-wrap so a large `look.font.size` setting (which
   scales icons but not the fixed 220px sidebar) wraps the rightmost icons
   to a second row inside the foot instead of overflowing into the input
   bar to the right (issue #64). */
.sidebar-foot {
  margin-top: auto;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
/* Collapsed rail: hide the brand, swap the foot to a vertical stack, and
   center everything in the 36px column. Foot icons keep their muscle-memory
   spot at the bottom of the sidebar; the toggle chevron sits up top. */
.sidebar.collapsed .sidebar-head {
  padding: 8px 0;
  justify-content: center;
}
.sidebar.collapsed .sidebar-foot {
  flex-direction: column;
  padding: 8px 0;
  gap: 8px;
  justify-content: flex-end;
}

.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 0 4px;
  cursor: pointer;
  font: inherit;
  text-decoration: none;
}
.link:hover {
  color: var(--fg);
}
.link.toggle {
  color: var(--fg-muted);
}
.link.toggle:hover {
  color: var(--fg);
}

.topic {
  grid-area: topic;
  padding: 8px 12px;
  display: flex;
  align-items: baseline;
  gap: 1ch;
  white-space: nowrap;
  overflow: hidden;
}
.topic-divider {
  grid-area: divider;
  background: var(--border);
  height: 1px;
}
.topic .buffer {
  color: var(--accent);
}
.topic .sep {
  color: var(--border);
}
.topic .topic-text {
  color: var(--fg-muted);
  text-overflow: ellipsis;
  overflow: hidden;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  min-width: 0;
}
.topic .topic-text:hover {
  color: var(--fg);
}
.topic .topic-text:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}

/* These selectors target the root elements of the imported components.
   Vue 3 scoped CSS attaches the parent's data-v attribute to a child
   component's root element, so .message-list / .members / .input here
   match the rendered roots of MessageList / MemberList / MessageInput. */
.message-list {
  grid-area: messages;
}
.members {
  grid-area: members;
  border-left: 1px solid var(--border);
}
.status-bar {
  grid-area: status;
}
.input {
  grid-area: input;
}

/* Pin the right-side cluster (cog / members toggle / count) to the far
   right of the topic bar regardless of what's between them and the buffer
   label. The topic text shrinks first (it has min-width: 0 + ellipsis) so
   the cluster stays put. The cog claims the slack via margin-left:auto and
   the remaining elements follow it in DOM order. When the cog is absent
   (server buffers), members-toggle's own margin-left:auto takes over.
   Count sits to the right of the icon. */
.topic .buffer-cog {
  margin-left: auto;
  padding-left: 8px;
}
.topic .buffer-cog + .members-toggle {
  margin-left: 0;
  padding-left: 4px;
}
.topic .members-toggle {
  margin-left: auto;
  padding-left: 8px;
}
.topic .member-count {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
</style>
