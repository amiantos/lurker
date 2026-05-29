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
      <div ref="footEl" class="sidebar-foot" :class="{ 'foot-wrapped': footWrapped }">
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
      <button
        v-if="isDmHeader"
        type="button"
        class="buffer link"
        title="View profile"
        @click="openDmProfile"
      >
        {{ bufferLabel }}
      </button>
      <span v-else class="buffer">{{ bufferLabel }}</span>
      <template v-if="topic">
        <span class="sep">│</span>
        <button type="button" class="topic-text" title="View full topic" @click="showTopic = true">
          <LinkedText :text="topic" />
        </button>
      </template>
      <button
        v-if="isServerBuffer"
        type="button"
        class="link word server-right-start"
        @click="showChannelList = true"
      >
        Channel List
      </button>
      <button v-if="isServerBuffer" type="button" class="link word" @click="toggleServerConnection">
        {{ serverConnectActionLabel }}
      </button>
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
        v-if="isServerBuffer"
        class="link network-cog"
        title="Edit network"
        @click="editActiveNetwork"
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
import { computed, nextTick, onMounted, ref, watch } from 'vue';
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
import UserProfileModal from '../components/UserProfileModal.vue';
import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts.js';
import { useNicklistCollapseStore } from '../stores/nicklistCollapse.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useWhoisStore } from '../stores/whois.js';
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
const whois = useWhoisStore();
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

// Sidebar-foot wrap detector. At large `look.font.size` settings the six icons
// overflow the fixed 220px sidebar and flex-wrap to a second row. Browser's
// natural wrap packs as-many-as-fit on row 1 (5+1 or 4+2 looks lopsided);
// we'd rather show a clean 3+3 split. Measure offsetTop of first vs last
// icon in the natural flex layout — when they differ, the row wrapped, and
// `.foot-wrapped` swaps the flex layout for a 3-column grid. The class is
// stripped before measuring so we read the flex state, not our own override
// (otherwise the icons would always be on different rows and we'd be stuck
// in 3+3 even after the user shrinks the font back down). The detector
// also bails out and clears the flag while the sidebar is collapsed: the
// collapsed rail uses `flex-direction: column` so every icon stacks on its
// own row, which would otherwise stick the flag true and force the 3-col
// grid on re-expand even at default font.
const footEl = ref<HTMLElement | null>(null);
const footWrapped = ref(false);
async function measureFootWrap() {
  const el = footEl.value;
  if (!el || el.children.length < 2) return;
  if (!showChannels.value) {
    footWrapped.value = false;
    return;
  }
  if (footWrapped.value) {
    footWrapped.value = false;
    await nextTick();
  }
  const first = (el.children[0] as HTMLElement).offsetTop;
  const last = (el.children[el.children.length - 1] as HTMLElement).offsetTop;
  footWrapped.value = first !== last;
}
watch(
  () => settings.effective('look.font.size'),
  () => void measureFootWrap(),
);
// Re-measure when the sidebar expands — we cleared the flag on collapse, so
// without this the foot would stay flex-wrapped (5+1 / 4+2) even at fonts
// that triggered the grid before the user collapsed.
watch(showChannels, async (open) => {
  if (!open) return;
  await nextTick();
  void measureFootWrap();
});
onMounted(measureFootWrap);

// True when the active buffer is a DM (not a channel, not the network's
// server buffer). Drives the clickable DM header that opens the user
// profile modal — channel headers stay non-interactive.
const isDmHeader = computed(() => {
  if (!active.value) return false;
  if (isChannel.value || isServerBuffer.value) return false;
  return true;
});
function openDmProfile() {
  if (!active.value) return;
  whois.openViewer(active.value.networkId, active.value.target);
}

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

// State-aware connect/disconnect for the server buffer header. We label the
// button "Disconnect" only while we're confidently connected; every other
// state (idle, connecting, reconnecting, disconnected, unknown) reads as
// "Reconnect" because the action — fire a fresh connect — is the same in
// each case, and "Reconnect" is what the user reaches for when something
// looks stuck.
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
  // than wiring a toast through the topic bar for this case.
  const p =
    serverConnectionState.value === 'connected' ? networks.disconnect(id) : networks.reconnect(id);
  p.catch((err) => console.error('[DesktopChat] toggle server connection failed', err));
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
  /* Height sized to the dynamic viewport. iOS scrolls the page
     naturally when the keyboard opens; the input row at the bottom
     stays visible above the keyboard, and the upper portion (sidebar,
     topic, older messages) scrolls off the top of the visible area.
     See issue #85. */
  height: 100dvh;
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
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--space-4);
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
   `padding: 1ch 12px 8px` (not the original symmetric 8px) makes the foot's
   top padding scale with the font the way the status bar's does — both have
   `padding-top: 1ch` — so the foot's top border lines up with the status
   bar's top border at any font size in the two-row wrapped state, and the
   top icon row sits the same `1ch` below its border as the status text does
   below its own. Bottom stays at 8px so the bottom row stays vertically
   centered with the input bar's text (whose box also has `padding: 8px`).
   flex-wrap so a large `look.font.size` setting (which scales icons but
   not the fixed 220px sidebar) wraps the rightmost icons to a second row
   inside the foot instead of overflowing into the input bar to the right
   (issue #64). */
.sidebar-foot {
  margin-top: auto;
  padding: 1ch var(--space-6) var(--space-4);
  border-top: 1px solid var(--border);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  /* Match the input bar's line-height (1.4) — the body default of 1.55
     would leave the foot's content row visibly taller than the input's
     content row at the same font size. See the matching override on
     .status-bar. */
  line-height: 1.4;
}
/* When the icons wrap, swap to a 3-column grid so the six icons split
   evenly into 2 rows of 3 instead of the browser's natural "as many as fit
   then leftovers" packing (which lands at 5+1 or 4+2 at borderline fonts).
   Only kicks in when the foot is expanded — the collapsed rail's own
   flex-column override below takes precedence. */
.sidebar:not(.collapsed) .sidebar-foot.foot-wrapped {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  justify-items: center;
}
/* Collapsed rail: hide the brand, swap the foot to a vertical stack, and
   center everything in the 36px column. Foot icons keep their muscle-memory
   spot at the bottom of the sidebar; the toggle chevron sits up top. */
.sidebar.collapsed .sidebar-head {
  padding: var(--space-4) 0;
  justify-content: center;
}
.sidebar.collapsed .sidebar-foot {
  flex-direction: column;
  padding: var(--space-4) 0;
  gap: var(--space-4);
  justify-content: flex-end;
}

.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 0 var(--space-2);
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
  padding: var(--space-4) var(--space-6);
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
/* DM headers double as a "view profile" trigger. Strip the .link padding so
   the button-rendered label sits exactly where the span used to, and only
   underline on hover so it doesn't read as a link in steady state. */
button.buffer.link {
  padding: 0;
}
button.buffer.link:hover {
  text-decoration: underline;
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
   (server buffers), the server network-cog takes the same slot, or
   members-toggle's own margin-left:auto takes over. Count sits to the
   right of the icon. */
.topic .buffer-cog,
.topic .server-right-start {
  margin-left: auto;
  padding-left: var(--space-4);
}
.topic .network-cog {
  padding-left: var(--space-4);
}
.topic .buffer-cog + .members-toggle {
  margin-left: 0;
  padding-left: var(--space-2);
}
.topic .members-toggle {
  margin-left: auto;
  padding-left: var(--space-4);
}
/* Word-button styling for the server-buffer affordances (Channel List,
   Disconnect/Reconnect). They cluster on the right alongside the
   network-cog — the first one (Channel List) carries margin-left:auto via
   .server-right-start, and the rest follow it in DOM order. */
.topic .link.word {
  padding: 0 var(--space-3);
}
.topic .member-count {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
</style>
