<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <nav class="buffer-list" :class="{ 'unread-bold': unreadBold }">
    <div v-for="net in networks.networks" :key="net.id" class="net">
      <div
        class="net-head"
        :class="{ active: isActive(net.id, serverTarget(net.id)) }"
        :title="`Open ${net.name} server buffer`"
        @click="select(net.id, serverTarget(net.id))"
      >
        <span class="indicator" :class="stateClass(net.id)"></span>
        <span class="name">{{ net.name }}</span>
        <span
          v-if="serverHighlights(net.id) > 0 && showHighlightBadge"
          class="badge highlight"
          :title="`${serverHighlights(net.id)} highlight${serverHighlights(net.id) === 1 ? '' : 's'}`"
        >●</span>
        <span
          v-if="countFor(serverUnread(net.id), serverHighlights(net.id)) > 0"
          class="badge"
        >{{ unreadLabel(countFor(serverUnread(net.id), serverHighlights(net.id))) }}</span>
      </div>

      <draggable
        v-if="(pinnedBufsByNet[net.id] || []).length"
        :list="pinnedBufsByNet[net.id]"
        item-key="target"
        tag="ul"
        class="channels pinned"
        :animation="120"
        ghost-class="drag-ghost"
        @start="dragging = true"
        @end="onPinDragEnd(net.id)"
      >
        <template #item="{ element: buf }">
          <li
            :class="rowClasses(buf, net.id)"
            :title="dmTitle(buf)"
            @click="select(net.id, buf.target)"
            @contextmenu.prevent="onBufferContextMenu($event, buf)"
          >
            <span class="label">{{ labelFor(buf) }}</span>
            <span v-if="isPeerOffline(buf)" class="peer-mark" aria-hidden="true">*</span>
            <span
              v-if="hasDraft(buf)"
              class="badge draft"
              title="unsent draft"
              aria-label="unsent draft"
            ><i class="fa-solid fa-pencil"></i></span>
            <span
              v-if="buf.highlighted > 0 && showHighlightBadge"
              class="badge highlight"
              :title="`${buf.highlighted} highlight${buf.highlighted === 1 ? '' : 's'}`"
            >●</span>
            <span
              v-if="countFor(buf.unread, buf.highlighted) > 0"
              class="badge"
            >{{ unreadLabel(countFor(buf.unread, buf.highlighted)) }}</span>
            <button
              v-if="!isServerBuffer(buf)"
              type="button"
              class="row-actions"
              title="Actions"
              aria-label="Buffer actions"
              @click.stop="onRowActionsClick($event, buf)"
              @contextmenu.stop.prevent
            ><i class="fa-solid fa-ellipsis-vertical"></i></button>
          </li>
        </template>
      </draggable>

      <div
        v-if="(pinnedBufsByNet[net.id] || []).length && unpinnedBufs(net.id).length"
        class="pin-divider"
        aria-hidden="true"
      ></div>

      <ul v-if="unpinnedBufs(net.id).length" class="channels">
        <li
          v-for="buf in unpinnedBufs(net.id)"
          :key="buf.target"
          :class="rowClasses(buf, net.id)"
          :title="dmTitle(buf)"
          @click="select(net.id, buf.target)"
          @contextmenu.prevent="onBufferContextMenu($event, buf)"
        >
          <span class="label">{{ labelFor(buf) }}</span>
          <span v-if="isPeerOffline(buf)" class="peer-mark" aria-hidden="true">*</span>
          <span
            v-if="hasDraft(buf)"
            class="badge draft"
            title="unsent draft"
            aria-label="unsent draft"
          ><i class="fa-solid fa-pencil"></i></span>
          <span
            v-if="buf.highlighted > 0 && showHighlightBadge"
            class="badge highlight"
            :title="`${buf.highlighted} highlight${buf.highlighted === 1 ? '' : 's'}`"
          >●</span>
          <span
            v-if="countFor(buf.unread, buf.highlighted) > 0"
            class="badge"
          >{{ unreadLabel(countFor(buf.unread, buf.highlighted)) }}</span>
          <button
            v-if="!isServerBuffer(buf)"
            type="button"
            class="row-actions"
            title="Actions"
            aria-label="Buffer actions"
            @click.stop="onRowActionsClick($event, buf)"
            @contextmenu.stop.prevent
          ><i class="fa-solid fa-ellipsis-vertical"></i></button>
        </li>
      </ul>
    </div>
    <p v-if="!networks.networks.length" class="empty">No networks yet — add one with the + button.</p>
  </nav>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import draggable from 'vuedraggable';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useDraftStore } from '../stores/drafts.js';
import { usePinsStore } from '../stores/pins.js';
import { useSettingsStore } from '../stores/settings.js';
import { useBufferActions } from '../composables/useBufferActions.js';
import { isPeerOffline as derivePeerOffline, isPeerAway as derivePeerAway } from '../utils/peerPresence.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const drafts = useDraftStore();
const pins = usePinsStore();
const settings = useSettingsStore();
const bufferActions = useBufferActions();

// Buffer-list display settings — feed both the row CSS (bold gate) and the
// badge logic. `unread_display` picks between four modes:
//   full       → highlight ● + total unread count (default, current behavior)
//   highlights → highlight ● + highlight-only count (hides noisy totals)
//   badge      → highlight ● only, no numbers
//   off        → nothing — row color/weight is the only cue
const unreadBold = computed(() => !!settings.effective('look.buffer_list.unread_bold'));
const unreadDisplay = computed(() => String(settings.effective('look.buffer_list.unread_display')));
const showHighlightBadge = computed(() => unreadDisplay.value !== 'off');
function countFor(unread, highlights) {
  if (unreadDisplay.value === 'full') return unread;
  if (unreadDisplay.value === 'highlights') return highlights;
  return 0;
}

// Per-network local mirror of the pinned buffer list, kept as concrete buffer
// objects so vuedraggable can render them directly. We mutate the inner arrays
// (splice) rather than replace them so vuedraggable's bound array reference
// stays stable across syncs.
const pinnedBufsByNet = reactive({});
const dragging = ref(false);

function isServerBuffer(buf) {
  return buf.target.startsWith(':server:');
}

function isDmBuffer(buf) {
  return !isServerBuffer(buf) && !buf.target.startsWith('#');
}

function serverTarget(networkId) {
  return `:server:${networkId}`;
}

function serverBuf(networkId) {
  return buffers.byKey(`${networkId}::${serverTarget(networkId)}`);
}

function serverUnread(networkId) {
  return serverBuf(networkId)?.unread || 0;
}

function serverHighlights(networkId) {
  return serverBuf(networkId)?.highlighted || 0;
}

// Keep the unread chip narrow — a four-figure count would stretch the row
// and isn't more actionable than "a lot".
function unreadLabel(count) {
  return count > 999 ? '>999' : String(count);
}

function hasDraft(buf) {
  return drafts.hasDraft(buf.networkId, buf.target);
}

function labelFor(buf) {
  return buf.target;
}

function bufferOrder(buf) {
  if (buf.target.startsWith('#')) return 0;
  return 1;
}

// Strip leading hashes so ##anime sorts next to #anime, not before #aardvark
// (raw localeCompare would weight every leading '#' as sort-significant).
function sortKey(target) {
  return target.replace(/^#+/, '').toLowerCase();
}

function unpinnedBufs(networkId) {
  const pinnedSet = new Set(pins.forNetwork(networkId));
  return buffers
    .forNetwork(networkId)
    .filter((b) => !isServerBuffer(b) && !pinnedSet.has(b.target))
    .sort((a, b) => {
      const oa = bufferOrder(a);
      const ob = bufferOrder(b);
      if (oa !== ob) return oa - ob;
      return sortKey(a.target).localeCompare(sortKey(b.target));
    });
}

// Mirror pins.byNetwork into a local reactive map of concrete buffer objects.
// Pinned targets without a matching open buffer (e.g. closed/parted, pin row
// persists on the server) are filtered out so we don't render empty rows.
function syncPinned() {
  if (dragging.value) return;
  for (const net of networks.networks) {
    const targets = pins.forNetwork(net.id);
    const bufByTarget = new Map();
    for (const b of buffers.forNetwork(net.id)) bufByTarget.set(b.target, b);
    const list = targets.map((t) => bufByTarget.get(t)).filter(Boolean);
    if (!pinnedBufsByNet[net.id]) {
      pinnedBufsByNet[net.id] = list;
    } else {
      const arr = pinnedBufsByNet[net.id];
      arr.splice(0, arr.length, ...list);
    }
  }
  // Drop entries for networks that no longer exist.
  const live = new Set(networks.networks.map((n) => n.id));
  for (const k of Object.keys(pinnedBufsByNet)) {
    if (!live.has(Number(k))) delete pinnedBufsByNet[k];
  }
}

// Only re-sync when something structurally relevant changes — pin order, the
// set of networks, or the set of buffer keys. Per-buffer state churn (unread
// counts, member list, messages) doesn't affect which buffers belong in the
// pinned list and shouldn't re-walk this whole map on every keystroke.
watch(
  () => [pins.byNetwork, networks.networks.map((n) => n.id), Object.keys(buffers.buffers)],
  syncPinned,
  { deep: true, immediate: true },
);

function onPinDragEnd(networkId) {
  dragging.value = false;
  const list = pinnedBufsByNet[networkId] || [];
  pins.reorder(networkId, list.map((b) => b.target));
}

function onBufferContextMenu(e, buf) {
  bufferActions.openMenuFor(buf, e.clientX, e.clientY);
}

// Hover three-dots affordance — opens the same menu anchored to the button.
function onRowActionsClick(e, buf) {
  bufferActions.openMenuFromButton(buf, e.currentTarget);
}

function rowClasses(buf, networkId) {
  return {
    active: isActive(networkId, buf.target),
    unread: buf.unread > 0,
    highlighted: buf.highlighted > 0,
    'not-joined': isUnjoined(buf, networkId),
    'peer-away': isPeerAway(buf),
    'peer-offline': isPeerOffline(buf),
  };
}

function select(networkId, target) {
  buffers.activate(networkId, target);
}

function isActive(networkId, target) {
  return networks.activeKey === `${networkId}::${target}`;
}

function stateClass(networkId) {
  const s = networks.states[networkId]?.state;
  if (s === 'connected') return 'good';
  if (s === 'connecting' || s === 'reconnecting') return 'warn';
  return 'bad';
}

// Channels render dimmed when we're either explicitly parted (joined=false)
// or when the network itself isn't connected — in both cases the buffer is
// just a history view, not a live channel. DMs and server buffers have no
// "joined" concept and are never dimmed by this rule.
function isUnjoined(buf, networkId) {
  if (!buf.target.startsWith('#')) return false;
  if (buf.joined === false) return true;
  return networks.states[networkId]?.state !== 'connected';
}

function peerOf(buf) {
  return networks.states[buf.networkId]?.peerPresence?.[buf.target.toLowerCase()] || null;
}
function isPeerOffline(buf) {
  return isDmBuffer(buf) && derivePeerOffline(peerOf(buf));
}
function isPeerAway(buf) {
  return isDmBuffer(buf) && derivePeerAway(peerOf(buf));
}
function dmTitle(buf) {
  if (!isDmBuffer(buf)) return null;
  if (isPeerOffline(buf)) return `${buf.target} is offline`;
  if (isPeerAway(buf)) return `${buf.target} is away`;
  return null;
}
</script>

<style scoped>
.buffer-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0;
}
.net { padding: 4px 0 6px; }
.net + .net { border-top: 1px solid var(--border); margin-top: 4px; }
.net-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.net-head:hover { background: var(--bg-soft); }
.net-head.active {
  background: var(--bg-soft);
  border-left-color: var(--accent);
}
.name { flex: 1; color: var(--fg); }
.indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--bad);
  flex: 0 0 auto;
}
.indicator.good { background: var(--good); }
.indicator.warn { background: var(--warn); }
.indicator.bad { background: var(--bad); }

.channels { list-style: none; margin: 0; padding: 0; }
.channels li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 24px;
  cursor: pointer;
  border-left: 2px solid transparent;
  position: relative;
  user-select: none;
}
/* Tree guide: top-half vertical + horizontal arm. The arm meets the row's
   vertical centerline and stops short of the label, producing ├─ / └─. */
.channels li::before {
  content: "";
  position: absolute;
  left: 12px;
  top: 0;
  height: 50%;
  width: 8px;
  border-left: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  pointer-events: none;
}
/* Bottom-half vertical: only when there's a sibling below — turns └─ into ├─. */
.channels li:not(:last-child)::after {
  content: "";
  position: absolute;
  left: 12px;
  top: 50%;
  bottom: 0;
  width: 0;
  border-left: 1px solid var(--border);
  pointer-events: none;
}
/* When the pinned section is followed by a divider (i.e. there are unpinned
   buffers below), the last pinned row's spine must continue down through the
   divider — otherwise the └─ terminator would break the line. :has() scopes
   the override so an all-pinned network still terminates with └─ correctly. */
.channels.pinned:has(+ .pin-divider) li:last-child::after {
  content: "";
  position: absolute;
  left: 12px;
  top: 50%;
  bottom: 0;
  width: 0;
  border-left: 1px solid var(--border);
  pointer-events: none;
}
.channels li:hover { background: var(--bg-soft); }
.channels li.active {
  background: var(--bg-soft);
  border-left-color: var(--accent);
}
.channels li.unread .label { color: var(--buffer-unread); }
.channels li.highlighted .label { color: var(--buffer-highlight); }
/* Bold is opt-in via look.buffer_list.unread_bold — applies to plain unread
   and highlighted rows alike (highlighted implies unread on the data side). */
.buffer-list.unread-bold .channels li.unread .label,
.buffer-list.unread-bold .channels li.highlighted .label { font-weight: 600; }
/* Parted/disconnected channels render as a history view rather than a live
   buffer. Apply opacity to the whole row so badges, labels, and tree guides
   all dim together; unread/highlight colors still come through. */
.channels li.not-joined { opacity: 0.5; }
/* DM peer state. Away nicks render in the muted gray used by away members in
   the channel nicklist; offline nicks also pick up the asterisk marker
   (`.peer-mark`). */
.channels li.peer-away .label,
.channels li.peer-offline .label { color: var(--fg-muted); }
.peer-mark {
  color: var(--fg-muted);
  font-weight: 600;
  margin-left: 2px;
}
.label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  color: var(--accent);
  padding: 0 2px;
}
.badge.highlight { color: var(--buffer-highlight); }
/* Draft pencil is a passive "you've got unsent text here" cue, not an alert —
   render it in the muted text color so it doesn't compete with unread/
   highlight badges for attention. */
.badge.draft {
  color: var(--fg-muted);
  font-size: 0.85em;
}

/* Hover three-dots: absolute-positioned so it doesn't displace badges on
   hover-in. Briefly overlays the rightmost badges while the cursor is on
   the row — that's the moment the user is reaching for the menu, so the
   badges have already done their job. Background matches the row's hover
   shade so the overlay reads as part of the row, not floating chrome.
   Hidden on touch breakpoints; mobile uses the topic-bar cog (channels/
   DMs) or single-tap (members) instead. */
.channels .row-actions {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  padding: 0 4px;
  background: var(--bg-soft);
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  line-height: 1;
  opacity: 0;
  transition: opacity 80ms linear;
}
.channels li:hover .row-actions,
.channels .row-actions:focus-visible { opacity: 1; }
.channels .row-actions:hover { color: var(--fg); }
@media (max-width: 768px) {
  .channels .row-actions { display: none; }
}

.empty { padding: 12px; color: var(--fg-muted); font-style: italic; }

/* Separator between the pinned section and the auto-sorted section. The
   vertical tree spine continues through the divider (so pinned and unpinned
   read as one connected tree); a short dashed horizontal arm marks the
   section boundary — like a phantom row that says "section break". */
.pin-divider {
  position: relative;
  height: 10px;
  pointer-events: none;
  /* Channel rows carry `border-left: 2px solid transparent` (reserved for the
     active-row accent), which shifts their content box 2px right. Mirror that
     here so the divider's left:12px spine lines up with the channel rows'. */
  border-left: 2px solid transparent;
}
.pin-divider::before {
  content: "";
  position: absolute;
  left: 12px;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--border);
}
.pin-divider::after {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  top: 50%;
  border-top: 1px solid var(--border);
}
/* The placeholder vuedraggable inserts during a drag — keep it visually
   subtle so it doesn't fight with the row hover state. */
.drag-ghost {
  opacity: 0.4;
  background: var(--bg-soft);
}
</style>
