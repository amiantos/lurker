<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <div ref="scroller" class="message-list" @scroll="onScroll" @wheel="onWheel">
    <!-- No "loading older…" notice. It would appear/disappear above the
         user's view during a history fetch, shifting scrollTop and either
         throwing off the prepend anchor math or (with browser anchoring)
         leaving scrollTop near the top so maybeRequestHistory cascades. -->
    <div v-if="!buffer?.hasMore && messages.length" class="notice">— start of history —</div>
    <p v-if="!messages.length" class="notice empty">No messages yet.</p>
    <template v-for="row in renderRows" :key="row.key">
    <div v-if="row.divider === 'unread'" class="notice unread-divider">— unread —</div>
    <div v-else-if="row.divider === 'away'" class="notice presence-divider">
      — away<template v-if="row.awayMessage">: {{ row.awayMessage }}</template> —
    </div>
    <div v-else-if="row.divider === 'back'" class="notice presence-divider">
      — back (gone {{ formatDuration(row.awayAt, row.backAt) }}) —
    </div>
    <div v-else-if="row.divider === 'date'" class="notice date-divider">{{ row.dateStr }}</div>
    <div
      v-else-if="row.consolidation"
      class="line"
      :data-cons-first-id="row.firstId ?? null"
      :data-cons-last-id="row.lastId ?? null"
    >
      <span class="time">{{ time(row.time) }}</span>
      <span class="prefix p-cons">--</span>
      <span class="body meta-body">
        <template v-for="(g, gi) in row.groups" :key="gi"
          ><template v-if="gi > 0">; </template
          ><template v-for="(item, ii) in g.visible" :key="ii"
            ><template v-if="ii > 0">{{ ii === g.visible.length - 1 && g.hidden === 0 ? ' and ' : ', ' }}</template
            ><template v-if="g.kind === 'renamed'"
              ><NickRef :nick="item.from" /> → <NickRef :nick="item.to" /></template
            ><template v-else><NickRef :nick="item.nick" /></template
          ></template
          ><template v-if="g.hidden > 0">, and {{ g.hidden }} {{ g.hidden === 1 ? 'other' : 'others' }}</template
          ><template v-if="g.kind === 'joined'"> joined</template
          ><template v-else-if="g.kind === 'left'"> left</template
          ><template v-else-if="g.kind === 'reconnected'"> reconnected</template
          ><template v-else-if="g.kind === 'joinedAndLeft'"> joined briefly</template
        ></template>
      </span>
    </div>
    <div
      v-else
      class="line"
      :class="rowClass(row)"
      :data-msg-id="row.m.id ?? null"
    >
      <span class="time">{{ time(row.m.time) }}</span>
      <span class="prefix" :class="prefixClass(row.m)" :style="prefixStyle(row.m)">{{ prefixText(row.m) }}</span>
      <span class="body" :class="bodyClass(row.m)">
        <template v-if="hasInlineText(row.m)">
          <template v-for="(seg, j) in textSegments(row.m)" :key="j">
            <a
              v-if="seg.url"
              class="msg-link"
              :href="seg.url"
              target="_blank"
              rel="noreferrer noopener"
              :style="segStyle(seg)"
            >{{ seg.text }}</a>
            <span v-else-if="segHasStyle(seg)" :style="segStyle(seg)">{{ seg.text }}</span>
            <template v-else>{{ seg.text }}</template>
          </template>
        </template>
        <template v-else-if="row.m.type === 'join'"><NickRef :nick="row.m.nick" /> joined</template>
        <template v-else-if="row.m.type === 'part'"><NickRef :nick="row.m.nick" /> left<template v-if="row.m.text"> (<LinkedText :text="row.m.text" />)</template></template>
        <template v-else-if="row.m.type === 'quit'"><NickRef :nick="row.m.nick" /> quit<template v-if="row.m.text"> (<LinkedText :text="row.m.text" />)</template></template>
        <template v-else-if="row.m.type === 'kick'"><NickRef :nick="row.m.kicked" /> kicked by <NickRef :nick="row.m.nick" /><template v-if="row.m.text"> (<LinkedText :text="row.m.text" />)</template></template>
        <template v-else-if="row.m.type === 'nick'"><NickRef :nick="row.m.nick" /> is now <NickRef :nick="row.m.newNick" /></template>
        <template v-else-if="row.m.type === 'mode'">mode by <NickRef :nick="row.m.nick" /><template v-if="row.m.text">: <LinkedText :text="row.m.text" /></template></template>
        <template v-else-if="row.m.type === 'topic'">topic set by <NickRef :nick="row.m.nick" /><template v-if="row.m.text">: <LinkedText :text="row.m.text" /></template></template>
        <template v-else-if="row.m.type === 'motd'"><LinkedText :text="row.m.text" /></template>
        <template v-else-if="row.m.type === 'error'"><LinkedText :text="row.m.text" /></template>
      </span>
    </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { socketSend } from '../composables/useSocket.js';
import { useNickColors } from '../composables/useNickColors.js';
import {
  setStuckToBottom,
  bumpNewBelow,
  resetScrollState,
  useScrollState,
} from '../composables/useScrollState.js';
import { segmentInlineStyle, segmentHasStyle } from '../utils/nickColor.js';
import { formatTimestamp, formatDuration, formatDate } from '../utils/timestamp.js';
import { consolidateRows } from '../utils/consolidate.js';
import NickRef from './NickRef.vue';
import LinkedText from './LinkedText.vue';

const props = defineProps({
  pendingScrollId: { type: [Number, String, null], default: null },
});

const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const ignores = useIgnoresStore();
const nicks = useNickColors();

const actionItalic = computed(() => !!settings.effective('look.action.italic'));
const selfColor = computed(() => settings.effective('look.nick.self_color'));
const tsFormat = computed(() => settings.effective('look.buffer.time_format'));

const scroller = ref(null);
const stickToBottom = ref(true);
const { scrollToBottomToken } = useScrollState();

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));
const messages = computed(() => buffer.value?.messages || []);

const selfLower = computed(() => {
  const b = buffer.value;
  const sn = b ? networks.states[b.networkId]?.nick : null;
  return sn ? sn.toLowerCase() : null;
});

const nickSet = computed(() => {
  const b = buffer.value;
  const set = new Set();
  if (!b) return set;
  for (const mem of (b.members || [])) {
    const n = typeof mem === 'string' ? mem : mem.nick;
    if (n) set.add(n);
  }
  if (b.target && !b.target.startsWith('#') && !b.target.startsWith(':server:')) {
    set.add(b.target);
  }
  const sn = networks.states[b.networkId]?.nick;
  if (sn) set.add(sn);
  return set;
});

function time(iso) {
  return formatTimestamp(iso, tsFormat.value);
}

function rowClass(row) {
  return {
    [`type-${row.m.type}`]: true,
    self: row.m.self,
    alt: row.alt,
    highlight: !!row.m.matched,
  };
}

const smartFilterEnabled = computed(() => !!settings.effective('chat.smart_filter'));
const smartFilterDelayMs = computed(() => (settings.effective('chat.smart_filter_delay') || 0) * 60_000);
const smartFilterUnmaskMs = computed(() => (settings.effective('chat.smart_filter_join_unmask') || 0) * 60_000);
const smartFilterJoin = computed(() => !!settings.effective('chat.smart_filter_join'));
const smartFilterQuit = computed(() => !!settings.effective('chat.smart_filter_quit'));
const smartFilterNick = computed(() => !!settings.effective('chat.smart_filter_nick'));

const consolidateEnabled = computed(() => !!settings.effective('chat.consolidate_joins'));
const consolidateMaxNames = computed(() => settings.effective('chat.consolidate_max_names') || 5);

// User-level self-presence (driven by user_away_state on the server). Each
// network broadcasts the same payload, so reading from this buffer's network
// is equivalent to reading user state. The server pseudo-buffer doesn't get
// presence markers — it's noise-only.
const awayState = computed(() => {
  const b = buffer.value;
  if (!b || b.target.startsWith(':server:')) return null;
  return networks.states[b.networkId]?.away || null;
});

// Away/back markers stop being useful once the user has been back a while —
// in slow buffers they linger forever otherwise. We hide both 30 min after
// backAt. The minute-ticking `now` ref drives the recompute so the markers
// disappear without needing a new message to trigger renderRows.
const PRESENCE_MARKER_TTL_MS = 30 * 60 * 1000;
const now = ref(Date.now());
let nowTimer = null;

// Striped row types — chat-shaped events that receive .line.alt zebra striping.
// System events (join/part/quit/nick/mode/topic/etc.) are never striped, so
// smart-filtering them out can't desync the pattern. Authoritative parity is
// stored server-side on messages.alt per (network_id, target), computed at
// insert time across only these types.
const STRIPED_TYPES = new Set(['message', 'action', 'notice']);

// One-pass walk over messages to (a) decide which rows the smart filter
// should hide and (b) tag rows with alt-row striping.
const renderRows = computed(() => {
  const list = messages.value;
  const buf = buffer.value;
  const out = [];

  const filterOn = smartFilterEnabled.value && !!buf?.speakers;
  const ownNickLc = selfLower.value;
  const delayMs = smartFilterDelayMs.value;
  const unmaskMs = smartFilterUnmaskMs.value;
  const fJoin = smartFilterJoin.value;
  const fQuit = smartFilterQuit.value;
  const fNick = smartFilterNick.value;

  const dividerAfterId = buf?.dividerAfterId || 0;
  // Skip divider insertion entirely when there's nothing to mark (no pointer
  // yet, or pointer at 0 = brand-new buffer where every message is "first
  // time you're seeing this").
  let dividerInserted = dividerAfterId === 0;

  // Self-presence anchors. The away divider lands before the first message
  // newer than the user's last /away time; the back divider lands before the
  // first message newer than the matching /back. Anchoring by message time
  // (not id) means the markers stay correctly placed even if buffer history
  // was prepended later — message ids are insertion-order, but `time` reflects
  // when the message actually happened.
  const aw = awayState.value;
  const awaySinceMs = aw?.since ? Date.parse(aw.since) : null;
  const backAtMs = aw?.backAt ? Date.parse(aw.backAt) : null;
  const presenceExpired = backAtMs != null && (now.value - backAtMs) > PRESENCE_MARKER_TTL_MS;
  let awayInserted = !awaySinceMs || presenceExpired;
  let backInserted = !backAtMs || presenceExpired;

  // Day-change marker: WeeChat-style date line emitted before the first
  // visible message of each local calendar day (including the very first
  // message in the buffer). Tracked across the loop below.
  let lastDayKey = null;
  const pushAwayDivider = () => {
    out.push({ divider: 'away', awayMessage: aw.message, awayAt: aw.since, key: 'presence-away' });
  };
  const pushBackDivider = () => {
    out.push({ divider: 'back', awayAt: aw.since, backAt: aw.backAt, key: 'presence-back' });
  };


  const networkId = buf?.networkId;

  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const key = m.id ?? `live:${i}`;
    let hidden = false;

    // Render-time ignore filter. Self-authored events are never hidden (the
    // user always sees their own activity), and the matcher is fed both the
    // bare nick and the full nick!user@host so hostmask entries can fire.
    // Removing a mask re-runs this computed and previously-hidden rows
    // reappear without a backlog reload.
    if (!m.self && m.nick && networkId
        && ignores.isIgnored(networkId, m.nick, m.userhost)) {
      continue;
    }

    if (filterOn && m.nick && !m.self) {
      const filterable =
        (m.type === 'join' && fJoin) ||
        ((m.type === 'part' || m.type === 'quit') && fQuit) ||
        (m.type === 'nick' && fNick);
      if (filterable && m.nick.toLowerCase() !== ownNickLc) {
        const lastSpoke = buf.speakers[m.nick.toLowerCase()]?.lastTime;
        const eventTime = Date.parse(m.time) || 0;
        const recentlySpoke = lastSpoke != null
          && lastSpoke <= eventTime
          && (eventTime - lastSpoke) <= delayMs;
        const unmasked = m.type === 'join'
          && unmaskMs > 0
          && lastSpoke != null
          && lastSpoke > eventTime
          && (lastSpoke - eventTime) <= unmaskMs;
        if (!recentlySpoke && !unmasked) hidden = true;
      }
    }

    if (hidden) continue;

    // Day-change marker before the first visible row of each local day.
    const dayKey = formatDate(m.time);
    if (dayKey && dayKey !== lastDayKey) {
      out.push({ divider: 'date', dateStr: dayKey, key: `date:${dayKey}` });
      lastDayKey = dayKey;
    }

    const mTimeMs = Date.parse(m.time) || 0;
    if (!awayInserted && mTimeMs > awaySinceMs) {
      pushAwayDivider();
      awayInserted = true;
    }
    if (!backInserted && mTimeMs > backAtMs) {
      pushBackDivider();
      backInserted = true;
    }
    // Insert the unread divider before the first visible row with id past
    // the snapshot. Tolerates the exact-id row being filtered out: we just
    // pick the next surviving row past the boundary.
    if (!dividerInserted && m.id != null && m.id > dividerAfterId) {
      out.push({ divider: 'unread', key: 'unread-divider' });
      dividerInserted = true;
    }
    out.push({ m, alt: STRIPED_TYPES.has(m.type) && !!m.alt, key });
  }

  // Both presence timestamps newer than every loaded message → markers land
  // at the very end of the buffer (e.g. you went away after the most recent
  // message and nothing has arrived yet).
  if (!awayInserted) pushAwayDivider();
  if (!backInserted) pushBackDivider();

  // Final pass: merge consecutive join/part/quit/nick rows into a single
  // summary row when consolidation is enabled. Dividers break runs (we want
  // the away/back/unread markers to land between events, not get swallowed
  // by a multi-event group). Recent speakers come from the same `speakers`
  // map nick completion uses, so the cap prefers nicks the reader knows.
  if (consolidateEnabled.value) {
    const speakers = buf?.speakers ? Object.keys(buf.speakers) : [];
    return consolidateRows(out, {
      enabled: true,
      maxNames: consolidateMaxNames.value,
      recentSpeakers: speakers,
    });
  }
  return out;
});

// What goes in column 2. For chat lines this is the nick (right-aligned);
// for system events it's a tiny indicator glyph (-->, <--, --, !!).
function prefixText(m) {
  switch (m.type) {
    case 'message': return m.nick;
    case 'action':  return '*';
    case 'notice':  return `-${m.nick}-`;
    case 'join':    return '-->';
    case 'part':
    case 'quit':
    case 'kick':    return '<--';
    case 'nick':
    case 'mode':
    case 'topic':
    case 'motd':    return '--';
    case 'error':   return '!!';
    default:        return '';
  }
}

function prefixClass(m) {
  return {
    nick: m.type === 'message' || m.type === 'notice',
    'action-marker': m.type === 'action',
    italic: m.type === 'action' && actionItalic.value,
    self: m.self,
    [`p-${m.type}`]: true,
  };
}

function prefixStyle(m) {
  if (m.type === 'message' || m.type === 'notice') {
    if (m.self) return { color: selfColor.value };
    const c = nicks.color(m.nick);
    return c ? { color: c } : null;
  }
  return null;
}

function bodyClass(m) {
  return {
    italic: m.type === 'action' && actionItalic.value,
    'meta-body': m.type !== 'message' && m.type !== 'action' && m.type !== 'notice',
  };
}

// True for any line type whose body is just `m.text` and should be split
// through the nick-coloring helper. Action lines render their author's nick
// at the start of the body, with `m.text` after.
function hasInlineText(m) {
  return m.type === 'message' || m.type === 'notice' || m.type === 'action';
}

function textSegments(m) {
  if (m.type === 'action') {
    // Body is "<nick> <text>" — author's nick then the action text.
    return nicks.splitText(`${m.nick} ${m.text || ''}`, nickSet.value, selfLower.value);
  }
  return nicks.splitText(m.text || '', nickSet.value, selfLower.value);
}

function segStyle(seg) { return segmentInlineStyle(seg, selfColor.value); }
function segHasStyle(seg) { return segmentHasStyle(seg); }

function requestMoreHistory() {
  const buf = buffer.value;
  if (!buf) return;
  if (!buf.hasMore || buf.loadingHistory) return;
  if (buf.target.startsWith(':server:')) return;
  const before = buf.oldestId ?? buf.messages[0]?.id;
  // Without an anchor id, the server interprets `before` as "latest" and
  // returns the most recent rows — which can include a live row we just got
  // via fan-out, defeating prependHistory's prepend semantics and creating a
  // visible duplicate. Wait until there's at least one message to anchor on.
  if (!before) return;
  buffers.setLoadingHistory(buf.networkId, buf.target, true);
  socketSend({
    type: 'history',
    networkId: buf.networkId,
    target: buf.target,
    before,
    limit: 100,
  });
}

function maybeRequestHistory() {
  const el = scroller.value;
  if (!el) return;
  if (el.scrollTop > 80) return;
  requestMoreHistory();
}

// Fetch more history if the buffer's content doesn't fill the viewport.
// On a tall window or after a buffer click, the initial backlog can be
// shorter than clientHeight — there's no overflow, so onScroll never
// fires, and the user can't reach the "top" to trigger a fetch through
// normal scrolling. Recursive: each prepend triggers another check, and
// fetching stops when we either have overflow or run out of history.
function ensureViewportFilled() {
  const el = scroller.value;
  if (!el) return;
  if (el.scrollHeight > el.clientHeight) return;
  requestMoreHistory();
}

// Debounce timer for maybeRequestHistory. Trackpad scroll inertia keeps
// firing scroll events after our prepend math sets scrollTop high; if we
// fired the request synchronously each time scrollTop dipped past 80, the
// inertia would carry past our set, the dip would be detected again, and
// another fetch would cascade. We wait until scroll stabilizes before
// deciding the user is genuinely at the top.
let pendingHistoryTimer = null;

// Last seen scroller clientHeight, used to detect resize-induced scroll
// events. When the scroller shrinks (input grows, keyboard slides up,
// window resizes), browsers can fire a synthetic scroll event from
// scrollTop clamping or scroll anchoring — and that event arrives BEFORE
// the ResizeObserver callback. If onScroll runs the normal stick-to-bottom
// math on those values (new clientHeight, old scrollTop), it crosses the
// 30px threshold and falsely marks the user as scrolled-up. We compare
// clientHeight against this and skip the user-scroll logic when it differs;
// the resize handler is responsible for the snap in that path.
// (Pattern from stackblitz-labs/use-stick-to-bottom — "Scroll events may
// come before a ResizeObserver event".)
let lastClientHeight = 0;

function onScroll() {
  const el = scroller.value;
  if (!el) return;
  const ch = el.clientHeight;
  if (ch !== lastClientHeight) {
    lastClientHeight = ch;
    return;
  }
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  setStuckToBottom(stickToBottom.value);
  if (pendingHistoryTimer) clearTimeout(pendingHistoryTimer);
  pendingHistoryTimer = setTimeout(() => {
    pendingHistoryTimer = null;
    maybeRequestHistory();
  }, 150);
}

// Disengage stick-to-bottom synchronously on any upward wheel input.
// Without this, a live message can arrive between the user's wheel and the
// scroll event firing, the watcher resumes on nextTick before onScroll has
// run, and reads a stale stickToBottom=true — snapping the user back.
function onWheel(e) {
  if (e.deltaY < 0) {
    stickToBottom.value = false;
    setStuckToBottom(false);
  }
}

function scrollToBottom() {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

// Away/back markers are emitted from awayState, not from messages.value, so
// the messages-array watcher below doesn't see them. When the user flips
// state while pinned to the bottom, follow the new divider down — same
// behavior as sending a normal message.
watch(
  [() => awayState.value?.since, () => awayState.value?.backAt],
  async (next, prev) => {
    if (next[0] === prev?.[0] && next[1] === prev?.[1]) return;
    if (!stickToBottom.value) return;
    await nextTick();
    scrollToBottom();
  },
);

// Watch the messages array shape so we can react to:
//   - prepend (older history): pin the OLD first row's viewport position.
//   - replace (wholesale snapshot): snap to bottom.
//   - live push: snap to bottom IF the user is already pinned there.
watch(
  [
    () => messages.value.length,
    () => messages.value[0]?.id,
    () => messages.value[messages.value.length - 1]?.id,
  ],
  async ([newLen, newFirstId, newLastId], [oldLen, oldFirstId, oldLastId]) => {
    const el = scroller.value;
    if (!el) return;
    const prevLen = oldLen || 0;
    const grew = newLen > prevLen;
    const firstChanged = prevLen > 0 && newFirstId !== oldFirstId;
    const lastChanged = prevLen > 0 && newLastId !== oldLastId;
    // A live append that lands while the buffer is at MAX_PER_BUFFER evicts
    // the oldest row, so firstId shifts too — but the previous tail message
    // is still in the array. A wholesale re-snapshot also shifts both ends,
    // yet replaces that tail. Use the surviving tail to tell them apart, so a
    // capped buffer isn't misread as a re-snapshot (and force-scrolled to the
    // bottom) on every single message.
    const appended = lastChanged && oldLastId != null
      && messages.value.some((m) => m.id === oldLastId);
    // Pure prepend: anchor by element ID so re-flow from changing column
    // widths or differing message heights doesn't drift the math. With the
    // loading notice gone from the template, the OLD DOM and NEW DOM share
    // the same set of [data-msg-id] elements with stable identity above
    // and below the prepend boundary.
    if (firstChanged && !lastChanged && grew && oldFirstId != null) {
      const anchor = el.querySelector(`[data-msg-id="${oldFirstId}"]`);
      const anchorOldTop = anchor ? anchor.offsetTop : null;
      const oldScrollTop = el.scrollTop;
      const oldScrollHeight = el.scrollHeight;
      await nextTick();
      const anchorNew = anchorOldTop != null
        ? el.querySelector(`[data-msg-id="${oldFirstId}"]`)
        : null;
      if (anchorNew) {
        el.scrollTop = anchorNew.offsetTop - (anchorOldTop - oldScrollTop);
      } else {
        el.scrollTop = el.scrollHeight - oldScrollHeight + oldScrollTop;
      }
      ensureViewportFilled();
      return;
    }
    // Wholesale replace (fresh backlog from a re-snapshot): both ends shifted
    // and the previous tail is gone — distinct from a cap-evicting append,
    // which shifts both ends but keeps the tail (see `appended` above).
    const replaced = firstChanged && lastChanged && !appended;
    await nextTick();
    if (replaced) {
      stickToBottom.value = true;
      resetScrollState();
      scrollToBottom();
      ensureViewportFilled();
      return;
    }
    // Live append (new message arrived) — including the case where the
    // buffer was at its cap and the oldest row was evicted. When the user is
    // pinned, scroll along; otherwise track the unread-below count so the
    // status bar can surface "[N new ↓]". Skip the bump entirely when the
    // newly-arrived tail is from an ignored sender; the user wouldn't see
    // it scrolling into view anyway, and "1 new ↓" pointing at nothing is
    // confusing.
    if (appended) {
      if (stickToBottom.value) scrollToBottom();
      else {
        const tail = messages.value[messages.value.length - 1];
        const nid = buffer.value?.networkId;
        const tailIgnored = tail && !tail.self && tail.nick && nid
          && ignores.isIgnored(nid, tail.nick, tail.userhost);
        if (!tailIgnored) bumpNewBelow();
      }
    }
    ensureViewportFilled();
  },
);

// immediate: true handles the mobile case where MessageList is v-if'd out
// until the user taps a buffer — by the time we mount, activeKey is already
// set, so a plain (lazy) watcher would never see it change. The first
// nextTick after setup resolves after the initial render, so scroller.value
// is populated by the time scrollToBottom runs.
watch(() => networks.activeKey, async () => {
  stickToBottom.value = true;
  resetScrollState();
  await nextTick();
  scrollToBottom();
  ensureViewportFilled();
}, { immediate: true });

// StatusBar's "[N new ↓]" click increments scrollToBottomToken. Watching the
// token (rather than wiring a callback) keeps the composable stateless and
// avoids leaking refs to MessageList's DOM out of the component.
watch(scrollToBottomToken, async () => {
  await nextTick();
  stickToBottom.value = true;
  setStuckToBottom(true);
  scrollToBottom();
});

// Anything that shrinks MessageList's clientHeight (iOS soft keyboard sliding
// up via --viewport-h; the message-input textarea auto-growing past one row;
// the desktop window resizing) shrinks the visible window from the bottom
// without moving scrollTop — so a user pinned to the latest message ends up
// with the tail of the conversation hidden behind whatever just grew.
// ResizeObserver fires after layout settles, so scrollHeight is current; the
// snap is done synchronously here so any scroll event the snap triggers is
// observed against the freshly-updated lastClientHeight (i.e. classified as
// not-a-user-scroll). Pairs with the resize-induced-scroll guard in onScroll.
let scrollerObserver = null;
function onScrollerResize() {
  const el = scroller.value;
  if (!el) return;
  lastClientHeight = el.clientHeight;
  if (!stickToBottom.value) return;
  el.scrollTop = el.scrollHeight;
}

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && scroller.value) {
    lastClientHeight = scroller.value.clientHeight;
    scrollerObserver = new ResizeObserver(onScrollerResize);
    scrollerObserver.observe(scroller.value);
  }
  nowTimer = setInterval(() => { now.value = Date.now(); }, 60_000);
});

onBeforeUnmount(() => {
  if (scrollerObserver) {
    scrollerObserver.disconnect();
    scrollerObserver = null;
  }
  if (nowTimer) { clearInterval(nowTimer); nowTimer = null; }
});

watch(() => props.pendingScrollId, async (id) => {
  if (id == null) return;
  await nextTick();
  const el = scroller.value;
  if (!el) return;
  const target = el.querySelector(`[data-msg-id="${id}"]`);
  if (!target) return;
  stickToBottom.value = false;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.add('scroll-target');
  setTimeout(() => target.classList.remove('scroll-target'), 1500);
});
</script>

<style scoped>
/* WeeChat-style 3-column layout: time | nick | body, with column 2 sized to
   the widest nick currently visible. Each .line is a subgrid row, so the
   columns line up across every message in the pane.

   Gaps come from per-cell padding (column-gap is 0) so we can put a thin
   vertical separator centered between the nick and body columns. */
.message-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Disable browser scroll anchoring — when older history prepends with the
     loading-notice transition, the browser is unreliable about picking a
     stable anchor element (especially near the top of the buffer where
     there are few elements to choose from), and we end up with scrollTop
     near zero, which re-triggers maybeRequestHistory and cascades. The
     prepend watcher in <script setup> handles position preservation
     manually with a known-stable anchor (the OLD first message). */
  overflow-anchor: none;
  padding: 4px 12px;
  display: grid;
  /* Nick column has a 16ch floor (matching the most common modern NICKLEN)
     so the layout is consistent across buffers regardless of who's talking,
     and stretches if a network advertises a higher limit. */
  grid-template-columns: max-content minmax(16ch, max-content) minmax(0, 1fr);
  grid-auto-rows: min-content;
  align-content: start;
  column-gap: 0;
  row-gap: 0;
  line-height: 1.55;
}

.line {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: baseline;
}
.line.alt { background: var(--alt-bg); color: var(--alt-fg); }
.line:hover { background: var(--bg-soft); }

/* Matched highlight (rule fired): warm background tint. Sits above .alt so
   striping doesn't drown it out. DMs are NOT styled here — they get their
   own buffer + unread badge already. */
.line.highlight {
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.line.highlight.alt {
  background: color-mix(in srgb, var(--warn) 18%, transparent);
}
.line.scroll-target {
  animation: scroll-target-pulse 1.5s ease-out;
}
@keyframes scroll-target-pulse {
  0%   { background: color-mix(in srgb, var(--accent) 30%, transparent); }
  100% { background: transparent; }
}

.time {
  color: var(--fg-muted);
  padding-right: 1ch;
}

.prefix {
  justify-self: end;
  white-space: nowrap;
  padding-right: 1ch;
}
.prefix.italic { font-style: italic; }
.prefix.action-marker { color: var(--fg-muted); }
.prefix.p-join  { color: var(--good); }
.prefix.p-part,
.prefix.p-quit  { color: var(--fg-muted); }
.prefix.p-kick,
.prefix.p-error { color: var(--bad); }
.prefix.p-nick,
.prefix.p-mode,
.prefix.p-topic,
.prefix.p-motd,
.prefix.p-away,
.prefix.p-back,
.prefix.p-cons  { color: var(--fg-muted); }

.body {
  position: relative;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  padding-left: 1ch;
}
/* Vertical separator between the nick and body columns. Drawn from .body
   so it stretches the full height of the body cell — including wrapped
   lines — rather than just the nick's single-line box. */
.body::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 1px;
  background: var(--border);
}
.body.meta-body { color: var(--fg-muted); font-style: italic; }
.body.italic { font-style: italic; }
/* .msg-link styling lives in src/assets/main.css (shared with the topic bar). */

/* Mobile: phone widths can't spare the time column or the 16ch nick floor —
   either alone would leave 10ch for the body. We drop the time column
   entirely and let the nick column collapse to the widest currently-visible
   nick. The breakpoint matches useViewport's, so the column count changes
   in lockstep with Chat.vue's view dispatch. */
@media (max-width: 768px) {
  .message-list {
    grid-template-columns: minmax(0, max-content) minmax(0, 1fr);
    padding: 4px 8px;
  }
  .time { display: none; }
  .prefix { padding-right: 0.5ch; }
  .body { padding-left: 0.5ch; }
}

.notice {
  grid-column: 1 / -1;
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
  padding: 6px 0;
  margin: 0;
}

/* Boundary between read and unread messages. Pinned to the lastReadId
   snapshot taken on buffer activation; advances only after switch-away.
   Dashed border on either side of the label, warn-colored to differentiate
   from the muted "start of history" notice. */
.unread-divider {
  color: var(--warn);
  font-style: normal;
  font-size: 0.85em;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 4px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.unread-divider::before,
.unread-divider::after {
  content: '';
  flex: 1;
  border-top: 1px dashed var(--warn);
  opacity: 0.6;
}

/* Self-presence markers (away / back) and the day-change marker. Same shape
   as the unread divider so they read as a sibling kind of "structural" line,
   but in the muted fg color since they're informational rather than
   action-required. */
.presence-divider,
.date-divider {
  font-style: normal;
  font-size: 0.85em;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 4px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.presence-divider::before,
.presence-divider::after,
.date-divider::before,
.date-divider::after {
  content: '';
  flex: 1;
  border-top: 1px dashed var(--fg-muted);
  opacity: 0.6;
}
</style>
