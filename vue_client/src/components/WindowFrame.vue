<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Window chrome for one buffer on the mIRC-style canvas: a titlebar you drag,
  eight edges/corners you resize from, and the minimize/maximize/close cluster.

  Geometry lives in the windows store, not here — this component turns pointer
  gestures into store calls and renders the result. That keeps the frame free of
  its own truth, so the store can clamp, cascade, or restore geometry without
  the frame knowing.

  Pointer capture (not window-level listeners) means a fast drag that outruns
  the cursor still delivers its moves here, and the gesture ends cleanly if the
  pointer is lost. Focus happens on pointerdown rather than click so a button
  inside a background window acts on an already-focused window — which is what
  makes the topic bar's "search this buffer" scope to the right buffer.
-->

<template>
  <div
    class="window"
    :class="{ focused: isFocused, maximized: win.state === 'maximized' }"
    :style="frameStyle"
    @pointerdown="windows.focus(win.key)"
  >
    <header class="titlebar" @pointerdown="onTitlePointerDown" @dblclick="onTitleDoubleClick">
      <span class="title">{{ label }}</span>
      <span v-if="unread > 0" class="unread" :class="{ highlight: highlighted > 0 }">{{
        unread
      }}</span>
      <span class="spacer"></span>
      <div class="controls">
        <button
          type="button"
          class="ctl"
          title="Minimize"
          aria-label="Minimize"
          @click="emit('minimize')"
        >
          <i class="fa-solid fa-minus"></i>
        </button>
        <button
          type="button"
          class="ctl"
          :title="win.state === 'maximized' ? 'Restore' : 'Maximize'"
          :aria-label="win.state === 'maximized' ? 'Restore' : 'Maximize'"
          @click="windows.toggleMaximize(win.key)"
        >
          <i
            :class="
              win.state === 'maximized' ? 'fa-regular fa-window-restore' : 'fa-regular fa-square'
            "
          ></i>
        </button>
        <button
          type="button"
          class="ctl close"
          title="Close"
          aria-label="Close"
          @click="emit('close')"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </header>

    <div class="body">
      <slot />
    </div>

    <!-- Resize grips. Hidden while maximized, where the frame owns the canvas. -->
    <template v-if="win.state !== 'maximized'">
      <div
        v-for="dir in GRIPS"
        :key="dir"
        class="grip"
        :class="`grip-${dir}`"
        @pointerdown.stop="onGripPointerDown($event, dir)"
      ></div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CSSProperties } from 'vue';
import {
  useWindowsStore,
  WINDOW_MIN_H,
  WINDOW_MIN_W,
  type BufferWindow,
} from '../stores/windows.js';

const props = defineProps<{
  win: BufferWindow;
  label: string;
  unread: number;
  highlighted: number;
  isFocused: boolean;
  // Canvas size, so a drag can't strand a window past the right/bottom edge.
  canvasWidth: number;
  canvasHeight: number;
}>();

// Close and minimize are the two gestures that take a buffer off screen, which
// the canvas has to reconcile with the buffer's read state. Move/resize/focus/
// maximize are pure chrome, so they go straight to the store.
const emit = defineEmits<{ (e: 'close'): void; (e: 'minimize'): void }>();

const windows = useWindowsStore();

const GRIPS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Grip = (typeof GRIPS)[number];

const frameStyle = computed<CSSProperties>(() => {
  const w = props.win;
  if (w.state === 'maximized') {
    return { inset: '0', zIndex: `calc(var(--z-window) + ${w.z})` };
  }
  return {
    left: `${w.x}px`,
    top: `${w.y}px`,
    width: `${w.w}px`,
    height: `${w.h}px`,
    zIndex: `calc(var(--z-window) + ${w.z})`,
  };
});

// A drag is: remember where the window and the pointer were when it started,
// then on every move apply the pointer's delta to the remembered origin. Taking
// deltas against the *start* rather than the previous move means a dropped
// frame can't accumulate drift.
interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  origin: { x: number; y: number; w: number; h: number };
  grip: Grip | null; // null = titlebar move
}
let gesture: Gesture | null = null;

function beginGesture(e: PointerEvent, grip: Grip | null): void {
  const w = props.win;
  if (w.state === 'maximized') return;
  gesture = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    origin: { x: w.x, y: w.y, w: w.w, h: w.h },
    grip,
  };
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', endGesture);
  el.addEventListener('pointercancel', endGesture);
  e.preventDefault();
}

function onTitlePointerDown(e: PointerEvent): void {
  // Let the control buttons have their clicks.
  if ((e.target as Element).closest('button')) return;
  windows.focus(props.win.key);
  beginGesture(e, null);
}

// Double-click the bar to maximize — but not when the double-click landed on a
// control, where two fast clicks on Minimize would otherwise also maximize.
function onTitleDoubleClick(e: MouseEvent): void {
  if ((e.target as Element).closest('button')) return;
  windows.toggleMaximize(props.win.key);
}

function onGripPointerDown(e: PointerEvent, grip: Grip): void {
  windows.focus(props.win.key);
  beginGesture(e, grip);
}

function onPointerMove(e: PointerEvent): void {
  if (!gesture || e.pointerId !== gesture.pointerId) return;
  const dx = e.clientX - gesture.startX;
  const dy = e.clientY - gesture.startY;
  const o = gesture.origin;
  const key = props.win.key;

  if (!gesture.grip) {
    // Move. Clamp so the titlebar can't be dragged off the canvas entirely:
    // enough of the frame stays inside to grab it again. The lower bounds are 0
    // rather than something negative, matching windows.clampTo() — if a drag
    // could park a window at a negative origin, the next canvas resize would
    // clamp it back to 0 and the window would jump on its own.
    const GRAB = 80;
    const x = Math.max(0, Math.min(o.x + dx, Math.max(0, props.canvasWidth - GRAB)));
    const y = Math.max(0, Math.min(o.y + dy, Math.max(0, props.canvasHeight - 24)));
    windows.move(key, x, y);
    return;
  }

  // Resize. Dragging a north/west edge moves the origin as well as the size, so
  // the opposite edge stays put. Clamping the origin against the min size keeps
  // a shrinking window from walking its far edge backwards once it bottoms out.
  let { x, y, w, h } = o;
  if (gesture.grip.includes('e')) w = o.w + dx;
  if (gesture.grip.includes('s')) h = o.h + dy;
  if (gesture.grip.includes('w')) {
    w = o.w - dx;
    x = o.x + Math.min(dx, o.w - WINDOW_MIN_W);
  }
  if (gesture.grip.includes('n')) {
    h = o.h - dy;
    y = o.y + Math.min(dy, o.h - WINDOW_MIN_H);
  }
  windows.move(key, Math.max(0, x), Math.max(0, y));
  windows.resize(key, w, h);
}

function endGesture(e: PointerEvent): void {
  if (!gesture || e.pointerId !== gesture.pointerId) return;
  const el = e.currentTarget as HTMLElement;
  el.releasePointerCapture?.(gesture.pointerId);
  el.removeEventListener('pointermove', onPointerMove);
  el.removeEventListener('pointerup', endGesture);
  el.removeEventListener('pointercancel', endGesture);
  gesture = null;
}
</script>

<style scoped>
.window {
  position: absolute;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-popover);
  overflow: hidden;
}
/* The focused window gets an accent frame — the only "which one am I typing
   into" signal on a canvas where every window looks alike. */
.window.focused {
  border-color: var(--accent);
}
.window.maximized {
  border-width: 0;
  box-shadow: none;
}

.titlebar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
  cursor: move;
  user-select: none;
  touch-action: none;
  white-space: nowrap;
}
.window.maximized .titlebar {
  cursor: default;
}
.title {
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
}
.window.focused .title {
  color: var(--accent);
}
.unread {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
.unread.highlight {
  color: var(--warn);
}
.spacer {
  flex: 1;
  min-width: 0;
}
.controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}
.ctl {
  background: none;
  border: none;
  color: var(--fg-muted);
  padding: 0 var(--space-2);
  cursor: pointer;
  font: inherit;
}
.ctl:hover {
  color: var(--fg);
}
.ctl.close:hover {
  color: var(--bad);
}

.body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  overflow: hidden;
}
.body > * {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* Grips sit just outside the content, overlapping the border. 6px is a
   comfortable pointer target without eating into the frame's padding; corners
   are 12px squares layered above the edges. */
.grip {
  position: absolute;
  touch-action: none;
}
.grip-n,
.grip-s {
  left: 0;
  right: 0;
  height: 6px;
  cursor: ns-resize;
}
.grip-n {
  top: -3px;
}
.grip-s {
  bottom: -3px;
}
.grip-e,
.grip-w {
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
}
.grip-e {
  right: -3px;
}
.grip-w {
  left: -3px;
}
.grip-ne,
.grip-nw,
.grip-se,
.grip-sw {
  width: 12px;
  height: 12px;
  z-index: 1;
}
.grip-ne {
  top: -3px;
  right: -3px;
  cursor: nesw-resize;
}
.grip-nw {
  top: -3px;
  left: -3px;
  cursor: nwse-resize;
}
.grip-se {
  bottom: -3px;
  right: -3px;
  cursor: nwse-resize;
}
.grip-sw {
  bottom: -3px;
  left: -3px;
  cursor: nesw-resize;
}
</style>
