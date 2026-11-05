<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  An IRCv3 reply's quote (#993): the line it answers, as the first line of the
  reply's own body — the counterpart of ReactionRow under the text. Part of the
  message, so a reply doesn't break its author's run of lines.

  Written the way IRC writes the line — `<alice> text`, `* bob waves`,
  `-ChanServ- text` — after a box-drawing arm (the list's other markers are
  plain text, and the square corner matches the buffer list's lines), so it
  reads as what was said, not as a sentence starting with a name. One clipped
  line, italic, faded with opacity so the quoted nick keeps its own colour.
  Clicking (or Enter/Space) jumps to the line; with no parent to show it says
  so and does nothing. A deleted parent (#1013) says so too, and still jumps:
  the line is there, as a placeholder. Out of the buffer (search, activity, bookmarks — #998)
  it's `static`: part of the row, whose click jumps to the reply, where this
  quote is live again.
-->

<template>
  <span
    class="reply-quote"
    :class="{ missing: !parent, static: $props.static }"
    :title="live ? 'Jump to this message' : undefined"
    :role="live ? 'button' : undefined"
    :tabindex="live ? 0 : undefined"
    @click="onClick"
    @keydown.enter.space="onKey"
    ><span class="reply-mark" role="img" aria-label="In reply to">╭─</span
    ><span class="reply-text"
      ><template v-if="parent"
        >{{ marks[0]
        }}<NickRef
          :nick="parent.nick"
          :self="parent.self"
          :network-id="networkId"
          :plain="!!parent.relaySource"
        />{{ marks[1] }}
        <span
          v-if="parent.relaySource"
          class="reply-relay"
          :title="`Relayed via ${parent.relayBot}`"
          >[{{ parent.relaySource }}] </span
        ><template v-if="parent.redacted">message deleted</template
        ><template v-else>{{ replyExcerpt(parent.text) }}</template></template
      ><template v-else>original message unavailable</template></span
    ></span
  >
</template>

<script setup lang="ts">
import { computed } from 'vue';
import NickRef from './NickRef.vue';
import { replyExcerpt } from '../utils/replyText.js';
import { quoteMarks, type QuotedLine, type ReplyParent } from '../../../shared/replies.js';

const props = defineProps<{
  // The answered line as it should show — null for "unavailable" (gone, never
  // held, or from someone ignored; useReplyQuote decides).
  // A relayed line comes unwrapped (QuotedLine), `self` then saying whether
  // the person in it is you (useReplyQuote).
  parent: QuotedLine | null;
  // The network the quoted line is on, for its author's display name (#607);
  // a search or history result can come from a network other than the open one.
  networkId?: number | null;
  // Not a control of its own: clicks fall through to what it sits in.
  static?: boolean;
}>();

const emit = defineEmits<{ jump: [parent: ReplyParent] }>();

const live = computed(() => !!props.parent && !props.static);

// What goes either side of the nick, by the quoted line's type — the rule the
// Quote action's plain-text line shares.
const marks = computed(() => quoteMarks(props.parent?.type));

// In the timeline the quote keeps its clicks, even with nothing to jump to;
// static, they're the row's.
function onClick(e: MouseEvent): void {
  if (props.static) return;
  e.stopPropagation();
  if (props.parent) emit('jump', props.parent);
}

function onKey(e: KeyboardEvent): void {
  if (props.static) return;
  e.preventDefault();
  e.stopPropagation();
  if (props.parent) emit('jump', props.parent);
}
</script>

<style scoped>
.reply-quote {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg);
  font-style: italic;
  opacity: var(--quote-fade);
  cursor: pointer;
}
.reply-quote:not(.missing):not(.static):hover {
  opacity: 0.8;
}
.reply-quote.missing {
  cursor: default;
}
/* Part of the row it sits in: the row's cursor, and no hover of its own. */
.reply-quote.static {
  cursor: inherit;
}
.reply-mark {
  margin-right: 1ch;
  /* Upright in the italic line: a slanted corner stops lining up. */
  font-style: normal;
  /* Nudged up off the baseline, so the arm sits level with the text's middle.
     Relative, so the line's height doesn't change. */
  position: relative;
  top: -3px;
}
</style>
