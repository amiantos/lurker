<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A reply thread (#993) as a tree, in place of the channel's message list:

    14:02  <amiantos> blah blah blah
    14:05  ├─ <relyimah> yadda yadda yadda
    14:07  │  └─ <amiantos> i disagree
    14:11  └─ <bradroot> I think that's a great idea

  The time column and `<nick>` are the channel's, so a line reads the same in
  both places; the rails are CSS (like the buffer list's), so they run
  unbroken down a line that wraps. Each line's `reply` opens the composer
  under it — the shell teleports its one MessageInput into the slot this view
  renders for the pending reply (DesktopChat); with nothing picked, a line sent
  from here answers the first line (threads.defaultReply).
-->

<template>
  <div ref="scroller" class="thread-view" :class="{ loading: view?.loading }">
    <div v-if="!view || (view.loading && rows.length <= 1 && !view.root)" class="notice">
      loading thread…
    </div>
    <template v-else>
      <template v-for="(row, i) in rows" :key="row.line?.id ?? 'root'">
        <div
          class="t-line"
          :class="lineClass(row)"
          :style="{ order: i * 2 }"
          :data-msg-id="row.line?.id ?? null"
          @click="onLineClick($event, row.line)"
        >
          <span class="time" :title="fullTime(row.line)">{{ time(row.line) }}</span>
          <div class="t-main">
            <span
              v-for="(on, i) in row.rails"
              :key="i"
              class="g"
              :class="on ? 'rail' : 'blank'"
              aria-hidden="true"
            ></span>
            <span
              v-if="row.depth > 0"
              class="g"
              :class="row.last ? 'elbow' : 'tee'"
              aria-hidden="true"
            ></span>
            <span v-if="!row.line" class="t-body missing">original message unavailable</span>
            <span v-else-if="hidden(row.line)" class="t-body missing">(ignored)</span>
            <span
              v-else
              class="t-body"
              :class="{ italic: row.line.type === 'action' && actionItalic }"
              ><span class="t-nick"
                >{{ marks(row.line)[0] }}<NickRef :nick="String(row.line.nick ?? '')" />{{
                  marks(row.line)[1]
                }}</span
              >
              <MessageBody
                v-if="previewBody(row.line)"
                :text="bodyText(row.line)"
                :segments="segments(row.line)"
                :self-color="selfColor"
                :network-id="view?.networkId ?? null" /><RenderSegments
                v-else
                :segments="segments(row.line)"
                :self-color="selfColor"
                :network-id="view?.networkId ?? null" /><button
                v-if="replyable(row.line)"
                type="button"
                class="link t-reply"
                :class="{ active: pending?.messageId === row.line.id }"
                @click.stop="startReply(row.line)"
              >
                reply</button
              ><ReactionRow
                v-if="view"
                :message="{ ...row.line, networkId: view.networkId }"
                :interactive="row.line.type !== 'notice' && !row.line.e2e"
            /></span>
          </div>
          <div
            v-if="row.line && hoverActions && eligible(row.line)"
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
              <i :class="a.icon"></i>
            </button>
            <button
              type="button"
              class="row-action"
              title="View in channel"
              aria-label="View in channel"
              @click.stop="viewInChannel(row.line)"
            >
              <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </button>
          </div>
        </div>
      </template>
      <!-- The composer's slot. ONE element for the life of the view, drawn under
           the line being answered by grid order rather than by where it sits in
           the DOM: the shell's Teleport targets it by id, and a Teleport resolves
           a changed target while its parent patches — before this view has drawn
           a new one — so a slot per line would be missing when it's looked up. -->
      <div
        v-show="composeRow"
        class="t-line t-compose"
        :style="{ order: composeRow ? composeRow.index * 2 + 1 : 0 }"
      >
        <span class="time"></span>
        <div class="t-main">
          <span
            v-for="(on, k) in composeRow?.rails ?? []"
            :key="k"
            class="g"
            :class="on ? 'rail' : 'blank'"
            aria-hidden="true"
          ></span>
          <span
            class="g"
            :class="composeRow?.row.hasChildren ? 'tee' : 'elbow'"
            aria-hidden="true"
          ></span>
          <div id="thread-compose" class="t-slot"></div>
        </div>
      </div>
      <div v-if="view.truncated" class="notice" :style="{ order: rows.length * 2 }">
        this thread is longer than can be shown at once — its oldest replies are above
      </div>
    </template>
  </div>
  <IgnoreModal
    v-if="ignoreTarget"
    :nick="ignoreTarget.nick"
    :user="ignoreTarget.user"
    :host="ignoreTarget.host"
    :network-id="ignoreTarget.networkId"
    @close="ignoreTarget = null"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import NickRef from './NickRef.vue';
import MessageBody from './MessageBody.vue';
import RenderSegments from './RenderSegments.vue';
import ReactionRow from './ReactionRow.vue';
import IgnoreModal from './IgnoreModal.vue';
import { useThreadsStore } from '../stores/threads.js';
import type { ThreadMessage } from '../stores/threads.js';
import { useBuffersStore, bufferKey } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useConfigStore } from '../stores/config.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useRepliesStore } from '../stores/replies.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useViewport } from '../composables/useViewport.js';
import { useThreadRoute } from '../composables/useThreadRoute.js';
import { addressNick } from '../composables/useComposerOverlay.js';
import { emitJumpIntent } from '../composables/useJumpIntent.js';
import { useMessageActions } from '../composables/useMessageActions.js';
import type {
  MessageActionKey,
  MessageAction,
  MessageContext,
  MessageLike,
} from '../composables/useMessageActions.js';
import { threadRows } from '../lib/threadTree.js';
import type { ThreadRow } from '../lib/threadTree.js';
import { formatTimestamp } from '../utils/timestamp.js';
import { stripReplyAddress } from '../utils/replyText.js';
import type { RenderSegment } from '../utils/nickColor.js';
import { isDccChatTarget } from '../../../shared/channels.js';
import { REPLY_LINE_TYPES } from '../../../shared/replies.js';

const props = withDefaults(
  defineProps<{
    // Desktop teleports the composer under the line being answered; mobile
    // keeps it at the bottom, over the keyboard.
    composeInline?: boolean;
  }>(),
  { composeInline: false },
);

const router = useRouter();
const threads = useThreadsStore();
const buffers = useBuffersStore();
const networks = useNetworksStore();
const settings = useSettingsStore();
const config = useConfigStore();
const ignores = useIgnoresStore();
const replies = useRepliesStore();
const nicks = useNickColors();
const { canHover } = useViewport();
const threadRoute = useThreadRoute();
const messageActions = useMessageActions();

const scroller = ref<HTMLElement | null>(null);
const ignoreTarget = ref<{
  nick: string;
  user: string | null;
  host: string | null;
  networkId: number | null;
} | null>(null);

const view = computed(() => threads.view);
const buffer = computed(() => (view.value ? buffers.byId(view.value.bufferId) : null));
const channelKey = computed(() =>
  buffer.value ? bufferKey(buffer.value.networkId, buffer.value.target) : null,
);
const pending = computed(() => replies.forKey(channelKey.value));

const rows = computed((): ThreadRow<ThreadMessage>[] =>
  view.value ? threadRows(view.value.root, view.value.replies) : [],
);

const hoverActions = computed(
  () => canHover.value && !!settings.effective('look.message.hover_actions'),
);
const actionItalic = computed(() => !!settings.effective('look.action.italic'));
const selfColor = computed<string | null>(
  () => (settings.effective('look.nick.self_color') as string | undefined) ?? null,
);

// Open whatever the route names; a new thread (or the same one re-entered)
// reloads. The view closes with the component.
watch(
  () => threadRoute.value && `${threadRoute.value.bufferId}|${threadRoute.value.rootMsgid}`,
  () => {
    const r = threadRoute.value;
    if (r) threads.open(r.bufferId, r.rootMsgid);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  // Back to the channel's own lines: they've been arriving unread while the
  // thread was up (buffers.pushLive), and returning to an already-active buffer
  // activates nothing — so read them in here, as entering it would.
  const v = threads.view;
  const now = router.currentRoute.value;
  threads.close();
  if (v && now.name === 'buffer' && Number(now.params.id) === v.bufferId) {
    buffers.activate(v.networkId, v.target);
  }
});

// The buffer arrives over the socket after a cold deep link; open once it does.
watch(
  () => threadRoute.value && buffers.byId(threadRoute.value.bufferId) != null,
  (ready) => {
    const r = threadRoute.value;
    if (ready && r && !threads.view) threads.open(r.bufferId, r.rootMsgid);
  },
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

// Bring the reply that was clicked into view once it's drawn.
watch(
  () => [threadRoute.value?.focusId, view.value?.loading] as const,
  async ([focusId, loading]) => {
    if (!focusId || loading !== false) return;
    await nextTick();
    const el = scroller.value?.querySelector(`[data-msg-id="${focusId}"]`);
    if (!(el instanceof HTMLElement)) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('scroll-target');
  },
  { immediate: true },
);

// ─── Lines ───────────────────────────────────────────────────────────────

const tsFormat = computed(() => settings.effective('look.buffer.time_format') as string);

function time(m: ThreadMessage | null): string {
  return m?.time ? formatTimestamp(m.time, tsFormat.value ?? '') : '';
}

function fullTime(m: ThreadMessage | null): string | undefined {
  return m?.time ? new Date(m.time).toLocaleString() : undefined;
}

// What goes either side of the nick, as the reply quote writes it.
function marks(m: ThreadMessage): [string, string] {
  if (m.type === 'action') return ['* ', ''];
  if (m.type === 'notice') return ['-', '-'];
  return ['<', '>'];
}

function lineClass(row: ThreadRow<ThreadMessage>) {
  const m = row.line;
  return {
    root: row.depth === 0,
    self: !!m?.self,
    highlight: !!m && !m.self && (!!m.matched || !!m.replyToSelf),
    replying: !!m && pending.value?.messageId === m.id,
  };
}

// Someone ignored since the line arrived — the server only screens who was
// ignored at the time. The line keeps its place so its replies keep theirs.
function hidden(m: ThreadMessage): boolean {
  if (m.self || !m.nick || view.value == null) return false;
  return ignores.evaluate(view.value.networkId, {
    nick: String(m.nick),
    userhost: (m.userhost as string | null | undefined) ?? null,
    target: view.value.target,
    text: String(m.text ?? ''),
    type: m.type,
    isDm: buffer.value?.kind === 'dm',
  }).hide;
}

// The text without the `nick: ` a reply opens with when it names who it
// answers — the tree already shows that.
function bodyText(m: ThreadMessage): string {
  const text = String(m.text ?? '');
  const parentNick = m.replyTo?.parent?.nick;
  return parentNick ? stripReplyAddress(text, parentNick) : text;
}

const selfLower = computed(() => {
  const n = view.value ? networks.states[view.value.networkId]?.nick : null;
  return n ? n.toLowerCase() : null;
});

const nickSet = computed((): Set<string> => {
  const set = new Set<string>();
  for (const mem of buffer.value?.members || []) {
    const n = typeof mem === 'string' ? mem : mem.nick;
    if (n) set.add(n);
  }
  if (selfLower.value && view.value) set.add(networks.states[view.value.networkId]?.nick ?? '');
  return set;
});

function segments(m: ThreadMessage): RenderSegment[] {
  return nicks.splitText(bodyText(m), nickSet.value, selfLower.value) as RenderSegment[];
}

const previewsActive = computed(
  () =>
    config.linkPreviews &&
    (settings.effective('chat.inline_media.enabled') === true ||
      settings.effective('chat.link_previews.enabled') === true),
);

// Same gate as the message list's: a notice never unfurls.
function previewBody(m: ThreadMessage): boolean {
  return (
    (m.type === 'message' || m.type === 'action') &&
    previewsActive.value &&
    String(m.text ?? '').includes('://')
  );
}

// ─── Replying ────────────────────────────────────────────────────────────

// Any chat line with a msgid — our own included: in a thread, adding to what
// you said is ordinary. The server re-checks it (replySendMsgid).
function replyable(m: ThreadMessage): boolean {
  return (
    !!m.msgid &&
    !m.e2e &&
    REPLY_LINE_TYPES.includes(m.type) &&
    !!view.value &&
    !isDccChatTarget(view.value.target)
  );
}

function startReply(m: ThreadMessage): void {
  const key = channelKey.value;
  if (!key) return;
  if (pending.value?.messageId === m.id) return;
  replies.start(key, {
    messageId: m.id,
    nick: String(m.nick ?? ''),
    type: m.type,
    text: String(m.text ?? ''),
  });
  if (m.nick && !m.self) addressNick(String(m.nick));
}

// Where the composer's slot goes: after the line being answered, with that
// line's rails carried down (plus its own, when it has later siblings).
const composeRow = computed(() => {
  if (!props.composeInline) return null;
  const id = pending.value?.messageId;
  if (id == null) return null;
  const index = rows.value.findIndex((r) => r.line?.id === id);
  if (index < 0) return null;
  const row = rows.value[index];
  return { index, row, rails: [...row.rails, ...(row.depth > 0 ? [!row.last] : [])] };
});

// ─── Actions ─────────────────────────────────────────────────────────────

function eligible(m: ThreadMessage): boolean {
  return REPLY_LINE_TYPES.includes(m.type);
}

const actionContext: MessageContext = {
  get networkId() {
    return view.value?.networkId ?? 0;
  },
  onReply: (msg: MessageLike) => startReply(msg as ThreadMessage),
  onIgnore: (msg: MessageLike) => {
    const at = String(msg.userhost ?? '').split('!')[1] ?? '';
    const [user, host] = at.includes('@') ? at.split('@') : [null, null];
    ignoreTarget.value = {
      nick: msg.nick ?? '',
      user: user || null,
      host: host || null,
      networkId: view.value?.networkId ?? null,
    };
  },
};

function asLike(m: ThreadMessage): MessageLike {
  return { ...m, networkId: view.value?.networkId } as unknown as MessageLike;
}

function actionsFor(m: ThreadMessage): MessageAction[] {
  // `reply` is on the line itself here.
  return messageActions.buildActions(asLike(m)).filter((a) => a.key !== 'reply');
}

function runAction(key: MessageActionKey, m: ThreadMessage): void {
  messageActions.run(key, asLike(m), actionContext);
}

// No hover bar (touch, or turned off): a tap opens the same actions as a menu.
function onLineClick(e: MouseEvent, m: ThreadMessage | null): void {
  if (!m || !eligible(m) || hoverActions.value) return;
  if ((e.target as Element | null)?.closest('a, button')) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  messageActions.openMenu(
    asLike(m),
    actionContext,
    e.clientX,
    e.clientY,
    e.currentTarget as Element,
  );
}

// The line where it sits in the channel, through the shared jump pipeline —
// which leaves the thread view for the channel's lines first.
function viewInChannel(m: ThreadMessage): void {
  const v = view.value;
  if (!v) return;
  emitJumpIntent({ kind: 'jump', networkId: v.networkId, target: v.target, messageId: m.id });
}
</script>

<style scoped>
/* Time | tree. The time column is the message list's; the tree's rails are
   drawn with borders (like the buffer list's), so they stay unbroken down a
   line that wraps and across the row boundary. */
.thread-view {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--space-6);
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  grid-auto-rows: min-content;
  align-content: start;
  line-height: 1.55;
}

.notice {
  grid-column: 1 / -1;
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-2) 0;
}

.t-line {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  position: relative;
}
.t-line:hover,
.t-line.replying {
  background: var(--bg-soft);
}
.t-line.highlight {
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.t-line.scroll-target {
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
  white-space: nowrap;
}

.t-main {
  display: flex;
  align-items: stretch;
  min-width: 0;
}

/* One gutter cell per tree level, 3ch wide like `├─ `. */
.g {
  flex: none;
  width: 3ch;
  position: relative;
}
.g.rail::before,
.g.tee::before,
.g.elbow::before {
  content: '';
  position: absolute;
  left: 0.5ch;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--fg-muted);
}
/* └─ stops at the first line's middle. */
.g.elbow::before {
  bottom: auto;
  height: 0.775em;
}
.g.tee::after,
.g.elbow::after {
  content: '';
  position: absolute;
  left: 0.5ch;
  width: 2ch;
  top: 0.775em;
  border-top: 1px solid var(--fg-muted);
}

.t-body {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.t-body.italic {
  font-style: italic;
}
.t-body.missing {
  color: var(--fg-muted);
  font-style: italic;
}
.t-nick {
  white-space: nowrap;
}

.t-reply {
  margin-left: 1ch;
  color: var(--fg-muted);
  opacity: 0;
}
.t-line:hover .t-reply,
.t-reply:focus-visible,
.t-reply.active {
  opacity: 1;
}
.t-reply.active {
  color: var(--accent);
}
/* No hover to reveal it on touch: always there, quietly. */
@media (hover: none) {
  .t-reply {
    opacity: 0.6;
  }
}

.t-compose .t-slot {
  flex: 1;
  min-width: 0;
  padding: var(--space-1) 0;
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

@media (max-width: 720px) {
  .thread-view {
    padding: var(--space-2) var(--space-3);
  }
}
</style>
