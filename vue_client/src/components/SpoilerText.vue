<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <span
    class="spoiler"
    :class="{ revealed }"
    :role="revealed ? undefined : 'button'"
    :tabindex="revealed ? undefined : 0"
    :aria-expanded="revealed ? undefined : 'false'"
    :aria-label="revealed ? undefined : 'Hidden spoiler, activate to reveal'"
    :title="revealed ? undefined : 'Hidden spoiler — click to reveal'"
    @click="reveal"
    @keydown.enter.prevent="reveal"
    @keydown.space.prevent="reveal"
    ><span class="spoiler-body" :style="bodyStyle" :aria-hidden="revealed ? undefined : 'true'">{{
      seg.text
    }}</span></span
  >
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { CSSProperties } from 'vue';
import type { RenderSegment } from '../utils/nickColor.js';

// Renders an IRC spoiler run (fg===bg, i.e. text deliberately coloured to be
// invisible) as a Discord-style blacked-out box. The content is kept out of
// the accessible name (aria-hidden) until revealed so a screen reader doesn't
// read the secret aloud. Reveal is one-way: once a user deliberately opens a
// spoiler, re-hiding it isn't a behaviour anyone expects.
const props = defineProps<{ seg: RenderSegment }>();

const revealed = ref(false);
function reveal(): void {
  revealed.value = true;
}

// The spoiler run still carries any bold/italic/underline/strike toggles that
// were active — apply them so the revealed text matches how it was sent.
const bodyStyle = computed<CSSProperties>(() => {
  const s: CSSProperties = {};
  if (props.seg.bold) s.fontWeight = 'bold';
  if (props.seg.italic) s.fontStyle = 'italic';
  const decos: string[] = [];
  if (props.seg.underline) decos.push('underline');
  if (props.seg.strike) decos.push('line-through');
  if (decos.length) s.textDecoration = decos.join(' ');
  return s;
});
</script>

<style scoped>
.spoiler {
  border-radius: 3px;
  padding: 0 3px;
  background: var(--fg-muted);
  transition: background-color 0.1s ease;
}
.spoiler:not(.revealed) {
  cursor: pointer;
}
.spoiler:not(.revealed) .spoiler-body {
  color: transparent;
  /* Stop a drag-select from revealing the text — click is the only reveal. */
  user-select: none;
}
.spoiler:not(.revealed):hover {
  background: var(--fg);
}
.spoiler.revealed {
  /* A faint tint so it still reads as "this was a spoiler" once opened. */
  background: color-mix(in srgb, var(--fg-muted) 22%, transparent);
}
.spoiler:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}
</style>
