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
import type { CSSProperties } from 'vue';
import type { RenderSegment } from '../utils/nickColor.js';
import { segmentInlineStyle, segmentHasStyle } from '../utils/nickColor.js';
import SpoilerText from './SpoilerText.vue';

// The single renderer for an array of RenderSegments (the output of
// splitTextByTokens): URLs, mIRC fg/bg colour, bold/italic/underline/strike,
// nick coloring, and spoilers. Every message-list layout and LinkedText
// funnel their segments through here, so a new segment kind only has to be
// handled in one place — no render path can silently miss it.
//
// Branch order matters: spoiler is matched first because a spoiler segment
// must never fall through to the plain <span>/text branches, which would
// reveal the hidden content. `selfColor` tints segments belonging to the
// current user; pass null where there's no message context (topic bar,
// motd, part reasons, etc.).
const props = withDefaults(
  defineProps<{
    segments: RenderSegment[];
    selfColor?: string | null;
  }>(),
  { selfColor: null },
);

function styleFor(seg: RenderSegment): CSSProperties {
  return segmentInlineStyle(seg, props.selfColor ?? null) as CSSProperties;
}
function hasStyle(seg: RenderSegment): boolean {
  return segmentHasStyle(seg);
}
</script>
