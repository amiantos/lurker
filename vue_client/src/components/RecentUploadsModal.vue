<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="uploads" title="recent uploads" size="xl" fill-height @close="$emit('close')">
    <p v-if="uploads.listError" class="error">{{ uploads.listError }}</p>
    <p v-if="deleteError" class="error">{{ deleteError }}</p>

    <div ref="listEl" class="list-wrap" @scroll="onScroll">
      <ul v-if="recentRows.length" class="list">
        <li v-for="u in recentRows" :key="u.id" class="row" :class="{ removed: u.removed }">
          <!-- Moderated-away upload: the object is gone, so show a tombstone
               instead of a link to a dead URL. -->
          <div v-if="u.removed" class="thumb thumb-placeholder" title="removed by moderation">
            <i class="fa-solid fa-gavel fa-2x"></i>
          </div>
          <a
            v-else
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
            <div v-if="u.removed" class="url removed-note">Removed by moderation</div>
            <div v-else class="url" :title="u.url">{{ u.url }}</div>
            <div class="sub">{{ metaLine(u) }}</div>
          </div>
          <div class="row-actions">
            <!-- Delete destroys the stored file. Offered only where that's true
                 (can_delete) — there is no remove-the-record-only action. -->
            <button
              v-if="!u.removed && u.can_delete"
              class="link delete"
              :disabled="deletingId === u.id"
              @click="onDelete(u)"
              title="delete file"
              aria-label="delete file"
            >
              <i
                :class="deletingId === u.id ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-trash'"
              ></i>
            </button>
            <!-- A removed upload's URL is dead, so there's nothing to copy. -->
            <button
              v-if="!u.removed"
              class="link copy"
              :class="{ copied: copiedId === u.id }"
              @click="onCopy(u)"
              :title="copiedId === u.id ? 'copied' : 'copy URL'"
              :aria-label="copiedId === u.id ? 'copied' : 'copy URL'"
            >
              <i :class="copiedId === u.id ? 'fa-solid fa-check' : 'fa-regular fa-copy'"></i>
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

defineEmits<{
  close: [];
}>();
const uploads = useUploadsStore();
// Cast the store's UploadItem[] to UploadRow[] so the template can access
// the server-supplied extra fields (created_at, byte_size, width, height).
const recentRows = computed(() => uploads.recent as UploadRow[]);
const listEl = ref<HTMLDivElement | null>(null);
const copiedId = ref<number | null>(null);
const deletingId = ref<number | null>(null);
const deleteError = ref('');

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
  if (!confirm(`Delete "${u.filename || u.url}"? The file is removed from storage.`)) return;
  deletingId.value = u.id;
  deleteError.value = '';
  try {
    await uploads.remove(u.id);
  } catch (e: any) {
    // The bytes weren't destroyed, so the row stays and the reason surfaces.
    deleteError.value = e.message || 'delete failed';
  } finally {
    deletingId.value = null;
  }
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Build the metadata sub-line in JS so the " · " separators keep their spaces —
// Vue's whitespace condensing strips the gaps between adjacent inline spans.
function metaLine(u: UploadRow): string {
  return [
    u.provider,
    u.created_at && formatRelative(u.created_at),
    u.byte_size && formatBytes(u.byte_size),
    u.width && u.height && `${u.width}×${u.height}`,
  ]
    .filter(Boolean)
    .join(' · ');
}
</script>

<style scoped>
.link {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.link:hover {
  color: var(--fg);
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
  /* Roomy padding-bottom above the separator plus a margin below it to space the
     rows well apart, matching HistoryMessageRow. */
  padding: var(--space-4) 0 var(--space-8);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--space-4);
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
.removed-note {
  color: var(--bad);
}
.row.removed .filename {
  color: var(--fg-muted);
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
/* Two icon actions at most (copy + delete) — they fit the actions column on
   every width, no separate mobile bar needed. Padding gives each a comfortable
   tap target. */
.copy,
.delete {
  padding: var(--space-3) var(--space-4);
  font-size: var(--icon-md);
}
.delete:hover {
  color: var(--bad);
}
.delete:disabled {
  color: var(--fg-muted);
  cursor: default;
}
.copy.copied {
  color: var(--good);
}
.copy.copied:hover {
  color: var(--good);
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
