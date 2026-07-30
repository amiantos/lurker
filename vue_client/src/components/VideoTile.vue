<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  One video tile in the call panel. It owns the attach/detach of its LiveKit
  track to the <video> element — REQUIRED for adaptiveStream to deliver remote
  video (an unattached/hidden track never starts). Self camera tiles are mirrored
  and muted; screen-share tiles are letterboxed (contain) and always muted here
  (you don't play your own screen audio back).
-->

<template>
  <div class="video-tile" :class="{ screen: source === 'screen_share' }">
    <video
      ref="el"
      autoplay
      playsinline
      :muted="self"
      :class="{ mirror: self && source !== 'screen_share' }"
    ></video>
    <span class="tile-label">
      <i v-if="source === 'screen_share'" class="fa-solid fa-desktop"></i>
      {{ self ? 'You' : identity }}<span v-if="source === 'screen_share'"> · screen</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useVoiceStore } from '../stores/voice.js';

const props = defineProps<{ identity: string; source: string; self: boolean }>();
const voice = useVoiceStore();
const el = ref<HTMLVideoElement | null>(null);

onMounted(() => {
  if (el.value) voice.attachVideo(props.identity, props.source, el.value, props.self);
});
onBeforeUnmount(() => {
  if (el.value) voice.detachVideo(props.identity, props.source, el.value, props.self);
});
</script>

<style scoped>
.video-tile {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 0.35rem;
  overflow: hidden;
  border: 1px solid var(--border, #2c2f38);
}
.video-tile video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.video-tile.screen video {
  object-fit: contain;
  background: #000;
}
.video-tile video.mirror {
  transform: scaleX(-1);
}
.tile-label {
  position: absolute;
  left: 0.25rem;
  bottom: 0.25rem;
  max-width: calc(100% - 0.5rem);
  padding: 0.05rem 0.3rem;
  border-radius: 0.25rem;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 0.7rem;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
