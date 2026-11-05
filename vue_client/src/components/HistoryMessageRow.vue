<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Single row for a historical message shown out of buffer context
  (search results, highlights list, etc). Header strip shows where
  and when the message happened ("network/channel" matching the
  status bar, plus the time); the body reads like a real chat line —
  nick with its standard color, then the message text.
-->

<template>
  <li class="row" @click="$emit('jump', message)">
    <div class="head">
      <div class="where">
        <template v-if="targetLabel"
          ><span class="net">{{ networkLabel }}/</span
          ><span class="target">{{ targetLabel }}</span></template
        >
        <span v-else class="net">{{ networkLabel }}</span>
      </div>
      <div class="meta">
        <span class="time">{{ time }}</span>
        <button
          v-if="removable"
          type="button"
          class="remove"
          title="Remove"
          aria-label="Remove"
          @click.stop="$emit('remove', message)"
        >
          <XIcon />
        </button>
      </div>
    </div>
    <div v-if="reaction != null" class="body">
      <span class="nick" :style="nickStyle">{{ message.nick }}</span>
      <span class="sep">|</span>
      <span class="reaction">{{ reaction }}</span>
      <span class="text"> on “{{ message.text ?? '' }}”</span>
    </div>
    <div v-else class="body">
      <!-- IRCv3 reply (#998): the line it answers, as in the timeline. Static —
           the row's click jumps to the reply, where the quote jumps on. -->
      <ReplyQuote
        v-if="message.replyTo"
        :parent="shown.parent"
        :network-id="message.networkId"
        static
      />
      <span class="nick" :style="nickStyle">{{ line.nick }}</span>
      <span class="sep">|</span>
      <!-- A deleted line (#1013): its placeholder, where its words were. -->
      <span v-if="deleted" class="text deleted">{{ deleted }}</span>
      <span v-else class="text"
        ><span v-if="line.relaySource" class="relay-via" :title="`Relayed via ${line.relayBot}`"
          >[{{ line.relaySource }}] </span
        ><LinkedText :text="shown.text"
      /></span>
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CSSProperties } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNickColors } from '../composables/useNickColors.js';
import { formatTimestamp, formatDate } from '../utils/timestamp.js';
import LinkedText from './LinkedText.vue';
import ReplyQuote from './ReplyQuote.vue';
import { useReplyQuote } from '../composables/useReplyQuote.js';
import { useRelayBotsStore } from '../stores/relayBots.js';
import { useRedactionsStore } from '../stores/redactions.js';
import type { ReplyContext } from '../../../shared/replies.js';
import { redactionLabel } from '../../../shared/redaction.js';
import type { Redaction } from '../../../shared/redaction.js';
import { XIcon } from '@lucide/vue';

// Shared row shape from search/highlights/bookmarks. All callers pass at
// minimum { id, networkId, target, nick, time, text }; `self` and
// `networkName` are optional extras some callers include.
export interface HistoryMessage {
  id?: number | string | null;
  networkId: number;
  target: string;
  nick: string;
  text?: string;
  time?: string;
  self?: boolean;
  networkName?: string;
  type?: string;
  // An IRCv3 reply's quote, resolved by the server as on the timeline (#998).
  replyTo?: ReplyContext;
  // The line was deleted (#1013); the row shows the placeholder instead.
  redaction?: Redaction;
  [key: string]: unknown;
}

const props = withDefaults(
  defineProps<{
    message: HistoryMessage;
    removable?: boolean;
    // A reactions-tab row: `message.nick` reacted with this on `message.text`
    // (one of the user's own lines), and `message.time` is when.
    reaction?: string | null;
  }>(),
  { removable: false, reaction: null },
);

defineEmits<{
  jump: [message: HistoryMessage];
  remove: [message: HistoryMessage];
}>();

const networks = useNetworksStore();
const settings = useSettingsStore();
const nicks = useNickColors();
const replyQuote = useReplyQuote();
const relayBots = useRelayBotsStore();
const redactions = useRedactionsStore();

// The placeholder for a deleted line (#1013), or null for one with its words.
const deleted = computed(() => {
  const r = redactions.get(props.message);
  return r ? redactionLabel(r, props.message.nick) : null;
});

// The line as the timeline shows it: from a marked relay bot, as the person
// inside the envelope (#996), with the `[source]` label the timeline shows.
const line = computed(() => {
  const m = props.message;
  const relayed = relayBots.unwrap(m.networkId, m);
  if (!relayed) return { nick: m.nick, text: m.text ?? '', type: m.type, self: m.self };
  return {
    nick: relayed.nick,
    text: relayed.text,
    type: m.type,
    // You, echoed back through the bridge, on the row's own network — not the
    // open buffer's.
    self: networks.isOwnNick(m.networkId, relayed.nick),
    relayBot: m.nick,
    relaySource: relayed.source,
  };
});

// A reply reads as it does in the timeline: its quote, and its text without
// the address the quote makes redundant.
const shown = computed(() => {
  const m = props.message;
  if (!m.replyTo) return { parent: null, text: line.value.text };
  return replyQuote.shownReply(m.replyTo, line.value, m.networkId, m.target);
});

const tsFormat = computed(() => settings.effective('look.buffer.time_format'));
const selfColor = computed(() => settings.effective('look.nick.self_color'));

// History rows are out-of-buffer (search/highlights), so a bare HH:mm is
// ambiguous — prepend the calendar date. Skipped if the user's format
// already includes a year token to avoid doubling up.
const time = computed(() => {
  const fmt = tsFormat.value as string;
  const iso = props.message.time ?? '';
  const t = formatTimestamp(iso, fmt);
  if (fmt && /YYYY/.test(fmt)) return t;
  const d = formatDate(iso);
  if (!d) return t;
  return t ? `${d} ${t}` : d;
});

const networkLabel = computed((): string => {
  const m = props.message;
  return (
    (m.networkName as string | undefined) ||
    networks.networks.find((n) => n.id === m.networkId)?.name ||
    `net:${m.networkId}`
  );
});

// Drop the `:server:<id>` pseudo-target so server messages render as just
// the network name (matches StatusBar.vue's buffer segment).
const targetLabel = computed(() => {
  const t = props.message.target;
  if (!t || t.startsWith(':server:')) return '';
  return t;
});

const nickStyle = computed((): CSSProperties | null => {
  if (line.value.self) return { color: selfColor.value as string };
  const c = nicks.color(line.value.nick);
  return c ? { color: c } : null;
});
</script>

<style scoped>
.text.deleted {
  color: var(--fg-muted);
  font-style: italic;
}
.row {
  /* No horizontal padding — the list already insets to the card's content edge
     (padding: 0 var(--card-pad-x) on its scroll container), so the row content
     sits flush with its full-width separators rather than adding a second inset.
     Roomy padding-bottom above the separator plus a margin below it space the
     rows well apart. */
  padding: var(--space-4) 0 var(--space-8);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--space-4);
  cursor: pointer;
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
  color: var(--fg-muted);
  margin-bottom: var(--space-3);
}
/* Time + remove icon, grouped at the right edge of the header strip — the
   xmark sits in the top-right corner and the date is nudged left to clear it. */
.meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-5);
  flex-shrink: 0;
}
.remove {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}
.remove:hover {
  color: var(--bad);
}
.where {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.net {
  color: var(--fg-muted);
}
.target {
  color: var(--accent);
}
.time {
  flex-shrink: 0;
}

.body {
  white-space: pre-wrap;
  word-break: break-word;
}
.relay-via {
  color: var(--fg-muted);
}
.sep {
  color: var(--border);
  margin: 0 0.5ch;
}
/* Mirror the channel-list rows: the message text sits at the secondary fg and
   lifts to full fg on row hover, so the row still has a hover tell even though
   the nick keeps its own color. */
.text {
  color: var(--fg-muted);
}
.row:hover .text {
  color: var(--fg);
}
</style>
