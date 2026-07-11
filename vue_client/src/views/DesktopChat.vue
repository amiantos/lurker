<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="chat" :class="{ 'sidebar-collapsed': !showChannels }" @click="onChatClick">
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

    <!-- The whole content area right of the sidebar. In classic mode that's one
         maximized pane; the windowed canvas (behind look.layout.windowed) puts
         several in draggable frames instead. -->
    <WindowCanvas
      v-if="windowed"
      class="canvas"
      :pending-scroll-id="pendingScrollId"
      @open-search="openSearch"
      @open-highlights="openHighlights"
      @show-topic="showTopic = true"
      @view-activity="onViewActivity"
    />
    <BufferPane
      v-else
      class="pane"
      :buffer-key="networks.activeKey"
      :pending-scroll-id="pendingScrollId"
      @open-search="openSearch"
      @open-highlights="openHighlights"
      @show-topic="showTopic = true"
      @view-activity="onViewActivity"
    />

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
import { useBuffersStore } from '../stores/buffers.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';
import { useSocket } from '../composables/useSocket.js';
import { useNetworksStore } from '../stores/networks.js';
import { useChatBootstrap } from '../composables/useChatBootstrap.js';
import { useActiveBuffer } from '../composables/useActiveBuffer.js';
import { useBufferSearchScope } from '../composables/useBufferSearchScope.js';
import { useSettingsStore } from '../stores/settings.js';
import { useAuthStore } from '../stores/auth.js';
import { useConfigStore } from '../stores/config.js';
import BufferList from '../components/BufferList.vue';
import BufferPane from '../components/BufferPane.vue';
import WindowCanvas from '../components/WindowCanvas.vue';
import NetworkForm from '../components/NetworkForm.vue';
import HighlightsModal from '../components/HighlightsModal.vue';
import BookmarksModal from '../components/BookmarksModal.vue';
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
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useFriendsStore } from '../stores/friends.js';
import { useDccStore } from '../stores/dcc.js';
import { useWhoisStore } from '../stores/whois.js';
import { useChannelListModal } from '../composables/useChannelListModal.js';
import { useJoinChannelModal } from '../composables/useJoinChannelModal.js';
import { useImageModal } from '../composables/useImageModal.js';
import { useNetworkEditor } from '../composables/useNetworkEditor.js';
import { useJumpToMessage } from '../composables/useJumpToMessage.js';
import { paneFor } from '../composables/usePaneRegistry.js';

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
// The shell still tracks the active buffer for the modals it owns (topic,
// scoped search) and for the keyboard shortcuts, which target whichever pane
// has focus. The pane itself resolves its buffer from its own prop.
const { active, topic, bufferLabel } = useActiveBuffer();

const settings = useSettingsStore();
const auth = useAuthStore();
const config = useConfigStore();
const nickNotes = useNickNotesStore();
const friends = useFriendsStore();
const dcc = useDccStore();
const dccTitle = computed(() =>
  dcc.pendingCount > 0 ? `DCC transfers — ${dcc.pendingCount} awaiting approval` : 'DCC transfers',
);
const whois = useWhoisStore();

const channelListModal = reactive(useChannelListModal());
const joinChannelModal = reactive(useJoinChannelModal());
const imageModal = reactive(useImageModal());
const networkEditor = reactive(useNetworkEditor());
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
// The pane the keyboard and stray-click handlers act on: whichever one is
// showing the active buffer. With a single maximized pane that's the only one;
// with windows it's the focused window, since focusing a window is what makes
// its buffer active.
const focusedPane = () => paneFor(networks.activeKey);

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
    focusedPane()?.focusInput();
  },
  onScrollMessages: (dir) => {
    if (anyModalOpen.value) return;
    focusedPane()?.scrollByPage(dir);
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

// Channel notification level (always/highlights/nothing/muted) now lives in the
// buffer context-menu ladder (right-click the sidebar row, or the topic-bar cog),
// so there is no dedicated topic-bar bell anymore (issue #359).

// mIRC-style windowed buffers on the canvas right of the sidebar, instead of one
// maximized pane. Opt-in and experimental.
const windowed = computed(() => settings.effective('look.layout.windowed') === true);

function toggleChannels() {
  settings.setValue('look.layout.show_channel_list', !showChannels.value);
}

// Forward stray clicks anywhere in the chat frame (topic bar, message list,
// member list, sidebar gutter, etc.) into the focused pane's message input. The
// selector excludes anything genuinely interactive — buttons, links, form
// controls, and modal contents — and we bail if the user is in the middle of
// selecting text so we don't kill their selection.
function onChatClick(e: MouseEvent) {
  if (
    (e.target as Element).closest(
      'button, a, input, textarea, select, label, .modal, [contenteditable=true]',
    )
  )
    return;
  const sel = window.getSelection();
  if (sel && sel.toString().length > 0) return;
  focusedPane()?.focusInput();
}

const onJumpToMessage = useJumpToMessage({ pendingScrollId });

const router = useRouter();
// Collapsed-only footer affordance: the settings cog normally lives on the
// LURKER sidebar row, but that whole list is unmounted when the sidebar is
// collapsed (BufferList v-if), so the rail offers the cog here instead (#355).
function openSettings() {
  router.push('/settings');
}

// Admin panel entry (collapsed-rail twin of the BufferList header shield):
// admin-only, and only when the instance enabled LURKER_NEW_ADMIN_PANEL.
const showAdminEntry = computed(() => config.newAdminPanel && auth.isAdmin);
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

useChatBootstrap({ onJump: onJumpToMessage });
</script>

<style scoped>
/* WeeChat-style frame: the sidebar runs full height on the left, and everything
   right of it is the content area — either one maximized BufferPane (which owns
   its own topic/messages/members/status/input grid) or the windowed canvas.

   The sidebar column is sized via a CSS custom property so .sidebar-collapsed
   can shrink it to a 36px rail without touching the rest of the grid. */
.chat {
  --sidebar-w: 220px;
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  /* Explicit 1fr rather than an implicit auto row: the pane and canvas both
     need a definite height to size their own scrollers against. */
  grid-template-rows: 1fr;
  grid-template-areas: 'sidebar content';
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
/* min-height/min-width 0 lets flex/scrolling children stay inside their row. */
.chat > * {
  min-width: 0;
  min-height: 0;
}
.pane,
.canvas {
  grid-area: content;
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
</style>
