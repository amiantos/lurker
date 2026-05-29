<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="uploads" title="recent uploads" size="xl" @close="$emit('close')">
    <p v-if="uploads.listError" class="error">{{ uploads.listError }}</p>

    <div ref="listEl" class="list-wrap" @scroll="onScroll">
      <ul v-if="recentRows.length" class="list">
        <li v-for="u in recentRows" :key="u.id" class="row">
          <a
            :href="u.url"
            target="_blank"
            rel="noreferrer noopener"
            class="thumb-link"
            :title="u.url"
          >
            <img
              v-if="u.thumbnail_url"
              :src="u.thumbnail_url"
              class="thumb"
              alt=""
              loading="lazy"
            />
            <div v-else class="thumb thumb-placeholder">
              <i class="fa-solid fa-file-lines fa-2x"></i>
            </div>
          </a>
          <div class="meta">
            <div class="filename" :title="u.filename || ''">{{ u.filename || '(pasted)' }}</div>
            <div class="url" :title="u.url">{{ u.url }}</div>
            <div class="sub">
              <span v-if="u.provider">{{ u.provider }}</span>
              <span v-if="u.created_at">· {{ formatRelative(u.created_at) }}</span>
              <span v-if="u.byte_size">· {{ formatBytes(u.byte_size) }}</span>
              <span v-if="u.width && u.height">· {{ u.width }}×{{ u.height }}</span>
            </div>
          </div>
          <div class="row-actions">
            <button class="link" @click="onInsert(u)" title="insert URL into input">insert</button>
            <button
              class="link"
              @click="onCopy(u)"
              :title="copiedId === u.id ? 'copied' : 'copy URL'"
            >
              {{ copiedId === u.id ? 'copied' : 'copy' }}
            </button>
            <button
              class="link danger"
              @click="onDelete(u)"
              title="remove from history (does not delete from host)"
            >
              delete
            </button>
          </div>
        </li>
      </ul>
      <p v-else-if="uploads.loading && !uploads.loaded" class="empty">Loading…</p>
      <p v-else-if="uploads.loaded" class="empty">
        No uploads yet. Paste, drop, or pick an image in the input.
      </p>
      <p v-if="uploads.loading && uploads.loaded" class="empty small">Loading more…</p>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import { useUploadsStore } from '../stores/uploads.js';
import type { UploadItem } from '../stores/uploads.js';
import { formatRelative } from '../utils/timestamp.js';

// The server response can include extra metadata fields not tracked in the
// store's base UploadItem shape (they come from the GET /api/uploads list).
interface UploadRow extends UploadItem {
  created_at?: string;
  byte_size?: number;
  width?: number;
  height?: number;
}

const emit = defineEmits<{
  close: [];
}>();
const uploads = useUploadsStore();
// Cast the store's UploadItem[] to UploadRow[] so the template can access
// the server-supplied extra fields (created_at, byte_size, width, height).
const recentRows = computed(() => uploads.recent as UploadRow[]);
const listEl = ref<HTMLDivElement | null>(null);
const copiedId = ref<number | null>(null);

onMounted(() => {
  uploads.loadRecent().catch(() => {
    /* surfaced via store.listError */
  });
});

function onScroll() {
  const el = listEl.value;
  if (!el || !uploads.hasMore || uploads.loading) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
    uploads.loadMore();
  }
}

function onInsert(u: UploadRow) {
  uploads.requestInsert(u.url);
  emit('close');
}

async function onCopy(u: UploadRow) {
  try {
    await navigator.clipboard.writeText(u.url);
    copiedId.value = u.id;
    setTimeout(() => {
      if (copiedId.value === u.id) copiedId.value = null;
    }, 1500);
  } catch (_) {
    // Clipboard API can fail without a user-gesture context on Firefox/Safari;
    // the user can fall back to right-click-copy on the URL text.
  }
}

async function onDelete(u: UploadRow) {
  try {
    await uploads.remove(u.id);
  } catch (_) {
    /* listError set */
  }
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<style scoped>
.link {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.link:hover {
  color: var(--accent);
}
.link.danger:hover {
  color: var(--bad);
}

.error {
  margin: 0 0 var(--space-4);
  padding: var(--space-4) 0;
  color: var(--bad);
  border-bottom: 1px solid var(--border);
}

.list-wrap {
  /* Break out of card padding so the scrollbar sits against the card
     border; padding keeps row content visually aligned with the rest. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: grid;
  grid-template-columns: 80px 1fr max-content;
  /* Tight column-gap so the thumb hugs the meta text. The meta→actions
     edge gets its own breathing room via margin-left on .row-actions. */
  column-gap: var(--space-2);
  row-gap: var(--space-4);
  align-items: center;
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border);
}
.thumb-link {
  display: block;
  line-height: 0;
}
.thumb {
  width: 64px;
  height: 64px;
  object-fit: cover;
  background: var(--bg-soft);
  border: 1px solid var(--border);
}
.thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
}
.meta {
  min-width: 0;
}
.filename {
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.url {
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub {
  color: var(--fg-muted);
  margin-top: var(--space-1);
}
.row-actions {
  display: flex;
  gap: var(--space-4);
  align-items: center;
  margin-left: var(--space-6);
}

/* Phone widths: stack the actions under the thumb+meta block instead of
   trying to fit a third column. Bumps the tap target padding so the
   tiny text links aren't a coin-toss to hit with a thumb. */
@media (max-width: 768px) {
  .row {
    grid-template-columns: 80px 1fr;
    row-gap: var(--space-4);
  }
  .row-actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
    margin-left: 0;
  }
  .row-actions .link {
    padding: var(--space-3) var(--space-5);
  }
}

.empty {
  padding: var(--space-9) 0;
  color: var(--fg-muted);
  text-align: center;
}
.empty.small {
  padding: var(--space-4) 0;
  color: var(--fg-muted);
}
</style>
