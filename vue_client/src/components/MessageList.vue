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
      <div v-if="row.divider === 'unread'" :ref="setUnreadDividerEl" class="notice unread-divider">
        <span class="notice-label">unread</span>
      </div>
      <div v-else-if="row.divider === 'away'" class="notice presence-divider">
        <span class="notice-label"
          >away<template v-if="row.awayMessage">: {{ row.awayMessage }}</template></span
        >
      </div>
      <div v-else-if="row.divider === 'back'" class="notice presence-divider">
        <span class="notice-label"
          >back (gone {{ formatDuration(row.awayAt ?? '', row.backAt ?? '') }})</span
        >
      </div>
      <div v-else-if="row.divider === 'date'" class="notice date-divider">
        <span class="notice-label">{{ row.dateStr }}</span>
      </div>
      <div v-else-if="row.divider === 'cleared'" class="notice cleared-divider">
        <span class="notice-label"
          >cleared {{ formatDateTime(row.clearedAt ?? '') }}
          <button type="button" class="cleared-undo" @click="onUnclearClick">
            Show earlier messages
          </button></span
        >
      </div>
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
                ><NickRef
                  :nick="asRename(item).from"
                  interactive
                  @click.stop.prevent="onNickMenu($event, asRename(item).from)" />
                →
                <NickRef
                  :nick="asRename(item).to"
                  interactive
                  @click.stop.prevent="onNickMenu($event, asRename(item).to)" /></template
              ><template v-else
                ><NickRef
                  :nick="asNick(item).nick"
                  interactive
                  @click.stop.prevent="
                    onNickMenu($event, asNick(item).nick)
                  " /></template></template
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
        :class="rowClass(row)"
        :data-msg-id="row.m?.id ?? null"
        @click="onMessageRowClick($event, row.m)"
      >
        <template v-if="compactMode && row.m?.type === 'message'">
          <!-- Compact-mode message rows (IRCCloud-style): nick on its own
             head line above the body; body row carries the body and a
             right-aligned timestamp. The head is omitted entirely on
             author continuations so a run of same-author messages reads
             as one block, but every body row still shows its own time. -->
          <div v-if="!row.continuationAuthor" class="head">
            <span class="prefix" :class="prefixClass(row.m)"
              ><NickRef
                :nick="row.m?.nick ?? ''"
                :modes="authorModes(row.m)"
                :show-prefix="showModePrefix"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.nick, row.m)"
            /></span>
          </div>
          <span class="body" :class="bodyClass(row.m)">
            <span
              v-if="row.m?.relaySource && !row.continuationAuthor"
              class="relay-via"
              :title="'Relayed via ' + row.m.relayBot"
              >[{{ relayLabel(row.m) }}]</span
            ><RenderSegments
              :segments="textSegments(row.m)"
              :self-color="selfColor"
              :network-id="buffer?.networkId ?? null"
              interactive-nicks
              @nick-click="onMentionMenu"
            />
          </span>
          <span class="time">{{ row.continuationTime ? '' : time(row.m?.time) }}</span>
        </template>
        <template v-else>
          <span class="time">{{ row.continuationTime ? '' : time(row.m?.time) }}</span>
          <span
            class="prefix"
            :class="prefixClass(row.m)"
            :style="row.continuationAuthor || row.m?.type === 'message' ? null : prefixStyle(row.m)"
            ><template v-if="row.m?.type === 'message' && !row.continuationAuthor"
              ><NickRef
                :nick="row.m?.nick ?? ''"
                :modes="authorModes(row.m)"
                :show-prefix="showModePrefix"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.nick, row.m)" /></template
            ><template v-else>{{ row.continuationAuthor ? '' : prefixText(row.m) }}</template></span
          >
          <span class="body" :class="bodyClass(row.m)">
            <span
              v-if="row.m?.relaySource && !row.continuationAuthor"
              class="relay-via"
              :title="'Relayed via ' + row.m.relayBot"
              >[{{ relayLabel(row.m) }}]</span
            ><RenderSegments
              v-if="hasInlineText(row.m)"
              :segments="textSegments(row.m)"
              :self-color="selfColor"
              :network-id="buffer?.networkId ?? null"
              interactive-nicks
              @nick-click="onMentionMenu"
            />
            <template v-else-if="row.m?.type === 'join'"
              ><NickRef
                :nick="row.m.nick ?? ''"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.nick, row.m)"
              />{{ eventHostSuffix(row.m) }} joined</template
            >
            <template v-else-if="row.m?.type === 'part'"
              ><NickRef
                :nick="row.m.nick ?? ''"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.nick, row.m)"
              />{{ eventHostSuffix(row.m) }} left<template v-if="row.m.text">
                (<LinkedText :text="row.m.text" />)</template
              ></template
            >
            <template v-else-if="row.m?.type === 'quit'"
              ><NickRef
                :nick="row.m.nick ?? ''"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.nick, row.m)"
              />{{ eventHostSuffix(row.m) }} quit<template v-if="row.m.text">
                (<LinkedText :text="row.m.text" />)</template
              ></template
            >
            <template v-else-if="row.m?.type === 'kick'"
              ><NickRef
                :nick="row.m.kicked ?? ''"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.kicked)"
              />
              kicked by
              <NickRef
                :nick="row.m.nick ?? ''"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.nick, row.m)"
              /><template v-if="row.m.text">
                (<LinkedText :text="row.m.text" />)</template
              ></template
            >
            <template v-else-if="row.m?.type === 'invite'"
              ><NickRef
                :nick="row.m.nick ?? ''"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.nick, row.m)" />
              invited
              <NickRef
                :nick="row.m.invited ?? ''"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.invited)"
            /></template>
            <template v-else-if="row.m?.type === 'nick'"
              ><NickRef
                :nick="row.m.nick ?? ''"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.nick, row.m)"
              />
              is now
              <NickRef
                :nick="row.m.newNick ?? ''"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.newNick, row.m)"
              />{{ eventHostSuffix(row.m) }}</template
            >
            <template v-else-if="row.m?.type === 'mode'"
              >mode by
              <NickRef
                :nick="row.m.nick ?? ''"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.nick, row.m)" /><template
                v-if="row.m.text"
                >: <LinkedText :text="row.m.text" /></template
            ></template>
            <template v-else-if="row.m?.type === 'topic'"
              >topic set by
              <NickRef
                :nick="row.m.nick ?? ''"
                interactive
                @click.stop.prevent="onNickMenu($event, row.m?.nick, row.m)" /><template
                v-if="row.m.text"
                >: <LinkedText :text="row.m.text" /></template
            ></template>
            <template
              v-else-if="
                row.m?.type === 'motd' ||
                row.m?.type === 'system' ||
                row.m?.type === 'e2e' ||
                row.m?.type === 'ctcp'
              "
              ><LinkedText :text="row.m.text ?? ''"
            /></template>
            <template v-else-if="row.m?.type === 'error'"
              ><LinkedText :text="row.m.text ?? ''"
            /></template>
          </span>
        </template>
        <div
          v-if="hoverActions && eligibleForActions(row.m)"
          class="row-actions"
          role="group"
          aria-label="Message actions"
        >
          <button
            v-for="a in actionsFor(row.m)"
            :key="a.key"
            type="button"
            class="row-action"
            :class="{ active: a.active }"
            :title="a.label"
            :aria-label="a.label"
            @click.stop="runAction(a.key, row.m)"
            @contextmenu.stop.prevent
          >
            <i :class="a.icon"></i>
          </button>
        </div>
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
import type { CSSProperties, ComponentPublicInstance } from 'vue';
import { useNetworksStore, type AwayState } from '../stores/networks.js';
import { useBuffersStore, type BufferMember } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useHighlightRulesStore } from '../stores/highlightRules.js';
import { useRelayBotsStore } from '../stores/relayBots.js';
import { socketSend } from '../composables/useSocket.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useViewport } from '../composables/useViewport.js';
import {
  setStuckToBottom,
  bumpNewBelow,
  resetScrollState,
  setUnreadAnchor,
  useScrollState,
} from '../composables/useScrollState.js';
import type { RenderSegment } from '../utils/nickColor.js';
import {
  formatTimestamp,
  formatDuration,
  formatDate,
  formatDateTime,
  formatDayLabel,
} from '../utils/timestamp.js';
import { consolidateRows } from '../utils/consolidate.js';
import type { ConsolidationGroup, NickEntry, RenameEntry } from '../../../shared/consolidate.js';
import { collapseDisplay } from '../utils/collapseDisplay.js';
import { parseRelayMessage } from '../../../shared/parseRelay.js';
import NickRef from './NickRef.vue';
import LinkedText from './LinkedText.vue';
import RenderSegments from './RenderSegments.vue';
import IgnoreModal from './IgnoreModal.vue';
import { useMessageActions } from '../composables/useMessageActions.js';
import type {
  MessageContext,
  MessageAction,
  MessageActionKey,
} from '../composables/useMessageActions.js';
import { useMemberActions } from '../composables/useMemberActions.js';
import type { MemberContext, MemberLike } from '../composables/useMemberActions.js';
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.js';
import { useWhoisStore } from '../stores/whois.js';
import { addressNick } from '../composables/useComposerOverlay.js';
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
  invited?: string;
  userhost?: string;
  // System-buffer lines (#355): the network this line is about, when any. The
  // prefix column resolves the network's current name from it.
  originNetworkId?: number | null;
  // RPE2E (#382): this line rode the wire encrypted. Carried through from the
  // server (extra JSON) for a future indicator — not rendered right now.
  e2e?: boolean;
  // Severity for `type: 'e2e'` status lines — drives the tag color.
  level?: 'info' | 'warn';
  // Relay-bot re-attribution (#277). When set, this row was authored by a nick
  // the user marked as a relay bot: `nick`/`text` have been swapped to the
  // embedded speaker, `relayBot` holds the bot's real nick (the actual IRC
  // entity), and `relaySource` is the `[source]` tag when the envelope had one.
  // These exist only on the per-render display clone, never on the stored row.
  relayBot?: string;
  relaySource?: string | null;
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
  clearedAt?: string;
  // Consolidation row (from consolidateRows)
  consolidation?: boolean;
  groups?: ConsolidationGroup[];
  time?: string;
  firstId?: number | string | null;
  lastId?: number | string | null;
  // Display-collapsing tags (mutated by collapseDisplay)
  continuationAuthor?: boolean;
  continuationTime?: boolean;
  // A NOHIGHLIGHT ignore rule matched — suppress the highlight tint (#301).
  nohilight?: boolean;
  // A highlight rule matched — server stamp (m.matched) OR live client eval
  // (#349), so a freshly added rule tints scrollback without a reload.
  highlight?: boolean;
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
const highlights = useHighlightRulesStore();
const relayBots = useRelayBotsStore();
const nicks = useNickColors();
const { isMobile, canHover } = useViewport();

const actionItalic = computed(() => !!settings.effective('look.action.italic'));
// Hover action bar toggle (#392). Off → the bar never renders and a left-click
// on a message opens the action menu instead (onMessageRowClick). Always off on
// touch via the CSS reveal media query, where tap opens the menu regardless.
const hoverActions = computed(() => !!settings.effective('look.message.hover_actions'));
// The message whose action menu is open — set when a tap (touch) or, with the
// hover bar toggled off, a click (desktop) opens it (onMessageRowClick). Gives
// the row a `selected` background so users with no hover can see which message
// the menu targets (#392). Cleared when the menu closes.
const selectedMessageId = ref<number | null>(null);
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
const { scrollToBottomToken, scrollToUnreadToken } = useScrollState();

// Unread-divider visibility tracking. The divider is pinned for the whole
// visit (dividerAfterId snapshot). The "Jump to unread" button exists to catch
// the case where you land in a channel and the marker is off-screen, so it
// surfaces only while the marker has neither been seen nor timed out this
// visit, and auto-retires UNREAD_BUTTON_TTL_MS after it first appears so it
// doesn't linger obnoxiously (#246). All of seen/expired/element reset on
// buffer switch. An IntersectionObserver on the (single) divider element
// drives setUnreadAnchor: off-screen-and-unseen surfaces the button with an
// up/down arrow, on-screen clears it and flips unreadSeen.
let unreadDividerEl: HTMLElement | null = null;
let unreadObserver: IntersectionObserver | null = null;
let unreadSeen = false;
let unreadExpired = false;
let unreadExpiryTimer: ReturnType<typeof setTimeout> | null = null;

// The button earns its keep in the first moments after you land in a channel
// and can't see the marker; if you don't jump then, you probably won't — so it
// gets a few seconds in the sun, then retires for the rest of the visit (#246).
const UNREAD_BUTTON_TTL_MS = 5000;

function startUnreadExpiry(): void {
  if (unreadExpiryTimer || unreadExpired) return;
  unreadExpiryTimer = setTimeout(() => {
    unreadExpiryTimer = null;
    unreadExpired = true;
    setUnreadAnchor(null);
  }, UNREAD_BUTTON_TTL_MS);
}

function clearUnreadExpiry(): void {
  if (unreadExpiryTimer) {
    clearTimeout(unreadExpiryTimer);
    unreadExpiryTimer = null;
  }
}

function evaluateUnread(entry: IntersectionObserverEntry): void {
  if (entry.isIntersecting) {
    unreadSeen = true;
    clearUnreadExpiry();
    setUnreadAnchor(null);
    return;
  }
  // Off-screen. Stay quiet once the marker has been seen this visit OR the
  // button has already had its run — new messages shoving the divider off the
  // top (while you read the live tail) must not re-summon it (#246).
  if (unreadSeen || unreadExpired) {
    setUnreadAnchor(null);
    return;
  }
  const top = entry.boundingClientRect.top;
  const rootTop = entry.rootBounds?.top ?? scroller.value?.getBoundingClientRect().top ?? 0;
  setUnreadAnchor(top < rootTop ? 'up' : 'down');
  startUnreadExpiry();
}

// At buffer entry the IntersectionObserver hasn't delivered its first callback
// yet — and if new messages shove the marker off-screen before it does, the
// only state IO ever reports is "off-screen", which would wrongly surface the
// button (#246). Seed unreadSeen synchronously from the divider's geometry
// right after the entry scroll settles, so a marker that was on screen when you
// arrived counts as seen even if it scrolls away a moment later.
function seedUnreadSeen(): void {
  const el = scroller.value;
  const divider = unreadDividerEl;
  if (!el || !divider) return;
  const er = el.getBoundingClientRect();
  const dr = divider.getBoundingClientRect();
  if (dr.bottom > er.top && dr.top < er.bottom) {
    unreadSeen = true;
    clearUnreadExpiry();
    setUnreadAnchor(null);
  }
}

// Vue function ref on the unread divider: called with the element when it
// mounts and null when it unmounts (e.g. dividerAfterId reset to 0). Keep the
// observer pointed at the live element across re-renders. The param type is
// Vue's VNodeRef union; this ref only ever binds a native <div>, but guard
// with instanceof so the observer is never handed a non-Element (a no-op,
// not a throw, if a component instance ever slipped through).
function setUnreadDividerEl(el: Element | ComponentPublicInstance | null): void {
  const next = el instanceof HTMLElement ? el : null;
  if (next === unreadDividerEl) return;
  if (unreadDividerEl && unreadObserver) unreadObserver.unobserve(unreadDividerEl);
  unreadDividerEl = next;
  if (next && unreadObserver) unreadObserver.observe(next);
  else if (!next) setUnreadAnchor(null);
}

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));
const messages = computed(() => buffer.value?.messages || []);

const selfLower = computed(() => {
  const b = buffer.value;
  // The app-scoped system buffer has no network (and no self nick).
  const sn = b && b.networkId != null ? networks.states[b.networkId]?.nick : null;
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
  const sn = b.networkId != null ? networks.states[b.networkId]?.nick : undefined;
  if (sn) set.add(sn);
  return set;
});

function time(iso: string | undefined): string {
  return formatTimestamp(iso ?? '', (tsFormat.value as string) ?? '');
}

// Drops the /clear marker for the currently-active buffer. Wired to the
// "Show earlier messages" button on the cleared divider; the server's
// buffer-cleared fan-out echoes back and clearedBeforeId reverts to 0.
function onUnclearClick(): void {
  const b = buffer.value;
  // /clear never applies to the app-scoped system buffer (no network).
  if (!b || b.networkId == null) return;
  buffers.unclearBuffer(b.networkId, b.target);
}

function rowClass(row: RenderRow) {
  const m = row.m;
  return {
    [`type-${m?.type}`]: true,
    self: m?.self,
    alt: row.alt,
    highlight: !!row.highlight && !row.nohilight,
    'cont-author': !!row.continuationAuthor,
    'cont-time': !!row.continuationTime,
    selected: m?.id != null && m.id === selectedMessageId.value,
  };
}

// Per-message action-bar wiring (issue #117). The hover bar renders the
// actions built by useMessageActions; the ignore confirmation modal and the
// reply hand-off to the composer are owned here so the action callbacks don't
// need to know which view they live in (mirrors MemberList's pattern).
const messageActions = useMessageActions();
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

// One stable context for every row — the handlers read `buffer.value` at call
// time, so there's no need to rebuild it per message (the bar re-evaluates for
// up to 500 rows on each render). `run()` is handed this on click.
const actionContext: MessageContext = {
  get networkId() {
    return buffer.value?.networkId ?? 0;
  },
  onReply: (msg) => {
    if (msg.nick) addressNick(msg.nick);
  },
  onIgnore: (msg) => {
    const { user, host } = parseUserHost(msg.userhost);
    ignoreTarget.value = {
      nick: msg.nick,
      user,
      host,
      networkId: buffer.value?.networkId ?? undefined,
    };
  },
};

function actionsFor(m: ChatMessage | undefined | null): MessageAction[] {
  if (!m) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return messageActions.buildActions(m as any);
}

function runAction(key: MessageActionKey, m: ChatMessage | undefined | null): void {
  if (!m) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messageActions.run(key, m as any, actionContext);
}

// Click/tap → message action menu (#392). The entry point whenever the hover
// action bar isn't doing the job: always on touch (no hover), and on desktop
// when the bar is toggled off — otherwise there'd be no way to reach the actions
// there. When the bar IS on (desktop default), a left-click stays a plain text
// click and the bar is the affordance. Right-click is always left to the
// browser's native menu (desktop users expect that).
function onMessageRowClick(e: MouseEvent, m: ChatMessage | undefined | null): void {
  if (canHover.value && hoverActions.value) return;
  if (!eligibleForActions(m)) return;
  // Clicks on a link follow the link; clicks on a nick are handled by NickRef
  // (which stops propagation), so they never reach here.
  if ((e.target as Element | null)?.closest('a')) return;
  // Don't pop the menu out from under a text selection (drag-select on desktop,
  // long-press select on touch) — let the user keep/copy their selection.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  selectedMessageId.value = m?.id ?? null;
  // Pass the row as the trigger so a second tap on the same message toggles its
  // menu closed (matches the nick menu), instead of just reopening it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messageActions.openMenu(
    m as any,
    actionContext,
    e.clientX,
    e.clientY,
    e.currentTarget as Element,
  );
}

// ─── Nick interactivity (#238) + mode-prefix glyph (#376) ──────────────────
// Message-list nicks behave exactly like their nicklist entry: a tap (or
// right-click / long-press) opens the shared member-action menu — Reply, Copy
// Nickname, whois, DM, note, friend, ignore, and op-gated kick/ban/op/voice.
// The menu and ignore modal are owned here, mirroring MemberList's pattern.
const memberActions = useMemberActions();
const contextMenu = useContextMenu();
const whois = useWhoisStore();

// Clear the selected-message highlight (declared up top) whenever the shared
// context menu closes — tap an item, tap outside, or Escape (#392).
watch(
  () => contextMenu.state.open,
  (open) => {
    if (!open) selectedMessageId.value = null;
  },
);

const showModePrefix = computed(() => !!settings.effective('look.nick.show_mode_prefix'));

// Look up a speaker in the active buffer by case-folded nick — servers send
// case-variant nicks, so we never key on exact casing.
function nickMember(nick: string): BufferMember | undefined {
  const b = buffer.value;
  if (!b || !nick) return undefined;
  const lc = nick.toLowerCase();
  return b.members?.find((m) => m.nick.toLowerCase() === lc);
}

// The current user's own modes in the active channel, gating the operator
// actions in the nick menu (mirrors MemberList's selfModes).
const selfModes = computed<string[]>(() => {
  const sl = selfLower.value;
  if (!sl) return [];
  const me = buffer.value?.members?.find((m) => m.nick.toLowerCase() === sl);
  return me && Array.isArray(me.modes) ? me.modes : [];
});

// The author's channel modes for the prefix glyph — channel buffers only (DMs
// and the system buffer carry no modes). Returns undefined (no glyph) when the
// speaker isn't a current member, e.g. backlog from someone who has since left.
// Called per message row at render, so short-circuit when the glyph is off (the
// default) to skip the per-row member-list scan entirely.
function authorModes(m: ChatMessage | undefined): string[] | undefined {
  if (!showModePrefix.value || !m?.nick) return undefined;
  const b = buffer.value;
  if (!b || !b.target?.startsWith('#')) return undefined;
  return nickMember(m.nick)?.modes;
}

function nickIsSelf(member: MemberLike | string): boolean {
  const sl = selfLower.value;
  const nick = typeof member === 'string' ? member : member.nick;
  return !!sl && !!nick && nick.toLowerCase() === sl;
}

function nickMenuContext(): MemberContext {
  return {
    networkId: buffer.value?.networkId ?? 0,
    isSelf: nickIsSelf,
    onIgnore: (member) => {
      const nick = typeof member === 'string' ? member : member.nick;
      ignoreTarget.value = {
        nick,
        user: typeof member === 'string' ? null : (member.user ?? null),
        host: typeof member === 'string' ? null : (member.host ?? null),
        networkId: buffer.value?.networkId ?? undefined,
      };
    },
    channel: buffer.value?.target ?? null,
    selfModes: selfModes.value,
  };
}

// `m` is the source message, used only to recover a userhost for a speaker who
// is no longer in the member list — so whois/ban masks still work on backlog.
// Omit it for nicks where the message's userhost belongs to someone else (e.g.
// the kicked user in a kick line).
function onNickMenu(e: MouseEvent, nick: string | undefined, m?: ChatMessage): void {
  if (!buffer.value) return;
  // Nicks open on left-click, so pass the clicked element as the trigger:
  // re-clicking the same name toggles its menu closed, like the kebab menus.
  const trigger = (e.currentTarget as Element | null) ?? null;
  // Relay virtual speaker (#277): the displayed author is the embedded speaker,
  // not a real IRC user, so the full member menu (DM, ignore, kick, ban) is
  // meaningless. Give it a trimmed menu aimed at the relayed nick instead.
  if (m?.relayBot && nick && buffer.value.networkId != null) {
    openRelayNickMenu(nick, m.relayBot, buffer.value.networkId, e.clientX, e.clientY, trigger);
    return;
  }
  if (!nick) return;
  // Prefer the live member (modes for op-gating, host for a clean ban mask);
  // fall back to the message's own userhost so a departed speaker stays
  // actionable.
  const member: MemberLike = nickMember(nick) ?? { nick, ...parseUserHost(m?.userhost) };
  memberActions.openMenuFor(member, nickMenuContext(), e.clientX, e.clientY, trigger);
}

// Context menu for a relayed virtual speaker (#277). Only the actions that make
// sense for a name with no IRC presence: address them in a reply (the bridge
// carries it back the other way) and copy the name — both targeting the relayed
// nick. View Profile, by contrast, opens the relay *bot's* profile: it's the
// only real IRC entity here, so its whois actually resolves.
function openRelayNickMenu(
  nick: string,
  bot: string,
  networkId: number,
  x: number,
  y: number,
  triggerEl: Element | null = null,
): void {
  const items: ContextMenuItem[] = [
    { label: `Reply to ${nick}`, icon: 'fa-solid fa-reply', onClick: () => addressNick(nick) },
    {
      label: 'Copy Nickname',
      icon: 'fa-regular fa-copy',
      onClick: () => {
        navigator.clipboard?.writeText(nick).catch(() => {});
      },
    },
    { divider: true },
    {
      label: 'View Profile…',
      icon: 'fa-solid fa-id-card',
      onClick: () => whois.openViewer(networkId, bot),
    },
  ];
  contextMenu.open(items, x, y, triggerEl);
}

// The "via" affordance shown next to a re-attributed relay line (#277): the
// `[source]` platform tag. Only rendered when the envelope actually carried a
// source (the template gates on relaySource), so a bare `<nick> message` relay
// shows no tag and the re-attributed nick just reads as the speaker. The title
// (set in the template) still names the bot, so provenance is one hover away.
function relayLabel(m: ChatMessage | undefined): string {
  return m?.relaySource || '';
}

// A coloured nick mention inside message text (emitted by RenderSegments). The
// mentioned user isn't the message author, so there's no userhost to recover
// from the row — pass the nick alone and let onNickMenu resolve a live member
// (or fall back to a bare-nick menu).
function onMentionMenu(nick: string, e: MouseEvent): void {
  onNickMenu(e, nick);
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

const showEventHost = computed(() => !!settings.effective('chat.show_event_host'));

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
  if (!b || b.networkId == null || b.target.startsWith(':server:')) return null;
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

  // /clear marker. Filter is suppressed while the buffer is detached — a
  // search/highlight jump shows context around its anchor regardless of the
  // marker, so the user can peek without losing their fresh slate. clearedAt
  // gating means a buffer with no active clear emits no divider; we still
  // run the loop normally.
  const clearedBeforeId = buf?.detached ? 0 : buf?.clearedBeforeId || 0;
  const clearedAt = buf?.detached ? null : buf?.clearedAt || null;
  let clearedInserted = !clearedAt;
  const pushClearedDivider = () => {
    if (!clearedAt) return;
    out.push({ divider: 'cleared', clearedAt, key: 'cleared-divider' });
  };

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
  const bufTarget = buf?.target ?? '';
  const bufIsDm = !bufTarget.startsWith('#') && !bufTarget.startsWith(':server:');

  for (let i = 0; i < list.length; i++) {
    // Cast to ChatMessage so template-used properties are typed; BufferMessage
    // uses [key: string]: unknown for extra fields (time, self, alt, userhost…).
    const m = list[i] as ChatMessage;
    const key = m.id ?? `live:${i}`;
    let hidden = false;

    // /clear filter (hard hide). Comes first so the divider, when emitted
    // below, lands above every other filter's surviving rows.
    if (clearedBeforeId > 0 && m.id != null && Number(m.id) <= clearedBeforeId) continue;

    // Render-time ignore filter (issue #301). Self-authored events are never
    // hidden. The matcher gets full event context so level/channel/pattern
    // rules apply. A NOHIGHLIGHT rule doesn't hide — it suppresses the row's
    // highlight tint (rowNohilight → rowClass), which also retro-applies to
    // backlog rows the server stamped before the rule existed. Removing a rule
    // re-runs this computed and hidden rows reappear without a backlog reload.
    let rowNohilight = false;
    if (!m.self && m.nick && networkId) {
      const verdict = ignores.evaluate(networkId, {
        nick: m.nick,
        userhost: m.userhost ?? null,
        target: bufTarget,
        text: m.text ?? '',
        type: m.type,
        isDm: bufIsDm,
      });
      if (verdict.hide) continue;
      rowNohilight = verdict.nohilight;
    }

    // Render-time highlight match (#349). The server stamps m.matched at insert
    // (drives notifications + the highlights feed). For the live tint we evaluate
    // against the *current* rules instead, so adding a rule lights matching rows
    // up AND removing/disabling one clears them — honoring -network/-channels/
    // -mask scope. Client evaluation is authoritative once the rule store has
    // loaded; until then we fall back to the server stamp.
    let rowHighlight = !!m.matched;
    if (highlights.loaded && !m.self && networkId) {
      rowHighlight = highlights.evaluate(networkId, {
        nick: m.nick,
        userhost: m.userhost ?? null,
        target: bufTarget,
        text: m.text ?? '',
        type: m.type,
        self: m.self,
      });
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

    // Cleared divider sits at the very top of the visible region — above the
    // day-change marker so the user sees "cleared at …" before any date.
    if (!clearedInserted) {
      pushClearedDivider();
      clearedInserted = true;
    }

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
    // Relay-bot re-attribution (#277). If this line's author is a nick the user
    // marked as a relay/bridge bot, parse its `[source] <nick> message` envelope
    // and display the embedded speaker as the author instead. Display-only: we
    // push a shallow clone so the stored row keeps the bot's nick/text (unmark
    // restores the raw view instantly). Coloring, author-continuation collapse,
    // and the body all key off the clone, so a relayed user gets their own
    // colour and consecutive lines from the same person collapse naturally.
    // Highlights/ignores ran above on the raw line — the bot's full text is a
    // superset of the embedded text, so a ping inside it still fires. Restricted
    // to plain messages: relays bridge speech as PRIVMSG, and action/notice
    // re-attribution would tangle with their special body rendering.
    let mDisplay = m;
    if (
      m.type === 'message' &&
      m.nick &&
      !m.self &&
      networkId &&
      relayBots.isRelay(networkId, m.nick)
    ) {
      const parsed = parseRelayMessage(m.text ?? '', relayBots.patternFor(networkId, m.nick));
      if (parsed) {
        mDisplay = {
          ...m,
          nick: parsed.nick,
          text: parsed.text,
          relayBot: m.nick,
          relaySource: parsed.source,
        };
      }
    }
    out.push({
      m: mDisplay,
      alt: STRIPED_TYPES.has(m.type) && !!m.alt,
      key,
      nohilight: rowNohilight,
      highlight: rowHighlight,
    });
  }

  // Both presence timestamps newer than every loaded message → markers land
  // at the very end of the buffer (e.g. you went away after the most recent
  // message and nothing has arrived yet).
  if (!awayInserted) pushAwayDivider();
  if (!backInserted) pushBackDivider();
  // Every loaded row got filtered by /clear (or the buffer is empty) — drop
  // the divider at the end so the user still sees an undo affordance.
  if (!clearedInserted) pushClearedDivider();

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
  // prefix/time cells (subgrid stays aligned).
  if (effectiveCollapseAuthors.value || effectiveCollapseTimestamps.value) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collapseDisplay(final as any, {
      collapseAuthors: effectiveCollapseAuthors.value,
      authorWindowMs: collapseAuthorsWindowMs.value,
      collapseTimestamps: effectiveCollapseTimestamps.value,
      formatTime: (iso) => time(iso),
    });
  }
  return final;
});

// The origin-network name for a system-buffer line (#355), or null when the
// line is network-agnostic. Preferred source is the stable id, resolved to the
// network's *current* name at render time, so a rename (or the networks store
// loading after the log snapshot) updates the prefix live. Falls back to the
// `net:<name>` scope label — a snapshot of the name when the line was written —
// for older rows that predate the id and for a network that no longer exists,
// so existing lines still carry a label. null = network-agnostic, which
// prefixText renders as "System" (real server MOTD, type 'motd', is the `--`
// case — not this).
function systemNetworkName(m: ChatMessage | undefined): string | null {
  if (m?.type !== 'system') return null;
  const id = m.originNetworkId;
  if (typeof id === 'number') {
    const name = networks.networkById(id)?.name;
    if (name) return name;
  }
  const scope = m.scope;
  if (typeof scope === 'string' && scope.startsWith('net:')) {
    return scope.slice('net:'.length) || null;
  }
  return null;
}

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
    case 'invite':
      return '--';
    case 'system':
      // System-buffer log lines (#355). Tied to a network → that network's
      // current name; other app-level lines (away/back, server lifecycle,
      // node, …) → "System".
      return systemNetworkName(m) ?? 'System';
    case 'e2e':
      // RPE2E status echoes get their own tag (not the generic "System") so the
      // user can tell encryption lines apart at a glance (#382).
      return 'E2E';
    case 'ctcp':
      // CTCP request/reply/echo status lines get their own tag (#263).
      return 'CTCP';
    case 'error':
      return '!!';
    default:
      return '';
  }
}

// When the "Show user@host on join/part/quit/nick" setting is on, return the
// affected user's ` (user@host)` suffix (leading space + parens, ready to drop
// straight after the nick) for a presence event line — join, part, quit, nick
// (#322). Returns '' when the setting is off, the userhost is missing
// (pre-upgrade backlog rows, or an event with no prefix), or either half is
// absent — the server stores an empty ident/host when it lacks one
// (`nick!@host` / `nick!ident@`), and a half-mask like `(@host)` reads worse
// than nothing, so we only render when both pieces are present. The full
// formatting (leading space + parens) lives here so the four presence-line
// templates share one source of truth and each call it once (only the matching
// branch renders per row); reuses parseUserHost so parsing matches the ignore
// flow exactly.
function eventHostSuffix(m: ChatMessage | undefined): string {
  if (!showEventHost.value) return '';
  const { user, host } = parseUserHost(m?.userhost);
  if (!user || !host) return '';
  return ` (${user}@${host})`;
}

function prefixClass(m: ChatMessage | undefined) {
  return {
    nick: m?.type === 'message' || m?.type === 'notice',
    'action-marker': m?.type === 'action',
    italic: m?.type === 'action' && actionItalic.value,
    self: m?.self,
    // A warn-level E2E line (TOFU warning, refused send) colors its tag like an
    // error; info-level stays the calm E2E color.
    'e2e-warn': m?.type === 'e2e' && m?.level === 'warn',
    // A warn-level CTCP line (e.g. "/ctcp: this network isn't connected") reads
    // as an error too; info-level stays muted (#263).
    'ctcp-warn': m?.type === 'ctcp' && m?.level === 'warn',
    [`p-${m?.type}`]: true,
  };
}

function prefixStyle(m: ChatMessage | undefined): CSSProperties | null {
  if (m?.type === 'message' || m?.type === 'notice') {
    if (m.self) return { color: selfColor.value as string };
    const c = nicks.color(m.nick ?? '');
    return c ? { color: c } : null;
  }
  // System-buffer lines tied to a network (#355) color the network name with
  // the same deterministic palette as nicks, so each network gets a stable,
  // distinguishable color. Network-agnostic "System" lines have no origin
  // network and keep the muted prefix styling (the .p-system class).
  const netName = systemNetworkName(m);
  if (netName) {
    const c = nicks.color(netName);
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
  if (buf.networkId == null) return;
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
  if (!buf || buf.networkId == null || !buf.detached || buf.loadingHistory) return;
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

// Bump the "N new ↓" unread counter for a live append that landed below a
// scrolled-up reader — unless the new tail is from an ignored sender (they
// won't see it scroll into view, so "1 new ↓" pointing at nothing is
// confusing) or is an id-less ephemeral status echo (a /e2e line, the user's
// own command output), which shouldn't inflate the count.
function maybeBumpNewBelow() {
  const tail = messages.value[messages.value.length - 1] as ChatMessage | undefined;
  const nid = buffer.value?.networkId;
  const tailIgnored =
    tail &&
    !tail.self &&
    tail.nick &&
    nid &&
    ignores.isHidden(nid, {
      nick: tail.nick,
      userhost: tail.userhost ?? null,
      target: tail.target,
      text: tail.text ?? '',
      type: tail.type,
      isDm: !tail.target.startsWith('#') && !tail.target.startsWith(':server:'),
    });
  if (!tailIgnored && tail?.id != null) bumpNewBelow();
}

// Re-pin the viewport so the row with `anchorId` keeps its on-screen position
// across the reflow this watcher tick triggers: capture its offsetTop BEFORE
// nextTick, restore scrollTop after. `useHeightFallback` decides what happens
// when the anchor row can't be measured after the reflow. A pure PREPEND only
// adds content above the viewport, so a scrollHeight-delta correction is a safe
// best-effort there. A CAP-EVICT also adds a row BELOW the viewport, so that
// same formula would over-scroll by the appended row's height — pass false and
// leave scrollTop untouched (at most one row of drift for that event, never a
// downward jump). Anchoring by element id keeps re-flow from changing column
// widths or differing message heights from drifting the math.
async function pinAnchorRow(el: HTMLElement, anchorId: number, useHeightFallback: boolean) {
  const anchor = el.querySelector(`[data-msg-id="${anchorId}"]`) as HTMLElement | null;
  const anchorOldTop = anchor ? anchor.offsetTop : null;
  const oldScrollTop = el.scrollTop;
  const oldScrollHeight = el.scrollHeight;
  await nextTick();
  const anchorNew =
    anchorOldTop != null
      ? (el.querySelector(`[data-msg-id="${anchorId}"]`) as HTMLElement | null)
      : null;
  if (anchorNew) {
    el.scrollTop = anchorNew.offsetTop - (anchorOldTop! - oldScrollTop);
  } else if (useHeightFallback) {
    el.scrollTop = el.scrollHeight - oldScrollHeight + oldScrollTop;
  }
}

// Watch the messages array shape so we can react to:
//   - prepend (older history): pin the OLD first row's viewport position.
//   - replace (wholesale snapshot): snap to bottom.
//   - cap-evict while scrolled up: a live append at MAX_PER_BUFFER also
//     splices the oldest row off the FRONT, so pin the new first row's
//     viewport position the same way a prepend does (#448).
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
    // ID-less (ephemeral) rows — /e2e and other server command echoes surfaced
    // via publishEphemeral — carry `id === undefined`, so the id-presence test
    // can't anchor on them. Fall back to structural signals around them:
    //   • growth that isn't a prepend is an append — covers a new ephemeral tail
    //     AND a real message arriving right after an ephemeral one (the latter
    //     would otherwise match neither branch and fail to stick to bottom); and
    //   • a same-length cap-evict whose OLD tail was id-less is still an append,
    //     not a wholesale replace, so a reader scrolled up isn't yanked down.
    const oldTailPresent = oldLastId != null && messages.value.some((m) => m.id === oldLastId);
    const appended =
      (lastChanged && oldTailPresent) ||
      (grew && !firstChanged) ||
      (lastChanged && oldLastId == null && newLen >= prevLen);
    // Pure prepend: anchor by element ID so re-flow from changing column
    // widths or differing message heights doesn't drift the math. With the
    // loading notice gone from the template, the OLD DOM and NEW DOM share
    // the same set of [data-msg-id] elements with stable identity above
    // and below the prepend boundary.
    if (firstChanged && !lastChanged && grew && oldFirstId != null) {
      await pinAnchorRow(el, oldFirstId, true);
      ensureViewportFilled();
      return;
    }
    // Wholesale replace (fresh backlog from a re-snapshot): both ends shifted
    // and the previous tail is gone — distinct from a cap-evicting append,
    // which shifts both ends but keeps the tail (see `appended` above).
    // "Filled from empty" counts too: the system-log snapshot landing in the
    // freshly-activated, still-empty system buffer on load (#355). The activeKey
    // watcher's scroll already ran while it was empty, and firstChanged/
    // lastChanged are gated on prevLen>0, so without this it never snaps down.
    const filledFromEmpty = prevLen === 0 && newLen > 0;
    const replaced = (firstChanged && lastChanged && !appended) || filledFromEmpty;
    const isDetached = !!buffer.value?.detached;
    // Cap-evict while scrolled up: the buffer was at MAX_PER_BUFFER, so this
    // live append also spliced the oldest row(s) off the FRONT (above the
    // viewport). That shrinks content above the read position; with
    // overflow-anchor disabled the browser won't compensate, so without this
    // the rows the user is reading drift upward one message-height per
    // arrival (#448). Anchor on the surviving new-front row and re-pin
    // scrollTop after the reflow. Only when NOT pinned to the bottom — a pinned
    // reader is scrolling along with the live tail, and the append branch below
    // already follows it down. useHeightFallback is false: unlike a prepend,
    // this event also adds a row below the viewport, so if the new-front row
    // isn't measurable (e.g. a history prepend landed in the same flush and put
    // an unseen row at the front), leave scrollTop alone rather than let the
    // prepend-style fallback over-scroll and jump the view.
    if (appended && firstChanged && !stickToBottom.value && !isDetached && newFirstId != null) {
      await pinAnchorRow(el, newFirstId, false);
      maybeBumpNewBelow();
      ensureViewportFilled();
      return;
    }
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
    // Live append (new message arrived) that did NOT evict from the front —
    // a cap-evict while scrolled up is handled by the anchored branch above
    // and returned early, and a cap-evict while pinned scrolls along here.
    // When the user is pinned, scroll along; otherwise content was added only
    // below the viewport, so the current scrollTop still points at the row
    // they were reading — just track the unread-below count so the status bar
    // can surface "[N new ↓]" (maybeBumpNewBelow skips ignored/ephemeral
    // tails so the badge never points at a row that won't scroll into view).
    //
    // Pager-driven appends (mode='after' response while detached) share this
    // shape — same `appended` test passes. We let them through without any
    // scroll adjustment for the same reason, and isDetached gates out the
    // bump since these aren't live events.
    if (appended && !isDetached) {
      if (stickToBottom.value) scrollToBottom();
      else maybeBumpNewBelow();
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
    unreadSeen = false;
    unreadExpired = false;
    clearUnreadExpiry();
    resetScrollState();
    await nextTick();
    scrollToBottom();
    seedUnreadSeen();
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

// StatusBar's "Return to present ↓" click increments scrollToBottomToken.
// Watching the token (rather than wiring a callback) keeps the composable
// stateless and avoids leaking refs to MessageList's DOM out of the component.
watch(scrollToBottomToken, async () => {
  await nextTick();
  stickToBottom.value = true;
  setStuckToBottom(true);
  scrollToBottom();
});

// Center the (single) unread divider element, marking not-stuck first so a
// live message can't yank us back to the tail mid-read. The observer flips
// unreadSeen once the divider lands in view, retiring the button.
function scrollDividerIntoView() {
  const target = scroller.value?.querySelector('.unread-divider');
  if (!target) return;
  stickToBottom.value = false;
  setStuckToBottom(false);
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// StatusBar's "Jump to unread" click increments scrollToUnreadToken.
//
// The divider only sits at the real read/unread seam when some loaded row is
// at or below the boundary (dividerAfterId). In a large backlog every loaded
// row is newer than the boundary, so renderRows pins the divider to the TOP
// of the slice instead — scrolling to that fiction lands at scrollTop≈0, trips
// the history pager, and stalls before reaching the seam (issue #216). In that
// case fetch a slice centered on the boundary first — the same loadAround path
// jump-to-message uses — then center the real divider once it lands.
watch(scrollToUnreadToken, async () => {
  await nextTick();
  if (!scroller.value) return;
  const buf = buffer.value;
  const dividerAfterId = buf?.dividerAfterId || 0;
  const dividerPinnedToTop =
    dividerAfterId > 0 &&
    buf != null &&
    buf.networkId != null &&
    buf.oldestId != null &&
    buf.oldestId > dividerAfterId;
  if (dividerPinnedToTop && buf.networkId != null && buf.hasMoreOlder && !buf.loadingHistory) {
    stickToBottom.value = false;
    setStuckToBottom(false);
    const wantKey = networks.activeKey;
    buffers.loadAround(buf.networkId, buf.target, dividerAfterId);
    // loadAround rolls loadingHistory back to false synchronously if the send
    // failed (offline) — nothing will land to drive the scroll, and there's no
    // more history to pull, so fall back to centering the top-pinned divider so
    // the click still has a visible effect.
    if (!buf.loadingHistory) {
      scrollDividerIntoView();
      return;
    }
    // applyAroundSlice clears loadingHistory when the around response replaces
    // buf.messages; that false transition is our "slice landed" signal (more
    // reliable than messages.length, which can be unchanged when both the live
    // window and the slice sit at MAX_PER_BUFFER).
    const stop = watch(
      () => buf.loadingHistory,
      async (loading) => {
        if (loading) return;
        stop();
        // Bail if the user switched buffers while the slice was in flight —
        // the scroller now belongs to a different buffer.
        if (networks.activeKey !== wantKey) return;
        await nextTick();
        scrollDividerIntoView();
      },
    );
    return;
  }
  scrollDividerIntoView();
});

// Anything that shrinks MessageList's clientHeight (iOS soft keyboard sliding
// up and scrolling the page; the message-input textarea auto-growing past one
// row; the desktop window resizing) shrinks the visible window from the bottom
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
  if (typeof IntersectionObserver !== 'undefined' && scroller.value) {
    unreadObserver = new IntersectionObserver(
      (entries) => {
        // Honor a "was visible" entry anywhere in the batch: a visible→hidden
        // pair can land together when new messages shove the marker off the top
        // in the same frame, and taking only the last entry would drop the
        // "seen" half and wrongly keep the button alive (#246). Fall back to
        // the latest position when nothing in the batch was intersecting.
        const entry = entries.find((e) => e.isIntersecting) ?? entries[entries.length - 1];
        if (entry) evaluateUnread(entry);
      },
      { root: scroller.value, threshold: 0 },
    );
    // The divider may already be mounted (immediate activeKey render) before
    // the observer exists — pick it up now if so.
    if (unreadDividerEl) unreadObserver.observe(unreadDividerEl);
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
  if (unreadObserver) {
    unreadObserver.disconnect();
    unreadObserver = null;
  }
  clearUnreadExpiry();
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

// Budget (in animation frames, ~1s at 60fps) for the target row to mount before
// we give up. On a cold-start deep link or a large around-slice the row often
// isn't painted on the first tick; a single querySelector would silently abandon
// the jump, which is the main reason a *delivered* jump fails to scroll on mobile.
const SCROLL_RETRY_FRAMES = 60;

watch(
  () => props.pendingScrollId,
  async (id) => {
    if (id == null) return;
    await nextTick();
    let attempts = 0;
    const tryScroll = () => {
      // A newer jump superseded this one — abandon the stale retry loop.
      if (props.pendingScrollId !== id) return;
      const el = scroller.value;
      if (!el) return;
      const target = el.querySelector(`[data-msg-id="${id}"]`);
      if (!target) {
        if (attempts++ < SCROLL_RETRY_FRAMES) requestAnimationFrame(tryScroll);
        return;
      }
      stickToBottom.value = false;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('scroll-target');
      setTimeout(() => target.classList.remove('scroll-target'), 1500);
    };
    tryScroll();
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
  padding: var(--space-2) var(--space-6);
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
/* The row whose tap-opened action menu is open (touch). Same background as
   hover, but authored without `:hover` so it survives the build's hover gating
   (#115) and shows on touch — where there's no hover, this is the only cue for
   which message the menu targets (#392). */
.line.selected {
  background: var(--bg-soft);
}
/* Override only the alt-row background on hover/selected — not its text color.
   The `.line.alt` selector outweighs `.line:hover` / `.line.selected`, so the
   background needs restating here, but the alt foreground (--alt-fg) stays put:
   it's a background-only cue and shouldn't shift the text color. */
.message-list:not(.compact) .line.alt:hover,
.message-list:not(.compact) .line.alt.selected {
  background: var(--bg-soft);
}

/* Hover-revealed action bar on eligible rows (issue #117). A small floating
   toolbar — same card treatment as the toast stack (bg + border + drop
   shadow) — anchored to the top-right of the line, floating just above it so
   the bar barely overlaps the top edge instead of covering the message text.
   Desktop only: the build wraps every `:hover` rule in `@media (hover: hover)`
   (#115), so on touch this reveal simply doesn't exist — the bar never shows
   and the old sticky-:hover two-tap never fires. When the bar is hidden (touch,
   or toggled off on desktop), the same actions are reached by clicking/tapping a
   message — see onMessageRowClick; right-click stays the native browser menu.
   The bar can also be turned off via look.message.hover_actions. */
.row-actions {
  position: absolute;
  /* Sit the bar fully above the row, then nudge down a few px so its bottom
     edge just clips the top of the line — anchors it to its own row without
     obscuring the text. */
  top: var(--space-2);
  right: var(--space-3);
  transform: translateY(-100%);
  display: flex;
  align-items: center;
  gap: var(--space-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  padding: var(--space-1);
  opacity: 0;
  pointer-events: none;
  z-index: var(--z-base);
}
/* Keyboard a11y reveal stays unconditional so focus-within works everywhere.
   The hover reveal below is authored plain; the build gates it behind
   `@media (hover: hover)` (#115) so it never fires on touch. */
.row-actions:focus-within {
  opacity: 1;
  pointer-events: auto;
}
.line:hover .row-actions {
  opacity: 1;
  pointer-events: auto;
}
.row-action {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: var(--radius-sm);
}
.row-action:hover {
  color: var(--fg);
}
.row-action.active {
  color: var(--accent);
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
/* RPE2E status tag (#382): the calm "E2E" lock-green for info, error-red when a
   line is a warning (TOFU change, refused send). */
.prefix.p-e2e {
  color: var(--good);
}
.prefix.p-e2e.e2e-warn {
  color: var(--bad);
}
.prefix.p-nick,
.prefix.p-mode,
.prefix.p-topic,
.prefix.p-motd,
.prefix.p-away,
.prefix.p-back,
/* CTCP request/reply/echo status (#263): informational, so muted like motd. */
.prefix.p-ctcp,
.prefix.p-cons {
  color: var(--fg-muted);
}
/* …except a warn-level CTCP line (failed send) colors its tag like an error. */
.prefix.p-ctcp.ctcp-warn {
  color: var(--bad);
}
/* "System" lines (#355) read as the full-strength foreground, not muted — the
   app speaking in its own voice. A network-tied system line overrides this with
   its hashed network color inline (prefixStyle). */
.prefix.p-system {
  color: var(--fg);
}

.body {
  position: relative;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  padding-left: 1ch;
}
/* Relay-bot origin tag (#277): the bracketed [source] before the re-attributed
   text — mirrors how the bot framed the line, so it reads as provenance rather
   than part of the message. Muted, no glyph; font size stays uniform per house
   style. */
.relay-via {
  color: var(--fg-muted);
  margin-right: 1ch;
  white-space: nowrap;
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
    padding: var(--space-2) var(--space-4);
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
  padding: var(--space-2) var(--space-4);
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
  padding: var(--space-1) 0;
  /* Group separator: every non-continuation line marks the start of a new
     visual cluster (message head, action, notice, system event,
     consolidation summary). Transparent (not padding) so adjacent hover
     backgrounds don't touch across the gap. Adjacent siblings collapse
     vertical margins, so back-to-back clusters get one 10px gap, not 20px. */
  margin-top: var(--space-5);
}
/* Continuation message rows render only body + time — no head, no cluster
   start — and should sit tight under the previous line. */
.message-list.compact .line.cont-author {
  margin-top: 0;
}
/* Client-side dividers (unread/away/back/date) also mark a cluster boundary,
   so give them the same top gap as .line in compact mode. */
.message-list.compact .notice {
  margin-top: var(--space-5);
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
  padding: var(--space-3) 0;
  margin: 0;
}

/* Boundary between read and unread messages. Pinned to the lastReadId
   snapshot taken on buffer activation; advances only after switch-away.
   Dashed border on either side of the label, warn-colored to differentiate
   from the muted "start of history" notice. */
.unread-divider {
  color: var(--warn);
  font-style: normal;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: var(--space-2) 0;
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.unread-divider::before,
.unread-divider::after {
  content: '';
  flex: 1;
  min-width: var(--space-7);
  border-top: 1px dashed var(--warn);
  opacity: 0.6;
}

/* Self-presence markers (away / back) and the day-change marker. Same shape
   as the unread divider so they read as a sibling kind of "structural" line,
   but in the muted fg color since they're informational rather than
   action-required. */
.presence-divider,
.date-divider,
.cleared-divider {
  font-style: normal;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: var(--space-2) 0;
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.presence-divider::before,
.presence-divider::after,
.date-divider::before,
.date-divider::after,
.cleared-divider::before,
.cleared-divider::after {
  content: '';
  flex: 1;
  min-width: var(--space-7);
  border-top: 1px dashed var(--fg-muted);
  opacity: 0.6;
}

/* Center label for all flanked markers. Shrinks and wraps as a centered block
   between the two rules (which floor at min-width and stay vertically centered),
   so long labels — the unbounded /away reason worst case — wrap cleanly instead
   of crowding out the lines. overflow-wrap: anywhere only breaks mid-word as a
   last resort for an unbreakable token; word boundaries are preferred so the
   uppercase + letter-spacing styling stays readable. */
.notice-label {
  flex: 0 1 auto;
  min-width: 0;
  text-align: center;
  overflow-wrap: anywhere;
}

/* Undo affordance on the /clear divider — text-only button styled inline
   with the label so the whole line reads as one structural anchor. */
.cleared-undo {
  background: none;
  border: none;
  color: var(--fg-muted);
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  text-decoration: underline;
  cursor: pointer;
  padding: 0;
}
.cleared-undo:hover {
  color: var(--accent);
}
</style>
