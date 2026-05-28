<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Generic horizontal suggestion strip rendered as a StatusBar overlay — the
  IRCCloud-style autocomplete bar. Visually it mirrors NickSuggestionStrip
  (same chrome as the bar it covers); behaviourally it's keyboard-navigable
  via an externally-owned activeIndex so the host's keydown handler can
  drive it without an imperative ref.

  The strip is content-agnostic: callers pass an `items` array, a `keyFor`
  function, and the current `activeIndex`, and render each chip's body
  through the `chip` slot. The emoji suggester is the first consumer;
  NickSuggestionStrip could later adopt it.
-->

<template>
  <div
    ref="rootEl"
    class="suggestion-strip"
    :class="{ visible: items.length > 0 }"
    @pointerdown.stop
    @mousedown.prevent.stop
  >
    <!-- iOS keyboard preservation, same rationale as NickSuggestionStrip:
         fire on `click` (end of touch), keep `@mousedown.prevent` on the chip
         so focus never leaves the textarea, and use a plain <div role=button>
         rather than a focusable <button>. -->
    <div
      v-for="(item, i) in items"
      :key="keyFor(item)"
      role="button"
      class="chip"
      :class="{ active: i === activeIndex }"
      @mousedown.prevent
      @click="emit('select', item)"
      @mouseenter="emit('hover', i)"
    >
      <slot name="chip" :item="item" />
    </div>
  </div>
</template>

<script setup lang="ts" generic="T">
import { ref, watch, nextTick } from 'vue';

const props = defineProps<{
  /** Readonly so a reactive readonly source (e.g. useComposerOverlay) can
      be passed through without a cast — the strip never mutates it. */
  items: readonly T[];
  /** Stable :key for each item — the strip is content-agnostic. */
  keyFor: (item: T) => string;
  /** Highlighted chip; the host owns the index so keyboard nav lives
      outside this component. */
  activeIndex: number;
}>();

const emit = defineEmits<{
  select: [item: T];
  /** Mouse hover claimed a chip — host updates activeIndex so mouse and
      keyboard share the same highlight. */
  hover: [index: number];
}>();

const rootEl = ref<HTMLElement | null>(null);

// When the host shifts activeIndex via keyboard nav, pull the chip into
// view if the row has overflowed horizontally. Watching the prop keeps the
// strip declarative — no imperative ref method needed.
watch(
  () => props.activeIndex,
  () => {
    nextTick(() => {
      rootEl.value
        ?.querySelector('.chip.active')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  },
);
</script>

<style scoped>
/* Overlays StatusBar's row with the same chrome — same padding, same
   border-top, same background — so the bar visually disappears under the
   strip while it's active. Positioned absolute to fill the parent
   .status-bar (StatusBar's component root). */
.suggestion-strip {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 1ch 12px 0;
  background: var(--bg);
  border-top: 1px solid var(--border);
  white-space: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  z-index: 5;
  opacity: 0;
  pointer-events: none;
  transition: opacity 80ms linear;
}
.suggestion-strip::-webkit-scrollbar {
  display: none;
}
.suggestion-strip.visible {
  opacity: 1;
  pointer-events: auto;
}
.chip {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5ch;
  background: none;
  border: none;
  /* Horizontal padding only — vertical padding would make the chip taller
     than the nick strip's chips, and `align-items: center` on the strip
     would then push the emoji glyph above the StatusBar's text baseline. */
  padding: 0 6px;
  /* Emoji glyphs sit higher in their line box than letter forms — even
     with the chip's box centered, the glyph reads above the bar's text
     baseline. Nudge the whole chip down to compensate. */
  transform: translateY(1px);
  font: inherit;
  color: var(--fg);
  cursor: pointer;
  user-select: none;
  /* Disables the iOS double-tap-zoom heuristic and its ~300ms click delay. */
  touch-action: manipulation;
}
/* Highlight matches a selected buffer row in the buffer list — a flat
   --bg-soft fill with square edges — so the suggester reads as the same kind
   of selection affordance used elsewhere. Single rule shared by mouse and
   keyboard: hovering emits `hover` (see @mouseenter) which the host maps to
   activeIndex, so `.active` alone covers both with no separate :hover rule
   that could double-highlight during keyboard nav. */
.chip.active {
  background: var(--bg-soft);
}
</style>
