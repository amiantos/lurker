<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  The colour picker shell. Desktop: a floating card anchored under the swatch
  that opened it (teleported to body, viewport-clamped, re-placed on scroll,
  resize and its own size changes). Mobile: the standard AppModal sheet. Both
  wrap ColorPickerBody, and a viewport flip while open swaps shells in place.

  Commit semantics mirror the text field it sits beside, whose blur commits:
  clicking away, Enter in the field, the sheet's close button, "done", and the
  swatch scrolling out of view all commit the draft if it changed. Escape is
  the one way out WITHOUT committing, in both shells; "revert" puts the
  opening value back without closing. Nothing is written while the user drags
  — Settings is a full page with no chat behind it, so there is nothing to
  preview live, and the theme editor that will have a live view gets its own
  shell over the same body.
-->

<template>
  <Teleport to="body">
    <AppModal v-if="isMobile" size="sm" word="color" @close="finish">
      <!-- Own header: AppModal's stock one ends in an X, which reads as
           "cancel" when it actually commits. Say "done" instead, with the
           undo glyph for revert — the same pair as the desktop footer. -->
      <template #head>
        <header class="sheet-head">
          <h2>color</h2>
          <div class="sheet-actions">
            <button
              class="icon-btn"
              type="button"
              :disabled="!dirty"
              title="revert to the color you opened with"
              aria-label="revert to the color you opened with"
              @click="revert"
            >
              <Undo2Icon />
            </button>
            <button class="btn-primary done" type="button" @click="finish">done</button>
          </div>
        </header>
      </template>
      <!-- AppModal maps Escape to `close`, which here means commit. Catch it
           first so Escape abandons the draft on this shell too. -->
      <div @keydown.esc.stop.prevent="cancel">
        <ColorPickerBody v-model="draft" :initial="value" :setting-key="settingKey" />
      </div>
    </AppModal>
    <div
      v-else
      ref="cardEl"
      class="picker-card"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      tabindex="-1"
      role="dialog"
      aria-label="color picker"
      @keydown.esc.stop.prevent="cancel"
      @keydown.enter="onEnter"
    >
      <ColorPickerBody v-model="draft" :initial="value" :setting-key="settingKey" />
      <footer class="foot">
        <button
          class="icon-btn"
          type="button"
          :disabled="!dirty"
          title="revert to the color you opened with"
          aria-label="revert to the color you opened with"
          @click="revert"
        >
          <Undo2Icon />
        </button>
        <button class="btn-primary done" type="button" @click="finish">done</button>
      </footer>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Undo2Icon } from '@lucide/vue';
import AppModal from './AppModal.vue';
import ColorPickerBody from './ColorPickerBody.vue';
import { useViewport } from '../composables/useViewport.js';

const props = defineProps<{
  /** The setting's current stored value, as the row shows it. */
  value: string;
  /** The swatch button that opened the picker; the desktop card hangs off it. */
  anchor: HTMLElement | null;
  /** The registry key being edited; see ColorPickerBody's reference swap. */
  settingKey?: string;
}>();

const emit = defineEmits<{
  commit: [value: string];
  close: [];
}>();

const { isMobile } = useViewport();
const draft = ref(props.value);
const dirty = computed(() => draft.value.trim() !== props.value.trim());
// Opening the picker blurs the text field beside the swatch, whose @change
// commit is still in flight when we mount — so the value we opened on can
// change under us a moment later. While the user hasn't touched the draft it
// follows; otherwise committing the stale opening value would undo the edit
// they just typed.
watch(
  () => props.value,
  (next, prev) => {
    if (draft.value === prev) draft.value = next;
  },
);

// Closing is one-shot: the scroll/resize/observer paths can all call finish()
// before the parent has unmounted us, and a second commit would double-write.
let closed = false;
function finish(): void {
  if (closed) return;
  closed = true;
  if (dirty.value) emit('commit', draft.value.trim());
  emit('close');
  props.anchor?.focus();
}
function cancel(): void {
  if (closed) return;
  closed = true;
  emit('close');
  // Focus goes back where it came from, not to <body>: the card took it on
  // mount, and a keyboard user's next Tab should continue from the swatch.
  props.anchor?.focus();
}
function revert(): void {
  draft.value = props.value;
}
// Enter commits from the text field only. On a swatch or the star it is the
// button's own activation: finishing on keydown would unmount the picker
// before the click it triggers ever fires, so the pick would be lost.
function onEnter(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (!(t instanceof HTMLInputElement) || t.type !== 'text') return;
  e.preventDefault();
  finish();
}

// ─── desktop placement ───────────────────────────────────────────────────

const cardEl = ref<HTMLElement | null>(null);
const pos = ref({ x: 0, y: 0 });

// Under the anchor, left-aligned; above it when the bottom would clip; then
// clamped into the viewport the way ContextMenu does. Writes `pos` only when
// it moves: the card re-renders on every draft change, and a fresh object per
// render from a hook would re-trigger that render without end.
function place(): void {
  const a = props.anchor;
  const el = cardEl.value;
  if (!a || !el) return;
  const r = a.getBoundingClientRect();
  // The swatch scrolled out of its pane: the card would float detached from
  // anything, so treat it like a click-away. The pane, not the window — the
  // Settings page scrolls inside its content region under a fixed header, so
  // a swatch can be hidden while still inside the viewport.
  const bounds = scrollBounds(a);
  if (r.bottom < bounds.top || r.top > bounds.bottom) {
    finish();
    return;
  }
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const pad = 4;
  const gap = 6;
  let x = r.left;
  let y = r.bottom + gap;
  if (y + h + pad > window.innerHeight) {
    const above = r.top - gap - h;
    y = above >= pad ? above : Math.max(pad, window.innerHeight - h - pad);
  }
  if (x + w + pad > window.innerWidth) x = window.innerWidth - w - pad;
  if (x < pad) x = pad;
  if (x !== pos.value.x || y !== pos.value.y) pos.value = { x, y };
}

// The visible vertical extent of the anchor's nearest scrolling ancestor, or
// the viewport when nothing between it and the document scrolls.
function scrollBounds(el: HTMLElement): { top: number; bottom: number } {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') {
      const pr = p.getBoundingClientRect();
      return { top: Math.max(0, pr.top), bottom: Math.min(window.innerHeight, pr.bottom) };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}

function onWindowPointerDown(e: PointerEvent): void {
  const t = e.target;
  if (!(t instanceof Node)) return;
  if (cardEl.value?.contains(t)) return;
  // The swatch's own click only opens; a pointerdown on it while open is the
  // user prodding the thing that is already up, not a dismissal.
  if (props.anchor?.contains(t)) return;
  finish();
}

// The desktop listeners follow the shell, not the component: a window
// narrowed past the breakpoint (an iPad rotated) swaps the card for the sheet
// while the picker is open, and a stale pointerdown listener with no card to
// test against would commit on the first tap inside the sheet.
let desktopAttached = false;
let resizeObserver: ResizeObserver | null = null;

async function attachDesktop(): Promise<void> {
  if (desktopAttached) return;
  desktopAttached = true;
  await nextTick();
  if (!desktopAttached) return;
  place();
  cardEl.value?.focus();
  window.addEventListener('pointerdown', onWindowPointerDown, { capture: true });
  window.addEventListener('resize', place);
  // Capture: the settings pane scrolls, not the window, and scroll doesn't bubble.
  window.addEventListener('scroll', place, { capture: true, passive: true });
  // Rows that appear as the draft changes (favourites, harmony) change the
  // card's height; the observer re-places without a render hook in the loop.
  if (typeof ResizeObserver !== 'undefined' && cardEl.value) {
    resizeObserver = new ResizeObserver(() => place());
    resizeObserver.observe(cardEl.value);
  }
}
function detachDesktop(): void {
  if (!desktopAttached) return;
  desktopAttached = false;
  window.removeEventListener('pointerdown', onWindowPointerDown, { capture: true });
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, { capture: true });
  resizeObserver?.disconnect();
  resizeObserver = null;
}

onMounted(() => {
  if (!isMobile.value) void attachDesktop();
});
watch(isMobile, (mobile) => {
  if (mobile) detachDesktop();
  else void attachDesktop();
});
onBeforeUnmount(detachDesktop);
</script>

<style scoped>
.picker-card {
  position: fixed;
  width: 300px;
  max-width: calc(100vw - 8px);
  max-height: calc(100dvh - 8px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  z-index: var(--z-popover);
  outline: none;
}
.foot {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--space-6);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
}
/* Mirrors AppModal's .head / .title-wrap h2 / .close-btn, which are scoped
   there and don't reach a replaced header. */
.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-6);
  padding: 0 0 var(--space-5);
  margin-bottom: var(--space-6);
  border-bottom: 1px solid var(--border);
}
.sheet-head h2 {
  margin: 0;
  color: var(--accent);
  font-weight: var(--font-weight);
  text-transform: lowercase;
  letter-spacing: 0.02em;
}
.sheet-actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
/* Both shells' undo: scoped styles reach slot content this component renders,
   so one set of rules serves the footer and the header. "done" beside it is the
   global .btn-primary; undo is the same outlined square at its height. */
.done {
  padding-block: var(--space-2);
}
.icon-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  font-size: var(--icon-lg);
  padding: var(--space-2) var(--space-4);
  display: inline-flex;
  align-self: stretch;
  align-items: center;
}
.icon-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
