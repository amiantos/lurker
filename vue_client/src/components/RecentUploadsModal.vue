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

  Uploads are called shares here (#1085): what you shared in chat. The same
  window, with `view="dcc"`, is the DCC window, opened by its own button: the
  files the account keeps on the server and the transfers and XDCC queue moving
  them (DccFilesTab), under the same search and type chips.
-->

<template>
  <AppModal :word="view" :title="title" size="xl" fill-height @close="$emit('close')">
    <div class="filters">
      <!-- Search and the starred toggle share a line. The toggle used to sit after
           the kind chips, where it had nowhere to go: those five fill the content
           width on a phone, so it wrapped onto a row of its own even reduced to a
           bare star. The search field is the one flexible thing in this bar, so the
           toggle rides in the space that field gives up instead. -->
      <div class="search-row">
        <div class="search">
          <SearchIcon class="search-icon" />
          <input
            ref="searchEl"
            :value="onDcc ? dccQuery : query"
            @input="onDcc ? onDccQueryInput($event) : onQueryInput($event)"
            type="search"
            class="search-input"
            placeholder="Search filenames…"
            :aria-label="onDcc ? 'Search DCC files by filename' : 'Search shares by filename'"
            @keydown.esc="onEscape"
          />
        </div>
        <!-- Not a sixth kind chip: starred composes WITH a kind ("my starred
             gifs") rather than replacing one, and sitting inside the All/Images/…
             row would imply the mutual exclusivity those have. Beside the search
             field it reads as what it is — another way to narrow the same list. -->
        <span v-if="!onDcc" class="btn-bar starred">
          <button
            :aria-pressed="uploads.favoritesOnly"
            title="Show only starred uploads"
            aria-label="Show only starred uploads"
            @click="onToggleFavoritesFilter"
          >
            <StarIcon /><span class="label">Starred</span>
          </button>
        </span>
      </div>
      <div class="kinds btn-bar" role="group" aria-label="Filter by type">
        <button
          v-for="k in KIND_CHIPS"
          :key="k.value ?? 'all'"
          :aria-pressed="activeKind === k.value"
          @click="onKind(k.value)"
        >
          {{ k.label }}
        </button>
      </div>
    </div>

    <div v-if="onDcc" class="grid-wrap">
      <DccFilesTab :query="dccQuery" :kind="dccKind" />
    </div>

    <p v-if="!onDcc && uploads.listError" class="error">{{ uploads.listError }}</p>
    <!-- After a failed delete the row still looks deletable, so its tile keeps
         offering only the trash. The way off the list for it is here. -->
    <p v-if="!onDcc && actionError" class="error">
      {{ actionError }}
      <button v-if="failedDelete" class="link" @click="onForget(failedDelete)">
        Remove it from the list instead
      </button>
    </p>

    <div v-if="!onDcc" ref="listEl" class="grid-wrap" @scroll="onScroll">
      <ul v-if="recentRows.length" class="grid">
        <li v-for="u in recentRows" :key="u.id" class="tile" :class="{ removed: u.removed }">
          <!-- Moderated-away upload: the object is gone, so show a tombstone
               instead of a link to a dead URL. -->
          <div v-if="u.removed" class="art art-icon" title="removed by moderation">
            <GavelIcon />
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
              <component :is="iconForMime(u.mime)" />
            </div>
          </a>

          <!-- The star lives in its own corner, away from the action cluster,
               because it is a STATE badge as much as a control: filled, it has to
               be readable at a glance while scanning the unfiltered grid, so unlike
               copy/delete it stays visible once set rather than hiding until hover.
               Keeping it out of that cluster is also what keeps three finger-sized
               buttons fitting across a 180px tile on touch. -->
          <!-- ⚠ `!u.removed || u.favorite`, not just `!u.removed`. A moderated
               takedown does not clear the star (the server keeps it, so the state
               survives if the row is ever restored), which means a tombstone can
               arrive already starred — and hiding the button on every removed row
               would leave that star set with no way in any UI to clear it. Nothing
               new can be starred from a tombstone; an existing one can be undone. -->
          <div v-if="!u.removed || u.favorite" class="star-slot" :class="{ starred: u.favorite }">
            <button
              class="act star"
              :class="{ on: u.favorite }"
              :disabled="starring.has(u.id)"
              :title="u.favorite ? 'unstar' : 'star for quick access'"
              :aria-label="u.favorite ? 'unstar' : 'star for quick access'"
              :aria-pressed="!!u.favorite"
              @click="onToggleStar(u)"
            >
              <StarIcon :class="{ 'icon-filled': u.favorite }" />
            </button>
          </div>

          <div class="name" :title="u.filename || u.url">{{ u.filename || '(pasted)' }}</div>
          <div class="sub" :title="metaLine(u)">
            <template v-if="u.removed">Removed by moderation</template>
            <MetaLine v-else :parts="metaParts(u)" />
          </div>

          <!-- Overlaid on the artwork (absolutely positioned, so source order is free)
               and last in the DOM so keyboard focus reaches the image itself before its
               controls. Revealed on hover with a pointer; always visible, and finger-
               sized, on touch — see the @media rules. -->
          <div class="actions">
            <!-- Delete destroys the stored file. Offered only where that's true
                 (can_delete). Every other row — no delete handle, a destination
                 the user removed, a moderation tombstone — gets "remove from
                 list" instead (#1289): the record goes, the file stays wherever
                 it is. One or the other on a tile; the second also appears in
                 the error line once a delete has failed, so a row that only
                 LOOKS deletable is never stuck. -->
            <button
              v-if="!u.removed && u.can_delete"
              class="act delete"
              :disabled="deletingId !== null"
              @click="onDelete(u)"
              title="delete file"
              aria-label="delete file"
            >
              <LoaderCircleIcon v-if="deletingId === u.id" class="icon-spin" />
              <TrashIcon v-else />
            </button>
            <!-- Not `.delete`: this one doesn't destroy anything, so it must not
                 hover the destructive red. -->
            <button
              v-else
              class="act forget"
              :disabled="deletingId !== null"
              @click="onForget(u)"
              title="remove from list"
              aria-label="remove from list"
            >
              <LoaderCircleIcon v-if="deletingId === u.id" class="icon-spin" />
              <ListXIcon v-else />
            </button>
            <!-- Put it in the message being composed. The modal closes on the way
                 out — you asked for this file, so the browse is over; leaving it up
                 over the composer you just typed into would be in the way.

                 ⚠ Gated on there BEING a composer. The mobile shell opens this
                 browser from the buffer-list screen, which has no MessageInput
                 mounted, so the insert would land nowhere and report nothing —
                 a button that only works on desktop. Copy link is the mobile
                 path, and it is right there. -->
            <button
              v-if="!u.removed && uploads.canInsert"
              class="act insert"
              @click="onInsert(u)"
              title="add to message"
              aria-label="add to message"
            >
              <CornerRightDownIcon />
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
              <CheckIcon v-if="clipboard.isCopied(u.id)" />
              <CopyIcon v-else />
            </button>
          </div>
        </li>
      </ul>

      <p v-else-if="uploads.loading && !uploads.loaded" class="empty">Loading…</p>
      <p v-else-if="uploads.loaded && isFiltered" class="empty">
        Nothing matches {{ filterDescription }}.
      </p>
      <p v-else-if="uploads.loaded" class="empty">
        Nothing shared yet. Paste, drop, or pick a file in the input.
      </p>
      <!-- The starred view comes back whole rather than paged, so when it arrives
           full there may be more the server didn't send. Say so — silence here
           reads as "that's all of them". -->
      <p v-if="uploads.favoritesTruncated" class="empty small">
        Showing your {{ recentRows.length }} most recently starred shares.
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
import DccFilesTab from './DccFilesTab.vue';
import MetaLine from './MetaLine.vue';
import { useUploadsStore } from '../stores/uploads.js';
import type { UploadItem, UploadKind } from '../stores/uploads.js';
import { useMediaViewer } from '../composables/useMediaViewer.js';
import { useCopyFeedback } from '../composables/useCopyFeedback.js';
import { formatRelative } from '../utils/timestamp.js';
import { joinMeta, type MetaPart } from '../utils/metaLine.js';
import { useDccStore } from '../stores/dcc.js';
import { formatBytes } from '../utils/formatBytes.js';
import { iconForMime } from '../utils/uploaders.js';
import { mediaKindForUrl } from '../utils/uploadHostMatch.js';
import { useImeSafeInput } from '../composables/useImeSafeInput.js';
import {
  CheckIcon,
  CopyIcon,
  CornerRightDownIcon,
  GavelIcon,
  ListXIcon,
  LoaderCircleIcon,
  SearchIcon,
  StarIcon,
  TrashIcon,
} from '@lucide/vue';

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

const props = withDefaults(defineProps<{ view?: 'shares' | 'dcc' }>(), { view: 'shares' });
const emit = defineEmits<{
  close: [];
}>();
const uploads = useUploadsStore();

const onDcc = computed(() => props.view === 'dcc');
const dcc = useDccStore();
// Picking a file for a secure send (#1157) names the window after it, since the
// pick's kind is set by the menu entry that opened it and shown nowhere else.
const title = computed(() => (onDcc.value && dcc.pick?.secure ? 'secure dcc' : props.view));
// The DCC window filters what it already holds, so its search and chip are its
// own, apart from the shares search the server answers.
const dccQuery = ref('');
const onDccQueryInput = useImeSafeInput(dccQuery);
const dccKind = ref<UploadKind | null>(null);
const activeKind = computed(() => (onDcc.value ? dccKind.value : uploads.kind));
// Raw (not reactive()-wrapped) because this component reads the refs in script rather
// than the template — the two views that RENDER the viewer wrap it for unwrapping.
const viewer = useMediaViewer();
const recentRows = computed(() => uploads.recent as UploadRow[]);
const listEl = ref<HTMLDivElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const clipboard = useCopyFeedback();
const deletingId = ref<number | null>(null);
const actionError = ref('');
// The row whose delete just failed, while its error is showing: the error line
// offers remove-from-list for it (#1289). Cleared by the next action.
const failedDelete = ref<UploadRow | null>(null);
// A SET, not a single id, unlike deletingId's single-flight: starring is cheap and
// non-destructive, so stars on different tiles run concurrently — and a lone ref
// would be overwritten by the second tile, re-enabling the first while its request
// is still in flight and letting a third click fire a duplicate toggle off the
// not-yet-updated `u.favorite`. Each tile guards only itself.
const starring = ref(new Set<number>());

// Local, so typing is never gated on a round trip; pushed to the store (and thus the
// server) on a debounce.
const query = ref(uploads.query);
const onQueryInput = useImeSafeInput(query);
let debounce: ReturnType<typeof setTimeout> | null = null;

const isFiltered = computed(() => Boolean(uploads.query || uploads.kind || uploads.favoritesOnly));
const filterDescription = computed(() => {
  const kindLabel = KIND_CHIPS.find((k) => k.value === uploads.kind)?.label.toLowerCase();
  // Built as "<term> in <scope>" where the scope is whichever of starred/kind are on
  // — an empty starred view has to say STARRED, or "nothing matches images" sends
  // the user hunting for a search term they never typed.
  const scope = [uploads.favoritesOnly ? 'starred' : null, uploads.kind ? kindLabel : null]
    .filter(Boolean)
    .join(' ');
  if (uploads.query && scope) return `“${uploads.query}” in ${scope}`;
  if (uploads.query) return `“${uploads.query}”`;
  return scope || 'that filter';
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
  searchEl.value?.focus();
  if (onDcc.value) return;
  // Reset the filters on open. A search left over from a previous session would look
  // like an empty uploads list — the worst possible first impression of the browser.
  void uploads.setFilters({ query: '', kind: null, favoritesOnly: false }).catch(() => {
    /* surfaced via store.listError */
  });
  query.value = '';
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
  const field = onDcc.value ? dccQuery : query;
  if (!field.value) return; // nothing to clear → let AppModal have it
  event.stopPropagation();
  field.value = '';
}

function onKind(kind: UploadKind | null) {
  if (onDcc.value) {
    dccKind.value = kind;
    return;
  }
  if (uploads.kind === kind) return;
  void uploads.setFilters({ kind }).catch(() => {
    /* surfaced via store.listError */
  });
}

function onToggleFavoritesFilter() {
  void uploads.setFilters({ favoritesOnly: !uploads.favoritesOnly }).catch(() => {
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

// EVERY kind the viewer can show, which since #563 is every kind we accept: images,
// video, audio, and text. The gallery used to be images-only because the viewer was an
// <img> and anything else was a step onto a blank screen. Now left/right walks the
// whole result set — so the filters double as a way to scope it, and "Audio" + arrow
// keys is a playlist.
//
// A moderated-away upload stays out: its bytes are gone, so there is nothing to view.
const galleryItems = computed(() =>
  recentRows.value.filter(isViewable).map((u) => ({ url: u.url, filename: u.filename })),
);

function isViewable(u: UploadRow): boolean {
  return !u.removed && mediaKindForUrl(u.url) !== null;
}

function onArtClick(event: MouseEvent, u: UploadRow) {
  // A modified click still means "new tab" — the browser does that better than we do.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  if (!isViewable(u)) return;

  const items = galleryItems.value;
  const start = items.findIndex((i) => i.url === u.url);
  if (start < 0) return;

  event.preventDefault();
  viewer.openGallery(items, start);
}

// Arrowing toward the end of what's loaded pages more in — otherwise the gallery
// silently stops at the last row the user happened to have scrolled to, which from
// inside the viewer looks like the end of their uploads.
watch(
  () => viewer.index.value,
  (i) => {
    if (!viewer.isOpen.value) return;
    if (i < galleryItems.value.length - 2) return;
    if (!uploads.hasMore || uploads.loading) return;
    void uploads.loadMore();
  },
);

// New rows landed (from paging, or a fresh upload) while the viewer is open — extend
// the gallery under it. setItems keeps the viewer on the image it is showing.
watch(galleryItems, (items) => {
  if (viewer.isOpen.value) viewer.setItems(items);
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

// Drop the URL into the draft and get out of the way. The store's insert bus does
// the caret work (and refocuses the textarea), so the modal doesn't need to know
// where the composer is.
function onInsert(u: UploadRow) {
  uploads.requestInsert(u.url);
  emit('close');
}

async function onToggleStar(u: UploadRow) {
  if (starring.value.has(u.id)) return;
  // Reassign rather than mutate: a plain Set is not reactive, so the template's
  // :disabled binding would not see an .add()/.delete() on it.
  starring.value = new Set(starring.value).add(u.id);
  // Reuses actionError: it's the tile grid's one error line, and a failed star and a
  // failed delete are never both pending — the star request is the only thing that
  // could have written it while a delete is in flight, and vice versa.
  actionError.value = '';
  try {
    await uploads.setFavorite(u.id, !u.favorite);
  } catch (e: any) {
    actionError.value = e.message || 'could not update star';
  } finally {
    const next = new Set(starring.value);
    next.delete(u.id);
    starring.value = next;
  }
}

async function onDelete(u: UploadRow) {
  // One delete at a time: a second in-flight delete would fight over the single
  // deletingId ref (spinner/disabled state desync). All delete buttons are
  // disabled while one runs; this guard covers the pre-render window.
  if (deletingId.value !== null) return;
  if (!confirm(`Delete "${u.filename || u.url}"? The file is removed from storage.`)) return;
  deletingId.value = u.id;
  actionError.value = '';
  failedDelete.value = null;
  try {
    await uploads.remove(u.id);
  } catch (e: any) {
    // The bytes weren't destroyed, so the row stays and the reason surfaces —
    // with the record-only exit beside it, since the tile itself only offers
    // the trash that just failed.
    actionError.value = e.message || 'delete failed';
    failedDelete.value = u;
  } finally {
    deletingId.value = null;
  }
}

// Remove-from-list (#1289): the record goes, the file stays wherever it is.
// Shares deletingId with onDelete: both are "this tile is being taken off the
// list", and a tile offers one of the two.
async function onForget(u: UploadRow) {
  if (deletingId.value !== null) return;
  const what = u.filename || u.url;
  const note = u.removed
    ? ''
    : ' The file stays where it is; this only takes it off your uploads list.';
  if (!confirm(`Remove "${what}" from your uploads?${note}`)) return;
  deletingId.value = u.id;
  actionError.value = '';
  failedDelete.value = null;
  try {
    await uploads.forget(u.id);
  } catch (e: any) {
    actionError.value = e.message || 'could not remove';
  } finally {
    deletingId.value = null;
  }
}

// Deliberately does NOT name the uploader. Which backend a file happened to land on is
// the app's business, not the user's: it doesn't help you recognise a picture, and it
// isn't actionable from here. When it matters — the file is gone, or can't be deleted
// — that surfaces as its own state, not as a label on every tile.
function metaParts(u: UploadRow): MetaPart[] {
  return [u.created_at && formatRelative(u.created_at), u.byte_size && formatBytes(u.byte_size)];
}
function metaLine(u: UploadRow): string {
  return joinMeta(metaParts(u));
}
</script>

<style scoped>
/* Matches .search-row in HighlightsModal / SearchModal: a margin, not a rule. Those
   two are the house pattern for "a filter field above a scrolling list", and this
   modal is the same shape — an extra border here just made it look like a different
   app. */
.filters {
  /* One vertical padding for the search field, the starred toggle and the kind
     bar, so the three controls stand the same height. */
  --control-pad: var(--space-3);
  display: flex;
  gap: var(--space-4);
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: var(--space-6);
}
/* Search + starred toggle. This is the flexible item in `.filters`, so it takes
   the leftover width and the kind chips wrap beneath it when the modal is narrow.
   The 200px floor lives here now rather than on `.search`, which has to be free to
   shrink so the toggle beside it always fits. */
.search-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex: 1;
  min-width: 200px;
}
.search {
  position: relative;
  flex: 1;
  min-width: 0;
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
  /* The input's left padding below is derived from --icon-size (the global .lucide
     box), so the two stay in step. */
}
/* The same field as .filter in HighlightsModal / SearchModal — background, border and
   padding all match. Only the LEFT padding differs, because ours has an icon in it. */
.search-input {
  width: 100%;
  /* Left padding is derived, not picked: where the icon starts, plus the icon's own
     width, plus one character of breathing room. */
  padding: var(--control-pad) var(--space-5) var(--control-pad)
    calc(var(--search-icon-inset) + var(--icon-size) + 1ch);
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

/* The kind chips and the starred toggle are .btn-bar choices (main.css), at the
   filter row's control height. */
.kinds > button,
.starred > button {
  padding-block: var(--control-pad);
}
.starred {
  /* Never squeezed by the search field growing, and as tall as the field: on a
     phone the button holds only the icon, whose box is shorter than a text line,
     so left to its content it would stand short of the input beside it. */
  flex: none;
  align-self: stretch;
}
.starred > button {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.starred > button[aria-pressed='true'] .lucide {
  color: var(--warn);
  fill: currentColor;
}
/* At phone width the five kind chips already fill the row, so the word tips this
   one onto a line of its own — a whole row of chrome spent on one control. The
   star alone is unambiguous next to them, and the button keeps its aria-label, so
   dropping the word costs nothing but the pixels. */
@media (max-width: 768px) {
  .starred > button {
    gap: 0;
  }
  .starred .label {
    display: none;
  }
}

.error {
  margin: var(--space-4) 0 0;
  color: var(--bad);
}
/* The record-only exit beside a failed delete's reason. Same text-button shape
   as HighlightsModal's .link; muted so the red reason stays the loud part. */
.error .link {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.error .link:hover {
  color: var(--accent);
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
/* The file-type glyph standing in for a thumbnail — big enough to read as the tile's art. */
.art-icon {
  --icon-size: 2em;
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
/* Opposite corner from .actions so the star never competes with the three
   controls over there, and so a filled one is always in the same place while the
   eye scans the grid. */
.star-slot {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
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
  .actions,
  .star-slot {
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .actions {
    gap: var(--space-1);
  }
  /* focus-within, not just hover: hidden-until-hover is the ONLY way to reach copy and
     delete with a pointer, so they have to be reachable by keyboard too. */
  .tile:hover .actions,
  .tile:focus-within .actions,
  .tile:hover .star-slot,
  .tile:focus-within .star-slot {
    opacity: 1;
  }
  /* ⚠ A STARRED tile keeps its star visible without hover. It is the one control
     here that is also a state readout: hiding it would mean the only way to see
     which of your uploads are starred is to hover each tile in turn, which defeats
     the point of marking them. The empty outline still hides. */
  .star-slot.starred {
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
/* Gold once set, so a starred tile is identifiable by colour alone at grid scale —
   the filled-vs-outline glyph difference is too fine to scan at 180px. */
.star.on {
  color: var(--warn);
}
.star.on:hover {
  color: var(--warn);
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
