<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <template v-for="(seg, i) in segments" :key="i">
    <SpoilerText v-if="seg.spoiler" :seg="seg" />
    <a
      v-else-if="seg.url"
      class="msg-link"
      :href="seg.url"
      target="_blank"
      rel="noreferrer noopener"
      :style="styleFor(seg)"
      >{{ seg.text }}</a
    >
    <span v-else-if="hasStyle(seg)" :style="styleFor(seg)">{{ seg.text }}</span>
    <template v-else>{{ seg.text }}</template>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CSSProperties } from 'vue';
import type { RenderSegment } from '../utils/nickColor.js';
import { splitTextByTokens, segmentInlineStyle, segmentHasStyle } from '../utils/nickColor.js';
import SpoilerText from './SpoilerText.vue';

// Renders a plain-text string with URLs auto-linked and IRC formatting
// (bold/italic/underline/strike + mIRC fg colours) applied. Used by every
// line type in MessageList that doesn't go through nick coloring (motd,
// errors, part reasons, etc.) and by the topic bar in Chat.vue. Lines that
// DO get nick coloring (message/notice/action) call splitTextByTokens
// directly with a real nickSet.
const props = withDefaults(
  defineProps<{
    text?: string;
  }>(),
  { text: '' },
);

const segments = computed(() => splitTextByTokens(props.text, null, null, null));
function styleFor(seg: RenderSegment): CSSProperties {
  return segmentInlineStyle(seg, null) as CSSProperties;
}
function hasStyle(seg: RenderSegment) {
  return segmentHasStyle(seg);
}
</script>
