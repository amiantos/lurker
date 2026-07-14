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
      'system-active': isSystemBuffer,
    }"
    @click="onChatClick"
  >
    <aside class="sidebar" :class="{ collapsed: !showChannels }">
      <!-- The "lurker" header + connection dot live in BufferList's LURKER row
           (#355); the collapse control lives there too. When collapsed the list
           is unmounted, so the expand control returns to the top of the rail. -->
      <BufferList v-if="showChannels" />
      <button v-else class="link rail-toggle" title="Show channel list" @click="toggleChannels">
        <i class="fa-solid fa-angles-right"></i>
      </button>
      <div ref="footEl" class="sidebar-foot" :class="{ 'foot-wrapped': footWrapped }">
        <!-- Settings and Add-network normally live in the LURKER header (#411),
             but that header is unmounted while the sidebar is collapsed, so the
             rail offers them here instead — collapsed-only to avoid duplicating
             the header controls when expanded. -->
        <button v-if="!showChannels" class="link" @click="openSettings" title="Settings">
          <i class="fa-solid fa-gear"></i>
        </button>
        <button
          v-if="!showChannels && showAdminEntry"
          class="link"
          @click="openAdmin"
          title="Admin panel"
          aria-label="Admin panel"
        >
          <i class="fa-solid fa-shield-halved"></i>
        </button>
        <button v-if="!showChannels" class="link" @click="openAddNetwork" title="Add network">
          <i class="fa-solid fa-plus"></i>
        </button>
        <button class="link" @click="openSearch(false)" title="Search messages">
          <i class="fa-solid fa-magnifying-glass"></i>
        </button>
        <button class="link" @click="openHighlights(false)" title="Highlights">
          <i class="fa-regular fa-bell"></i>
        </button>
        <button class="link" @click="showBookmarks = true" title="Saved messages">
          <i class="fa-regular fa-bookmark"></i>
        </button>
        <button class="link" @click="showUploads = true" title="Recent uploads">
          <i class="fa-solid fa-arrow-up-from-bracket"></i>
        </button>
        <!-- Self-revealing: DCC is off for almost everyone, so the Transfers
             button only appears once a transfer exists (or the panel is open).
             Color-as-signal (house style, no count badge): the glyph turns
             warn-colored while an unsolicited offer awaits a decision. -->
        <button
          v-if="dcc.hasAny || dcc.panelOpen"
          class="link dcc-btn"
          :class="{ pending: dcc.pendingCount > 0 }"
          @click="dcc.open()"
          :title="dccTitle"
        >
          <i class="fa-solid fa-download"></i>
        </button>
      </div>
    </aside>

    <!-- Topic bar: always rendered so the back/forward history controls (#411)
         are present in every state, even before any buffer is selected. The nav
         cluster is anchored at the far left, left of the buffer title; the meta
         (name + topic) and per-buffer actions render conditionally beside it. -->
    <header class="topic">
      <div class="topic-nav">
        <button
          type="button"
          class="link nav-btn"
          title="Back"
          aria-label="Back"
          :disabled="!navHistory.canBack"
          @click="navHistory.back()"
        >
          <i class="fa-solid fa-angle-left"></i>
        </button>
        <button
          type="button"
          class="link nav-btn"
          title="Forward"
          aria-label="Forward"
          :disabled="!navHistory.canForward"
          @click="navHistory.forward()"
        >
          <i class="fa-solid fa-angle-right"></i>
        </button>
      </div>
      <div class="topic-meta">
        <span v-if="isVirtual || active" class="buffer">{{ bufferLabel }}</span>
        <template v-if="active && topic">
          <button
            type="button"
            class="topic-text"
            title="View full topic"
            @click="showTopic = true"
          >
            <LinkedText :text="topic" />
          </button>
        </template>
      </div>
      <div class="topic-actions">
        <template v-if="isVirtual">
          <template v-if="isFriendsBuffer">
            <button
              type="button"
              class="link"
              title="Add friend"
              aria-label="Add friend"
              @click="friends.openEditorNew()"
            >
              <i class="fa-solid fa-person-circle-plus"></i>
            </button>
            <span
              class="member-count"
              :title="`${friendCount} ${friendCount === 1 ? 'friend' : 'friends'}`"
            >
              <i class="fa-solid fa-users"></i> {{ friendCount }}
            </span>
          </template>
        </template>
        <template v-else-if="active">
          <!-- Search & highlights scoped to this buffer (channels/DMs only) —
               parity with the mobile topic bar. The server buffer has no
               per-buffer scope, so it's excluded. -->
          <template v-if="!isServerBuffer">
            <button
              type="button"
              class="link"
              title="Search this buffer"
              aria-label="Search this buffer"
              @click="openSearch(true)"
            >
              <i class="fa-solid fa-magnifying-glass"></i>
            </button>
            <button
              type="button"
              class="link"
              title="Highlights in this buffer"
              aria-label="Highlights in this buffer"
              @click="openHighlights(true)"
            >
              <i class="fa-regular fa-bell"></i>
            </button>
          </template>
          <template v-if="isServerBuffer">
            <button
              type="button"
              class="link"
              title="Join channel"
              aria-label="Join channel"
              :disabled="serverConnectionState !== 'connected'"
              @click="active && joinChannelModal.open(active.networkId)"
            >
              <i class="fa-solid fa-plus"></i>
            </button>
            <button
              type="button"
              class="link"
              title="Channel list"
              aria-label="Channel list"
              @click="active && channelListModal.open(active.networkId)"
            >
              <i class="fa-solid fa-hashtag"></i>
            </button>
            <button
              type="button"
              class="link"
              :title="serverConnectActionLabel"
              :aria-label="serverConnectActionLabel"
              @click="toggleServerConnection"
            >
              <i :class="serverConnectActionIcon"></i>
            </button>
            <button class="link" title="Edit network" @click="editActiveNetwork">
              <i class="fa-solid fa-gear"></i>
            </button>
          </template>
          <template v-else-if="isDmHeader">
            <button
              type="button"
              class="link"
              title="View profile"
              aria-label="View profile"
              @click="openDmProfile"
            >
              <i class="fa-solid fa-id-card"></i>
            </button>
            <button
              type="button"
              class="link"
              :title="dmNoteLabel"
              :aria-label="dmNoteLabel"
              @click="openDmNote"
            >
              <i class="fa-solid fa-note-sticky"></i>
            </button>
          </template>
          <template v-else-if="isChannel">
            <button
              class="link"
              :title="showMembers ? 'Hide members' : 'Show members'"
              :aria-label="showMembers ? 'Hide members' : 'Show members'"
              @click="toggleMembers"
            >
              <i class="fa-solid fa-users"></i>
            </button>
            <span
              v-if="memberCount != null"
              class="member-count"
              :title="`${memberCount} ${memberCount === 1 ? 'user' : 'users'} in channel`"
              >{{ memberCount }}</span
            >
          </template>
        </template>
      </div>
    </header>
    <div class="topic-divider"></div>

    <FriendsOverview v-if="renderMode === 'overview'" @view-activity="onViewActivity" />
    <MessageList v-else ref="messageListRef" :pending-scroll-id="pendingScrollId" />
    <MemberList v-if="showMembers && hasNicklist" />
    <StatusBar />
    <MessageInput v-if="hasInput" ref="messageInputRef" />

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
      v-if="showTopic && active"
      :topic="topic"
      :label="bufferLabel"
      @close="showTopic = false"
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
    <QuickSwitcher v-if="showSwitcher" @close="showSwitcher = false" />
    <SearchModal
      v-if="showSearch"
      :scope="searchScope"
      @close="showSearch = false"
      @jump="onJumpToMessage"
    />
    <KeyboardHelpModal v-if="showKbdHelp" @close="showKbdHelp = false" />
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
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Network } from '../stores/networks.js';
import { useBuffersStore, type Buffer } from '../stores/buffers.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';
import { useSocket } from '../composables/useSocket.js';
import { useNetworksStore } from '../stores/networks.js';
import { useChatBootstrap } from '../composables/useChatBootstrap.js';
import { useActiveBuffer } from '../composables/useActiveBuffer.js';
import { useBufferSearchScope } from '../composables/useBufferSearchScope.js';
import { useSettingsStore } from '../stores/settings.js';
import { useAuthStore } from '../stores/auth.js';
import BufferList from '../components/BufferList.vue';
import MessageList from '../components/MessageList.vue';
import FriendsOverview from '../components/FriendsOverview.vue';
import MessageInput from '../components/MessageInput.vue';
import MemberList from '../components/MemberList.vue';
import StatusBar from '../components/StatusBar.vue';
import NetworkForm from '../components/NetworkForm.vue';
import HighlightsModal from '../components/HighlightsModal.vue';
import BookmarksModal from '../components/BookmarksModal.vue';
import LinkedText from '../components/LinkedText.vue';
import TopicModal from '../components/TopicModal.vue';
import ChannelListModal from '../components/ChannelListModal.vue';
import JoinChannelModal from '../components/JoinChannelModal.vue';
import RecentUploadsModal from '../components/RecentUploadsModal.vue';
import TransfersModal from '../components/TransfersModal.vue';
import QuickSwitcher from '../components/QuickSwitcher.vue';
import SearchModal from '../components/SearchModal.vue';
import KeyboardHelpModal from '../components/KeyboardHelpModal.vue';
import NickNoteModal from '../components/NickNoteModal.vue';
import ConfigureFriendModal from '../components/ConfigureFriendModal.vue';
import UserProfileModal from '../components/UserProfileModal.vue';
import ImageViewerModal from '../components/ImageViewerModal.vue';
import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts.js';
import { useNicklistCollapseStore } from '../stores/nicklistCollapse.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useFriendsStore } from '../stores/friends.js';
import { useDccStore } from '../stores/dcc.js';
import { useWhoisStore } from '../stores/whois.js';
import { useChannelListModal } from '../composables/useChannelListModal.js';
import { useJoinChannelModal } from '../composables/useJoinChannelModal.js';
import { useImageModal } from '../composables/useImageModal.js';
import { useNetworkEditor } from '../composables/useNetworkEditor.js';
import { useJumpToMessage } from '../composables/useJumpToMessage.js';
import { useNavHistoryStore } from '../stores/navHistory.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();
// Registers the WebSocket connect lifecycle (onMounted) for the desktop shell —
// must be called even though we don't read `connected` here (the LURKER row's
// status light reads the exported `connected` ref directly). Without this call
// the socket never opens: red status light + no buffers (#355 regression).
useSocket();

// Land on the system buffer instead of a blank "No messages yet." pane when
// nothing else is active on load (#355). The last-active buffer isn't persisted,
// so activeKey is null on every fresh load; the system buffer always exists in
// the store, so this is always a valid target. Guarded on null so a deep-link /
// push-jump that set a buffer first still wins.
onMounted(() => {
  if (networks.activeKey == null) buffers.activate(null, SYSTEM_KEY);
});
const {
  active,
  activeBuf,
  topic,
  isServerBuffer,
  isChannel,
  bufferLabel,
  isSystemBuffer,
  isVirtual,
  isFriendsBuffer,
  renderMode,
  hasInput,
  hasNicklist,
} = useActiveBuffer();

const settings = useSettingsStore();
const auth = useAuthStore();
const nicklistCollapse = useNicklistCollapseStore();
const nickNotes = useNickNotesStore();
const friends = useFriendsStore();
const friendCount = computed(() => friends.contacts.length);
const dcc = useDccStore();
const dccTitle = computed(() =>
  dcc.pendingCount > 0 ? `DCC transfers — ${dcc.pendingCount} awaiting approval` : 'DCC transfers',
);
const whois = useWhoisStore();

const channelListModal = reactive(useChannelListModal());
const joinChannelModal = reactive(useJoinChannelModal());
const imageModal = reactive(useImageModal());
const networkEditor = reactive(useNetworkEditor());
const navHistory = useNavHistoryStore();
const showBookmarks = ref(false);
const showTopic = ref(false);
const showUploads = ref(false);
const showSwitcher = ref(false);
const showKbdHelp = ref(false);
const pendingScrollId = ref<number | null>(null);

// Search & Highlights modal state + per-buffer `in:/on:` scoping, shared with
// MobileChat (#496).
const {
  showSearch,
  showHighlights,
  searchScope,
  highlightScope,
  openSearch,
  openHighlights,
  onViewActivity,
} = useBufferSearchScope();
const messageInputRef = ref<{ focus: () => void } | null>(null);
const messageListRef = ref<{ scrollByPage: (dir: number) => void } | null>(null);

// Any modal open? Type-ahead must not steal focus from a modal's own fields.
const anyModalOpen = computed(
  () =>
    networkEditor.isOpen ||
    showHighlights.value ||
    showBookmarks.value ||
    showTopic.value ||
    channelListModal.isOpen ||
    joinChannelModal.isOpen ||
    imageModal.isOpen ||
    showUploads.value ||
    dcc.panelOpen ||
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
    openSearch(false);
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
// DM note button — mirrors the old context-menu entry, surfaced inline so the
// per-peer note is one click from the conversation. Label flips once a note
// exists so the button doubles as a "has a note" tell.
const dmNoteLabel = computed(() =>
  active.value && nickNotes.hasNote(active.value.networkId, active.value.target)
    ? 'Edit note'
    : 'Add note',
);
function openDmNote() {
  if (!active.value) return;
  nickNotes.openEditor(active.value.networkId, active.value.target);
}

// Channel notification level (always/highlights/nothing/muted) now lives in the
// buffer context-menu ladder (right-click the sidebar row, or the topic-bar cog),
// so there is no dedicated topic-bar bell anymore (issue #359).

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

const router = useRouter();
// Collapsed-only footer affordance: the settings cog normally lives on the
// LURKER sidebar row, but that whole list is unmounted when the sidebar is
// collapsed (BufferList v-if), so the rail offers the cog here instead (#355).
function openSettings() {
  router.push('/settings');
}

// Admin panel entry (collapsed-rail twin of the BufferList header shield).
const showAdminEntry = computed(() => auth.isAdmin);
function openAdmin() {
  router.push('/admin');
}

// Collapsed-rail add-network (the expanded affordance is the LURKER header's +,
// which is unmounted with the sidebar).
function openAddNetwork() {
  networkEditor.open();
}
function closeNetworkForm() {
  networkEditor.close();
}

function editActiveNetwork() {
  const net = active.value?.network as Network | undefined;
  if (net) networkEditor.open(net);
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
/* The status bar carries the separator border above the input, but it's hidden
   in the system buffer (no network state to show). Give the input its own top
   border there so it stays visually divided from the message list. */
.chat.system-active .input {
  border-top: 1px solid var(--border);
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
/* Pin the collapse toggle flush-left and the plus (add network) flush-right;
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
/* Collapsed rail: swap the foot to a vertical stack and center everything in
   the 36px column. The expand toggle sits at the top of the rail (.rail-toggle);
   the foot holds the stacked tool icons + settings cog. */
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
/* Disabled topic-bar link (e.g. Join channel while the network is disconnected):
   dimmed and non-interactive, and it must not brighten on hover. */
.link:disabled {
  opacity: 0.35;
  cursor: default;
}
.link:disabled:hover {
  color: var(--accent);
}
/* Transfers button: while an unsolicited offer awaits a decision the glyph
   turns warn-colored to draw the eye (color-as-signal, no count badge). */
.dcc-btn.pending {
  color: var(--warn);
}
/* Expand control at the top of the collapsed rail — the in-list collapse
   button is unmounted with the channel list, so this brings it back up top.
   Mirrors the LURKER header it stands in for so its bottom rule lines up with
   the topic divider: full-rail width, the same var(--space-4) block padding,
   and the icon in a normal line box (not flex — that sized to the glyph, ~1em,
   leaving the rule too high; text-align keeps the headers' line-height box). */
.rail-toggle {
  align-self: stretch;
  text-align: center;
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border);
}
/* The global `button:hover` repaints border-color to --accent, which would
   recolor the bottom rule on hover. Pin it back to --border — and keep it a
   real border (not a box-shadow) so the rule's 1px keeps the toggle the same
   height as the LURKER header / topic bar it lines up with. Specificity here
   (0,3,0) beats the global `button:hover:not(:disabled)` (0,2,1). */
.rail-toggle:hover:not(:disabled) {
  border-color: var(--border);
}

.topic {
  grid-area: topic;
  padding: var(--space-4) var(--space-6);
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  white-space: nowrap;
  overflow: hidden;
}
/* Back/forward history controls (#411), anchored at the far left of the bar,
   left of the buffer title. Same accent icon buttons as the rest of the bar;
   disabled (dimmed, non-interactive) when there's nowhere to go that way. */
.topic-nav {
  display: flex;
  align-items: baseline;
  /* Match .topic-actions' gap so the back/forward pair is spaced like every
     other button pair in the bar, not tighter. */
  gap: var(--space-4);
  flex-shrink: 0;
}
.nav-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.nav-btn:disabled:hover {
  color: var(--accent);
}
.topic-divider {
  grid-area: divider;
  background: var(--border);
  height: 1px;
}
.topic .buffer {
  color: var(--accent);
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

/* Two-group layout for the topic bar: .topic-meta (name + topic text, spaced
   by the 2ch gap — wider than the 1ch bar convention to give the name and
   topic breathing room now that the │ divider is gone) sits left,
   .topic-actions (buffer/network/channel buttons) sits right.
   .topic uses justify-content:space-between to split them. .topic-meta
   shrinks first via min-width:0 + topic-text ellipsis, so the action
   cluster stays anchored to the right edge. */
.topic-meta {
  display: flex;
  align-items: baseline;
  gap: 2ch;
  /* flex:1 so the meta absorbs the free space and keeps the action cluster
     anchored to the right edge; min-width:0 lets the topic text ellipsis. */
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.topic-actions {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  flex-shrink: 0;
}
.topic .member-count {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
</style>
