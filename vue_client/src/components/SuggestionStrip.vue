<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Generic horizontal suggestion strip rendered as a StatusBar overlay — the
  IRCCloud-style autocomplete bar. Same chrome as the bar it covers (so the
  bar visually disappears while the strip is up); keyboard-navigable via an
  externally-owned activeIndex so the host's keydown handler can drive it
  without an imperative ref.

  The strip is content-agnostic: callers pass an `items` array, a `keyFor`
  function, and the current `activeIndex`, and render each chip's body
  through the `chip` slot. Used by both the nick and emoji suggesters.
-->

<template>
  <div
    ref="rootEl"
    class="suggestion-strip"
    :class="{ visible: items.length > 0 }"
    @pointerdown.stop
    @mousedown.prevent.stop
  >
    <!-- iOS keyboard preservation:
         - Fire the action on `click` (end of the touch sequence). Emitting on
           pointerdown closes the strip *mid-touch*, so the subsequent mousedown
           lands on whatever's underneath (StatusBar) instead of this chip —
           defeating @mousedown.prevent and dismissing the soft keyboard.
         - @mousedown.prevent is the canonical iOS hook that prevents the
           browser from shifting focus away from the textarea on tap. It must
           fire on the chip itself, which is why the action moved to click.
         - Plain <div>, not <button>: a <button> is focusable, so iOS would
           still steal focus during the touch before mousedown.prevent runs. -->
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

// `v-show` (not `v-if`) preserves the strip's scrollLeft across hides, so
// reopening with a new candidate set could land the new chip 0 off-screen
// to the left of the previous session's scroll position — and the
// activeIndex watcher below wouldn't fire because activeIndex stayed at 0.
// Reset scrollLeft on the closed→open transition (items.length 0 → >0) so
// every fresh open starts at chip 0.
watch(
  () => props.items.length > 0,
  (visible, wasVisible) => {
    if (visible && !wasVisible && rootEl.value) rootEl.value.scrollLeft = 0;
  },
);

// When the host shifts activeIndex via keyboard nav, pull the chip into
// view if the row has overflowed horizontally. Watching the prop keeps the
// strip declarative — no imperative ref method needed.
//
// We compute the horizontal shift ourselves rather than calling
// scrollIntoView({ block: 'nearest', inline: 'nearest' }). scrollIntoView
// walks up the ancestor chain trying to satisfy both axes; even though the
// strip is `overflow-y: hidden`, the vertical axis still resolves against
// the next scrollable ancestor (the message area / document), which yanks
// the page up by ~1px when the chip's box doesn't line up perfectly with
// the viewport. Restricting the operation to the strip's own scrollLeft
// keeps the motion purely horizontal.
watch(
  () => props.activeIndex,
  () => {
    nextTick(() => {
      const strip = rootEl.value;
      const active = strip?.querySelector<HTMLElement>('.chip.active');
      if (!strip || !active) return;
      const stripRect = strip.getBoundingClientRect();
      const chipRect = active.getBoundingClientRect();
      if (chipRect.left < stripRect.left) {
        strip.scrollLeft -= stripRect.left - chipRect.left;
      } else if (chipRect.right > stripRect.right) {
        strip.scrollLeft += chipRect.right - stripRect.right;
      }
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
