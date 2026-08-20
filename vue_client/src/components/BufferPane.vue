<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <!-- pointerdown, not click: focus has to land BEFORE the click reaches
       whatever was pressed, because the topic-bar buttons emit up to the shell
       and the shell resolves them against the ACTIVE buffer. Focusing first is
       what makes "search this buffer" in an unfocused pane search that pane's
       buffer rather than the previously focused one. -->
  <div
    class="buffer-pane"
    :class="{
      focused: focused && split,
      split,
      'members-collapsed': !showMembers,
      'system-pane': isSystemBuffer,
    }"
    @pointerdown="emit('focus')"
  >
    <header class="topic">
      <!-- Back/forward are global history controls, so N panes would mean N
           copies of one control. They stay in the single-pane shell, where
           they're the only way to reach the history; in a split the keyboard
           (Cmd/Ctrl+[ and ]) covers it and the bar keeps the room for the
           buffer's own actions. -->
      <div v-if="!split" class="topic-nav">
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
          <!-- A channel topic is user prose: auto-link it and open the full
               view on click. A DM's pseudo-topic is the peer's ident@host —
               an identity string, not prose; auto-linking turns the host into
               a bogus email/URL link, so it renders as plain static text. -->
          <button
            v-if="isChannel"
            type="button"
            class="topic-text"
            title="View full topic"
            @click="emit('show-topic')"
          >
            <LinkedText :text="topic" />
          </button>
          <span v-else class="topic-text">{{ topic }}</span>
        </template>
      </div>
      <div class="topic-actions">
        <template v-if="active && !isVirtual">
          <!-- Search & highlights scoped to this buffer (channels/DMs only) —
               parity with the mobile topic bar. The server buffer has no
               per-buffer scope, so it's excluded. -->
          <template v-if="!isServerBuffer">
            <button
              type="button"
              class="link"
              title="Search this buffer"
              aria-label="Search this buffer"
              @click="emit('open-search', true)"
            >
              <i class="fa-solid fa-magnifying-glass"></i>
            </button>
            <button
              type="button"
              class="link"
              title="Highlights in this buffer"
              aria-label="Highlights in this buffer"
              @click="emit('open-highlights', true)"
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
            <button class="link" title="Edit network" @click="editPaneNetwork">
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
        <!-- Pane controls, split-only: with one pane there is nothing to
             maximize away from and closing it would leave an empty frame. -->
        <template v-if="split">
          <span class="pane-sep" aria-hidden="true"></span>
          <button
            type="button"
            class="link pane-btn"
            title="Maximize this pane"
            aria-label="Maximize this pane"
            @click="emit('maximize')"
          >
            <i class="fa-solid fa-expand"></i>
          </button>
          <button
            type="button"
            class="link pane-btn"
            title="Close this pane"
            aria-label="Close this pane"
            @click="emit('close')"
          >
            <i class="fa-solid fa-xmark"></i>
          </button>
        </template>
      </div>
    </header>
    <div class="topic-divider"></div>

    <MessageList ref="messageListRef" :pending-scroll-id="pendingScrollId" />
    <MemberList v-if="showMembers && hasNicklist" />
    <StatusBar />
    <MessageInput v-if="hasInput" ref="messageInputRef" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, toRef, watch } from 'vue';
import type { Network } from '../stores/networks.js';
import { useNetworksStore } from '../stores/networks.js';
import type { Buffer } from '../stores/buffers.js';
import { provideBufferKey, useActiveBuffer } from '../composables/useActiveBuffer.js';
import { registerPane, unregisterPane, type PaneApi } from '../composables/usePaneRegistry.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNicklistCollapseStore } from '../stores/nicklistCollapse.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useWhoisStore } from '../stores/whois.js';
import { useNavHistoryStore } from '../stores/navHistory.js';
import { useChannelListModal } from '../composables/useChannelListModal.js';
import { useJoinChannelModal } from '../composables/useJoinChannelModal.js';
import { useNetworkEditor } from '../composables/useNetworkEditor.js';
import MessageList from './MessageList.vue';
import MessageInput from './MessageInput.vue';
import MemberList from './MemberList.vue';
import StatusBar from './StatusBar.vue';
import LinkedText from './LinkedText.vue';

const props = withDefaults(
  defineProps<{
    // The buffer this pane renders. Null renders the empty header + "no
    // messages" body, which is what the shell shows before anything is active.
    paneKey: string | null;
    // Whether the frame is divided. Off means this is the whole chat view and
    // must look exactly like the pre-split shell — no focus ring, no pane
    // controls, and the nav cluster back in the topic bar.
    split?: boolean;
    // Whether this is the pane the user is working in. Only meaningful while
    // `split` — with one pane it's trivially true and the ring would be noise.
    focused?: boolean;
    // Jump-to-message target, forwarded to this pane's message list. The shell
    // only hands it to the pane that owns the jump's buffer.
    pendingScrollId?: number | null;
  }>(),
  { split: false, focused: false, pendingScrollId: null },
);

const emit = defineEmits<{
  (e: 'focus'): void;
  (e: 'close'): void;
  (e: 'maximize'): void;
  (e: 'open-search', scoped: boolean): void;
  (e: 'open-highlights', scoped: boolean): void;
  (e: 'show-topic'): void;
}>();

const paneKey = toRef(props, 'paneKey');
// Everything below this component resolves "my buffer" from here rather than
// from networks.activeKey.
provideBufferKey(paneKey);

const networks = useNetworksStore();
const settings = useSettingsStore();
const nicklistCollapse = useNicklistCollapseStore();
const nickNotes = useNickNotesStore();
const whois = useWhoisStore();
const navHistory = useNavHistoryStore();
const channelListModal = reactive(useChannelListModal());
const joinChannelModal = reactive(useJoinChannelModal());
const networkEditor = reactive(useNetworkEditor());

// Explicit key, not the injected one: inject() resolves against the *parent's*
// provides, so asking for our own would hand back the global activeKey.
const {
  active,
  activeBuf,
  topic,
  isServerBuffer,
  isChannel,
  bufferLabel,
  isSystemBuffer,
  isVirtual,
  hasInput,
  hasNicklist,
} = useActiveBuffer(paneKey);

const messageInputRef = ref<{ focus: () => void } | null>(null);
const messageListRef = ref<{ scrollByPage: (dir: number) => void } | null>(null);

const api: PaneApi = {
  focusInput: () => messageInputRef.value?.focus(),
  scrollByPage: (dir: number) => messageListRef.value?.scrollByPage(dir),
};
onMounted(() => registerPane(paneKey.value, api));
onBeforeUnmount(() => unregisterPane(paneKey.value, api));
// A pane repoints at another buffer without remounting (a plain click swaps the
// focused pane's contents), so the registration has to follow the key or the
// shortcuts would keep reaching the buffer this pane used to show.
watch(paneKey, (key, prev) => {
  unregisterPane(prev, api);
  registerPane(key, api);
});

// True when this buffer is a DM (not a channel, not the network's server
// buffer). Drives the clickable DM header that opens the user profile modal —
// channel headers stay non-interactive.
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

// User count for a channel buffer. Sits in the topic bar (next to the
// members-toggle button) rather than the status bar — the count is a property
// of the channel, so the channel header is the natural home.
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

function toggleMembers() {
  if (!isChannel.value || !active.value) return;
  const { networkId, target } = active.value;
  // Pass the current visibility through as the new collapsed flag — it flips.
  nicklistCollapse.setCollapsed(networkId, target, !!showMembers.value);
}

function editPaneNetwork() {
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
  p.catch((err) => console.error('[BufferPane] toggle server connection failed', err));
}
</script>

<style scoped>
/* The pane's own frame: topic and status/input bars span the full width; the
   message list and nicklist sit between them. This is the grid DesktopChat used
   to own for the whole shell, minus the sidebar column — which is why a single
   pane is pixel-identical to the pre-split view.

   The member-list column is sized via a custom property so the
   .members-collapsed modifier can zero it without touching the rest of the
   grid. */
.buffer-pane {
  --members-w: 180px;
  display: grid;
  grid-template-columns: 1fr var(--members-w);
  /* The 1px row owns the topic/messages divider as its own grid track,
     outside the scroll container. Putting the line inside .message-list
     (border-top, inset box-shadow) lets row backgrounds and hover states
     paint over it as content scrolls past — the line appears to be eaten
     by the scrolling rows. A dedicated row sits between the two children
     and nothing can paint on top of it. */
  grid-template-rows: auto auto 1fr auto auto;
  grid-template-areas:
    'topic    topic'
    'divider  divider'
    'messages members'
    'status   status'
    'input    input';
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  /* Opaque so the 1px grid gap of the split container (which paints --border)
     shows only in the gap and not through the panes. */
  background: var(--bg);
}
/* Members column fully collapses — no rail. The reopen toggle lives in the
   topic bar on the right, so there's nothing to leave behind. */
.buffer-pane.members-collapsed {
  --members-w: 0px;
}
/* System console has no member list — collapse the rail so the log pane
   spans the full content width instead of leaving an empty column. */
.buffer-pane.system-pane {
  --members-w: 0px;
}
/* The status bar carries the separator border above the input, but it's hidden
   in the system buffer (no network state to show). Give the input its own top
   border there so it stays visually divided from the message list. */
.buffer-pane.system-pane .input {
  border-top: 1px solid var(--border);
}
/* A split pane gets a narrower nicklist: 180px out of a half-width pane is a
   much bigger bite than out of the full frame, and it squeezes the message
   column past the point where lines stop being readable. */
.buffer-pane.split {
  --members-w: 140px;
}
/* min-height/min-width 0 lets flex/scrolling children stay inside their row. */
.buffer-pane > * {
  min-width: 0;
  min-height: 0;
}

/* Which pane the keyboard is talking to. An inset ring rather than a border:
   a border would take a pixel out of the grid track and shift the pane's
   contents by one pixel as focus moves between panes. Accent-colored on the
   topic bar edge only — a full outline around a pane that already has 1px
   separators on every side reads as a box-in-a-box. */
.buffer-pane.focused .topic-divider {
  background: var(--accent);
}
/* The unfocused panes recede rather than the focused one shouting: dimming the
   header text of what you're NOT working in is a quieter signal than painting
   the one you are, and it survives any theme because it's an opacity, not a
   color. */
.buffer-pane.split:not(.focused) .topic {
  opacity: 0.65;
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
  white-space: nowrap;
  min-width: 0;
}
/* Hover/click affordances belong to the clickable channel-topic BUTTON only;
   the DM identity renders as a static span sharing the layout styles above. */
button.topic-text {
  cursor: pointer;
}
button.topic-text:hover {
  color: var(--fg);
}
button.topic-text:focus-visible {
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
/* Hairline between the buffer's own actions and the pane controls: close and
   maximize act on the FRAME, not on the conversation, and without a divider
   they read as two more buffer actions. */
.pane-sep {
  width: 1px;
  align-self: stretch;
  background: var(--border);
  margin-inline: var(--space-2);
}
/* Pane controls sit quieter than the buffer's own actions until hovered —
   they're frame furniture, present in every pane, and at four panes eight
   accent-colored glyphs compete with the conversation for the eye. */
.pane-btn {
  color: var(--fg-muted);
}
</style>
