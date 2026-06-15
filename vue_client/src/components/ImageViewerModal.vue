<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div
    ref="overlayEl"
    class="lightbox"
    :class="{ 'lightbox--zoomed': isZoomed }"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="Image viewer"
    @click.self="$emit('close')"
    @keydown.esc="$emit('close')"
  >
    <div class="topbar">
      <div class="controls">
        <button
          class="control"
          type="button"
          :title="zoomControlLabel"
          :aria-label="zoomControlLabel"
          :disabled="loading || failed"
          @click="toggleZoomFromCenter"
        >
          <i :class="zoomIconClass"></i>
        </button>
        <button
          class="control"
          type="button"
          title="open in browser"
          aria-label="open in browser"
          @click="openInBrowser"
        >
          <i class="fa-solid fa-arrow-up-right-from-square"></i>
        </button>
        <button
          class="control"
          type="button"
          title="close"
          aria-label="close"
          @click="$emit('close')"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>

    <div class="stage" @click.self="$emit('close')">
      <div v-if="failed" class="failed-card">
        <p class="empty">
          Failed to load image.
          <button class="link" type="button" @click="openInBrowser">Open in browser.</button>
        </p>
      </div>
      <p v-else-if="loading" class="loading" aria-label="Loading image">
        <i class="fa-solid fa-circle-notch fa-spin"></i>
      </p>
      <img
        ref="imageEl"
        v-show="!loading && !failed"
        class="image"
        :class="{
          'image--zoomed': isZoomed,
          'image--dragging': isDragging,
          'image--pinching': isPinching,
        }"
        :style="imageStyle"
        :src="displayUrl"
        referrerpolicy="no-referrer"
        alt=""
        draggable="false"
        @click.stop="onImageClick"
        @dragstart.prevent
        @load="onLoad"
        @error="onError"
        @pointerdown="onImagePointerDown"
        @pointermove="onImagePointerMove"
        @pointerup="onImagePointerEnd"
        @pointercancel="onImagePointerEnd"
        @pointerleave="onImagePointerEnd"
        @lostpointercapture="onImagePointerEnd"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const LOAD_TIMEOUT_MS = 20_000;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const MOVE_SLOP_PX = 6;

const props = defineProps<{
  url: string;
}>();

const emit = defineEmits<{ close: [] }>();

const loading = ref(true);
const failed = ref(false);
const displayUrl = ref(props.url);
const overlayEl = ref<HTMLElement | null>(null);
const imageEl = ref<HTMLImageElement | null>(null);
const loadTimer = ref<number | null>(null);
const scale = ref(MIN_ZOOM);
const panX = ref(0);
const panY = ref(0);
const isDragging = ref(false);
const isPinching = ref(false);
const suppressNextClick = ref(false);
const lastPointerType = ref<string | null>(null);

type Point = {
  x: number;
  y: number;
};

type ActivePointer = Point & {
  startX: number;
  startY: number;
};

type DragStart = {
  point: Point;
  panX: number;
  panY: number;
};

type PinchStart = {
  center: Point;
  distance: number;
  panX: number;
  panY: number;
  scale: number;
};

const activePointers = new Map<number, ActivePointer>();
let dragStart: DragStart | null = null;
let pinchStart: PinchStart | null = null;

const isZoomed = computed(() => scale.value > MIN_ZOOM);
const zoomControlLabel = computed(() => (isZoomed.value ? 'zoom out' : 'zoom in'));
const zoomIconClass = computed(() => [
  'fa-solid',
  isZoomed.value ? 'fa-magnifying-glass-minus' : 'fa-magnifying-glass-plus',
]);
const imageStyle = computed(() => ({
  transform: `translate3d(${panX.value}px, ${panY.value}px, 0) scale(${scale.value})`,
}));

watch(
  () => props.url,
  (nextUrl) => startLoading(nextUrl),
);

function onLoad(): void {
  clearLoadTimer();
  resetZoom();
  loading.value = false;
  failed.value = false;
}

function onError(): void {
  clearLoadTimer();
  resetZoom();
  loading.value = false;
  failed.value = true;
}

function startLoading(nextUrl: string): void {
  clearLoadTimer();
  displayUrl.value = nextUrl;
  loading.value = true;
  failed.value = false;
  resetZoom();
  loadTimer.value = window.setTimeout(onLoadTimeout, LOAD_TIMEOUT_MS);
}

function clearLoadTimer(): void {
  if (loadTimer.value == null) return;

  window.clearTimeout(loadTimer.value);
  loadTimer.value = null;
}

function onLoadTimeout(): void {
  loadTimer.value = null;
  displayUrl.value = '';
  loading.value = false;
  failed.value = true;
  resetZoom();
}

function openInBrowser(): void {
  window.open(props.url, '_blank', 'noopener,noreferrer');
  emit('close');
}

function toggleZoomFromCenter(): void {
  const center = stageCenterPoint();
  if (center == null) return;

  toggleZoom(center);
}

function onImageClick(event: MouseEvent): void {
  if (loading.value || failed.value) return;
  if (lastPointerType.value === 'touch') return;
  if (suppressNextClick.value) {
    suppressNextClick.value = false;
    return;
  }

  const point = pointFromClient(event.clientX, event.clientY);
  if (point == null) return;

  toggleZoom(point);
}

function toggleZoom(point: Point): void {
  if (isZoomed.value) {
    resetZoom();
    return;
  }

  zoomAt(point, MAX_ZOOM);
}

function zoomAt(point: Point, nextScale: number): void {
  const stageCenter = stageCenterPoint();
  if (stageCenter == null) return;

  const clampedScale = clamp(nextScale, MIN_ZOOM, MAX_ZOOM);
  const localX = (point.x - stageCenter.x - panX.value) / scale.value;
  const localY = (point.y - stageCenter.y - panY.value) / scale.value;
  const nextPanX = point.x - stageCenter.x - localX * clampedScale;
  const nextPanY = point.y - stageCenter.y - localY * clampedScale;

  applyTransform(clampedScale, nextPanX, nextPanY);
}

function applyTransform(nextScale: number, nextPanX: number, nextPanY: number): void {
  const clampedScale = clamp(nextScale, MIN_ZOOM, MAX_ZOOM);
  const clampedPan = clampPan(nextPanX, nextPanY, clampedScale);

  scale.value = clampedScale;
  panX.value = clampedPan.x;
  panY.value = clampedPan.y;
  void nextTick(() => {
    const reclampedPan = clampPan(panX.value, panY.value, scale.value);
    panX.value = reclampedPan.x;
    panY.value = reclampedPan.y;
  });
}

function resetZoom(): void {
  activePointers.clear();
  dragStart = null;
  pinchStart = null;
  isDragging.value = false;
  isPinching.value = false;
  suppressNextClick.value = false;
  scale.value = MIN_ZOOM;
  panX.value = 0;
  panY.value = 0;
}

function onImagePointerDown(event: PointerEvent): void {
  if (loading.value || failed.value) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  lastPointerType.value = event.pointerType;
  activePointers.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
    startX: event.clientX,
    startY: event.clientY,
  });

  try {
    imageEl.value?.setPointerCapture(event.pointerId);
  } catch {
    // The pointer may already be gone on fast touch sequences.
  }

  if (activePointers.size === 2) {
    startPinch();
    event.preventDefault();
    return;
  }

  if (isZoomed.value) {
    dragStart = {
      point: { x: event.clientX, y: event.clientY },
      panX: panX.value,
      panY: panY.value,
    };
    isDragging.value = true;
  }
}

function onImagePointerMove(event: PointerEvent): void {
  const activePointer = activePointers.get(event.pointerId);
  if (activePointer == null) return;

  activePointer.x = event.clientX;
  activePointer.y = event.clientY;
  if (pointerMoved(activePointer)) suppressNextClick.value = true;

  if (activePointers.size >= 2) {
    updatePinch();
    event.preventDefault();
    return;
  }

  if (dragStart != null && isZoomed.value) {
    const nextPanX = dragStart.panX + event.clientX - dragStart.point.x;
    const nextPanY = dragStart.panY + event.clientY - dragStart.point.y;
    applyTransform(scale.value, nextPanX, nextPanY);
    event.preventDefault();
  }
}

function onImagePointerEnd(event: PointerEvent): void {
  if (!activePointers.has(event.pointerId)) return;

  activePointers.delete(event.pointerId);
  releasePointer(event.pointerId);

  if (activePointers.size >= 2) {
    startPinch();
    return;
  }

  pinchStart = null;
  isPinching.value = false;

  if (activePointers.size === 1 && isZoomed.value) {
    const remainingPointer = Array.from(activePointers.values())[0];
    dragStart = {
      point: { x: remainingPointer.x, y: remainingPointer.y },
      panX: panX.value,
      panY: panY.value,
    };
    isDragging.value = true;
    return;
  }

  dragStart = null;
  isDragging.value = false;
}

function startPinch(): void {
  const points = Array.from(activePointers.values());
  if (points.length < 2) return;

  pinchStart = {
    center: pointFromClientPairCenter(points[0], points[1]),
    distance: distanceBetween(points[0], points[1]),
    panX: panX.value,
    panY: panY.value,
    scale: scale.value,
  };
  dragStart = null;
  isDragging.value = false;
  isPinching.value = true;
  suppressNextClick.value = true;
}

function updatePinch(): void {
  if (pinchStart == null || pinchStart.distance <= 0) return;

  const points = Array.from(activePointers.values());
  if (points.length < 2) return;

  const nextDistance = distanceBetween(points[0], points[1]);
  const nextCenter = pointFromClientPairCenter(points[0], points[1]);
  const nextScale = pinchStart.scale * (nextDistance / pinchStart.distance);
  const nextPan = anchoredPan({
    fromCenter: pinchStart.center,
    toCenter: nextCenter,
    fromPanX: pinchStart.panX,
    fromPanY: pinchStart.panY,
    fromScale: pinchStart.scale,
    toScale: nextScale,
  });

  applyTransform(nextScale, nextPan.x, nextPan.y);
}

function anchoredPan(args: {
  fromCenter: Point;
  toCenter: Point;
  fromPanX: number;
  fromPanY: number;
  fromScale: number;
  toScale: number;
}): Point {
  const stageCenter = stageCenterPoint();
  if (stageCenter == null) return { x: panX.value, y: panY.value };

  const clampedScale = clamp(args.toScale, MIN_ZOOM, MAX_ZOOM);
  const localX = (args.fromCenter.x - stageCenter.x - args.fromPanX) / args.fromScale;
  const localY = (args.fromCenter.y - stageCenter.y - args.fromPanY) / args.fromScale;

  return {
    x: args.toCenter.x - stageCenter.x - localX * clampedScale,
    y: args.toCenter.y - stageCenter.y - localY * clampedScale,
  };
}

function clampPan(nextPanX: number, nextPanY: number, nextScale: number): Point {
  const stage = stageEl();
  const image = imageEl.value;
  if (stage == null || image == null || nextScale <= MIN_ZOOM) return { x: 0, y: 0 };

  const maxPanX = Math.max(0, (image.offsetWidth * nextScale - stage.clientWidth) / 2);
  const maxPanY = Math.max(0, (image.offsetHeight * nextScale - stage.clientHeight) / 2);

  return {
    x: clamp(nextPanX, -maxPanX, maxPanX),
    y: clamp(nextPanY, -maxPanY, maxPanY),
  };
}

function pointFromClient(clientX: number, clientY: number): Point | null {
  const stage = stageEl();
  if (stage == null) return null;

  const rect = stage.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function pointFromClientPairCenter(first: Point, second: Point): Point {
  const center = pointFromClient((first.x + second.x) / 2, (first.y + second.y) / 2);
  return center ?? { x: 0, y: 0 };
}

function stageCenterPoint(): Point | null {
  const stage = stageEl();
  if (stage == null) return null;

  return {
    x: stage.clientWidth / 2,
    y: stage.clientHeight / 2,
  };
}

function stageEl(): HTMLElement | null {
  return imageEl.value?.parentElement ?? null;
}

function distanceBetween(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function pointerMoved(pointer: ActivePointer): boolean {
  return Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) > MOVE_SLOP_PX;
}

function releasePointer(pointerId: number): void {
  try {
    if (imageEl.value?.hasPointerCapture(pointerId) === true)
      imageEl.value.releasePointerCapture(pointerId);
  } catch {
    // Capture is also released automatically on pointerup/pointercancel.
  }
}

function preventNativeTouchGesture(event: TouchEvent): void {
  if (event.touches.length > 1 || (isZoomed.value && event.touches.length > 0))
    event.preventDefault();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

onMounted(() => {
  overlayEl.value?.focus();
  imageEl.value?.addEventListener('touchstart', preventNativeTouchGesture, { passive: false });
  imageEl.value?.addEventListener('touchmove', preventNativeTouchGesture, { passive: false });
  startLoading(props.url);
});

onBeforeUnmount(() => {
  imageEl.value?.removeEventListener('touchstart', preventNativeTouchGesture);
  imageEl.value?.removeEventListener('touchmove', preventNativeTouchGesture);
  clearLoadTimer();
});
</script>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  --control-rail: calc(var(--icon-lg) + (2 * var(--space-2)));
  background: rgba(0, 0, 0, 0.84);
  display: grid;
  grid-template-rows: var(--control-rail) minmax(0, 1fr);
  gap: var(--space-4);
  padding: var(--space-7);
  outline: none;
  animation: lightbox-fade-in 100ms ease-out;
}
.lightbox--zoomed {
  gap: var(--space-2);
  padding-right: 0;
  padding-bottom: 0;
  padding-left: 0;
}

.topbar {
  grid-column: 1;
  grid-row: 1;
  width: 100%;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding-top: env(safe-area-inset-top);
  padding-right: env(safe-area-inset-right);
  z-index: 1;
}
.lightbox--zoomed .topbar {
  padding-right: calc(env(safe-area-inset-right) + var(--space-7));
  padding-left: calc(env(safe-area-inset-left) + var(--space-7));
}
.controls {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.control {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  /* Icon-only button — size the glyph, not text weight (fa-solid is already
     weight 900). */
  font-size: var(--icon-lg);
  line-height: 1;
  padding: var(--space-2) var(--space-4);
}
.control:hover {
  color: var(--accent);
}
.control:disabled {
  color: rgba(255, 255, 255, 0.32);
  cursor: default;
}

.stage {
  grid-column: 1;
  grid-row: 2;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  overscroll-behavior: contain;
  touch-action: none;
}
.image {
  display: block;
  width: auto;
  height: auto;
  max-width: 92vw;
  max-height: 100%;
  object-fit: contain;
  cursor: zoom-in;
  touch-action: none;
  transform-origin: center center;
  transition: transform 120ms ease-out;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-user-drag: none;
  will-change: transform;
}
.lightbox--zoomed .image {
  max-width: 100vw;
}
.image--zoomed {
  cursor: zoom-out;
}
.image--dragging {
  cursor: grabbing;
}
.image--dragging,
.image--pinching {
  transition: none;
}
@media (pointer: coarse) {
  .image {
    cursor: default;
  }
}
.loading,
.empty {
  margin: 0;
  color: rgba(255, 255, 255, 0.78);
  text-align: center;
}
.loading {
  font-size: var(--icon-lg);
}
.failed-card {
  width: min(520px, 92vw);
  background: var(--bg);
  border: 1px solid var(--accent);
  padding: var(--space-9);
}
.empty {
  color: var(--fg);
}
.link {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.link:hover {
  color: var(--accent);
}
.link:focus-visible {
  color: var(--accent);
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}

@keyframes lightbox-fade-in {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
