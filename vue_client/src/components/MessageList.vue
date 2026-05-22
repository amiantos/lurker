<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div
    ref="scroller"
    class="message-list"
    :class="{ compact: compactMode }"
    @scroll="onScroll"
    @wheel="onWheel"
  >
    <!-- No "loading older…" notice. It would appear/disappear above the
         user's view during a history fetch, shifting scrollTop and either
         throwing off the prepend anchor math or (with browser anchoring)
         leaving scrollTop near the top so maybeRequestHistory cascades. -->
    <div v-if="!buffer?.hasMoreOlder && messages.length" class="notice">— start of history —</div>
    <p v-if="!messages.length" class="notice empty">No messages yet.</p>
    <template v-for="row in renderRows" :key="row.key">
      <div v-if="row.divider === 'unread'" class="notice unread-divider">— unread —</div>
      <div v-else-if="row.divider === 'away'" class="notice presence-divider">
        — away<template v-if="row.awayMessage">: {{ row.awayMessage }}</template> —
      </div>
      <div v-else-if="row.divider === 'back'" class="notice presence-divider">
        — back (gone {{ formatDuration(row.awayAt ?? '', row.backAt ?? '') }}) —
      </div>
      <div v-else-if="row.divider === 'date'" class="notice date-divider">{{ row.dateStr }}</div>
      <div
        v-else-if="row.consolidation"
        class="line"
        :class="{ 'cont-time': row.continuationTime }"
        :data-cons-first-id="row.firstId ?? null"
        :data-cons-last-id="row.lastId ?? null"
      >
        <span class="time">{{ row.continuationTime ? '' : time(row.time) }}</span>
        <span class="prefix p-cons">--</span>
        <span class="body meta-body">
          <template v-for="(g, gi) in row.groups" :key="gi"
            ><template v-if="gi > 0">; </template
            ><template v-for="(item, ii) in g.visible" :key="ii"
              ><template v-if="ii > 0">{{
                ii === g.visible.length - 1 && g.hidden === 0 ? ' and ' : ', '
              }}</template
              ><template v-if="g.kind === 'renamed'"
                ><NickRef :nick="asRename(item).from" /> →
                <NickRef :nick="asRename(item).to" /></template
              ><template v-else><NickRef :nick="asNick(item).nick" /></template></template
            ><template v-if="g.hidden > 0"
              >, and {{ g.hidden }} {{ g.hidden === 1 ? 'other' : 'others' }}</template
            ><template v-if="g.kind === 'joined'"> joined</template
            ><template v-else-if="g.kind === 'left'"> left</template
            ><template v-else-if="g.kind === 'reconnected'"> reconnected</template
            ><template v-else-if="g.kind === 'joinedAndLeft'"> joined briefly</template></template
          >
        </span>
      </div>
      <div
        v-else
        class="line"
        :class="[rowClass(row), { actionable: eligibleForActions(row.m) }]"
        :data-msg-id="row.m?.id ?? null"
        @contextmenu="onLineContextMenu($event, row.m)"
        v-bind="longPressBind(row.m)"
      >
        <template v-if="compactMode && row.m?.type === 'message'">
          <!-- Compact-mode message rows (IRCCloud-style): nick on its own
             head line above the body; body row carries the body and a
             right-aligned timestamp. The head is omitted entirely on
             author continuations so a run of same-author messages reads
             as one block, but every body row still shows its own time. -->
          <div v-if="!row.continuationAuthor" class="head">
            <span class="prefix" :class="prefixClass(row.m)" :style="prefixStyle(row.m)">{{
              row.m?.nick
            }}</span>
          </div>
          <span class="body" :class="bodyClass(row.m)">
            <RenderSegments :segments="textSegments(row.m)" :self-color="selfColor" />
          </span>
          <span class="time">{{ row.continuationTime ? '' : time(row.m?.time) }}</span>
        </template>
        <template v-else>
          <span class="time">{{ row.continuationTime ? '' : time(row.m?.time) }}</span>
          <span
            class="prefix"
            :class="prefixClass(row.m)"
            :style="row.continuationAuthor ? null : prefixStyle(row.m)"
            >{{ row.continuationAuthor ? '' : prefixText(row.m) }}</span
          >
          <span class="body" :class="bodyClass(row.m)">
            <RenderSegments
              v-if="hasInlineText(row.m)"
              :segments="textSegments(row.m)"
              :self-color="selfColor"
            />
            <template v-else-if="row.m?.type === 'join'"
              ><NickRef :nick="row.m.nick ?? ''" /> joined</template
            >
            <template v-else-if="row.m?.type === 'part'"
              ><NickRef :nick="row.m.nick ?? ''" /> left<template v-if="row.m.text">
                (<LinkedText :text="row.m.text" />)</template
              ></template
            >
            <template v-else-if="row.m?.type === 'quit'"
              ><NickRef :nick="row.m.nick ?? ''" /> quit<template v-if="row.m.text">
                (<LinkedText :text="row.m.text" />)</template
              ></template
            >
            <template v-else-if="row.m?.type === 'kick'"
              ><NickRef :nick="row.m.kicked ?? ''" /> kicked by
              <NickRef :nick="row.m.nick ?? ''" /><template v-if="row.m.text">
                (<LinkedText :text="row.m.text" />)</template
              ></template
            >
            <template v-else-if="row.m?.type === 'nick'"
              ><NickRef :nick="row.m.nick ?? ''" /> is now <NickRef :nick="row.m.newNick ?? ''"
            /></template>
            <template v-else-if="row.m?.type === 'mode'"
              >mode by <NickRef :nick="row.m.nick ?? ''" /><template v-if="row.m.text"
                >: <LinkedText :text="row.m.text" /></template
            ></template>
            <template v-else-if="row.m?.type === 'topic'"
              >topic set by <NickRef :nick="row.m.nick ?? ''" /><template v-if="row.m.text"
                >: <LinkedText :text="row.m.text" /></template
            ></template>
            <template v-else-if="row.m?.type === 'motd'"
              ><LinkedText :text="row.m.text ?? ''"
            /></template>
            <template v-else-if="row.m?.type === 'error'"
              ><LinkedText :text="row.m.text ?? ''"
            /></template>
          </span>
        </template>
        <button
          v-if="eligibleForActions(row.m)"
          type="button"
          class="row-actions"
          title="Message actions"
          aria-label="Message actions"
          @click.stop="onActionsClick($event, row.m)"
          @contextmenu.stop.prevent
        >
          <i class="fa-solid fa-ellipsis-vertical"></i>
        </button>
      </div>
    </template>
  </div>
  <IgnoreModal
    v-if="ignoreTarget"
    :nick="ignoreTarget.nick || ''"
    :user="ignoreTarget.user || null"
    :host="ignoreTarget.host || null"
    :network-id="ignoreTarget.networkId || null"
    @close="ignoreTarget = null"
  />
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import type { CSSProperties } from 'vue';
import { useNetworksStore, type AwayState } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { socketSend } from '../composables/useSocket.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useViewport } from '../composables/useViewport.js';
import {
  setStuckToBottom,
  bumpNewBelow,
  resetScrollState,
  useScrollState,
} from '../composables/useScrollState.js';
import type { RenderSegment } from '../utils/nickColor.js';
import { formatTimestamp, formatDuration, formatDate, formatDayLabel } from '../utils/timestamp.js';
import { consolidateRows } from '../utils/consolidate.js';
import type { ConsolidationGroup, NickEntry, RenameEntry } from '../../../shared/consolidate.js';
import { collapseDisplay } from '../utils/collapseDisplay.js';
import NickRef from './NickRef.vue';
import LinkedText from './LinkedText.vue';
import RenderSegments from './RenderSegments.vue';
import IgnoreModal from './IgnoreModal.vue';
import { useMessageActions } from '../composables/useMessageActions.js';
import type { MessageContext } from '../composables/useMessageActions.js';
import { useLongPress } from '../composables/useLongPress.js';
import { setViewedBuffer } from '../composables/useViewedBuffer.js';

// Extended BufferMessage fields accessed in the template and script
// (beyond the core BufferMessage definition which uses [key: string]: unknown).
interface ChatMessage {
  id?: number | null;
  networkId: number;
  target: string;
  type: string;
  nick?: string;
  text?: string;
  time?: string;
  self?: boolean;
  alt?: boolean;
  matched?: unknown;
  newNick?: string;
  kicked?: string;
  userhost?: string;
  [key: string]: unknown;
}

// A row emitted by renderRows — either a real message row, a consolidation
// summary, or a divider marker.
interface RenderRow {
  // Message row
  m?: ChatMessage;
  alt?: boolean;
  key: string | number;
  // Divider row
  divider?: string;
  dateStr?: string;
  awayMessage?: string;
  awayAt?: string;
  backAt?: string;
  // Consolidation row (from consolidateRows)
  consolidation?: boolean;
  groups?: ConsolidationGroup[];
  time?: string;
  firstId?: number | string | null;
  lastId?: number | string | null;
  // Display-collapsing tags (mutated by collapseDisplay)
  continuationAuthor?: boolean;
  continuationTime?: boolean;
}

// Ignore-confirm modal target
interface IgnoreTarget {
  nick?: string;
  user: string | null;
  host: string | null;
  networkId?: number;
}

const props = withDefaults(
  defineProps<{
    pendingScrollId?: number | string | null;
  }>(),
  { pendingScrollId: null },
);

const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const ignores = useIgnoresStore();
const nicks = useNickColors();
const { isMobile } = useViewport();

const actionItalic = computed(() => !!settings.effective('look.action.italic'));
const selfColor = computed<string | null>(
  () => (settings.effective('look.nick.self_color') as string | undefined) ?? null,
);
// Compact mode uses its own format setting so users can run the per-line
// time column at lower precision (default HH:mm) without affecting their
// standard-layout timestamps. Note: `tsFormat` is referenced via `time()`
// inside the collapseDisplay formatter too, so the timestamp-collapse
// granularity follows the active format automatically.
const tsFormat = computed(() =>
  settings.effective(
    compactMode.value ? 'look.buffer.time_format_compact' : 'look.buffer.time_format',
  ),
);

const scroller = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);
const { scrollToBottomToken } = useScrollState();

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));
const messages = computed(() => buffer.value?.messages || []);

const selfLower = computed(() => {
  const b = buffer.value;
  const sn = b ? networks.states[b.networkId]?.nick : null;
  return sn ? sn.toLowerCase() : null;
});

const nickSet = computed((): Set<string> => {
  const b = buffer.value;
  const set = new Set<string>();
  if (!b) return set;
  for (const mem of b.members || []) {
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

function time(iso: string | undefined): string {
  return formatTimestamp(iso ?? '', (tsFormat.value as string) ?? '');
}

function rowClass(row: RenderRow) {
  const m = row.m;
  return {
    [`type-${m?.type}`]: true,
    self: m?.self,
    alt: row.alt,
    highlight: !!m?.matched,
    'cont-author': !!row.continuationAuthor,
    'cont-time': !!row.continuationTime,
  };
}

// Per-message context menu wiring. Same items surface via right-click,
// mobile long-press, and the hover three-dots button — every path funnels
// through useMessageActions. The ignore confirmation modal is owned here so
// the menu callback can hand off without needing to know which view it lives
// in (mirrors MemberList's pattern).
const messageActions = useMessageActions();
const longPress = useLongPress();
const ignoreTarget = ref<IgnoreTarget | null>(null);

function eligibleForActions(m: ChatMessage | undefined | null): boolean {
  if (!m || m.id == null) return false;
  return m.type === 'message' || m.type === 'action' || m.type === 'notice';
}

function parseUserHost(userhost: string | null | undefined): {
  user: string | null;
  host: string | null;
} {
  if (!userhost) return { user: null, host: null };
  // Format is nick!user@host; tolerate missing pieces.
  const bang = userhost.indexOf('!');
  if (bang < 0) return { user: null, host: null };
  const rest = userhost.slice(bang + 1);
  const at = rest.indexOf('@');
  if (at < 0) return { user: null, host: null };
  return { user: rest.slice(0, at) || null, host: rest.slice(at + 1) || null };
}

function menuContext(m: ChatMessage): MessageContext {
  return {
    networkId: buffer.value?.networkId ?? 0,
    onIgnore: (msg) => {
      const { user, host } = parseUserHost(msg.userhost);
      ignoreTarget.value = {
        nick: msg.nick,
        user,
        host,
        networkId: buffer.value?.networkId,
      };
    },
  };
}

function onLineContextMenu(e: MouseEvent, m: ChatMessage | undefined) {
  // Desktop keeps the browser's native right-click menu — message actions are
  // reachable from the hover three-dots button. The in-app menu is a touch
  // affordance, opened via long-press on mobile. See issue #20.
  if (!isMobile.value) return;
  if (!eligibleForActions(m)) return;
  e.preventDefault();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messageActions.openMenuFor(m as any, menuContext(m!), e.clientX, e.clientY);
}

function onActionsClick(e: MouseEvent, m: ChatMessage | undefined) {
  if (!eligibleForActions(m)) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messageActions.openMenuFromButton(
    m as any,
    menuContext(m!),
    (e.currentTarget as Element) || null,
  );
}

// Touch long-press → same menu. Eligibility is rechecked inside the callback
// so the timer set on touchstart of an ineligible row (rare, the v-bind only
// emits handlers for eligible rows) is a no-op. The bind() factory threads
// the message through to the callback as the payload arg.
function longPressBind(m: ChatMessage | undefined) {
  if (!eligibleForActions(m)) return null;
  return longPress.bind((coords, msg) => {
    if (!msg) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messageActions.openMenuFor(msg as any, menuContext(msg), coords.clientX, coords.clientY);
  }, m as ChatMessage);
}

const smartFilterEnabled = computed(() => !!settings.effective('chat.smart_filter'));
const smartFilterDelayMs = computed(
  () => ((settings.effective('chat.smart_filter_delay') as number) || 0) * 60_000,
);
const smartFilterUnmaskMs = computed(
  () => ((settings.effective('chat.smart_filter_join_unmask') as number) || 0) * 60_000,
);
const smartFilterJoin = computed(() => !!settings.effective('chat.smart_filter_join'));
const smartFilterQuit = computed(() => !!settings.effective('chat.smart_filter_quit'));
const smartFilterNick = computed(() => !!settings.effective('chat.smart_filter_nick'));

const consolidateEnabled = computed(() => !!settings.effective('chat.consolidate_joins'));
const consolidateMaxNames = computed(
  () => (settings.effective('chat.consolidate_max_names') as number) || 5,
);

const collapseAuthorsEnabled = computed(
  () => !!settings.effective('look.message.collapse_authors'),
);
const collapseAuthorsWindowMs = computed(
  () =>
    Math.max(0, (settings.effective('look.message.collapse_authors_window') as number) || 0) *
    60_000,
);
const collapseTimestampsEnabled = computed(
  () => !!settings.effective('look.message.collapse_timestamps'),
);

// look.message.layout: auto / standard / compact. Compact swaps the 3-column
// subgrid for a two-line stack (head: nick + time, body below) on
// `type === 'message'` rows; other row types stay single-line. Auto picks
// compact on mobile-width viewports so phone users get the reflow by default.
const layoutSetting = computed(() => settings.effective('look.message.layout') || 'auto');
const compactMode = computed(() => {
  if (layoutSetting.value === 'compact') return true;
  if (layoutSetting.value === 'standard') return false;
  return isMobile.value;
});

// Compact mode forces author collapsing — the head is the only place the
// nick appears, and without collapsing the buffer is wall-to-wall headers.
// Timestamp collapsing stays user-opt-in regardless of mode: compact's
// right-aligned time is its own visual column (IRCCloud-style), so the
// repetition is much less noisy than in standard mode.
const effectiveCollapseAuthors = computed(() => compactMode.value || collapseAuthorsEnabled.value);
const effectiveCollapseTimestamps = computed(() => collapseTimestampsEnabled.value);

// User-level self-presence (driven by user_away_state on the server). Each
// network broadcasts the same payload, so reading from this buffer's network
// is equivalent to reading user state. The server pseudo-buffer doesn't get
// presence markers — it's noise-only.

const awayState = computed((): AwayState | null => {
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
let nowTimer: ReturnType<typeof setInterval> | null = null;

// Striped row types — chat-shaped events that receive .line.alt zebra striping.
// System events (join/part/quit/nick/mode/topic/etc.) are never striped, so
// smart-filtering them out can't desync the pattern. Authoritative parity is
// stored server-side on messages.alt per (network_id, target), computed at
// insert time across only these types.
const STRIPED_TYPES = new Set(['message', 'action', 'notice']);

// One-pass walk over messages to (a) decide which rows the smart filter
// should hide and (b) tag rows with alt-row striping.
const renderRows = computed((): RenderRow[] => {
  const list = messages.value;
  const buf = buffer.value;
  const out: RenderRow[] = [];

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
  const presenceExpired = backAtMs != null && now.value - backAtMs > PRESENCE_MARKER_TTL_MS;
  let awayInserted = !awaySinceMs || presenceExpired;
  let backInserted = !backAtMs || presenceExpired;

  // Day-change marker: WeeChat-style date line emitted before the first
  // visible message of each local calendar day (including the very first
  // message in the buffer). Tracked across the loop below.
  let lastDayKey = null;
  const pushAwayDivider = () => {
    if (!aw) return;
    out.push({
      divider: 'away',
      awayMessage: aw.message ?? undefined,
      awayAt: aw.since ?? undefined,
      key: 'presence-away',
    });
  };
  const pushBackDivider = () => {
    if (!aw) return;
    out.push({
      divider: 'back',
      awayAt: aw.since ?? undefined,
      backAt: aw.backAt ?? undefined,
      key: 'presence-back',
    });
  };

  const networkId = buf?.networkId;

  for (let i = 0; i < list.length; i++) {
    // Cast to ChatMessage so template-used properties are typed; BufferMessage
    // uses [key: string]: unknown for extra fields (time, self, alt, userhost…).
    const m = list[i] as ChatMessage;
    const key = m.id ?? `live:${i}`;
    let hidden = false;

    // Render-time ignore filter. Self-authored events are never hidden (the
    // user always sees their own activity), and the matcher is fed both the
    // bare nick and the full nick!user@host so hostmask entries can fire.
    // Removing a mask re-runs this computed and previously-hidden rows
    // reappear without a backlog reload.
    if (!m.self && m.nick && networkId && ignores.isIgnored(networkId, m.nick, m.userhost ?? '')) {
      continue;
    }

    if (filterOn && m.nick && !m.self) {
      const filterable =
        (m.type === 'join' && fJoin) ||
        ((m.type === 'part' || m.type === 'quit') && fQuit) ||
        (m.type === 'nick' && fNick);
      if (filterable && m.nick.toLowerCase() !== ownNickLc) {
        const lastSpoke = buf?.speakers[m.nick.toLowerCase()]?.lastTime;
        const eventTime = Date.parse(m.time ?? '') || 0;
        const recentlySpoke =
          lastSpoke != null && lastSpoke <= eventTime && eventTime - lastSpoke <= delayMs;
        const unmasked =
          m.type === 'join' &&
          unmaskMs > 0 &&
          lastSpoke != null &&
          lastSpoke > eventTime &&
          lastSpoke - eventTime <= unmaskMs;
        if (!recentlySpoke && !unmasked) hidden = true;
      }
    }

    if (hidden) continue;

    // Day-change marker before the first visible row of each local day.
    const dayKey = formatDate(m.time ?? '');
    if (dayKey && dayKey !== lastDayKey) {
      out.push({ divider: 'date', dateStr: formatDayLabel(m.time ?? ''), key: `date:${dayKey}` });
      lastDayKey = dayKey;
    }

    const mTimeMs = Date.parse(m.time ?? '') || 0;
    if (!awayInserted && awaySinceMs != null && mTimeMs > awaySinceMs) {
      pushAwayDivider();
      awayInserted = true;
    }
    if (!backInserted && backAtMs != null && mTimeMs > backAtMs) {
      pushBackDivider();
      backInserted = true;
    }
    // Insert the unread divider before the first visible row with id past
    // the snapshot. Tolerates the exact-id row being filtered out: we just
    // pick the next surviving row past the boundary.
    if (!dividerInserted && m.id != null && Number(m.id) > dividerAfterId) {
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
  let final: RenderRow[] = out;
  if (consolidateEnabled.value) {
    const speakers = buf?.speakers ? Object.keys(buf.speakers) : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    final = consolidateRows(out as any, {
      enabled: true,
      maxNames: consolidateMaxNames.value,
      recentSpeakers: speakers,
    }) as RenderRow[];
  }
  // Per-row display collapsing (nick + timestamp dedupe). Runs over the same
  // row shape consolidateRows emits and tags rows in place — the template
  // checks row.continuationAuthor / row.continuationTime to render empty
  // prefix/time cells (subgrid stays aligned). compactMode tells the util
  // to skip hidden continuation rows when tracking the time chain.
  if (effectiveCollapseAuthors.value || effectiveCollapseTimestamps.value) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collapseDisplay(final as any, {
      collapseAuthors: effectiveCollapseAuthors.value,
      authorWindowMs: collapseAuthorsWindowMs.value,
      collapseTimestamps: effectiveCollapseTimestamps.value,
      compactMode: compactMode.value,
      formatTime: (iso) => time(iso),
    });
  }
  return final;
});

// What goes in column 2. For chat lines this is the nick (right-aligned);
// for system events it's a tiny indicator glyph (-->, <--, --, !!).
function prefixText(m: ChatMessage | undefined): string {
  if (!m) return '';

  switch (m.type) {
    case 'message':
      return m.nick ?? '';
    case 'action':
      return '*';
    case 'notice':
      return `-${m.nick ?? ''}-`;
    case 'join':
      return '-->';
    case 'part':
    case 'quit':
    case 'kick':
      return '<--';
    case 'nick':
    case 'mode':
    case 'topic':
    case 'motd':
      return '--';
    case 'error':
      return '!!';
    default:
      return '';
  }
}

function prefixClass(m: ChatMessage | undefined) {
  return {
    nick: m?.type === 'message' || m?.type === 'notice',
    'action-marker': m?.type === 'action',
    italic: m?.type === 'action' && actionItalic.value,
    self: m?.self,
    [`p-${m?.type}`]: true,
  };
}

function prefixStyle(m: ChatMessage | undefined): CSSProperties | null {
  if (m?.type === 'message' || m?.type === 'notice') {
    if (m.self) return { color: selfColor.value as string };
    const c = nicks.color(m.nick ?? '');
    return c ? { color: c } : null;
  }
  return null;
}

function bodyClass(m: ChatMessage | undefined) {
  return {
    italic: m?.type === 'action' && actionItalic.value,
    'meta-body': m?.type !== 'message' && m?.type !== 'action' && m?.type !== 'notice',
  };
}

// True for any line type whose body is just `m.text` and should be split
// through the nick-coloring helper. Action lines render their author's nick
// at the start of the body, with `m.text` after.
function hasInlineText(m: ChatMessage | undefined): boolean {
  return m?.type === 'message' || m?.type === 'notice' || m?.type === 'action';
}

function textSegments(m: ChatMessage | undefined): RenderSegment[] {
  if (!m) return [];
  if (m.type === 'action') {
    // Body is "<nick> <text>" — author's nick then the action text.
    return nicks.splitText(
      `${m.nick} ${m.text || ''}`,
      nickSet.value,
      selfLower.value,
    ) as RenderSegment[];
  }
  return nicks.splitText(m.text || '', nickSet.value, selfLower.value) as RenderSegment[];
}

// Template helpers for consolidation row items — vue-tsc can't narrow
// NickEntry | RenameEntry based on g.kind, so we provide typed accessors.
function asRename(item: NickEntry | RenameEntry): RenameEntry {
  return item as RenameEntry;
}
function asNick(item: NickEntry | RenameEntry): NickEntry {
  return item as NickEntry;
}

function requestMoreHistory() {
  const buf = buffer.value;
  if (!buf) return;
  if (!buf.hasMoreOlder || buf.loadingHistory) return;
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

// Detached-only downward pager. Fires when the user scrolls toward the
// bottom of a historical slice; the server's 'after' mode ships the next
// page of newer events, which appendHistory tacks onto the tail. While
// live, the bottom edge IS the live tail, so there's nothing to fetch
// (and hasMoreNewer is false anyway).
function requestNewerHistory() {
  const buf = buffer.value;
  if (!buf) return;
  if (!buf.detached || !buf.hasMoreNewer || buf.loadingHistory) return;
  if (buf.target.startsWith(':server:')) return;
  const afterId = buf.newestId ?? buf.messages[buf.messages.length - 1]?.id;
  if (!afterId) return;
  buffers.setLoadingHistory(buf.networkId, buf.target, true);
  socketSend({
    type: 'history',
    mode: 'after',
    networkId: buf.networkId,
    target: buf.target,
    afterId,
    limit: 100,
  });
}

function maybeRequestHistory() {
  const el = scroller.value;
  if (!el) return;
  if (el.scrollTop > 80) return;
  requestMoreHistory();
}

function maybeRequestNewer() {
  const el = scroller.value;
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight > 80) return;
  const buf = buffer.value;
  if (!buf || !buf.detached || buf.loadingHistory) return;
  if (buf.target.startsWith(':server:')) return;
  if (buf.hasMoreNewer) {
    requestNewerHistory();
    return;
  }
  // Caught up: paged through to the bottom of the slice with nothing newer
  // server-side as of our last fetch. Auto-reattach so the buffer rejoins
  // live (also picks up anything that arrived during the detach via the
  // 'latest' refetch) and the StatusBar "Return to present" button
  // disappears without the user having to tap it.
  buffers.reattachToLive(buf.networkId, buf.target);
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
let pendingHistoryTimer: ReturnType<typeof setTimeout> | null = null;

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
    // Same debounce window also covers the downward pager so a fast scroll
    // through the slice can't fire both edges concurrently. The function
    // is a no-op for non-detached buffers.
    maybeRequestNewer();
  }, 150);
}

// Disengage stick-to-bottom synchronously on any upward wheel input.
// Without this, a live message can arrive between the user's wheel and the
// scroll event firing, the watcher resumes on nextTick before onScroll has
// run, and reads a stale stickToBottom=true — snapping the user back.
function onWheel(e: WheelEvent) {
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
watch([() => awayState.value?.since, () => awayState.value?.backAt], async (next, prev) => {
  if (next[0] === prev?.[0] && next[1] === prev?.[1]) return;
  if (!stickToBottom.value) return;
  await nextTick();
  scrollToBottom();
});

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
    const appended =
      lastChanged && oldLastId != null && messages.value.some((m) => m.id === oldLastId);
    // Pure prepend: anchor by element ID so re-flow from changing column
    // widths or differing message heights doesn't drift the math. With the
    // loading notice gone from the template, the OLD DOM and NEW DOM share
    // the same set of [data-msg-id] elements with stable identity above
    // and below the prepend boundary.
    if (firstChanged && !lastChanged && grew && oldFirstId != null) {
      const anchor = el.querySelector(`[data-msg-id="${oldFirstId}"]`) as HTMLElement | null;
      const anchorOldTop = anchor ? anchor.offsetTop : null;
      const oldScrollTop = el.scrollTop;
      const oldScrollHeight = el.scrollHeight;
      await nextTick();
      const anchorNew =
        anchorOldTop != null
          ? (el.querySelector(`[data-msg-id="${oldFirstId}"]`) as HTMLElement | null)
          : null;
      if (anchorNew) {
        el.scrollTop = anchorNew.offsetTop - (anchorOldTop! - oldScrollTop);
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
    const isDetached = !!buffer.value?.detached;
    await nextTick();
    if (replaced) {
      if (isDetached) {
        // Detached slice landed (loadAround response). The pendingScrollId
        // watcher will center the anchor row with scrollIntoView; don't
        // pre-empt that with a snap-to-bottom. Mark not-stuck so live state
        // doesn't try to pull us forward.
        stickToBottom.value = false;
        setStuckToBottom(false);
        ensureViewportFilled();
        return;
      }
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
    //
    // Pager-driven appends (mode='after' response while detached) share this
    // shape — same `appended` test passes. We let them through without any
    // scroll adjustment: content was added below the viewport, the user's
    // current scrollTop still points at the row they were reading, and
    // bumpNewBelow would be misleading since these aren't live events.
    if (appended && !isDetached) {
      if (stickToBottom.value) scrollToBottom();
      else {
        const tail = messages.value[messages.value.length - 1] as ChatMessage | undefined;
        const nid = buffer.value?.networkId;
        const tailIgnored =
          tail &&
          !tail.self &&
          tail.nick &&
          nid &&
          ignores.isIgnored(nid, tail.nick, tail.userhost ?? '');
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
watch(
  () => networks.activeKey,
  async () => {
    stickToBottom.value = true;
    resetScrollState();
    await nextTick();
    scrollToBottom();
    ensureViewportFilled();
  },
  { immediate: true },
);

// Layout toggle reflows every row's height (3-col grid ↔ stacked head+body).
// scrollTop becomes meaningless across the swap; re-snap if the user was
// pinned, otherwise leave them where they are (their reading position is
// approximately preserved by the surrounding content).
watch(compactMode, async () => {
  await nextTick();
  if (stickToBottom.value) scrollToBottom();
});

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
let scrollerObserver: ResizeObserver | null = null;
function onScrollerResize() {
  const el = scroller.value;
  if (!el) return;
  lastClientHeight = el.clientHeight;
  if (!stickToBottom.value) return;
  el.scrollTop = el.scrollHeight;
}

// Report which buffer's messages are on screen so toast suppression can tell
// "looking at this buffer" apart from networks.activeKey's looser "last-opened
// buffer" (see useHighlightNotifier.shouldNotifyInApp). This component mounts
// only while a buffer's messages are actually rendered, so its lifecycle is
// the signal: follow activeKey while mounted, clear on unmount (Settings
// route, mobile list/members screen, system console).
watch(
  () => networks.activeKey,
  (key) => setViewedBuffer(key),
  { immediate: true },
);

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && scroller.value) {
    lastClientHeight = scroller.value.clientHeight;
    scrollerObserver = new ResizeObserver(onScrollerResize);
    scrollerObserver.observe(scroller.value);
  }
  nowTimer = setInterval(() => {
    now.value = Date.now();
  }, 60_000);
});

onBeforeUnmount(() => {
  setViewedBuffer(null);
  if (scrollerObserver) {
    scrollerObserver.disconnect();
    scrollerObserver = null;
  }
  if (nowTimer) {
    clearInterval(nowTimer);
    nowTimer = null;
  }
});

// PageUp/PageDown shortcut handler: scroll the message list by ~90% of the
// viewport in either direction. Less than 100% leaves a row of overlap so the
// user keeps their place across the page boundary (same trick browsers use
// for their own PgUp/PgDn). Marks not-stuck on upward paging so a live
// message arriving mid-read doesn't yank the viewport back to the bottom;
// downward paging that reaches the tail re-engages stick-to-bottom via the
// normal onScroll path.
function scrollByPage(direction: number) {
  const el = scroller.value;
  if (!el) return;
  const delta = Math.max(el.clientHeight - 40, 80) * (direction < 0 ? -1 : 1);
  if (direction < 0) {
    stickToBottom.value = false;
    setStuckToBottom(false);
  }
  el.scrollBy({ top: delta, behavior: 'smooth' });
}

defineExpose({ scrollByPage });

watch(
  () => props.pendingScrollId,
  async (id) => {
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
  },
);
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
  position: relative;
}
/* iOS Safari fires its native text-callout on long-press, which would race
   our useLongPress handler. -webkit-touch-callout: none alone suppresses it
   without touching user-select, so desktop drag-to-select (including
   across multiple lines) still works exactly as before. */
.line.actionable {
  -webkit-touch-callout: none;
}
/* Alt-row striping is a standard-mode helper for telling adjacent same-type
   rows apart in a dense column. In compact mode, message groups already
   visually separate via the head/gap rhythm, so striping individual lines
   inside a group fights the grouping signal — drop it. */
.message-list:not(.compact) .line.alt {
  background: var(--alt-bg);
  color: var(--alt-fg);
}
.line:hover {
  background: var(--bg-soft);
}
/* Override only the alt-row background on hover — not its text color. The
   `.line.alt` selector outweighs `.line:hover`, so the hover background needs
   restating here, but the alt foreground (--alt-fg) stays put: hover is a
   background-only cue and shouldn't shift the text color under the cursor. */
.message-list:not(.compact) .line.alt:hover {
  background: var(--bg-soft);
}

/* Hover-revealed three-dots button on eligible rows (desktop only). Sits in
   the gutter on the right edge of the line. Hidden on touch viewports;
   mobile users get the same menu via long-press. */
.row-actions {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  z-index: 1;
  padding: 0;
  border-radius: 3px;
}
.line:hover .row-actions {
  opacity: 1;
  pointer-events: auto;
}
.row-actions:hover {
  color: var(--fg);
  background: var(--bg-soft);
}
@media (hover: none), (max-width: 768px) {
  .row-actions {
    display: none;
  }
}

/* Matched highlight (rule fired): warm background tint. Sits above .alt so
   striping doesn't drown it out. DMs are NOT styled here — they get their
   own buffer + unread badge already. */
.line.highlight {
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.message-list:not(.compact) .line.highlight.alt {
  background: color-mix(in srgb, var(--warn) 18%, transparent);
}
.line.scroll-target {
  animation: scroll-target-pulse 1.5s ease-out;
}
@keyframes scroll-target-pulse {
  0% {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  100% {
    background: transparent;
  }
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
.prefix.italic {
  font-style: italic;
}
.prefix.action-marker {
  color: var(--fg-muted);
}
.prefix.p-join {
  color: var(--good);
}
.prefix.p-part,
.prefix.p-quit {
  color: var(--fg-muted);
}
.prefix.p-kick,
.prefix.p-error {
  color: var(--bad);
}
.prefix.p-nick,
.prefix.p-mode,
.prefix.p-topic,
.prefix.p-motd,
.prefix.p-away,
.prefix.p-back,
.prefix.p-cons {
  color: var(--fg-muted);
}

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
.body.meta-body {
  color: var(--fg-muted);
  font-style: italic;
}
.body.italic {
  font-style: italic;
}
/* .msg-link styling lives in src/assets/main.css (shared with the topic bar). */

/* Mobile + standard layout: phone widths can't spare the time column or the
   16ch nick floor — either alone would leave 10ch for the body. We drop the
   time column entirely and let the nick column collapse to the widest
   currently-visible nick. Scoped to :not(.compact) because compact mode
   handles narrow viewports natively via its head-line layout, and the bare
   `.time { display: none }` would otherwise hide the time inside compact's
   head element. */
@media (max-width: 768px) {
  .message-list:not(.compact) {
    grid-template-columns: minmax(0, max-content) minmax(0, 1fr);
    padding: 4px 8px;
  }
  .message-list:not(.compact) .time {
    display: none;
  }
  .message-list:not(.compact) .prefix {
    padding-right: 0.5ch;
  }
  .message-list:not(.compact) .body {
    padding-left: 0.5ch;
  }
}

/* Compact layout (look.message.layout = compact, or = auto on mobile):
   IRCCloud-style two-column row — content on the left, timestamp on the
   right — with messages getting a nick-only head line above. Only the
   outer scroller and per-line layout change; the scroll/history machinery
   is untouched. */
.message-list.compact {
  /* Single content column — the 3-col subgrid alignment goes away. */
  grid-template-columns: minmax(0, 1fr);
  padding: 4px 8px;
}
.message-list.compact .line {
  /* Per-row grid: head spans both content columns above the body row;
     body row is [prefix? body time]. When .head is absent (continuation
     messages, non-message rows) the head track collapses to 0. When
     line-level .prefix is absent (compact message body/continuation rows)
     the prefix column collapses to 0 and body takes the remaining width. */
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas:
    'head   head head'
    'prefix body time';
  align-items: baseline;
  column-gap: 0.75ch;
  row-gap: 0;
  padding: 2px 0;
  /* Group separator: every non-continuation line marks the start of a new
     visual cluster (message head, action, notice, system event,
     consolidation summary). Transparent (not padding) so adjacent hover
     backgrounds don't touch across the gap. Adjacent siblings collapse
     vertical margins, so back-to-back clusters get one 10px gap, not 20px. */
  margin-top: 10px;
}
/* Continuation message rows render only body + time — no head, no cluster
   start — and should sit tight under the previous line. */
.message-list.compact .line.cont-author {
  margin-top: 0;
}
/* Client-side dividers (unread/away/back/date) also mark a cluster boundary,
   so give them the same top gap as .line in compact mode. */
.message-list.compact .notice {
  margin-top: 10px;
}
.message-list.compact .line > .head {
  grid-area: head;
  display: flex;
  align-items: baseline;
  gap: 0.75ch;
}
/* Inside the head we want the nick at the left edge — undo the standard
   prefix rules (justify-self: end / padding-right: 1ch) that the 3-col
   grid relies on. */
.message-list.compact .line > .head .prefix {
  justify-self: auto;
  padding-right: 0;
}
.message-list.compact .line > .prefix {
  grid-area: prefix;
  justify-self: start;
  padding-right: 0;
}
.message-list.compact .line > .body {
  grid-area: body;
  padding-left: 0;
}
.message-list.compact .line > .time {
  grid-area: time;
  color: var(--fg-muted);
  padding-right: 0;
  padding-left: 0.75ch;
}
/* The vertical separator between nick and body columns belongs to the
   3-column standard layout — drop it in compact mode. */
.message-list.compact .line > .body::before {
  display: none;
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
