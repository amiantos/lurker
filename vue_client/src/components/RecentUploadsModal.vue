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
          @keydown.esc="onEscape"
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

          <div class="name" :title="u.filename || u.url">{{ u.filename || '(pasted)' }}</div>
          <div class="sub" :title="metaLine(u)">
            {{ u.removed ? 'Removed by moderation' : metaLine(u) }}
          </div>

          <!-- Overlaid on the artwork (absolutely positioned, so source order is free)
               and last in the DOM so keyboard focus reaches the image itself before its
               controls. Revealed on hover with a pointer; always visible, and finger-
               sized, on touch — see the @media rules. -->
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
              :class="{ copied: clipboard.isCopied(u.id) }"
              @click="onCopy(u)"
              :title="clipboard.isCopied(u.id) ? 'copied' : 'copy link'"
              :aria-label="clipboard.isCopied(u.id) ? 'copied' : 'copy link'"
            >
              <i :class="clipboard.isCopied(u.id) ? 'fa-solid fa-check' : 'fa-regular fa-copy'"></i>
            </button>
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
import { useCopyFeedback } from '../composables/useCopyFeedback.js';
import { formatRelative } from '../utils/timestamp.js';
import { joinMeta } from '../utils/metaLine.js';
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
const clipboard = useCopyFeedback();
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
  // Trim here rather than in the input: leading/trailing spaces are almost always an
  // accident of typing, and a search for " " should not be a search.
  const trimmed = next.trim();
  // Nothing the SERVER would answer differently — the user added a trailing space, or
  // typed their way back to the term we already have results for. Also covers the open:
  // onMounted resets the store's filters and then clears this field, which would
  // otherwise schedule a second, identical request 250ms behind the first and supersede
  // it mid-flight.
  if (trimmed === uploads.query) return;
  debounce = setTimeout(() => {
    void uploads.setFilters({ query: trimmed }).catch(() => {
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
// as a browser find bar. With the field already empty there is nothing to clear, so it
// bubbles to AppModal's own @keydown.esc and Escape still means "get me out of here".
//
// ⚠ The propagation stop has to be CONDITIONAL. A blanket `.stop` on the template
// severs the bubble in both cases, so Escape on an empty field just blurred the input
// and the modal never closed — exactly the behaviour this comment used to claim it had.
function onEscape(event: KeyboardEvent) {
  if (!query.value) return; // nothing to clear → let AppModal have it
  event.stopPropagation();
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

// The `key` is why useCopyFeedback takes one: one instance serves the whole grid, and
// only the tile that was copied ticks.
function onCopy(u: UploadRow) {
  void clipboard.copy(u.url, u.id);
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

// Deliberately does NOT name the uploader. Which backend a file happened to land on is
// the app's business, not the user's: it doesn't help you recognise a picture, and it
// isn't actionable from here. When it matters — the file is gone, or can't be deleted
// — that surfaces as its own state, not as a label on every tile.
function metaLine(u: UploadRow): string {
  return joinMeta([
    u.created_at && formatRelative(u.created_at),
    u.byte_size && formatBytes(u.byte_size),
  ]);
}
</script>

<style scoped>
/* Matches .search-row in HighlightsModal / SearchModal: a margin, not a rule. Those
   two are the house pattern for "a filter field above a scrolling list", and this
   modal is the same shape — an extra border here just made it look like a different
   app. */
.filters {
  display: flex;
  gap: var(--space-4);
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: var(--space-6);
}
.search {
  position: relative;
  flex: 1;
  min-width: 200px;
  /* One knob for both the glyph's inset and the text's. They have to move together —
     the caret's position is DERIVED from where the icon ends, so a hardcoded value in
     each would let them drift apart the next time either is nudged. */
  --search-icon-inset: var(--space-5);
}
.search-icon {
  position: absolute;
  left: var(--search-icon-inset);
  top: 50%;
  transform: translateY(-50%);
  color: var(--fg-muted);
  pointer-events: none;
  /* Pin the glyph to a known box. Font Awesome glyph widths vary per icon, so without
     this the input's padding below would be guessing at where the icon ends. */
  width: 1em;
  text-align: center;
}
/* The same field as .filter in HighlightsModal / SearchModal — background, border and
   padding all match. Only the LEFT padding differs, because ours has an icon in it. */
.search-input {
  width: 100%;
  /* Left padding is derived, not picked: where the icon starts, plus the icon's own
     width, plus one character of breathing room. */
  padding: var(--space-4) var(--space-5) var(--space-4) calc(var(--search-icon-inset) + 1em + 1ch);
  background: var(--bg);
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
     padding keeps tile content visually aligned with the rest. Same as .match-list in
     HighlightsModal — the gap above comes from the filter row's margin, not from a
     padding here, so the two don't stack. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x);
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
/* ─── Tile actions ───────────────────────────────────────────────────────────
   Always ON the artwork — a row of buttons hanging below the file reads as orphaned,
   and at tile density it costs more vertical space than the filename does.

   What differs by input is REVEAL and SIZE, not position. With a pointer they fade in
   on hover, compact, because you can aim: a 26px chip is a fine mouse target. On touch
   there is no hover, so they are simply always there — and they have to be big enough
   to hit deliberately, because the thing next to `copy` deletes the file. */
.actions {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: flex;
  gap: var(--space-2);
}
/* A solid themed chip, NOT a scrim: --scrim is a dark translucent, so in the light
   theme a --fg icon on it would be dark-on-dark. It sits on arbitrary user imagery, so
   the button has to bring its own background either way. */
.act {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  font-size: var(--icon-md);
  line-height: 1;
  /* The iOS minimum, and the touch default. A 26px chip is hittable with a mouse and a
     coin toss with a thumb. */
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (hover: hover) {
  .actions {
    gap: var(--space-1);
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  /* focus-within, not just hover: hidden-until-hover is the ONLY way to reach copy and
     delete with a pointer, so they have to be reachable by keyboard too. */
  .tile:hover .actions,
  .tile:focus-within .actions {
    opacity: 1;
  }
  /* Compact, now that they only appear when you're already pointing at the tile — and
     44px chips would cover half a thumbnail for no benefit to someone with a mouse. */
  .act {
    min-width: 0;
    min-height: 0;
    padding: var(--space-2) var(--space-3);
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
