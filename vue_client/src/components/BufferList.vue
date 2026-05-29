<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="buffer-list-frame">
    <nav
      ref="scroller"
      class="buffer-list"
      :class="{ 'unread-bold': unreadBold }"
      @scroll="scheduleRecompute"
    >
      <div v-for="net in networks.networks" :key="net.id" class="net">
        <div
          class="net-head"
          :class="netHeadClasses(net.id)"
          :title="`Open ${net.name} server buffer`"
          @click="select(net.id, serverTarget(net.id))"
        >
          <span class="indicator" :class="stateClass(net.id)"></span>
          <span class="name">{{ net.name }}</span>
          <span
            v-if="serverHighlights(net.id) > 0 && showHighlightBadge"
            class="badge highlight"
            :title="`${serverHighlights(net.id)} highlight${serverHighlights(net.id) === 1 ? '' : 's'}`"
            >●</span
          >
          <span v-if="countFor(serverUnread(net.id), serverHighlights(net.id)) > 0" class="badge">{{
            unreadLabel(countFor(serverUnread(net.id), serverHighlights(net.id)))
          }}</span>
        </div>

        <!-- Touch delay (200ms, touch-only) so a quick swipe over the pinned
             section scrolls the channel list instead of starting a reorder.
             Press-and-hold still initiates drag — the iOS/Discord/Slack
             reorder convention. touchStartThreshold cancels the pending drag
             if the finger moves more than 5px during the delay, so scroll
             intent is recognised early. Desktop mouse drag stays instant. -->
        <draggable
          v-if="(pinnedBufsByNet[net.id] || []).length"
          :list="pinnedBufsByNet[net.id]"
          item-key="target"
          tag="ul"
          class="channels pinned"
          :animation="120"
          ghost-class="drag-ghost"
          :delay="200"
          :delay-on-touch-only="true"
          :touch-start-threshold="5"
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
                ><i class="fa-solid fa-pencil"></i
              ></span>
              <span
                v-if="buf.highlighted > 0 && showHighlightBadge"
                class="badge highlight"
                :title="`${buf.highlighted} highlight${buf.highlighted === 1 ? '' : 's'}`"
                >●</span
              >
              <span v-if="countFor(buf.unread, buf.highlighted) > 0" class="badge">{{
                unreadLabel(countFor(buf.unread, buf.highlighted))
              }}</span>
              <button
                v-if="!isServerBuffer(buf) && !hasUnreadIndicator(buf)"
                type="button"
                class="row-actions"
                title="Actions"
                aria-label="Buffer actions"
                @click.stop="onRowActionsClick($event, buf)"
                @contextmenu.stop.prevent
              >
                <i class="fa-solid fa-ellipsis-vertical"></i>
              </button>
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
              ><i class="fa-solid fa-pencil"></i
            ></span>
            <span
              v-if="buf.highlighted > 0 && showHighlightBadge"
              class="badge highlight"
              :title="`${buf.highlighted} highlight${buf.highlighted === 1 ? '' : 's'}`"
              >●</span
            >
            <span v-if="countFor(buf.unread, buf.highlighted) > 0" class="badge">{{
              unreadLabel(countFor(buf.unread, buf.highlighted))
            }}</span>
            <button
              v-if="!isServerBuffer(buf) && !hasUnreadIndicator(buf)"
              type="button"
              class="row-actions"
              title="Actions"
              aria-label="Buffer actions"
              @click.stop="onRowActionsClick($event, buf)"
              @contextmenu.stop.prevent
            >
              <i class="fa-solid fa-ellipsis-vertical"></i>
            </button>
          </li>
        </ul>
      </div>
      <p v-if="!networks.networks.length" class="empty">
        No networks yet — add one with the + button.
      </p>
    </nav>
    <button
      v-if="unreadAbove"
      type="button"
      class="unread-edge top"
      :class="{ 'is-highlight': highlightAbove }"
      title="Unread buffers above — click to scroll into view"
      aria-label="Scroll to unread buffers above"
      @click="scrollToUnread('up')"
    ></button>
    <button
      v-if="unreadBelow"
      type="button"
      class="unread-edge bottom"
      :class="{ 'is-highlight': highlightBelow }"
      title="Unread buffers below — click to scroll into view"
      aria-label="Scroll to unread buffers below"
      @click="scrollToUnread('down')"
    ></button>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  reactive,
  ref,
  watch,
} from 'vue';
import draggable from 'vuedraggable';
import { useNetworksStore, type PeerPresenceEntry } from '../stores/networks.js';
import { useBuffersStore, type Buffer } from '../stores/buffers.js';
import { useDraftStore } from '../stores/drafts.js';
import { usePinsStore } from '../stores/pins.js';
import { useSettingsStore } from '../stores/settings.js';
import { useBufferActions } from '../composables/useBufferActions.js';
import {
  isPeerOffline as derivePeerOffline,
  isPeerAway as derivePeerAway,
} from '../utils/peerPresence.js';

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
function countFor(unread: number, highlights: number): number {
  if (unreadDisplay.value === 'full') return unread;
  if (unreadDisplay.value === 'highlights') return highlights;
  return 0;
}

// Hover-revealed kebab lives in the same right-edge slot as the unread/
// highlight badges. When the row has unread state, the badge wins — the
// kebab stays hidden so it doesn't overlay the indicator the user is
// scanning for. Right-click on the row still opens the same action menu.
function hasUnreadIndicator(buf: Buffer): boolean {
  return (
    (buf.highlighted > 0 && showHighlightBadge.value) || countFor(buf.unread, buf.highlighted) > 0
  );
}

// Per-network local mirror of the pinned buffer list, kept as concrete buffer
// objects so vuedraggable can render them directly. We mutate the inner arrays
// (splice) rather than replace them so vuedraggable's bound array reference
// stays stable across syncs.
const pinnedBufsByNet = reactive<Record<number, Buffer[]>>({});
const dragging = ref(false);

function isServerBuffer(buf: Buffer): boolean {
  return buf.target.startsWith(':server:');
}

function isDmBuffer(buf: Buffer): boolean {
  return !isServerBuffer(buf) && !buf.target.startsWith('#');
}

function serverTarget(networkId: number): string {
  return `:server:${networkId}`;
}

function serverBuf(networkId: number): Buffer | null {
  return buffers.byKey(`${networkId}::${serverTarget(networkId)}`);
}

function serverUnread(networkId: number): number {
  return serverBuf(networkId)?.unread || 0;
}

function serverHighlights(networkId: number): number {
  return serverBuf(networkId)?.highlighted || 0;
}

// Keep the unread chip narrow — a four-figure count would stretch the row
// and isn't more actionable than "a lot".
function unreadLabel(count: number): string {
  return count > 999 ? '>999' : String(count);
}

function hasDraft(buf: Buffer): boolean {
  return drafts.hasDraft(buf.networkId, buf.target);
}

function labelFor(buf: Buffer): string {
  return buf.target;
}

function bufferOrder(buf: Buffer): number {
  if (buf.target.startsWith('#')) return 0;
  return 1;
}

// Strip leading hashes so ##anime sorts next to #anime, not before #aardvark
// (raw localeCompare would weight every leading '#' as sort-significant).
function sortKey(target: string): string {
  return target.replace(/^#+/, '').toLowerCase();
}

function unpinnedBufs(networkId: number): Buffer[] {
  const pinnedSet = new Set(pins.forNetwork(networkId));
  return buffers
    .forNetwork(networkId)
    .filter((b) => !isServerBuffer(b) && !pinnedSet.has(b.target))
    .toSorted((a, b) => {
      const oa = bufferOrder(a);
      const ob = bufferOrder(b);
      if (oa !== ob) return oa - ob;
      return sortKey(a.target).localeCompare(sortKey(b.target));
    });
}

// Mirror pins.byNetwork into a local reactive map of concrete buffer objects.
// Pinned targets without a matching open buffer (e.g. closed/parted, pin row
// persists on the server) are filtered out so we don't render empty rows.
function syncPinned(): void {
  if (dragging.value) return;
  for (const net of networks.networks) {
    const targets = pins.forNetwork(net.id);
    const bufByTarget = new Map<string, Buffer>();
    for (const b of buffers.forNetwork(net.id)) bufByTarget.set(b.target, b);
    const list = targets.map((t) => bufByTarget.get(t)).filter((b): b is Buffer => !!b);
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
    if (!live.has(Number(k))) delete pinnedBufsByNet[Number(k)];
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

function onPinDragEnd(networkId: number): void {
  dragging.value = false;
  const list = pinnedBufsByNet[networkId] || [];
  pins.reorder(
    networkId,
    list.map((b) => b.target),
  );
}

function onBufferContextMenu(e: MouseEvent, buf: Buffer): void {
  bufferActions.openMenuFor(buf, e.clientX, e.clientY);
}

// Hover three-dots affordance — opens the same menu anchored to the button.
function onRowActionsClick(e: MouseEvent, buf: Buffer): void {
  bufferActions.openMenuFromButton(buf, e.currentTarget as Element);
}

function rowClasses(buf: Buffer, networkId: number): Record<string, boolean> {
  return {
    active: isActive(networkId, buf.target),
    unread: buf.unread > 0,
    highlighted: buf.highlighted > 0,
    'not-joined': isUnjoined(buf, networkId),
    'peer-away': isPeerAway(buf),
    'peer-offline': isPeerOffline(buf),
  };
}

function select(networkId: number, target: string): void {
  buffers.activate(networkId, target);
}

function isActive(networkId: number, target: string): boolean {
  return networks.activeKey === `${networkId}::${target}`;
}

function stateClass(networkId: number): string {
  const s = networks.states[networkId]?.state;
  if (s === 'connected') return 'good';
  if (s === 'connecting' || s === 'reconnecting') return 'warn';
  return 'bad';
}

// Channels render dimmed when we're either explicitly parted (joined=false)
// or when the network itself isn't connected — in both cases the buffer is
// just a history view, not a live channel. DMs and server buffers have no
// "joined" concept and are never dimmed by this rule.
function isUnjoined(buf: Buffer, networkId: number): boolean {
  if (!buf.target.startsWith('#')) return false;
  if (buf.joined === false) return true;
  return networks.states[networkId]?.state !== 'connected';
}

function peerOf(buf: Buffer): PeerPresenceEntry | null {
  return networks.states[buf.networkId]?.peerPresence?.[buf.target.toLowerCase()] ?? null;
}
function isPeerOffline(buf: Buffer): boolean {
  return isDmBuffer(buf) && derivePeerOffline(peerOf(buf));
}
function isPeerAway(buf: Buffer): boolean {
  return isDmBuffer(buf) && derivePeerAway(peerOf(buf));
}
function dmTitle(buf: Buffer): string | undefined {
  if (!isDmBuffer(buf)) return undefined;
  if (isPeerOffline(buf)) return `${buf.target} is offline`;
  if (isPeerAway(buf)) return `${buf.target} is away`;
  return undefined;
}

// The network header doubles as the server buffer's row, so it carries the
// same unread/highlighted hooks the channel rows do — both the styling and
// the out-of-view detection below treat it as just another unread row.
function netHeadClasses(networkId: number): Record<string, boolean> {
  return {
    active: isActive(networkId, serverTarget(networkId)),
    unread: serverUnread(networkId) > 0,
    highlighted: serverHighlights(networkId) > 0,
  };
}

// ── Out-of-view unread indicator ───────────────────────────────────────────
// When unread buffers are scrolled past the top or bottom edge of the list, a
// thin accent bar appears at that edge (IRCCloud-style). Detection walks the
// rendered unread rows and compares each against the scroller's viewport box.
const scroller = ref<HTMLElement | null>(null);
const unreadAbove = ref(false);
const unreadBelow = ref(false);
const highlightAbove = ref(false);
const highlightBelow = ref(false);

// A row counts as out of view only when it's *fully* past an edge — a
// partially visible unread row is considered seen and raises no bar. The bar
// takes the highlight colour when any of the off-screen unread rows that way
// is a highlight, mirroring the row label colours.
function recomputeEdges(): void {
  const sc = scroller.value;
  if (!sc) {
    unreadAbove.value = unreadBelow.value = false;
    highlightAbove.value = highlightBelow.value = false;
    return;
  }
  const view = sc.getBoundingClientRect();
  let above = false;
  let below = false;
  let hlAbove = false;
  let hlBelow = false;
  for (const el of sc.querySelectorAll('.unread, .highlighted')) {
    const r = el.getBoundingClientRect();
    const isHighlight = el.classList.contains('highlighted');
    if (r.bottom <= view.top + 1) {
      above = true;
      hlAbove = hlAbove || isHighlight;
    } else if (r.top >= view.bottom - 1) {
      below = true;
      hlBelow = hlBelow || isHighlight;
    }
  }
  unreadAbove.value = above;
  unreadBelow.value = below;
  highlightAbove.value = hlAbove;
  highlightBelow.value = hlBelow;
}

// Coalesce the scroll / resize / re-render triggers into one measure per
// frame — getBoundingClientRect forces layout, so we don't want it per event.
let rafId = 0;
function scheduleRecompute(): void {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    recomputeEdges();
  });
}

// Bring the unread row nearest the clicked edge into view; repeated clicks
// then walk through the rest.
function scrollToUnread(dir: 'up' | 'down'): void {
  const sc = scroller.value;
  if (!sc) return;
  const view = sc.getBoundingClientRect();
  let target: Element | null = null;
  let best = dir === 'up' ? -Infinity : Infinity;
  for (const el of sc.querySelectorAll('.unread, .highlighted')) {
    const r = el.getBoundingClientRect();
    if (dir === 'up' && r.bottom <= view.top + 1) {
      if (r.bottom > best) {
        best = r.bottom;
        target = el;
      }
    } else if (dir === 'down' && r.top >= view.bottom - 1) {
      if (r.top < best) {
        best = r.top;
        target = el;
      }
    }
  }
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// Keep the selected row visible when the active buffer changes from outside
// the list — Alt+arrow, quick switcher, jump-to-message, etc. On a small
// display the new selection can otherwise sit off-screen. `block: 'nearest'`
// no-ops when the row is already visible, so a same-row reactivation or a
// click on an already-visible row doesn't pointlessly scroll.
async function ensureActiveVisible(): Promise<void> {
  await nextTick();
  const sc = scroller.value;
  if (!sc) return;
  const el = sc.querySelector<HTMLElement>('.net-head.active, .channels li.active');
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
watch(
  () => networks.activeKey,
  () => {
    // Wrap the async call so the watcher gets a sync callback — Vue doesn't
    // await the returned Promise either way, and explicit catch keeps any
    // future rejection from becoming an unhandled rejection.
    ensureActiveVisible().catch((err) => console.error('[BufferList] scroll active failed', err));
  },
);

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  // Cold-mount path: when the sidebar re-expands or the page first loads,
  // bring the previously-selected buffer into view without animation.
  void (async () => {
    await nextTick();
    const sc = scroller.value;
    if (!sc) return;
    const el = sc.querySelector<HTMLElement>('.net-head.active, .channels li.active');
    el?.scrollIntoView({ block: 'nearest' });
  })();
  // Guard like MessageList does: ResizeObserver is missing in some SSR/test
  // contexts. The onUpdated remeasure still covers content changes there.
  if (typeof ResizeObserver !== 'undefined' && scroller.value) {
    resizeObserver = new ResizeObserver(scheduleRecompute);
    resizeObserver.observe(scroller.value);
  }
  recomputeEdges();
});
// The list re-renders on every unread-count change — that's the cue to
// remeasure which unread rows are now off-screen. recomputeEdges only writes
// refs, and same-value writes don't re-render, so this can't loop.
onUpdated(scheduleRecompute);
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (rafId) cancelAnimationFrame(rafId);
});
</script>

<style scoped>
/* The frame is the component root: a non-scrolling, positioned box that holds
   the scrollable nav plus the absolutely-pinned out-of-view unread bars. It
   takes the flex slot the .buffer-list used to occupy in the sidebar. */
.buffer-list-frame {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}
.buffer-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-2) 0;
}
/* IRCCloud-style affordance: a thin accent bar pinned to the top or bottom
   edge of the list when unread buffers are scrolled out of view that way.
   Clicking it scrolls the nearest off-screen unread buffer into view.
   The visible bar is drawn by a 3px ::before stripe — the surrounding
   button is taller (and transparent) purely to give the affordance an
   easy-to-click/tap hit area without making the visual any thicker. */
.unread-edge {
  position: absolute;
  left: 0;
  right: 0;
  height: 12px;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  z-index: var(--z-raised);
}
/* The global `button:hover` paints `--bg-soft`, which would show as a 12px
   strip over the buffer list. Keep the button transparent — the ::before
   stripe is the only visual. */
.unread-edge:hover {
  background: transparent;
}
.unread-edge.top {
  top: 0;
}
.unread-edge.bottom {
  bottom: 0;
}
.unread-edge::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--buffer-unread);
}
.unread-edge.top::before {
  top: 0;
}
.unread-edge.bottom::before {
  bottom: 0;
}
.unread-edge.is-highlight::before {
  background: var(--buffer-highlight);
}
/* Grow the visible stripe a touch on hover/focus so the affordance reads as
   interactive — the button's own hit area is already comfortably large. */
.unread-edge:hover::before {
  height: 5px;
}
.unread-edge:focus-visible::before {
  height: 5px;
  outline: 1px solid var(--fg);
  outline-offset: -1px;
}
.net {
  padding: var(--space-2) 0 var(--space-3);
}
.net + .net {
  border-top: 1px solid var(--border);
  margin-top: var(--space-2);
}
.net-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-5);
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  border-left: 2px solid transparent;
}
/* Gate :hover behind (hover: hover) so iPad-in-desktop-layout (width > 768px,
   touch-only) doesn't get the iOS sticky-hover two-tap: with bare :hover the
   first tap is consumed as a hover preview, only the second activates. See
   issue #11. */
@media (hover: hover) {
  .net-head:hover {
    background: var(--bg-soft);
  }
}
.net-head.active {
  background: var(--bg-soft);
  border-left-color: var(--accent);
}
.name {
  flex: 1;
  color: var(--fg);
}
.indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--bad);
  flex: 0 0 auto;
}
.indicator.good {
  background: var(--good);
}
.indicator.warn {
  background: var(--warn);
}
.indicator.bad {
  background: var(--bad);
}

.channels {
  list-style: none;
  margin: 0;
  padding: 0;
}
.channels li {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-5) var(--space-1) var(--space-9);
  cursor: pointer;
  border-left: 2px solid transparent;
  position: relative;
  user-select: none;
}
/* Tree guide: top-half vertical + horizontal arm. The arm meets the row's
   vertical centerline and stops short of the label, producing ├─ / └─. */
.channels li::before {
  content: '';
  position: absolute;
  left: var(--space-6);
  top: 0;
  height: 50%;
  width: 8px;
  border-left: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  pointer-events: none;
}
/* Bottom-half vertical: only when there's a sibling below — turns └─ into ├─. */
.channels li:not(:last-child)::after {
  content: '';
  position: absolute;
  left: var(--space-6);
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
  content: '';
  position: absolute;
  left: var(--space-6);
  top: 50%;
  bottom: 0;
  width: 0;
  border-left: 1px solid var(--border);
  pointer-events: none;
}
@media (hover: hover) {
  .channels li:hover {
    background: var(--bg-soft);
  }
}
.channels li.active {
  background: var(--bg-soft);
  border-left-color: var(--accent);
}
.channels li.unread .label {
  color: var(--buffer-unread);
}
.channels li.highlighted .label {
  color: var(--buffer-highlight);
}
/* Bold is opt-in via look.buffer_list.unread_bold — applies to plain unread
   and highlighted rows alike (highlighted implies unread on the data side). */
.buffer-list.unread-bold .channels li.unread .label,
.buffer-list.unread-bold .channels li.highlighted .label {
  font-weight: 600;
}
/* Parted/disconnected channels render as a history view rather than a live
   buffer. Apply opacity to the whole row so badges, labels, and tree guides
   all dim together; unread/highlight colors still come through. */
.channels li.not-joined {
  opacity: 0.5;
}
/* DM peer state. Away nicks render in the muted gray used by away members in
   the channel nicklist; offline nicks also pick up the asterisk marker
   (`.peer-mark`). */
.channels li.peer-away .label,
.channels li.peer-offline .label {
  color: var(--fg-muted);
}
.peer-mark {
  color: var(--fg-muted);
  font-weight: 600;
  margin-left: var(--space-1);
}
.label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  color: var(--accent);
  padding: 0 var(--space-1);
}
.badge.highlight {
  color: var(--buffer-highlight);
}
/* Draft pencil is a passive "you've got unsent text here" cue, not an alert —
   render it in the muted text color so it doesn't compete with unread/
   highlight badges for attention. */
.badge.draft {
  color: var(--fg-muted);
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
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
  padding: 0 var(--space-2);
  background: var(--bg-soft);
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  line-height: 1;
  opacity: 0;
  transition: opacity 80ms linear;
}
/* Reveal the row-actions button on hover (desktop) or keyboard focus (a11y).
   No touch path here on purpose — long-press fires `contextmenu` on the row,
   which already opens the same buffer-actions menu, so iPad users reach
   identical functionality without paying the sticky-hover two-tap tax. */
@media (hover: hover) {
  .channels li:hover .row-actions {
    opacity: 1;
  }
  .channels .row-actions:hover {
    color: var(--fg);
  }
}
.channels .row-actions:focus-visible {
  opacity: 1;
}
@media (max-width: 768px) {
  .channels .row-actions {
    display: none;
  }
}

.empty {
  padding: var(--space-6);
  color: var(--fg-muted);
  font-style: italic;
}

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
  content: '';
  position: absolute;
  left: var(--space-6);
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--border);
}
.pin-divider::after {
  content: '';
  position: absolute;
  left: var(--space-6);
  right: var(--space-6);
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
