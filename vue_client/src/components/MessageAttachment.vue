<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <!-- Direct media: no card, no chrome. A frame around an image is furniture around content.
       `width`/`height` are the server's real pixel dimensions, and they're load-bearing rather
       than decorative — the browser derives the intrinsic aspect ratio from them and reserves
       the right box BEFORE any bytes arrive. -->
  <img
    v-if="preview.kind === 'image' && preview.src"
    class="inline-image"
    :class="{ 'strip-item': inStrip }"
    :src="preview.src"
    :width="preview.thumbWidth || undefined"
    :height="preview.thumbHeight || undefined"
    alt=""
    loading="lazy"
    decoding="async"
    @click.stop="openViewer"
    @load="$emit('measured')"
  />
  <video
    v-else-if="preview.kind === 'video' && preview.src"
    class="inline-video"
    :class="{ 'strip-item': inStrip }"
    :src="preview.src"
    controls
    preload="metadata"
    @click.stop
  />
  <audio
    v-else-if="preview.kind === 'audio' && preview.src"
    class="inline-audio"
    :src="preview.src"
    controls
    preload="metadata"
    @click.stop
  />

  <!-- A page, or a video page. Discord's panel treatment: the card sits on its own slightly
       raised background so it reads as a distinct object rather than as more chat text. -->
  <div v-else class="card" :class="{ 'card-video': isVideo }">
    <div class="card-text">
      <div v-if="preview.siteName" class="card-site">
        {{ preview.siteName }}<template v-if="preview.author"> · {{ preview.author }}</template>
      </div>
      <a
        v-if="preview.title"
        class="card-title"
        :href="preview.url"
        target="_blank"
        rel="noreferrer noopener"
        @click.stop
        >{{ preview.title }}</a
      >
      <div v-if="preview.description" class="card-desc">{{ preview.description }}</div>
    </div>

    <!-- Video: the thumbnail goes full-width with a play badge, because a video reduced to a
         72px square is pointless. Everything else keeps the small right-aligned thumbnail. -->
    <!-- ⚠ Gated on isVideo alone, NOT on having a thumbnail. `pageRecord` returns ok as soon as
         there is a title OR an image, so an oEmbed reply with a title but no thumbnail_url (or
         an og:image that normalizeUrl rejected) yielded embedUrl set and thumb undefined — both
         this branch and the `v-else-if="preview.thumb"` one were false, so the card showed a
         title with the ▶, and the whole video, unreachable. -->
    <div v-if="isVideo" class="card-media">
      <!-- THE FACADE. The iframe does not exist until this is clicked, so nothing is requested
           from the video host on render — not even the thumbnail, which is proxied through us
           like every other preview image. The first request the viewer makes to YouTube is the
           one they asked for by pressing play. -->
      <iframe
        v-if="playing"
        class="card-embed"
        :src="preview.embedUrl"
        title="Video player"
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        referrerpolicy="no-referrer"
        allowfullscreen
      ></iframe>
      <button
        v-else
        type="button"
        class="card-play"
        :aria-label="`Play ${preview.title ?? 'video'}`"
        @click.stop="play"
      >
        <img
          v-if="preview.thumb"
          class="card-thumb-wide"
          :src="preview.thumb"
          alt=""
          loading="lazy"
        />
        <span class="play-badge" aria-hidden="true">▶</span>
      </button>
    </div>
    <img
      v-else-if="preview.thumb"
      class="card-thumb"
      :src="preview.thumb"
      alt=""
      loading="lazy"
      decoding="async"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { LinkPreview } from '../composables/useLinkPreview.js';
import { useSettingsStore } from '../stores/settings.js';

// Purely presentational: it renders ONE already-resolved, already-permitted preview.
// Resolution happens at message ingest and the settings check happens in
// MessageAttachments, which needs the resolved set anyway to decide the arrangement.
const props = defineProps<{
  preview: LinkPreview;
  /** Sized by the strip's row height rather than by its own dimensions. */
  inStrip?: boolean;
}>();

// Emitted when an image finishes decoding. Only matters when the server couldn't give us
// dimensions (an exotic format, a truncated header) — there the box wasn't reserved, so the
// row does grow on load and the list needs a chance to re-pin.
// `activate` rather than opening the viewer here: what a click MEANS depends on the
// arrangement, and the arrangement is the parent's business. A tap on one image of a strip
// should open the whole strip as a gallery, and only the parent knows what the strip holds.
const emit = defineEmits<{ measured: []; activate: [] }>();

const settings = useSettingsStore();
const playing = ref(false);

const isVideo = computed(() => props.preview.kind === 'video-embed' && !!props.preview.embedUrl);

function play(): void {
  playing.value = true;
}

function openViewer(): void {
  // The viewer is opt-out (chat.image_modal.enabled); when it's off, an inline image is just
  // an image and a click does nothing special.
  if (settings.effective('chat.image_modal.enabled') !== true) return;
  emit('activate');
}
</script>

<style scoped>
.inline-image {
  max-width: 100%;
  /* Capped so one tall screenshot can't push the rest of the conversation off screen. The
     viewer is one click away for the full thing. */
  max-height: 240px;
  /* ⚠ Both `auto`, and both needed. The `width`/`height` attributes give the browser the
     intrinsic ratio to reserve space with; these let it SCALE that box down proportionally to
     fit inside max-width/max-height. Without `width: auto` a portrait image hits the height
     cap and keeps its attribute width, which is squashing rather than scaling. */
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: var(--radius-md);
  cursor: pointer;
  display: block;
}
.inline-video,
.inline-audio {
  max-width: 100%;
  width: auto;
  border-radius: var(--radius-md);
  display: block;
}
.inline-video {
  max-height: 280px;
}
.inline-audio {
  width: 100%;
}

/* Inside a strip the ROW decides the height and every item fills it, so the group reads as
   one band. Widths then vary with each image's aspect ratio, which is what makes a strip look
   like a strip rather than a grid of letterboxed cells. `cover` because a uniform height is
   the point — a panorama is cropped rather than allowed to be 2000px wide. */
.strip-item {
  height: 100%;
  width: auto;
  max-width: 360px;
  max-height: none;
  object-fit: cover;
  flex: none;
}

.card {
  display: flex;
  gap: var(--space-4);
  align-items: flex-start;
  /* A raised panel, Discord-style, so the card reads as a distinct object rather than as more
     chat text. Doing the distinction with a background instead of a left rule is what lets the
     rule go away on desktop (below) without the card losing its edges.
     ⚠ --embed-bg, NOT --bg-soft: that's the message row's hover fill, and a card painted with
     it disappears the moment the pointer crosses its row. */
  background: var(--embed-bg);
  border-radius: var(--radius-md);
  padding: var(--space-4);
}
/* The Slack-style left rule is a MOBILE-only cue. On desktop the app already has a vertical
   border running down the side of the message column right next to this, and a second rule a
   few pixels away just reads as noise. On a narrow viewport that border isn't there, so the
   rule is doing real work. */
@media (max-width: 768px) {
  .card {
    border-left: 3px solid var(--border);
    /* The rule replaces the panel's own left padding rather than adding to it. */
    padding-left: var(--space-5);
  }
}
.card-video {
  flex-direction: column;
  gap: var(--space-3);
}
.card-text {
  min-width: 0;
  flex: 1;
}
.card-site {
  color: var(--fg-muted);
  font-size: 0.85em;
}
.card-title {
  display: block;
  color: var(--accent);
  font-weight: 600;
  text-decoration: none;
  overflow-wrap: anywhere;
}
.card-title:hover {
  text-decoration: underline;
}
.card-desc {
  color: var(--fg-muted);
  /* Two lines: enough to tell what a page is, not enough to become the message. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-thumb {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  flex: none;
}

.card-media {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-md);
  overflow: hidden;
  /* Reads against the card's own panel, not against the chat background. */
  background: var(--bg);
}
.card-play {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  position: relative;
}
.card-thumb-wide {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.play-badge {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--bg) 70%, transparent);
  color: var(--fg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  /* Optically centred: a triangle glyph's visual mass sits left of its box. */
  padding-left: 3px;
}
.card-embed {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
</style>
