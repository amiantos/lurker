<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The shared composer popover behind NickPicker (`@`), ChannelPicker (`#`) and
  HistoryPicker (`>`). It owns every mechanic those three used to reimplement
  (issue #212):

    - a position:fixed panel anchored just above the input bar, riding above the
      iOS soft keyboard via visualViewport (resize/scroll re-anchoring)
    - outside-tap dismissal (a document pointerdown, excluding the panel and any
      `ignore` elements — an anchor or a toggle button) plus Escape-to-close
    - the iOS focus-preservation contract: `@mousedown.prevent` on the panel and
      every row so focus never leaves the textarea, acting on `click` (end of
      touch) with a plain <div role=button> rather than a focusable <button>.
      Emitting on pointerdown would close the panel (v-if) mid-touch and send the
      synthesized mousedown to whatever lands underneath — what stole iOS focus
      before.
    - keyboard navigation (activeIndex + moveActive/confirmActive, exposed so
      MessageInput's textarea keydown handler can drive it while the textarea
      keeps focus), the active row kept scrolled into view, and one .active
      highlight shared by mouse hover and the keyboard.

  Callers supply only their data: the `rows` array, a `#row` template for a
  row's contents, and a `select` handler. `reverse` opens the list bottom-up so
  the primary candidate (best match / newest line) sits at the bottom nearest
  the input; the active row defaults there too.
-->

<template>
  <div
    v-if="visible"
    ref="panelEl"
    class="vertical-popover"
    :style="panelStyle"
    @pointerdown.stop
    @mousedown.prevent.stop
  >
    <div
      v-for="(row, i) in displayRows"
      :key="keyFor(row, i)"
      role="button"
      class="row"
      :class="{ active: i === activeIndex }"
      @mousedown.prevent
      @click="pick(i)"
      @mouseenter="activeIndex = i"
    >
      <slot name="row" :row="row" :index="i" :active="i === activeIndex" />
    </div>
  </div>
</template>

<script setup lang="ts" generic="Row">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import type { PopoverNav } from './popoverNav.js';

const props = withDefaults(
  defineProps<{
    open?: boolean;
    rows?: readonly Row[];
    // Element to anchor the panel above (the input form). Positioning only —
    // not auto-excluded from dismissal; pass it in `ignore` if a tap on it
    // should keep the panel open.
    anchor?: HTMLElement | null;
    // Elements whose taps must NOT dismiss the panel, besides the panel itself:
    // the anchor (nick/channel keep open while typing) or the toggle button
    // (history — its own click handler owns open/close).
    ignore?: readonly (HTMLElement | null)[];
    // Render bottom-up so the primary candidate sits at the bottom, nearest the
    // input bar and under the user's eye.
    reverse?: boolean;
    // Stable :key for a row; defaults to its display position.
    rowKey?: (row: Row, index: number) => string | number;
  }>(),
  {
    open: false,
    rows: () => [],
    anchor: null,
    ignore: () => [],
    reverse: false,
    rowKey: undefined,
  },
);

const emit = defineEmits<{
  select: [row: Row];
  close: [];
}>();

const panelEl = ref<HTMLElement | null>(null);
const panelBottom = ref(8);

const displayRows = computed<readonly Row[]>(() =>
  props.reverse ? props.rows.toReversed() : props.rows,
);
// Hidden when closed or empty, so a no-match token never shows an empty box.
const visible = computed(() => props.open && displayRows.value.length > 0);

function keyFor(row: Row, index: number): string | number {
  return props.rowKey ? props.rowKey(row, index) : index;
}

// Index into displayRows (0 = top) of the highlighted row. Defaults to the
// bottom row — the primary candidate, nearest the input — and clamps rather
// than wraps.
const activeIndex = ref(0);
function defaultActive(): number {
  return Math.max(displayRows.value.length - 1, 0);
}

function pick(index: number): void {
  const row = displayRows.value[index];
  if (row !== undefined) emit('select', row);
}

// Driven from MessageInput's textarea keydown handler — the textarea keeps
// focus while the panel is open, so the panel never receives keys itself.
// `delta` is in visual rows: -1 moves up, +1 down. Clamps at both ends.
function moveActive(delta: number): void {
  const n = displayRows.value.length;
  if (n === 0) return;
  activeIndex.value = Math.min(Math.max(activeIndex.value + delta, 0), n - 1);
  // A keyboard move can land on a row scrolled out of the panel — pull it back
  // in. Hover also sets activeIndex (see @mouseenter) but a hovered row is
  // necessarily already visible, so the scroll lives here, not in a blanket
  // watch(activeIndex) that would also fire as a no-op on every cursor move.
  nextTick(scrollActiveIntoView);
}

function confirmActive(): void {
  pick(activeIndex.value);
}

function hasCandidates(): boolean {
  return displayRows.value.length > 0;
}

defineExpose<PopoverNav>({ moveActive, confirmActive, hasCandidates });

function scrollActiveIntoView(): void {
  const el = panelEl.value?.querySelector('.row.active');
  if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
}

function recomputePosition(): void {
  // Anchor just above the input bar, riding above the iOS soft keyboard via
  // visualViewport.height — without this the panel is occluded as the keyboard
  // slides up.
  const anchor = props.anchor;
  if (!anchor) {
    panelBottom.value = 8;
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const vv = window.visualViewport;
  const viewportHeight = vv ? vv.height : window.innerHeight;
  // Distance from the bottom of the viewport to the top of the anchor.
  const distance = viewportHeight - rect.top;
  panelBottom.value = Math.max(distance + 4, 8);
}

const panelStyle = computed(() => ({ bottom: `${panelBottom.value}px` }));

function onDocPointerDown(e: PointerEvent): void {
  if (!visible.value) return;
  const target = e.target as Node;
  if (panelEl.value?.contains(target)) return;
  for (const el of props.ignore) {
    if (el?.contains(target)) return;
  }
  emit('close');
}

function onKey(e: KeyboardEvent): void {
  if (!visible.value) return;
  if (e.key === 'Escape') emit('close');
}

onMounted(() => {
  recomputePosition();
  window.addEventListener('resize', recomputePosition);
  window.visualViewport?.addEventListener('resize', recomputePosition);
  window.visualViewport?.addEventListener('scroll', recomputePosition);
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', recomputePosition);
  window.visualViewport?.removeEventListener('resize', recomputePosition);
  window.visualViewport?.removeEventListener('scroll', recomputePosition);
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('keydown', onKey);
});

// A new candidate set (the query changed, or rows were re-filtered) re-anchors
// the highlight on the primary (bottom) row and pulls it into view.
watch(displayRows, () => {
  activeIndex.value = defaultActive();
  nextTick(scrollActiveIntoView);
});

watch(
  () => props.open,
  (v) => {
    if (!v) return;
    activeIndex.value = defaultActive();
    recomputePosition();
    nextTick(scrollActiveIntoView);
  },
);
</script>

<style scoped>
.vertical-popover {
  position: fixed;
  left: var(--space-4);
  right: var(--space-4);
  max-width: 480px;
  margin: 0 auto;
  max-height: 50vh;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover-up);
  z-index: var(--z-popover);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-6);
  min-height: 44px;
  cursor: pointer;
  user-select: none;
}
/* Single highlight shared by mouse and keyboard: hovering a row sets activeIndex
   (see @mouseenter), so .active alone covers both — no separate :hover rule that
   could double-highlight during keyboard nav. Soft neutral fill matches the
   context menu / Cmd-K list. */
.row.active {
  background: var(--bg-soft);
}
</style>
