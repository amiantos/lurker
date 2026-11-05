<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The thread panel's list mode (#1225): the buffer's reply threads by last
  activity. Each row is the line that started it, in the reply quote's voice,
  with its reply count and when the newest came. A thread the user is in with
  replies they haven't seen is accented, as its chip is. Click opens it.
-->

<template>
  <div class="thread-list">
    <div v-if="!list || (list.loading && list.threads.length === 0)" class="notice">
      loading threads…
    </div>
    <div v-else-if="list.threads.length === 0" class="notice">
      No threads here yet. Reply to a line to start one.
    </div>
    <ul v-else>
      <li
        v-for="t in list.threads"
        :key="t.rootMsgid"
        class="row"
        :class="{ unread: unreadFor(t.rootMsgid) > 0 }"
        role="button"
        tabindex="0"
        @click="open(t.rootMsgid)"
        @keydown.enter.prevent="open(t.rootMsgid)"
        @keydown.space.prevent="open(t.rootMsgid)"
      >
        <span v-if="t.root && !hiddenRoot(t.root)" class="root"
          >{{ marks(t.root.type)[0] }}<NickRef :nick="t.root.nick" />{{ marks(t.root.type)[1] }}
          <template v-if="t.root.redacted">message deleted</template
          ><template v-else>{{ excerpt(t.root.text) }}</template></span
        >
        <span v-else class="root missing">original message unavailable</span>
        <span class="meta"
          ><span>{{ t.replies }} {{ t.replies === 1 ? 'reply' : 'replies' }}</span
          ><span class="when">{{ formatRelative(t.lastReplyTime) }}</span
          ><span v-if="unreadFor(t.rootMsgid) > 0">{{ unreadFor(t.rootMsgid) }} new</span></span
        >
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import NickRef from './NickRef.vue';
import { useThreadsStore } from '../stores/threads.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useIgnoresStore } from '../stores/ignores.js';
import type { ReplyParent } from '../../../shared/replies.js';
import { requestThreadNav } from '../composables/useThreadNav.js';
import { formatRelative } from '../utils/timestamp.js';
import { replyExcerpt } from '../utils/replyText.js';
import { quoteMarks } from '../../../shared/replies.js';

const props = defineProps<{ bufferId: number }>();
const threads = useThreadsStore();
const buffers = useBuffersStore();
const ignores = useIgnoresStore();

// The server leaves out a root from someone ignored when it arrived; someone
// ignored since is judged here, as the reply quote judges its parent.
function hiddenRoot(root: ReplyParent): boolean {
  const buf = buffers.byId(props.bufferId);
  if (root.self || !buf || buf.networkId == null) return false;
  return ignores.isMessageHidden(buf.networkId, { ...root, target: buf.target });
}

const list = computed(() =>
  threads.list && threads.list.bufferId === props.bufferId ? threads.list : null,
);

function unreadFor(rootMsgid: string): number {
  return threads.unreadFor(props.bufferId, rootMsgid);
}

function marks(type: string | null | undefined): [string, string] {
  return quoteMarks(type);
}

function excerpt(text: string): string {
  return replyExcerpt(text);
}

function open(rootMsgid: string): void {
  requestThreadNav({ kind: 'thread', bufferId: props.bufferId, rootMsgid });
}
</script>

<style scoped>
.thread-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.notice {
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-4) var(--space-6);
}
ul {
  list-style: none;
  margin: 0;
  padding: var(--space-2) 0;
}
.row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-6);
  cursor: pointer;
}
.row:hover,
.row:focus-visible {
  background: var(--bg-soft);
  outline: none;
}
.root {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.root.missing {
  color: var(--fg-muted);
  font-style: italic;
}
/* Facts side by side with a gap and no separator, as the compact head sets
   its time beside the nick. */
.meta {
  display: flex;
  gap: 0.75ch;
  color: var(--fg-muted);
}
.row.unread .meta {
  color: var(--accent);
}
</style>
