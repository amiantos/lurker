<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The reply thread panel (#1225). On desktop it is a column bolted to the side
  of the chat: its rows are the chat grid's (subgrid), so its head sits level
  with the topic bar, and its lines and composer fill the rows of the message
  list, status bar and main composer, the composer at the foot, level with the
  main one at rest and growing up into the lines. On mobile (`screen`) it is a
  screen over the buffer, headed by the shell's bar.

  Two modes, by route (useThreadRoute):

    thread — the line that started it, a rule with the count, then every reply
             in order, always in the list's compact layout (head line over the
             body, avatars when they're on, the compact density tokens and
             timestamp formats): the panel is narrow like a phone, and the
             three-column grid never fits it. Links unfurl as they do in the
             list (inline media and previews, usePreviewBody's gate). No reply
             quotes: the thread's order is the context, and the `nick: ` a
             reply opens with is dropped as the list drops it. Lines have the message list's
             actions bar Reply and Quote.
    list   — the buffer's threads by last activity (ThreadList).

  With the thread on screen, replies the user hasn't seen are read as they are
  shown (threads.markViewRead); the channel's own lines are untouched.
-->

<template>
  <div class="thread-panel" :class="{ 'is-list': mode === 'list', screen }">
    <template v-if="!screen">
      <header class="panel-head">
        <button
          v-if="mode === 'thread'"
          type="button"
          class="link"
          title="All threads here"
          aria-label="All threads here"
          @click="showList"
        >
          <ListTreeIcon />
        </button>
        <span class="panel-title">{{ mode === 'list' ? 'Threads' : 'Thread' }}</span>
        <button type="button" class="link close" title="Close" aria-label="Close" @click="close">
          <XIcon />
        </button>
      </header>
      <div class="panel-divider"></div>
    </template>

    <ThreadList v-if="mode === 'list' && bufferId != null" :buffer-id="bufferId" />

    <!-- One column for the lines and the composer: see .thread-body. -->
    <div v-else class="thread-body">
      <div
        ref="scroller"
        class="lines"
        :class="{ compact: true, avatars: showAvatars }"
        @scroll.passive="onScroll"
      >
        <div
          v-if="!view || (view.loading && !view.root && view.replies.length === 0)"
          class="notice"
        >
          loading thread…
        </div>
        <template v-else>
          <template v-for="row in rows" :key="row.key">
            <div v-if="row.rule" class="rule">
              <span>{{ row.rule }}</span>
            </div>
            <div v-else-if="row.missing" class="t-line missing root">
              <span class="t-body missing">original message unavailable</span>
            </div>
            <div
              v-else-if="row.line"
              class="t-line"
              :class="lineClass(row)"
              :data-msg-id="row.line.id"
              @click="onLineClick($event, row.line)"
            >
              <template v-if="row.line.type === 'message'">
                <NickAvatar
                  v-if="showAvatars && !row.cont"
                  class="avatar"
                  :nick="String(row.line.nick ?? '')"
                  :network-id="view?.networkId ?? null"
                  :self="!!row.line.self"
                />
                <div v-if="!row.cont" class="head">
                  <span class="prefix nick" :class="{ self: row.line.self }"
                    ><NickRef :nick="String(row.line.nick ?? '')"
                  /></span>
                  <span class="time" :title="fullTime(row.line)">{{ time(row.line) }}</span>
                </div>
              </template>
              <template v-else>
                <span class="time" :title="fullTime(row.line)">{{ time(row.line) }}</span>
                <span class="prefix" :class="prefixClass(row.line)"
                  ><NickRef
                    v-if="row.line.type === 'message'"
                    :nick="String(row.line.nick ?? '')"
                  /><template v-else>{{ prefixText(row.line) }}</template></span
                >
              </template>
              <span v-if="row.hidden" class="t-body missing">(ignored)</span>
              <!-- A deleted line (#1013): its placeholder, where its words were. -->
              <span v-else-if="deletedLabel(row.line)" class="t-body missing">{{
                deletedLabel(row.line)
              }}</span>
              <span
                v-else
                class="t-body"
                :class="{ italic: row.line.type === 'action' && actionItalic }"
                ><template v-if="row.line.type === 'action'"
                  ><NickRef :nick="String(row.line.nick ?? '')" />{{ ' ' }}</template
                ><MessageBody
                  v-if="previewBody(row.line)"
                  :text="row.text ?? row.line.text"
                  :segments="segments(row.line, row.text)"
                  :self-color="selfColor"
                  :network-id="view?.networkId ?? null"
                  :blockquotes="row.line.type === 'message'"
                  @measured="followGrowth" /><RenderSegments
                  v-else
                  :segments="segments(row.line, row.text)"
                  :self-color="selfColor"
                  :network-id="view?.networkId ?? null"
                  :blockquotes="row.line.type === 'message'" /><ReactionRow
                  v-if="view"
                  :message="{ ...row.line, networkId: view.networkId }"
                  :interactive="row.line.type !== 'notice' && !row.line.e2e"
              /></span>
              <div
                v-if="hoverActions && eligible(row.line)"
                class="row-actions"
                role="group"
                aria-label="Message actions"
              >
                <button
                  v-for="a in actionsFor(row.line)"
                  :key="a.key"
                  type="button"
                  class="row-action"
                  :class="{ active: a.active }"
                  :title="a.label"
                  :aria-label="a.label"
                  @click.stop="runAction(a.key, row.line)"
                >
                  <component :is="a.icon" />
                </button>
              </div>
            </div>
          </template>
          <div v-if="view.truncated" class="notice">
            this thread is longer than can be shown at once — its oldest replies aren’t shown
          </div>
        </template>
      </div>
      <!-- Keyed by thread: a half-typed reply never follows the panel to
           another thread. At rest it is the main input's height, so the two
           composers' text sits level. -->
      <ThreadComposer :key="viewKey" ref="composerRef" />
    </div>
    <!-- Inside the root on purpose: the shells place the panel by its root
         class through their scoped styles, which a fragment root would lose. -->
    <IgnoreModal
      v-if="ignoreTarget"
      :nick="ignoreTarget.nick"
      :user="ignoreTarget.user"
      :host="ignoreTarget.host"
      :network-id="ignoreTarget.networkId"
      @close="ignoreTarget = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ListTreeIcon, XIcon } from '@lucide/vue';
import NickRef from './NickRef.vue';
import NickAvatar from './NickAvatar.vue';
import RenderSegments from './RenderSegments.vue';
import MessageBody from './MessageBody.vue';
import ReactionRow from './ReactionRow.vue';
import IgnoreModal from './IgnoreModal.vue';
import ThreadList from './ThreadList.vue';
import ThreadComposer from './ThreadComposer.vue';
import { threadKey, useThreadsStore } from '../stores/threads.js';
import type { ThreadMessage } from '../stores/threads.js';
import { useRedactionsStore } from '../stores/redactions.js';
import { redactionLabel } from '../../../shared/redaction.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useHighlightRulesStore } from '../stores/highlightRules.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useViewport } from '../composables/useViewport.js';
import { useReplyQuote } from '../composables/useReplyQuote.js';
import { useThreadRoute, requestThreadNav } from '../composables/useThreadNav.js';
import { useMessageActions } from '../composables/useMessageActions.js';
import { usePreviewBody } from '../composables/usePreviewBody.js';
import { previewRevision } from '../composables/useLinkPreview.js';
import type {
  MessageActionKey,
  MessageAction,
  MessageActionOptions,
  MessageContext,
  MessageLike,
} from '../composables/useMessageActions.js';
import { onSocketOpen } from '../composables/useSocket.js';
import { formatDate, formatTimestamp } from '../utils/timestamp.js';
import { parseUserHost } from '../utils/userhost.js';
import { stripReplyAddress } from '../utils/replyText.js';
import type { RenderSegment } from '../utils/nickColor.js';
import { REPLY_LINE_TYPES } from '../../../shared/replies.js';

const props = withDefaults(
  defineProps<{
    // A screen of its own (mobile): the shell's bar heads it, so no head here,
    // and the panel is a flex column rather than the chat grid's rows.
    screen?: boolean;
  }>(),
  { screen: false },
);

const threads = useThreadsStore();
const redactions = useRedactionsStore();

// The placeholder for a deleted line (#1013), or null for one with its words.
function deletedLabel(line: ThreadMessage): string | null {
  const r = redactions.get(line);
  return r ? redactionLabel(r, line.nick) : null;
}
const buffers = useBuffersStore();
const networks = useNetworksStore();
const settings = useSettingsStore();
const ignores = useIgnoresStore();
const highlights = useHighlightRulesStore();
const nicks = useNickColors();
const { canHover } = useViewport();
const replyQuote = useReplyQuote();
const threadRoute = useThreadRoute();
const messageActions = useMessageActions();

const scroller = ref<HTMLElement | null>(null);
const composerRef = ref<{ focus: () => void } | null>(null);
const ignoreTarget = ref<{
  nick: string;
  user: string | null;
  host: string | null;
  networkId: number | null;
} | null>(null);

const screen = computed(() => props.screen);
const mode = computed(() => threadRoute.value?.mode ?? 'thread');
const bufferId = computed(() => threadRoute.value?.bufferId ?? null);
const view = computed(() => threads.view);
const viewKey = computed(() =>
  view.value ? threadKey(view.value.bufferId, view.value.rootMsgid) : 'none',
);
const buffer = computed(() => (view.value ? buffers.byId(view.value.bufferId) : null));

const hoverActions = computed(
  () => canHover.value && !!settings.effective('look.message.hover_actions'),
);
const actionItalic = computed(() => !!settings.effective('look.action.italic'));
const selfColor = computed<string | null>(
  () => (settings.effective('look.nick.self_color') as string | undefined) ?? null,
);

// Always the list's compact layout here (the panel is narrow like a phone), so
// its settings apply: avatars, and the compact timestamp format with a date
// prefix on lines from another day (empty = never).
const showAvatars = computed(() => settings.effective('look.message.avatars') === true);
const tsFormat = computed(() => settings.effective('look.buffer.time_format_compact') as string);
const compactDateFormat = computed(() =>
  String(settings.effective('look.buffer.date_format_compact') ?? ''),
);
const collapseWindowMs = computed(
  () =>
    Math.max(0, (settings.effective('look.message.collapse_authors_window') as number) || 0) *
    60_000,
);

// ─── Route → store ───────────────────────────────────────────────────────

// Open whatever the route names; a new thread (or the same one re-entered)
// reloads. The buffer arrives over the socket after a cold deep link, so this
// also waits on it.
watch(
  () => {
    const r = threadRoute.value;
    if (!r) return null;
    // Ready once the buffer is in the store with its network: a cold deep
    // link routes before either lands.
    const ready = buffers.byId(r.bufferId)?.networkId != null;
    return r.mode === 'list'
      ? `list|${r.bufferId}|${ready}`
      : `${r.bufferId}|${r.rootMsgid}|${ready}`;
  },
  () => {
    const r = threadRoute.value;
    if (!r || buffers.byId(r.bufferId)?.networkId == null) return;
    // One mode at a time: the other's state goes, so a thread left behind
    // isn't read as replies land while the list is up.
    if (r.mode === 'list') {
      threads.close();
      threads.openList(r.bufferId);
    } else {
      threads.closeList();
      threads.open(r.bufferId, r.rootMsgid);
    }
  },
  { immediate: true },
);

// A dropped socket's gap-fill reaches the channel, not this view: ask again.
const offOpen = onSocketOpen(() => {
  const v = threads.view;
  if (v) threads.open(v.bufferId, v.rootMsgid);
  const l = threads.list;
  if (l) threads.openList(l.bufferId);
});

onBeforeUnmount(() => {
  scrollerObserver?.disconnect();
  offOpen();
  threads.close();
  threads.closeList();
});

function close(): void {
  const id = bufferId.value;
  if (id != null) requestThreadNav({ kind: 'close', bufferId: id });
}

function showList(): void {
  const id = bufferId.value;
  if (id != null) requestThreadNav({ kind: 'list', bufferId: id });
}

// ─── Rows ────────────────────────────────────────────────────────────────

interface Row {
  key: string;
  line?: ThreadMessage;
  // The line's text as shown: without the `nick: ` a reply opens with.
  text?: string;
  root?: boolean;
  missing?: boolean;
  rule?: string;
  // From someone ignored — when it arrived, or since. The row keeps its place.
  hidden?: boolean;
  // Highlighted by the current rules (or a reply to one of ours).
  highlight?: boolean;
  // Compact: a run of the same speaker continues; no head.
  cont?: boolean;
}

// Someone ignored — when it arrived (the server's stamp) or since — and
// whether a NOHIGHLIGHT rule takes the tint off, judged by today's rules as
// the message list judges its rows.
function verdictFor(m: ThreadMessage): { hide: boolean; nohilight: boolean } {
  if (m.fromIgnored) return { hide: true, nohilight: true };
  const v = view.value;
  if (m.self || !m.nick || !v) return { hide: false, nohilight: false };
  const verdict = ignores.evaluate(v.networkId, {
    nick: String(m.nick),
    userhost: (m.userhost as string | null | undefined) ?? null,
    target: v.target,
    text: String(m.text ?? ''),
    type: m.type,
    isDm: buffer.value?.kind === 'dm',
  });
  return { hide: verdict.hide, nohilight: verdict.nohilight };
}

// Tinted by what the line SHOWS. In a thread, answering you and opening with
// your nick are the shape of the conversation, not news — so the reply-to-you
// stamp doesn't tint here, and the rules are run on the text with the address
// dropped (`shown`). A mention in the body of a reply still does. The server's
// stamps are untouched: the channel badge and the Threads button read those.
function highlightFor(m: ThreadMessage, nohilight: boolean, shown: string): boolean {
  const v = view.value;
  if (!v || m.self || nohilight) return false;
  if (!highlights.loaded) return (m as { matchedRuleId?: unknown }).matchedRuleId != null;
  return highlights.evaluate(v.networkId, {
    nick: m.nick,
    userhost: (m.userhost as string | null | undefined) ?? null,
    target: v.target,
    text: shown,
    type: m.type,
    self: !!m.self,
  });
}

const rows = computed((): Row[] => {
  const v = view.value;
  if (!v) return [];
  const out: Row[] = [];
  // The text a reply shows: no quote here — the thread's order is the context
  // — but the `nick: ` it opens with is dropped as the list drops it
  // (useReplyQuote); an answer to the first line drops its author's even when
  // the quote's lookup had nothing, since that line is on screen above.
  const shownText = (r: ThreadMessage): string => {
    let text = String(r.text ?? '');
    if (!r.replyTo) return text;
    text = replyQuote.shownReply(r.replyTo, r, v.networkId, v.target).text;
    if (r.replyTo.msgid === v.rootMsgid && v.root?.nick && r.type === 'message') {
      text = stripReplyAddress(text, String(v.root.nick));
    }
    return text;
  };
  const judged = (m: ThreadMessage, text: string) => {
    const { hide, nohilight } = verdictFor(m);
    return { hidden: hide, highlight: highlightFor(m, nohilight, text) };
  };
  if (v.root) {
    const text = String(v.root.text ?? '');
    out.push({ key: 'root', line: v.root, text, root: true, ...judged(v.root, text) });
  } else {
    out.push({ key: 'root', missing: true, root: true });
  }
  const replies = v.replies.map((r) => {
    const text = shownText(r);
    return { r, text, ...judged(r, text) };
  });
  const n = replies.filter((x) => !x.hidden).length;
  out.push({
    key: 'rule',
    rule: n === 0 ? 'no replies yet' : `${n} ${n === 1 ? 'reply' : 'replies'}`,
  });
  let prev: ThreadMessage | null = null;
  for (const { r, text, hidden, highlight } of replies) {
    // A speaker's run shares one head, as the compact list does (its window);
    // a hidden line starts a new run.
    const deltaMs = Date.parse(r.time ?? '') - Date.parse(prev?.time ?? '');
    const cont =
      !!prev &&
      !hidden &&
      r.type === 'message' &&
      prev.type === 'message' &&
      !!prev.self === !!r.self &&
      String(prev.nick ?? '').toLowerCase() === String(r.nick ?? '').toLowerCase() &&
      deltaMs >= 0 &&
      deltaMs <= collapseWindowMs.value;
    out.push({ key: String(r.id), line: r, text, hidden, highlight, cont });
    prev = hidden ? null : r;
  }
  return out;
});

function time(m: ThreadMessage): string {
  if (!m.time) return '';
  const t = formatTimestamp(m.time, tsFormat.value ?? '');
  const dateFmt = compactDateFormat.value;
  if (!t || !dateFmt) return t;
  if (formatDate(m.time) === formatDate(new Date().toISOString())) return t;
  return `${formatTimestamp(m.time, dateFmt)} ${t}`;
}

function fullTime(m: ThreadMessage): string | undefined {
  return m.time ? new Date(m.time).toLocaleString() : undefined;
}

// The standard layout's prefix column, as the message list prints it.
function prefixText(m: ThreadMessage): string {
  if (m.type === 'action') return '*';
  if (m.type === 'notice') return `-${m.nick ?? ''}-`;
  return String(m.nick ?? '');
}

function prefixClass(m: ThreadMessage) {
  return {
    nick: m.type === 'message',
    'action-marker': m.type === 'action',
    self: !!m.self,
  };
}

function lineClass(row: Row) {
  const m = row.line;
  return {
    root: !!row.root,
    self: !!m?.self,
    highlight: !!row.highlight,
    cont: !!row.cont,
  };
}

const selfLower = computed(() => {
  const n = view.value ? networks.states[view.value.networkId]?.nick : null;
  return n ? n.toLowerCase() : null;
});

const nickSet = computed((): Set<string> => {
  const set = new Set<string>();
  for (const mem of buffer.value?.members || []) if (mem.nick) set.add(mem.nick);
  const v = view.value;
  if (v) {
    if (v.root?.nick) set.add(String(v.root.nick));
    for (const r of v.replies) if (r.nick) set.add(String(r.nick));
  }
  return set;
});

function segments(m: ThreadMessage, text: string | undefined): RenderSegment[] {
  const body = text ?? String(m.text ?? '');
  return nicks.splitText(body, nickSet.value, selfLower.value) as RenderSegment[];
}

// ─── Scrolling and read state ────────────────────────────────────────────

const atBottom = ref(true);
// The scroller's height as last seen. A shrink (the composer growing, a
// window resize) can fire a scroll event BEFORE the ResizeObserver's
// callback, measured with the new height and the old scrollTop, which would
// read as the reader having scrolled up and drop the pin the observer is
// about to keep. Such a scroll changes nothing here (MessageList's guard).
let lastClientHeight = 0;
function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  if (el.clientHeight !== lastClientHeight) {
    lastClientHeight = el.clientHeight;
    return;
  }
  // The reader moved: a focused reply's pin lets go (a re-pin's own scroll
  // lands on the top it recorded).
  if (focusPin && Math.abs(el.scrollTop - focusPin.top) > 1) focusPin = null;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

function scrollToBottom(): void {
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

// Inline media and link previews (MessageBody, the message list's gate): a
// picture (`measured`) or a card (`previewRevision`) that lands after its line
// grows it, and so does switching previews on, cards already cached. A reply
// opened by name (`?focus=`) stays where it was put until the reader scrolls,
// as the lines around it fill in (the scroller has overflow-anchor off, so the
// browser won't), even when that put it at the end; otherwise a reader at the
// end stays at the end.
const { previewBody, previewsActive } = usePreviewBody();
let focusPin: { id: number; top: number } | null = null;
function followGrowth(): void {
  const el = scroller.value;
  if (focusPin && el) {
    if (scrollToId(focusPin.id, false)) {
      focusPin.top = el.scrollTop;
      return;
    }
    focusPin = null;
  }
  if (atBottom.value) scrollToBottom();
}
watch([previewRevision, previewsActive], () => void nextTick(followGrowth));

// The composer grows up into the lines (and a window resize shrinks them)
// without moving scrollTop, which would hide the replies being answered: the
// lines follow the growth as they follow a preview's, so a reader at the end
// stays at the end, as in the message list.
const scrollerObserver =
  typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        lastClientHeight = scroller.value?.clientHeight ?? 0;
        followGrowth();
      })
    : null;
watch(scroller, (el, old) => {
  if (old) scrollerObserver?.unobserve(old);
  if (el) {
    lastClientHeight = el.clientHeight;
    scrollerObserver?.observe(el);
  }
});

function scrollToId(id: number, pulse: boolean): boolean {
  const el = scroller.value?.querySelector(`[data-msg-id="${id}"]`);
  if (!(el instanceof HTMLElement)) return false;
  el.scrollIntoView({ block: 'center' });
  if (pulse) {
    el.classList.add('scroll-target');
    setTimeout(() => el.classList.remove('scroll-target'), 1500);
  }
  return true;
}

// Loaded: the newest replies, or the reply the route names (`?focus=`) — also
// when a jump names another reply in the thread already open.
watch(
  () =>
    [
      view.value?.loading,
      view.value?.rootMsgid,
      threadRoute.value?.mode === 'thread' ? threadRoute.value.focusId : null,
    ] as const,
  async ([loading]) => {
    if (loading !== false) return;
    await nextTick();
    const focusId = threadRoute.value?.mode === 'thread' ? threadRoute.value.focusId : null;
    focusPin = null;
    if (focusId && scrollToId(focusId, true)) {
      focusPin = { id: focusId, top: scroller.value?.scrollTop ?? 0 };
    } else {
      scrollToBottom();
    }
    atBottom.value = !focusId;
  },
  { immediate: true },
);

// A reply arriving while the user reads the end follows it down, as the
// message list does. The pin is read after the tick: a load that centred a
// focused reply has just cleared it.
watch(
  // The tail's id, not the length: at the cap an arrival evicts the oldest
  // and the length stands still.
  () => view.value?.replies.at(-1)?.id,
  async () => {
    await nextTick();
    if (!atBottom.value) return;
    scrollToBottom();
  },
);

// A Reply in the channel opened this thread to answer in it: the caret goes
// to the composer once the thread is up.
watch(
  () => [view.value?.loading, threads.wantComposer] as const,
  async ([loading, want]) => {
    if (loading !== false || !want) return;
    threads.wantComposer = false;
    await nextTick();
    composerRef.value?.focus();
  },
  { immediate: true },
);

// Read as it's shown: on load, as replies arrive while it's open — and when
// the server's count for it moves, since a reply's `irc` frame lands before
// the `threads-changed` that counts it.
watch(
  () => [
    view.value?.loading,
    view.value?.replies.length,
    view.value && threads.unreadFor(view.value.bufferId, view.value.rootMsgid),
  ],
  () => threads.markViewRead(),
);

// ─── Actions ─────────────────────────────────────────────────────────────

// Neither Reply nor Quote is offered here. A send from the panel answers the
// newest reply from someone else (threads.replyTarget), so the thread reads as
// a conversation in clients without threads; picking lines would undo that.
// Quote would ride a send that already carries a reply tag (the two are
// exclusive, #1119).
const EXCLUDED: readonly MessageActionKey[] = ['reply', 'quote'];
const ACTION_OPTS: MessageActionOptions = { exclude: EXCLUDED };

function eligible(m: ThreadMessage): boolean {
  return REPLY_LINE_TYPES.includes(m.type);
}

function asLike(m: ThreadMessage): MessageLike {
  return { ...m, networkId: view.value?.networkId } as unknown as MessageLike;
}

const actionContext: MessageContext = {
  get networkId() {
    return view.value?.networkId ?? 0;
  },
  onReply: () => {},
  onQuote: () => {},
  onIgnore: (msg: MessageLike) => {
    const { user, host } = parseUserHost(msg.userhost);
    ignoreTarget.value = {
      nick: msg.nick ?? '',
      user,
      host,
      networkId: view.value?.networkId ?? null,
    };
  },
};

function actionsFor(m: ThreadMessage): MessageAction[] {
  return messageActions.buildActions(asLike(m)).filter((a) => !EXCLUDED.includes(a.key));
}

function runAction(key: MessageActionKey, m: ThreadMessage): void {
  messageActions.run(key, asLike(m), actionContext);
}

// No hover bar (touch, or turned off): a tap opens the same actions as a menu.
function onLineClick(e: MouseEvent, m: ThreadMessage): void {
  if (!eligible(m) || hoverActions.value) return;
  if ((e.target as Element | null)?.closest('a, button')) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  messageActions.openMenu(
    asLike(m),
    actionContext,
    e.clientX,
    e.clientY,
    e.currentTarget as Element,
    ACTION_OPTS,
  );
}
</script>

<style scoped>
/* Desktop: the chat grid's rows (DesktopChat assigns the area and the subgrid)
   so head, lines, status and composer line up with the chat's own. */
.thread-panel {
  display: grid;
  grid-template-rows: subgrid;
  min-height: 0;
  min-width: 0;
}
/* Mobile: a screen of its own, a plain column. */
.thread-panel.screen {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* The topic bar's row: same padding and baseline. */
.panel-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-6);
  white-space: nowrap;
  overflow: hidden;
}
.panel-head .link {
  display: inline-flex;
  align-items: center;
  align-self: center;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
  color: var(--accent);
}
.panel-head .link:hover {
  color: var(--fg);
}
.panel-head .close {
  margin-left: auto;
}
.panel-title {
  color: var(--accent);
}
.panel-divider {
  background: var(--border);
  height: 1px;
}

/* The list in list mode fills the lines row and the two below it. */
.thread-panel:not(.screen) > .thread-list {
  grid-row: span 3;
}
/* The lines and the composer, one column over the lines, status and input
   rows (nothing of the status bar applies here), so the avatar gutter's
   hairline runs down to the composer. The composer is not on the input row:
   that row is the main composer's alone, and a long reply grows up into the
   lines instead of under the main composer. */
.thread-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.thread-panel:not(.screen) > .thread-body {
  grid-row: span 3;
}
.thread-panel.screen > .thread-body {
  flex: 1;
}
.thread-body > .thread-input {
  border-top: 1px solid var(--border);
}

.lines {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;
  padding: var(--space-2) 0;
  line-height: 1.55;
}
.notice {
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-2) var(--space-4);
}
.rule {
  display: flex;
  align-items: center;
  gap: 1ch;
  color: var(--fg-muted);
  padding: var(--space-2) var(--space-4);
}
.rule::before,
.rule::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border);
}

/* ── The list's compact layout: a head line (nick, time) over the body; a
   speaker's run shares one head. Density is the user's (#1186): the three
   tokens useTheme writes. ── */
.lines.compact {
  line-height: var(--compact-line-height, 1.55);
}
.lines.compact .t-line {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas:
    'head head'
    'prefix body';
  align-items: baseline;
  column-gap: 0.75ch;
  position: relative;
  padding: var(--space-1) var(--space-4);
  margin-top: var(--compact-group-gap, 0);
}
.lines.compact .t-line.cont {
  margin-top: 0;
}
.lines.compact .head {
  grid-area: head;
  display: flex;
  align-items: baseline;
  gap: 0.75ch;
  min-width: 0;
}
.lines.compact .head .prefix {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lines.compact .t-body {
  grid-area: body;
}
.lines.compact .head ~ .t-body,
.lines.compact .t-line.cont > .t-body {
  grid-column: 1 / -1;
  padding-left: var(--compact-indent, 0);
}
/* Action and notice rows in compact: one line, time then prefix then body. */
.lines.compact .t-line:has(> .time:first-child) {
  grid-template-columns: auto auto minmax(0, 1fr);
  grid-template-areas: 'time prefix body';
}
.lines.compact .t-line:has(> .time:first-child) > .time {
  grid-area: time;
  padding-right: 0;
}
.lines.compact .t-line:has(> .time:first-child) > .prefix {
  grid-area: prefix;
  white-space: nowrap;
}
.lines.compact .t-line:has(> .time:first-child) > .t-body {
  grid-area: body;
  padding-left: 0;
}
/* Avatars (#607): the tile in a gutter on the left, as the list draws it,
   with the gutter's hairline on the scroller and again on each row (a hovered
   or highlighted row paints over the scroller's). */
.lines.compact.avatars {
  --avatar-size: min(2.7em, 2lh);
  --avatar-gutter: calc(var(--avatar-size) + var(--space-4));
  background-image: linear-gradient(var(--border), var(--border));
  background-size: 1px 100%;
  background-repeat: repeat-y;
  background-position: round(calc(var(--space-4) + var(--avatar-gutter)), 1px) 0;
  background-attachment: local;
}
.lines.compact.avatars .t-line {
  padding-left: calc(var(--space-4) + var(--avatar-gutter) + var(--space-5));
}
.lines.compact.avatars .t-line::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: round(calc(var(--space-4) + var(--avatar-gutter)), 1px);
  width: 1px;
  background: var(--border);
  pointer-events: none;
}
.lines.compact.avatars .t-line > .avatar {
  position: absolute;
  left: var(--space-4);
  top: calc(var(--space-1) + (2lh - var(--avatar-size)) / 2);
}
.lines.compact.avatars .head .prefix {
  font-weight: 600;
}
.lines.compact.avatars .head ~ .t-body,
.lines.compact.avatars .t-line.cont > .t-body {
  padding-left: 0;
}

/* ── Rows, both layouts ── */
.t-line:hover {
  background: var(--bg-soft);
}
.t-line.highlight {
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.t-line.scroll-target {
  animation: thread-scroll-target 1.5s ease-out;
}
@keyframes thread-scroll-target {
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
  white-space: nowrap;
}
.prefix.action-marker {
  color: var(--fg-muted);
}
.t-body {
  position: relative;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.t-body.italic {
  font-style: italic;
}
.t-body.missing,
.t-line.missing .t-body {
  color: var(--fg-muted);
  font-style: italic;
}
.t-line.missing {
  padding: var(--space-1) var(--space-4);
}

/* The message list's hover bar. */
.row-actions {
  position: absolute;
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
/* The first line sits at the top of the scroller, where a bar floated above
   it would be clipped: hang it below instead. */
.t-line.root .row-actions {
  top: auto;
  bottom: var(--space-2);
  transform: translateY(100%);
}
.row-actions:focus-within,
.t-line:hover .row-actions {
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
</style>
