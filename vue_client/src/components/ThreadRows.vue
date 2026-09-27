<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A buffer's followed reply threads (#993), nested under its row in the
  buffer list: the ones the user posted in or was highlighted in, newest
  activity first (stores/threads.ts). Each reads as its name — the user's, or
  its first line's words (threads.title) — with the same badges a buffer row
  has. Its menu renames it, in place, or takes it off the list until the user
  posts or is highlighted there again. The tree guides continue the list's
  own, a level in.
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
      :title="editing === t.rootMsgid ? undefined : title(t)"
      @click.stop="open(t)"
      @contextmenu.stop.prevent="openMenu(t, $event.clientX, $event.clientY, null)"
    >
      <input
        v-if="editing === t.rootMsgid"
        ref="nameInput"
        v-model="draft"
        class="rename"
        :maxlength="NAME_MAX"
        aria-label="Thread name"
        placeholder="name it from its first line"
        @click.stop
        @keydown.enter.prevent="saveRename(t)"
        @keydown.escape.prevent="editing = null"
        @blur="editing = null"
      />
      <span v-else class="label">{{ threadsStore.title(t.bufferId, t.rootMsgid) }}</span>
      <template v-if="editing !== t.rootMsgid">
        <span v-if="t.highlighted" class="badge highlight" title="highlight">●</span>
        <span v-if="t.unread > 0" class="badge">{{ unreadLabel(t.unread) }}</span>
        <button
          type="button"
          class="row-actions"
          title="Actions"
          aria-label="Thread actions"
          @click.stop="openMenuFromButton(t, $event)"
          @contextmenu.stop.prevent
        >
          <i class="fa-solid fa-ellipsis-vertical"></i>
        </button>
      </template>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useThreadsStore } from '../stores/threads.js';
import type { FollowedThread } from '../stores/threads.js';
import { useThreadRoute, pushThread } from '../composables/useThreadRoute.js';
import { useContextMenu } from '../composables/useContextMenu.js';
import { unreadLabel } from '../utils/unreadLabel.js';

defineProps<{ threads: FollowedThread[] }>();

// The server's limit (THREAD_NAME_MAX); it trims past it anyway.
const NAME_MAX = 100;

const router = useRouter();
const threadsStore = useThreadsStore();
const route = useThreadRoute();
const menu = useContextMenu();

// The row being renamed, in place, and what's typed so far.
const editing = ref<string | null>(null);
const draft = ref('');
const nameInput = ref<HTMLInputElement[] | null>(null);

function isActive(t: FollowedThread): boolean {
  return route.value?.bufferId === t.bufferId && route.value.rootMsgid === t.rootMsgid;
}

function open(t: FollowedThread): void {
  if (editing.value === t.rootMsgid) return;
  if (!isActive(t)) pushThread(router, t.bufferId, t.rootMsgid);
}

function title(t: FollowedThread): string {
  const name = threadsStore.title(t.bufferId, t.rootMsgid);
  return t.unread > 0 ? `${name} — ${t.unread} new` : name;
}

async function startRename(t: FollowedThread): Promise<void> {
  draft.value = t.name ?? '';
  editing.value = t.rootMsgid;
  await nextTick();
  const input = nameInput.value?.[0];
  input?.focus();
  input?.select();
}

function saveRename(t: FollowedThread): void {
  // Blank goes back to the name its first line gives it.
  if (draft.value.trim() !== (t.name ?? '')) {
    threadsStore.rename(t.bufferId, t.rootMsgid, draft.value);
  }
  editing.value = null;
}

function openMenu(t: FollowedThread, x: number, y: number, trigger: Element | null): void {
  menu.open(
    [
      { label: 'Rename…', icon: 'fa-solid fa-pen', onClick: () => void startRename(t) },
      {
        label: 'Remove from list',
        icon: 'fa-solid fa-xmark',
        onClick: () => threadsStore.unfollow(t.bufferId, t.rootMsgid),
      },
    ],
    x,
    y,
    trigger,
  );
}

function openMenuFromButton(t: FollowedThread, e: MouseEvent): void {
  const el = e.currentTarget as Element;
  const rect = el.getBoundingClientRect();
  openMenu(t, rect.left, rect.bottom + 2, el);
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
.rename {
  flex: 1;
  min-width: 0;
  font: inherit;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-1);
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
