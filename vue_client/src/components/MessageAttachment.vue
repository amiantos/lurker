<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <!-- Nothing renders until the server has answered. A preview appearing is
       always an ADDITION to the layout — no skeleton that later collapses,
       which in a scrolling message list would shove everything around twice. -->
  <template v-if="preview && preview.status === 'ok' && allowed">
    <!-- Direct media: no card, no chrome. A frame around an image is furniture
         around content. Click opens the media viewer that already exists. -->
    <img
      v-if="preview.kind === 'image' && preview.src"
      class="inline-image"
      :src="preview.src"
      :alt="''"
      loading="lazy"
      decoding="async"
      @click.stop="openViewer"
    />
    <video
      v-else-if="preview.kind === 'video' && preview.src"
      class="inline-video"
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

    <!-- A page, or a video page. Slack's treatment rather than Discord's: a thin
         accent rule and restrained text, not a large colourful engagement card.
         Lurker's timeline is dense and quiet and a preview should stay a guest
         in it. -->
    <div v-else class="card" :class="{ 'card-video': isVideo }">
      <div class="card-text">
        <div v-if="preview.siteName" class="card-site">
          {{ preview.siteName }}<template v-if="preview.author"> · {{ preview.author }}</template>
        </div>
        <a
          v-if="preview.title"
          class="card-title"
          :href="url"
          target="_blank"
          rel="noreferrer noopener"
          @click.stop
          >{{ preview.title }}</a
        >
        <div v-if="preview.description" class="card-desc">{{ preview.description }}</div>
      </div>

      <!-- Video: the thumbnail goes full-width with a play badge, because a
           video reduced to a 72px square is pointless. Everything else keeps the
           small right-aligned thumbnail. -->
      <div v-if="isVideo && preview.thumb" class="card-media">
        <!-- THE FACADE. The iframe does not exist until this is clicked, so
             nothing is requested from the video host on render — not even the
             thumbnail, which is proxied through us like every other preview
             image. The first request the viewer makes to YouTube is the one
             they asked for by pressing play. -->
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
          <img class="card-thumb-wide" :src="preview.thumb" alt="" loading="lazy" />
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
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useLinkPreview } from '../composables/useLinkPreview.js';
import { useSettingsStore } from '../stores/settings.js';
import { useMediaViewer } from '../composables/useMediaViewer.js';

const props = defineProps<{ url: string }>();

const settings = useSettingsStore();
const viewer = useMediaViewer();
const preview = useLinkPreview(props.url);
const playing = ref(false);

/**
 * Re-check the answer against the settings.
 *
 * The parent asked based on the URL's extension; the server replies with what
 * the thing ACTUALLY is. Those can disagree — an extensionless URL that turns
 * out to be a PNG, a `.jpg` that 302s to an HTML login page — and when they do,
 * the setting that governs is the one covering the server's answer, not the one
 * that covered our guess. Otherwise "link previews off" could still be talked
 * into rendering a card.
 */
const allowed = computed(() => {
  const kind = preview.value?.kind;
  if (!kind) return false;
  if (kind === 'image' || kind === 'video' || kind === 'audio') {
    return settings.effective('chat.inline_media.enabled') === true;
  }
  return settings.effective('chat.link_previews.enabled') === true;
});

const isVideo = computed(() => preview.value?.kind === 'video-embed' && !!preview.value.embedUrl);

function play(): void {
  playing.value = true;
}

function openViewer(): void {
  // The viewer is opt-out (chat.image_modal.enabled); when it's off, an inline
  // image is just an image and a click does nothing special.
  if (settings.effective('chat.image_modal.enabled') !== true) return;
  viewer.open(props.url);
}
</script>

<style scoped>
.inline-image {
  max-width: 100%;
  /* Capped so one tall screenshot can't push the rest of the conversation off
     screen. The viewer is one click away for the full thing. */
  max-height: 240px;
  border-radius: var(--radius-md);
  cursor: pointer;
  display: block;
}
.inline-video,
.inline-audio {
  max-width: 100%;
  border-radius: var(--radius-md);
  display: block;
}
.inline-video {
  max-height: 280px;
}
.inline-audio {
  width: 100%;
}

.card {
  display: flex;
  gap: var(--space-4);
  align-items: flex-start;
  /* The left rule is the Slack signature. Deliberately a muted border colour
     rather than a per-site accent: extracting a dominant colour per domain is a
     lot of machinery whose only effect is to make the timeline louder. */
  border-left: 3px solid var(--border);
  padding: var(--space-2) 0 var(--space-2) var(--space-6);
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
  background: var(--bg-soft);
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
