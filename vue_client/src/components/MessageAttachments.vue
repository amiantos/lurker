<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div v-if="visible.length" class="attachments">
    <!-- Two or more images/videos become one horizontally-scrolling row rather than a
         vertical stack, following Slack. Three portrait screenshots stacked is most of a
         screen of somebody else's message; as a strip it's one glance.

         The row's height is ALSO the sizing win: it comes from the server's dimensions, so
         it's known before a single byte of image data arrives, and it's ONE height for the
         whole group instead of N unknown ones. -->
    <div v-if="strip.length > 1" class="filmstrip" :style="{ height: `${stripHeight}px` }">
      <MessageAttachment
        v-for="item in strip"
        :key="item.url"
        :preview="item"
        in-strip
        @measured="$emit('measured')"
        @activate="openStripAt(item)"
      />
    </div>
    <MessageAttachment
      v-for="item in stacked"
      :key="item.url"
      :preview="item"
      @measured="$emit('measured')"
      @activate="viewer.open(item.url)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsStore } from '../stores/settings.js';
import { previewableUrls } from '../utils/previewUrls.js';
import { useLinkPreview, type LinkPreview } from '../composables/useLinkPreview.js';
import { useMediaViewer } from '../composables/useMediaViewer.js';
import MessageAttachment from './MessageAttachment.vue';

// Owns the ARRANGEMENT of a message's attachments; MessageAttachment owns how any one of
// them looks. That split is what makes grouping possible at all — while each child resolved
// its own preview, nothing was in a position to know that a message had three images and
// could lay them out as a row.
//
// Reads are pure (see composables/useLinkPreview): resolution happens at message ingest, so
// nothing here triggers a fetch no matter how often it re-renders.
const props = defineProps<{ text: string | null | undefined }>();

defineEmits<{ measured: [] }>();

const settings = useSettingsStore();
const viewer = useMediaViewer();

/** Row heights for a strip, picked by the group's dominant orientation.
 *
 *  Slack effectively has two, and it's the right simplification: it means a message list has
 *  a small, known set of possible attachment heights instead of one per image. Portrait gets
 *  more room because a tall photo squeezed into a landscape row is unreadable — but only a
 *  little more, or one message wins the screen. */
const STRIP_LANDSCAPE = 200;
const STRIP_PORTRAIT = 300;

const toggles = computed(() => ({
  inlineMedia: settings.effective('chat.inline_media.enabled') === true,
  linkPreviews: settings.effective('chat.link_previews.enabled') === true,
}));

const urls = computed(() => previewableUrls(props.text, toggles.value));

// One ref per URL, read-only. `useLinkPreview` on a URL nobody primed returns a permanently
// null ref, which is exactly the "render nothing" case.
const entries = computed(() => urls.value.map((url) => useLinkPreview(url)));

/**
 * Previews that are resolved AND allowed by the settings.
 *
 * Re-checked against the server's answer rather than the extension guess that prompted the
 * request: an extensionless URL that turns out to be a PNG is inline media, and a `.jpg` that
 * redirects to an HTML login page is not. Otherwise "link previews off" could still be talked
 * into rendering a card.
 */
const visible = computed<LinkPreview[]>(() =>
  entries.value
    .map((entry) => entry.value)
    .filter((p): p is LinkPreview => {
      if (!p || p.status !== 'ok') return false;
      const isMedia = p.kind === 'image' || p.kind === 'video' || p.kind === 'audio';
      return isMedia ? toggles.value.inlineMedia : toggles.value.linkPreviews;
    }),
);

/** Strip candidates: pictures and video, which read as a row. Audio doesn't — a row of
 *  transport controls is not a gallery — so it stays stacked and full-width. */
const strip = computed(() => visible.value.filter((p) => p.kind === 'image' || p.kind === 'video'));

/** Everything the strip didn't take. A lone image renders on its own, at its own size: it's
 *  the common case and a one-item strip would only make it smaller for no reason. */
const stacked = computed(() =>
  strip.value.length > 1 ? visible.value.filter((p) => !strip.value.includes(p)) : visible.value,
);

/**
 * Open the lightbox over the WHOLE strip, positioned on the image that was clicked.
 *
 * This is what makes a generous media cap safe: however many images a message carries, every
 * one of them is reachable by arrowing through the viewer rather than only by scrolling the
 * strip. The viewer has always been a gallery — a single file is a gallery of one — so this
 * needed no work there.
 */
function openStripAt(item: LinkPreview): void {
  const items = strip.value.map((p) => ({ url: p.url }));
  viewer.openGallery(items, strip.value.indexOf(item));
}

const stripHeight = computed(() => {
  const portrait = strip.value.filter((p) => (p.thumbHeight ?? 0) > (p.thumbWidth ?? 0)).length;
  // "Primarily portrait" rather than "any portrait": one tall image among four wide ones
  // shouldn't make the whole row tall.
  return portrait * 2 > strip.value.length ? STRIP_PORTRAIT : STRIP_LANDSCAPE;
});
</script>

<style scoped>
.attachments {
  display: flex;
  flex-direction: column;
  /* NOT the default `stretch`. A flex column stretches its children across the cross axis,
     which forced every inline image to the container's full width while `max-height` capped
     its height — squashing it instead of scaling it. */
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-2);
  /* No width cap HERE. The cap belongs to the card (below), not to the container: a strip
     scrolls, so capping it at card width would mean two images visible out of five for no
     reason other than that cards need a limit. */
  max-width: 100%;
  min-width: 0;
}
/* A card wants the width it's given — its text has to wrap against something — but not the
   full width of a wide window, where it stops reading as part of the message and starts
   reading as a page element. */
.attachments > :deep(.card) {
  align-self: stretch;
  max-width: 480px;
}

.filmstrip {
  display: flex;
  gap: var(--space-2);
  /* The strip scrolls itself; the message list must never scroll sideways. */
  overflow-x: auto;
  overflow-y: hidden;
  max-width: 100%;
  /* Height comes from the inline style — one known value for the whole group. */
  align-items: stretch;
  scrollbar-width: thin;
}
</style>
