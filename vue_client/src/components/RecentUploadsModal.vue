<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  The uploads browser (#547). It used to be a single-column list of thumbnails with
  an infinite-scroll cursor: fine for "the thing I just uploaded", useless for "that
  screenshot from March", which is the case that actually needs a browser.

  Two changes make that case work. SEARCH, which is server-side — unlike almost every
  other filter in Lurker, this one cannot be a render-time filter over what the client
  holds, because the client only holds the pages it has scrolled through and the whole
  point is finding one it hasn't. And a GRID, so the eye can scan instead of squint.

  Media and text uploads have no thumbnail (no ffmpeg, so no video poster frames —
  #515), so they get a type-icon tile in the same box rather than a different layout.
  A file card that happens to show an icon reads as a peer of one that shows a photo;
  a separate list of them would not.
-->

<template>
  <AppModal word="uploads" title="uploads" size="xl" fill-height @close="$emit('close')">
    <div class="filters">
      <div class="search">
        <i class="fa-solid fa-magnifying-glass search-icon"></i>
        <input
          ref="searchEl"
          v-model="query"
          type="search"
          class="search-input"
          placeholder="Search filenames…"
          aria-label="Search uploads by filename"
          @keydown.esc.stop="onEscape"
        />
      </div>
      <div class="kinds" role="group" aria-label="Filter by type">
        <button
          v-for="k in KIND_CHIPS"
          :key="k.value ?? 'all'"
          class="chip"
          :class="{ active: uploads.kind === k.value }"
          :aria-pressed="uploads.kind === k.value"
          @click="onKind(k.value)"
        >
          {{ k.label }}
        </button>
      </div>
    </div>

    <p v-if="uploads.listError" class="error">{{ uploads.listError }}</p>
    <p v-if="deleteError" class="error">{{ deleteError }}</p>

    <div ref="listEl" class="grid-wrap" @scroll="onScroll">
      <ul v-if="recentRows.length" class="grid">
        <li v-for="u in recentRows" :key="u.id" class="tile" :class="{ removed: u.removed }">
          <!-- Moderated-away upload: the object is gone, so show a tombstone
               instead of a link to a dead URL. -->
          <div v-if="u.removed" class="art art-icon" title="removed by moderation">
            <i class="fa-solid fa-gavel fa-2x"></i>
          </div>
          <!-- Still an <a href>, even though a left click opens the lightbox: that
               keeps middle-click and ⌘/ctrl-click opening the file in a new tab, which
               is what a thumbnail that looks like a link should do. Same modifier
               check RenderSegments makes for images in messages. -->
          <a
            v-else
            :href="u.url"
            target="_blank"
            rel="noreferrer noopener"
            class="art-link"
            :title="u.filename || u.url"
            @click="onArtClick($event, u)"
          >
            <img v-if="u.thumbnail_url" :src="u.thumbnail_url" class="art" alt="" loading="lazy" />
            <div v-else class="art art-icon">
              <i class="fa-solid fa-2x" :class="iconForMime(u.mime)"></i>
            </div>
          </a>

          <div class="actions">
            <!-- Delete destroys the stored file. Offered only where that's true
                 (can_delete) — there is no remove-the-record-only action. -->
            <button
              v-if="!u.removed && u.can_delete"
              class="act delete"
              :disabled="deletingId !== null"
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
              class="act copy"
              :class="{ copied: copiedId === u.id }"
              @click="onCopy(u)"
              :title="copiedId === u.id ? 'copied' : 'copy URL'"
              :aria-label="copiedId === u.id ? 'copied' : 'copy URL'"
            >
              <i :class="copiedId === u.id ? 'fa-solid fa-check' : 'fa-regular fa-copy'"></i>
            </button>
          </div>

          <div class="name" :title="u.filename || u.url">{{ u.filename || '(pasted)' }}</div>
          <div class="sub" :title="metaLine(u)">
            {{ u.removed ? 'Removed by moderation' : metaLine(u) }}
          </div>
        </li>
      </ul>

      <p v-else-if="uploads.loading && !uploads.loaded" class="empty">Loading…</p>
      <p v-else-if="uploads.loaded && isFiltered" class="empty">
        Nothing matches {{ filterDescription }}.
      </p>
      <p v-else-if="uploads.loaded" class="empty">
        No uploads yet. Paste, drop, or pick a file in the input.
      </p>
      <p v-if="uploads.loading && uploads.loaded && recentRows.length" class="empty small">
        Loading more…
      </p>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import { useUploadsStore } from '../stores/uploads.js';
import type { UploadItem, UploadKind } from '../stores/uploads.js';
import { useImageModal } from '../composables/useImageModal.js';
import { formatRelative } from '../utils/timestamp.js';
import { iconForMime } from '../utils/uploaders.js';

// The server response can include extra metadata fields not tracked in the
// store's base UploadItem shape (they come from the GET /api/uploads list).
interface UploadRow extends UploadItem {
  created_at?: string;
  byte_size?: number;
  width?: number;
  height?: number;
}

const KIND_CHIPS: Array<{ label: string; value: UploadKind | null }> = [
  { label: 'All', value: null },
  { label: 'Images', value: 'image' },
  { label: 'Video', value: 'video' },
  { label: 'Audio', value: 'audio' },
  { label: 'Text', value: 'text' },
];

// Long enough that a typed word is one request rather than eight, short enough that
// the grid still feels like it's responding to you.
const SEARCH_DEBOUNCE_MS = 250;

defineEmits<{
  close: [];
}>();
const uploads = useUploadsStore();
// Raw (not reactive()-wrapped) because this component reads the refs in script rather
// than the template — the two views that RENDER the viewer wrap it for unwrapping.
const imageModal = useImageModal();
const recentRows = computed(() => uploads.recent as UploadRow[]);
const listEl = ref<HTMLDivElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const copiedId = ref<number | null>(null);
const deletingId = ref<number | null>(null);
const deleteError = ref('');

// Local, so typing is never gated on a round trip; pushed to the store (and thus the
// server) on a debounce.
const query = ref(uploads.query);
let debounce: ReturnType<typeof setTimeout> | null = null;

const isFiltered = computed(() => Boolean(uploads.query || uploads.kind));
const filterDescription = computed(() => {
  const kindLabel = KIND_CHIPS.find((k) => k.value === uploads.kind)?.label.toLowerCase();
  if (uploads.query && uploads.kind) return `“${uploads.query}” in ${kindLabel}`;
  if (uploads.query) return `“${uploads.query}”`;
  return kindLabel ?? 'that filter';
});

watch(query, (next) => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    // Trim here rather than in the input: leading/trailing spaces are almost always
    // an accident of typing, and a search for " " should not be a search.
    void uploads.setFilters({ query: next.trim() }).catch(() => {
      /* surfaced via store.listError */
    });
  }, SEARCH_DEBOUNCE_MS);
});

onMounted(() => {
  // Reset the filters on open. A search left over from a previous session would look
  // like an empty uploads list — the worst possible first impression of the browser.
  void uploads.setFilters({ query: '', kind: null }).catch(() => {
    /* surfaced via store.listError */
  });
  query.value = '';
  searchEl.value?.focus();
});

onBeforeUnmount(() => {
  if (debounce) clearTimeout(debounce);
});

// Escape clears a non-empty search instead of closing the modal — the same convention
// as a browser find bar. With the field already empty it falls through to the modal's
// own close handler, so Escape still means "get me out of here" when there's nothing
// to clear.
function onEscape(event: KeyboardEvent) {
  if (!query.value) {
    (event.target as HTMLElement).blur();
    return;
  }
  query.value = '';
}

function onKind(kind: UploadKind | null) {
  if (uploads.kind === kind) return;
  void uploads.setFilters({ kind }).catch(() => {
    /* surfaced via store.listError */
  });
}

// ─── Lightbox ────────────────────────────────────────────────────────────────
//
// Clicking a thumbnail used to eject you into a new tab. It opens the viewer instead,
// and the viewer is a GALLERY: left/right walks the images in the result set you are
// currently looking at, at full size. Which means the search filters double as a way
// to scope the gallery — filter to images, type "march", and you can flick through
// exactly those.

// Only images. The viewer renders an <img>, so a .txt or an .mp4 in the gallery would
// be a step onto a blank screen. (Video joins it in #563; that's the card, not this
// one.) They keep the plain new-tab link.
const galleryItems = computed(() =>
  recentRows.value
    .filter((u) => !u.removed && (u.mime || '').startsWith('image/'))
    .map((u) => ({ url: u.url, filename: u.filename })),
);

function isViewable(u: UploadRow): boolean {
  return !u.removed && (u.mime || '').startsWith('image/');
}

function onArtClick(event: MouseEvent, u: UploadRow) {
  // Let the browser have the ones it does better: a modified click means "new tab",
  // and a non-image has nothing to show in an image viewer.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  if (!isViewable(u)) return;

  const items = galleryItems.value;
  const start = items.findIndex((i) => i.url === u.url);
  if (start < 0) return;

  event.preventDefault();
  imageModal.openGallery(items, start);
}

// Arrowing toward the end of what's loaded pages more in — otherwise the gallery
// silently stops at the last row the user happened to have scrolled to, which from
// inside the viewer looks like the end of their uploads.
watch(
  () => imageModal.index.value,
  (i) => {
    if (!imageModal.isOpen.value) return;
    if (i < galleryItems.value.length - 2) return;
    if (!uploads.hasMore || uploads.loading) return;
    void uploads.loadMore();
  },
);

// New rows landed (from paging, or a fresh upload) while the viewer is open — extend
// the gallery under it. setItems keeps the viewer on the image it is showing.
watch(galleryItems, (items) => {
  if (imageModal.isOpen.value) imageModal.setItems(items);
});

function onScroll() {
  const el = listEl.value;
  if (!el || !uploads.hasMore || uploads.loading) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) {
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
    // the user can fall back to opening the file and copying the address.
  }
}

async function onDelete(u: UploadRow) {
  // One delete at a time: a second in-flight delete would fight over the single
  // deletingId ref (spinner/disabled state desync). All delete buttons are
  // disabled while one runs; this guard covers the pre-render window.
  if (deletingId.value !== null) return;
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

// Built in JS so the " · " separators keep their spaces — Vue's whitespace condensing
// strips the gaps between adjacent inline spans.
function metaLine(u: UploadRow): string {
  return [
    u.created_at && formatRelative(u.created_at),
    u.byte_size && formatBytes(u.byte_size),
    u.provider,
  ]
    .filter(Boolean)
    .join(' · ');
}
</script>

<style scoped>
.filters {
  display: flex;
  gap: var(--space-4);
  align-items: center;
  flex-wrap: wrap;
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}
.search {
  position: relative;
  flex: 1;
  min-width: 200px;
}
.search-icon {
  position: absolute;
  left: var(--space-3);
  top: 50%;
  transform: translateY(-50%);
  color: var(--fg-muted);
  pointer-events: none;
}
.search-input {
  width: 100%;
  padding: var(--space-3) var(--space-3) var(--space-3) var(--space-8);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  color: var(--fg);
  font: inherit;
}
.search-input:focus {
  outline: none;
  border-color: var(--accent);
}
/* Safari draws its own clear affordance on type=search; ours is Escape. */
.search-input::-webkit-search-decoration,
.search-input::-webkit-search-cancel-button {
  appearance: none;
}

.kinds {
  display: flex;
  gap: var(--space-2);
}
.chip {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: var(--space-3) var(--space-4);
}
.chip:hover {
  color: var(--fg);
}
.chip.active {
  color: var(--fg);
  border-color: var(--accent);
  background: var(--bg-soft);
}

.error {
  margin: var(--space-4) 0 0;
  color: var(--bad);
}

.grid-wrap {
  /* Break out of card padding so the scrollbar sits against the card border;
     padding keeps tile content visually aligned with the rest. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: var(--space-4) var(--card-pad-x) 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  /* 180px, not 128: the point of a gallery is recognising a picture at a glance, and
     at 128 you squint — which is the complaint that started #547. The server thumb is
     512px, so this stays crisp at 2x and has room to grow.

     auto-fill, not auto-fit: a search that returns two results should leave them at
     tile size on the left, not stretch them across the whole modal. */
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--space-6);
}
.tile {
  position: relative;
  min-width: 0;
}
.art-link {
  display: block;
  line-height: 0;
}
.art {
  width: 100%;
  /* Square, so a portrait screenshot and a landscape one tile the same. The server
     thumbnail is a centre cover-crop, so this matches its own geometry. */
  aspect-ratio: 1;
  object-fit: cover;
  background: var(--bg-soft);
  border: 1px solid var(--border);
}
.art-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
}
.tile.removed .art {
  border-style: dashed;
}

.name {
  color: var(--fg);
  margin-top: var(--space-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub {
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tile.removed .name {
  color: var(--fg-muted);
}
.tile.removed .sub {
  color: var(--bad);
}

/* Actions sit on the art rather than below it: at tile density a permanent button row
   under every file would cost more vertical space than the filename does. They are
   revealed on hover where hover exists, and always visible where it doesn't — the
   :hover here is auto-wrapped in @media (hover: hover) at build time (#115), so on a
   touch device the base rule stands and the buttons are simply always there. */
.actions {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: flex;
  gap: var(--space-1);
}
/* A solid themed chip, NOT a scrim: --scrim is a dark translucent, so in the light
   theme a --fg icon on it would be dark-on-dark. The art behind is arbitrary user
   imagery, so the button has to bring its own background either way. */
.act {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: var(--space-2) var(--space-3);
  font-size: var(--icon-md);
  line-height: 1;
}
@media (hover: hover) {
  .actions {
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .tile:hover .actions,
  .tile:focus-within .actions {
    opacity: 1;
  }
}
.act:hover {
  color: var(--fg);
}
.delete:hover {
  color: var(--bad);
}
.act:disabled {
  color: var(--fg-muted);
  cursor: default;
}
.copy.copied {
  color: var(--good);
}

.empty {
  padding: var(--space-9) 0;
  color: var(--fg-muted);
  text-align: center;
}
.empty.small {
  padding: var(--space-4) 0;
}
</style>
