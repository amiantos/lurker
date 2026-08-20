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
      <!-- Collapsing the list takes its per-row highlight badges with it, so the
           control that brings it back carries their total (#636). Unlike the
           Transfers button below this one IS a count badge: the number is the
           information here, not a state the glyph could stand in for. -->
      <button
        v-else
        class="link rail-toggle"
        :title="railToggleTitle"
        :aria-label="railToggleTitle"
        @click="toggleChannels"
      >
        <i class="fa-solid fa-angles-right"></i>
        <span v-if="hlChip.show.value" class="hl-chip" aria-hidden="true">{{
          hlChip.label.value
        }}</span>
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

    <!-- The chat frame: one pane, or up to four sharing a 2x2 grid. The
         container paints --border and leaves a 1px gap, so the separators
         between panes come out of the gap itself and no pane has to know which
         edges it has neighbours on.

         Keyed by INDEX, not by buffer: a plain click swaps the focused pane's
         buffer, and keying by buffer would tear the whole subtree down and
         rebuild it on every switch. The single-pane view has always repointed
         in place, and it has to keep doing that. -->
    <div class="panes" :class="`panes-${paneKeys.length}`">
      <BufferPane
        v-for="(key, i) in paneKeys"
        :key="i"
        :style="{ gridArea: PANE_AREAS[i] }"
        :pane-key="key"
        :split="splits.isSplit"
        :focused="i === splits.focused"
        :pending-scroll-id="i === splits.focused ? pendingScrollId : null"
        @focus="onPaneFocus(i)"
        @close="onPaneClose(i)"
        @maximize="onPaneMaximize(i)"
        @open-search="openSearch"
        @open-highlights="openHighlights"
        @show-topic="showTopic = true"
      />
    </div>

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
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useBuffersStore } from '../stores/buffers.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';
import { useSocket } from '../composables/useSocket.js';
import { useNetworksStore } from '../stores/networks.js';
import { useChatBootstrap } from '../composables/useChatBootstrap.js';
import { useActiveBuffer } from '../composables/useActiveBuffer.js';
import { useBufferSearchScope } from '../composables/useBufferSearchScope.js';
import { useHighlightChip } from '../composables/useHighlightChip.js';
import { useSettingsStore } from '../stores/settings.js';
import { useAuthStore } from '../stores/auth.js';
import BufferList from '../components/BufferList.vue';
import BufferPane from '../components/BufferPane.vue';
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
import UserProfileModal from '../components/UserProfileModal.vue';
import MediaViewerModal from '../components/MediaViewerModal.vue';
import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts.js';
import { shouldOpenSystemBufferOnLoad } from '../utils/defaultBuffer.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useDccStore } from '../stores/dcc.js';
import { useWhoisStore } from '../stores/whois.js';
import { useChannelListModal } from '../composables/useChannelListModal.js';
import { useJoinChannelModal } from '../composables/useJoinChannelModal.js';
import { useMediaViewer } from '../composables/useMediaViewer.js';
import { useNetworkEditor } from '../composables/useNetworkEditor.js';
import { useJumpToMessage } from '../composables/useJumpToMessage.js';
import { useSplitsStore, PANE_AREAS } from '../stores/splits.js';
import { paneFor } from '../composables/usePaneRegistry.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();
// Registers the WebSocket connect lifecycle (onMounted) for the desktop shell —
// must be called even though we don't read `connected` here (the LURKER row's
// status light reads the exported `connected` ref directly). Without this call
// the socket never opens: red status light + no buffers (#355 regression).
useSocket();

// Un-provided, so this resolves through networks.activeKey — which follows pane
// focus. The shell only needs the focused pane's buffer now: the topic modal it
// hosts, and the type-ahead guard. Everything else that used to live here moved
// into BufferPane, which resolves its own buffer instead.
const { active, topic, bufferLabel } = useActiveBuffer();

const settings = useSettingsStore();
const auth = useAuthStore();
const nickNotes = useNickNotesStore();
const dcc = useDccStore();
const dccTitle = computed(() =>
  dcc.pendingCount > 0 ? `DCC transfers — ${dcc.pendingCount} awaiting approval` : 'DCC transfers',
);
const whois = useWhoisStore();

// Not reactive()-wrapped: the chip's fields stay refs so the template can read
// them as `hlChip.show.value`, which keeps this identical to MobileChat's use.
const hlChip = useHighlightChip();
// The count is aria-hidden in the markup — screen readers get it here instead,
// as words rather than a bare number floating beside "Show channel list".
const railToggleTitle = computed(() =>
  hlChip.show.value
    ? `Show channel list — ${hlChip.label.value} highlight${hlChip.count.value === 1 ? '' : 's'}`
    : 'Show channel list',
);

const channelListModal = reactive(useChannelListModal());
const joinChannelModal = reactive(useJoinChannelModal());
const viewer = reactive(useMediaViewer());
const networkEditor = reactive(useNetworkEditor());
const showBookmarks = ref(false);
const showTopic = ref(false);
const showUploads = ref(false);
const showSwitcher = ref(false);
const showKbdHelp = ref(false);
const pendingScrollId = ref<number | null>(null);

// Search & Highlights modal state + per-buffer `in:/on:` scoping, shared with
// MobileChat (#496).
const { showSearch, showHighlights, searchScope, highlightScope, openSearch, openHighlights } =
  useBufferSearchScope();

const splits = useSplitsStore();

// One pane per open buffer, or a single empty pane before anything is active —
// the shell has always rendered its frame with no buffer selected (the topic
// bar and "No messages yet." body), and it still does.
const paneKeys = computed<(string | null)[]>(() => (splits.count ? splits.panes : [null]));

// Point the app's active buffer at whatever the focused pane is showing. This
// is what keeps a split frame coherent with everything outside it: the
// buffer-list highlight, scoped search, the nav history and the keyboard
// shortcuts all still ask "what is the active buffer" and get the pane the user
// is in. It also keeps READ state honest — pushMessage advances the read
// pointer of the active buffer, so leaving activeKey on a buffer no pane is
// showing would mark it read while the user looks at something else.
//
// retainPrevious because nothing left the screen by getting here: either the
// outgoing pane is still sitting there, or the splits store already tore it
// down when it closed. That lifecycle is the store's, not activate()'s.
function activateFocusedPane() {
  const key = splits.focusedKey;
  if (!key || key === networks.activeKey) return;
  const buf = networks.bufferFor(key);
  if (buf) buffers.activate(buf.networkId, buf.target, { retainPrevious: true });
  else if (key === SYSTEM_KEY) buffers.activate(null, SYSTEM_KEY, { retainPrevious: true });
}

function onPaneFocus(index: number) {
  if (index === splits.focused) return;
  splits.focusPane(index);
  activateFocusedPane();
}

// Closing the FOCUSED pane hands focus to a neighbour showing a different
// buffer, so the active buffer has to follow it there. (Closing any other pane
// leaves focus where it was, and this no-ops.)
function onPaneClose(index: number) {
  splits.closePane(index);
  activateFocusedPane();
}

// Maximize is the same story: collapsing to one pane changes which buffer is
// focused whenever the maximized pane wasn't the focused one.
function onPaneMaximize(index: number) {
  splits.collapseTo(index);
  activateFocusedPane();
}

// The keyboard and the click-anywhere-to-type behavior address "the pane the
// user is in", which is the focused one — look it up by buffer rather than
// holding a template ref, since there are now up to four panes to hold one to.
function focusedPane() {
  return paneFor(splits.focusedKey);
}

// Activations that don't come through the pane controls — /query, the quick
// switcher, a jump-to-message, a push deep link, the land-on-system-buffer rule
// below — set networks.activeKey and expect the frame to follow. For a split
// frame that means "show it in the focused pane", which is exactly what a plain
// buffer-list click already does, so they share the one path.
//
// immediate, so a remount (a viewport flip back to desktop, coming back from
// Settings) reconciles the frame with whatever is active instead of painting an
// empty pane until the next click.
watch(
  () => networks.activeKey,
  (key) => {
    if (key) {
      splits.syncActive(key);
      return;
    }
    // Closing a buffer nulls activeKey (networks.dropBuffer) — right when it
    // was the only view of it, wrong when other panes are still up. The sweep
    // is synchronous and this watcher flushes after it, so by now the splits
    // store has closed that pane and focus has landed on a survivor: adopt it,
    // rather than leave the app with no active buffer while a conversation is
    // plainly on screen (no sidebar highlight, and type-ahead refusing to focus
    // the composer). With no panes left there's nothing to adopt, and the
    // land-on-system-buffer rule below takes it from here.
    activateFocusedPane();
  },
  { immediate: true },
);

// Any modal open? Type-ahead must not steal focus from a modal's own fields.
const anyModalOpen = computed(
  () =>
    networkEditor.isOpen ||
    showHighlights.value ||
    showBookmarks.value ||
    showTopic.value ||
    channelListModal.isOpen ||
    joinChannelModal.isOpen ||
    viewer.isOpen ||
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

function toggleChannels() {
  settings.setValue('look.layout.show_channel_list', !showChannels.value);
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
  focusedPane()?.focusInput();
}

const onJumpToMessage = useJumpToMessage({ pendingScrollId });

const router = useRouter();
const route = useRoute();

// Land on the system buffer instead of a blank "No messages yet." pane when
// nothing else is active (#355) — but not over the top of a deep link that
// hasn't resolved yet. See shouldOpenSystemBufferOnLoad for why the route half
// of that test is load-bearing.
//
// A watcher rather than a one-shot onMounted, because the interesting case
// arrives LATE: a stale bookmark declines this rule at mount (the URL names a
// buffer), then fails to resolve and drops the route back to `/` ten seconds
// later with nothing active. A one-shot never sees that, and desktop is left on
// the blank pane this rule exists to prevent.
//
// MUST stay below `route` above. `immediate: true` evaluates the getter
// synchronously inside watch(), and <script setup> preserves statement order —
// declared any earlier this throws a temporal-dead-zone ReferenceError during
// setup and the desktop shell never mounts at all. Neither vue-tsc (it cannot
// see through the closure) nor the suite (nothing mounts this component) catches
// it, so the ordering is load-bearing and invisible.
watch(
  () => [networks.activeKey, route.params.id] as const,
  () => {
    if (shouldOpenSystemBufferOnLoad(networks.activeKey, route.params.id)) {
      buffers.activate(null, SYSTEM_KEY);
    }
  },
  { immediate: true },
);
// Collapsed-only footer affordance: the settings cog normally lives on the
// LURKER sidebar row, but that whole list is unmounted when the sidebar is
// collapsed (BufferList v-if), so the rail offers the cog here instead (#355).
// The .catch matches BufferList's expanded-sidebar twin: router.onError does
// the actual recovery, this just keeps an aborted navigation from surfacing as
// an unhandled rejection.
function openSettings() {
  router.push('/settings').catch((err) => console.error('[DesktopChat] open settings failed', err));
}

// Admin panel entry (collapsed-rail twin of the BufferList header shield).
const showAdminEntry = computed(() => auth.isAdmin);
function openAdmin() {
  router.push('/admin').catch((err) => console.error('[DesktopChat] open admin failed', err));
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
/* WeeChat-style frame: the sidebar runs full height on the left, and the rest
   of the width is the chat content. The shell used to own the whole five-row
   topic/divider/messages/status/input grid; BufferPane owns that now, so what's
   left here is just the two columns. The sidebar is sized via a custom property
   so .sidebar-collapsed can shrink it to a 36px rail without touching the rest
   of the grid. */
.chat {
  --sidebar-w: 220px;
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
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

/* The pane grid. Every layout is a way of filling a 2x2, so the pane count
   picks a template rather than each count getting its own grid:

     1 pane    2 panes   3 panes   4 panes
     ┌─────┐   ┌─────┐   ┌─────┐   ┌──┬──┐
     │  a  │   │  a  │   │  a  │   │a │b │
     │     │   ├─────┤   ├──┬──┤   ├──┼──┤
     │     │   │  b  │   │b │c │   │c │d │
     └─────┘   └─────┘   └──┴──┘   └──┴──┘

   The separators are the 1px grid gap over a --border background rather than
   per-pane borders: which edges a pane needs a line on differs in all four
   layouts, and a gap is right in every one of them without the pane knowing
   anything about its neighbours. */
.panes {
  grid-area: content;
  display: grid;
  gap: 1px;
  background: var(--border);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.panes-1 {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
  grid-template-areas: 'a';
}
.panes-2 {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr 1fr;
  grid-template-areas: 'a' 'b';
}
/* Splitting the BOTTOM half is what makes a third pane an addition rather than
   a re-layout: a and b keep their full width and only b's height changes. */
.panes-3 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  grid-template-areas:
    'a a'
    'b c';
}
.panes-4 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  grid-template-areas:
    'a b'
    'c d';
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
  /* Anchors .hl-chip only — the chip is positioned so it stays OUT of the line
     box, which is what keeps the rule below aligned with the topic divider. */
  position: relative;
}
/* Highlight total for the list this button reveals. Colored text on a tint of
   the same var rather than a solid fill: --buffer-highlight is user-themeable
   (look.color.buffer.highlight), so any fixed label color could land on an
   unreadable pairing. The tint tracks whatever they picked and the text keeps
   its own contrast against it.

   Mixed against --bg, not transparent: the chip sits over the chevron, and a
   see-through wash let the glyph ghost through the pill where they overlap at
   larger font sizes. An opaque tint covers it cleanly while staying light
   enough to keep the colored text legible. */
.rail-toggle .hl-chip {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  font-size: 0.75em;
  line-height: 1.5;
  color: var(--buffer-highlight);
  background: color-mix(in srgb, var(--buffer-highlight) 24%, var(--bg));
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
