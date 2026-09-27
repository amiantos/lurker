<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A channel's followed reply threads (#993), nested under its row in the
  buffer list: the ones the user posted in or was highlighted in, newest
  activity first (stores/threads.ts). Each reads as the line that started it,
  `<nick> text`, with the same badges a buffer row has; × takes it off the list
  until the user posts or is highlighted there again. The tree guides continue
  the list's own, a level in.
-->

<template>
  <ul class="threads" role="group" aria-label="Threads">
    <li
      v-for="t in threads"
      :key="t.rootMsgid"
      :class="{
        active: isActive(t),
        unread: t.unread > 0,
        highlighted: t.highlighted,
      }"
      :title="title(t)"
      @click.stop="open(t)"
      @contextmenu.stop
    >
      <span class="label"
        ><template v-if="t.root">&lt;{{ t.root.nick }}&gt; {{ excerpt(t.root.text) }}</template
        ><template v-else>thread</template></span
      >
      <span v-if="t.highlighted" class="badge highlight" title="highlight">●</span>
      <span v-if="t.unread > 0" class="badge">{{ unreadLabel(t.unread) }}</span>
      <button
        type="button"
        class="row-actions"
        title="Remove from list"
        aria-label="Remove thread from list"
        @click.stop="threadsStore.unfollow(t.bufferId, t.rootMsgid)"
      >
        <i class="fa-solid fa-xmark"></i>
      </button>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useThreadsStore } from '../stores/threads.js';
import type { FollowedThread } from '../stores/threads.js';
import { useThreadRoute, pushThread } from '../composables/useThreadRoute.js';
import { unreadLabel } from '../utils/unreadLabel.js';
import { replyExcerpt } from '../utils/replyText.js';

defineProps<{ threads: FollowedThread[] }>();

const router = useRouter();
const threadsStore = useThreadsStore();
const route = useThreadRoute();

function isActive(t: FollowedThread): boolean {
  return route.value?.bufferId === t.bufferId && route.value.rootMsgid === t.rootMsgid;
}

function open(t: FollowedThread): void {
  if (!isActive(t)) pushThread(router, t.bufferId, t.rootMsgid);
}

function excerpt(text: string): string {
  return replyExcerpt(text);
}

function title(t: FollowedThread): string {
  const who = t.root ? `<${t.root.nick}> ${excerpt(t.root.text)}` : 'a thread';
  return t.unread > 0 ? `${who} — ${t.unread} new` : who;
}
</script>

<style scoped>
.threads {
  flex-basis: 100%;
  list-style: none;
  margin: 0;
  padding: 0;
}
.threads li {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-5) var(--space-1) var(--space-8);
  cursor: pointer;
  position: relative;
  user-select: none;
  color: var(--fg-muted);
}
/* The list's ├─ / └─, a level in: under the channel's label. */
.threads li::before {
  content: '';
  position: absolute;
  left: var(--space-3);
  top: 0;
  height: calc(var(--space-1) + 0.775em);
  width: 8px;
  border-left: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  pointer-events: none;
}
.threads li:not(:last-child)::after {
  content: '';
  position: absolute;
  left: var(--space-3);
  top: calc(var(--space-1) + 0.775em);
  bottom: 0;
  border-left: 1px solid var(--border);
  pointer-events: none;
}
@media (hover: hover) {
  .threads li:hover {
    background: var(--bg-soft);
  }
  .threads li:hover .row-actions {
    opacity: 1;
    pointer-events: auto;
  }
  .threads li:hover .badge {
    visibility: hidden;
  }
}
.threads li.active {
  background: var(--bg-soft);
  color: var(--fg);
}
.threads li.unread .label {
  color: var(--buffer-unread);
}
.threads li.highlighted .label {
  color: var(--buffer-highlight);
}
.label {
  flex: 1;
  min-width: 0;
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
.row-actions {
  position: absolute;
  right: var(--space-2);
  top: calc(var(--space-1) + 0.775em);
  transform: translateY(-50%);
  padding: 0 var(--space-2);
  background: var(--bg-soft);
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  line-height: 1;
  opacity: 0;
  pointer-events: none;
}
.threads li.active .row-actions,
.row-actions:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
.threads li.active .badge {
  visibility: hidden;
}
</style>
