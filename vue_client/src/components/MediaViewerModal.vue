<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div
    ref="overlayEl"
    class="lightbox"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="Image viewer"
    @click.self="$emit('close')"
    @keydown.esc="$emit('close')"
    @keydown.left="onArrowKey($event, 'prev')"
    @keydown.right="onArrowKey($event, 'next')"
  >
    <div class="topbar">
      <!-- What you're looking at, and where you are in the set. Only meaningful for a
           gallery; a single image is a gallery of one and shows neither. -->
      <div class="caption">
        <span v-if="filename" class="caption-name" :title="filename">{{ filename }}</span>
        <span v-if="count > 1" class="caption-count">{{ index + 1 }} / {{ count }}</span>
      </div>
      <div class="controls">
        <!-- Images only. There is nothing to zoom into on an audio player, and a video
             has its own controls; offering a dead button on three modes out of four
             would be worse than offering none. -->
        <button
          v-if="kind === 'image'"
          class="control"
          type="button"
          :title="zoomControlLabel"
          :aria-label="zoomControlLabel"
          :disabled="loading || failed"
          @click="toggleZoomFromCenter"
        >
          <i :class="zoomIconClass"></i>
        </button>
        <!-- Copying the link is what you usually want from something someone posted —
             to reply with it, or to send it on. It was previously only reachable by
             closing the viewer and finding the URL again. -->
        <button
          class="control"
          type="button"
          :class="{ copied: clipboard.isCopied() }"
          :title="clipboard.isCopied() ? 'copied' : 'copy link'"
          :aria-label="clipboard.isCopied() ? 'copied' : 'copy link'"
          @click="onCopyLink"
        >
          <i :class="clipboard.isCopied() ? 'fa-solid fa-check' : 'fa-regular fa-copy'"></i>
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

    <!-- Siblings of the stage, not children of it: the stage owns pan/zoom pointer
         handling, and an arrow inside it would have to fight that for its own clicks.
         Rendered only when there is somewhere to go, so a gallery of one shows none. -->
    <button
      v-if="hasPrev"
      class="nav nav-prev"
      type="button"
      title="previous"
      aria-label="previous image"
      @click.stop="$emit('prev')"
    >
      <i class="fa-solid fa-chevron-left"></i>
    </button>
    <button
      v-if="hasNext"
      class="nav nav-next"
      type="button"
      title="next"
      aria-label="next image"
      @click.stop="$emit('next')"
    >
      <i class="fa-solid fa-chevron-right"></i>
    </button>

    <div ref="stageEl" class="stage" @click.self="$emit('close')">
      <div v-if="failed" class="failed-card">
        <p class="empty">
          {{ failureMessage }}
          <button class="link" type="button" @click="openInBrowser">Open in browser.</button>
        </p>
      </div>
      <p v-else-if="loading" class="loading" aria-label="Loading">
        <i class="fa-solid fa-circle-notch fa-spin"></i>
      </p>

      <!-- IMAGE — the only mode with pan/zoom. A photo is the one thing here you want
           to inspect closer than it fits. -->
      <img
        v-if="kind === 'image'"
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
        @lostpointercapture="onImagePointerEnd"
      />

      <!-- VIDEO. `playsinline` is not optional: without it iOS Safari yanks the video
           into its own native fullscreen player and our viewer — gallery arrows, copy
           link, the lot — is gone.

           NO autoplay, here or on audio. Opening a file to look at it is not the same
           as asking it to start making noise, and walking a gallery with the arrow keys
           would fire off a new track on every keypress. Press play. -->
      <video
        v-else-if="kind === 'video'"
        v-show="!loading && !failed"
        class="video"
        :src="displayUrl"
        controls
        playsinline
        preload="metadata"
        @loadeddata="onLoad"
        @error="onError"
      ></video>

      <!-- AUDIO is just the player, in a box. There is nothing to look at, and dressing
           the nothing up with a big music glyph was decoration standing in for content.
           The filename lives in the caption above, same as every other kind. -->
      <div v-else-if="kind === 'audio'" v-show="!loading && !failed" class="audio-card">
        <audio
          class="audio"
          :src="displayUrl"
          controls
          preload="metadata"
          @loadeddata="onLoad"
          @error="onError"
        ></audio>
      </div>

      <!-- TEXT is the one kind we have to FETCH rather than hand to an element, which
           makes it the only one subject to CORS. Lurker's own long-message paste turns
           into a .txt upload, so this is the mode that lets you read one without
           leaving the app. When the provider won't allow the read, onError puts up the
           same "open in browser" card as a dead image — see loadText(). -->
      <pre v-else-if="kind === 'text'" v-show="!loading && !failed" class="text">{{
        textContent
      }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useCopyFeedback } from '../composables/useCopyFeedback.js';
import { mediaKindForUrl, type MediaKind } from '../utils/uploadHostMatch.js';

const LOAD_TIMEOUT_MS = 20_000;
// A .txt upload is a pasted chat message, not a novel — but nothing stops someone
// linking a 200 MB log, and a <pre> with 200 MB in it locks the tab. Show the head of
// it and say so.
const MAX_TEXT_CHARS = 200_000;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const MOVE_SLOP_PX = 6;
// When an image's aspect already matches the stage there is nothing to fill into,
// so a fit<->fill toggle falls back to this modest zoom for inspecting detail.
const FILL_FALLBACK_ZOOM = 2;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 32;

const props = withDefaults(
  defineProps<{
    url: string;
    // Gallery context (#547). All optional: a lone image opened from a message is a
    // gallery of one, and every one of these falls away to its single-image default.
    filename?: string | null;
    index?: number;
    count?: number;
    hasPrev?: boolean;
    hasNext?: boolean;
  }>(),
  { filename: null, index: 0, count: 1, hasPrev: false, hasNext: false },
);

const emit = defineEmits<{ close: []; prev: []; next: [] }>();

const clipboard = useCopyFeedback();

const loading = ref(true);
const failed = ref(false);
const displayUrl = ref(props.url);
const textContent = ref('');
const overlayEl = ref<HTMLElement | null>(null);
const imageEl = ref<HTMLImageElement | null>(null);
const stageEl = ref<HTMLElement | null>(null);
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
let pinchOccurred = false;
let lastTap: { time: number; x: number; y: number } | null = null;

// What we're showing. Derived from the URL rather than passed in, so a link clicked in
// a message and one clicked in the uploads grid classify identically — one rule, not
// two that can disagree. An unrecognised URL falls back to `image`, which fails into
// the "open in browser" card exactly as it did before this component knew about video.
const kind = computed<MediaKind>(() => mediaKindForUrl(props.url) ?? 'image');

const FAILURE_MESSAGES: Record<MediaKind, string> = {
  image: 'Failed to load image.',
  video: 'Failed to play video.',
  audio: 'Failed to play audio.',
  // The likeliest cause by far, and the one the user can do something about. Reading a
  // .txt means fetching its bytes, which the host has to permit (CORS) — playing a
  // video or showing an image never does.
  text: 'Could not read this file — the host may not allow it.',
};
const failureMessage = computed(() => FAILURE_MESSAGES[kind.value]);

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
  (nextUrl) => {
    startLoading(nextUrl);
    // Arrowing to the next image while the tick is still showing would leave a green
    // check sitting over a link the user has NOT copied.
    clipboard.reset();
  },
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
  textContent.value = '';
  resetZoom();
  loadTimer.value = window.setTimeout(onLoadTimeout, LOAD_TIMEOUT_MS);
  // <img>, <video> and <audio> fetch their own bytes and tell us via @load / @error.
  // Text has no element that does that, so we do it by hand.
  if (mediaKindForUrl(nextUrl) === 'text') void loadText(nextUrl);
}

/**
 * Read a .txt so it can be shown in-app.
 *
 * ⚠ THE ONLY MODE SUBJECT TO CORS. An <img> or <video> renders a cross-origin file
 * without the host's permission; READING one requires it. So this works on the `local`
 * driver (same origin) and is at the mercy of the provider anywhere else — catbox, x0,
 * a CDN. There is no way around that from the client: a proxy on our server would be an
 * SSRF surface and would put every viewed file through our bandwidth.
 *
 * When it's refused, we land on the same "open in browser" card as a dead image, which
 * is exactly today's behaviour. Nothing is lost by trying; a lot is gained when it
 * works, because Lurker's own long-message paste becomes a .txt upload and this is what
 * lets you read one without leaving the app.
 */
async function loadText(url: string): Promise<void> {
  try {
    const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.text();
    // The URL is still the one we started on — the user may have arrowed to the next
    // item while this was in flight, and a stale body must not overwrite it.
    if (displayUrl.value !== url) return;
    textContent.value =
      body.length > MAX_TEXT_CHARS
        ? `${body.slice(0, MAX_TEXT_CHARS)}\n\n… truncated — open in browser for the rest.`
        : body;
    onLoad();
  } catch {
    if (displayUrl.value !== url) return;
    onError();
  }
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

// Left/right walks the gallery — EXCEPT when a media element has focus, where the
// browser already gives those keys a better meaning: seek. Stealing them would make a
// video impossible to scrub with the keyboard, and the user who has clicked into the
// player is plainly not asking for the next file.
function onArrowKey(event: KeyboardEvent, direction: 'prev' | 'next'): void {
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (tag === 'VIDEO' || tag === 'AUDIO') return;
  event.preventDefault();
  // Branched rather than emit(direction): defineEmits' overloads don't narrow a union.
  if (direction === 'prev') emit('prev');
  else emit('next');
}

function openInBrowser(): void {
  window.open(props.url, '_blank', 'noopener,noreferrer');
  emit('close');
}

// Deliberately does NOT close the viewer, unlike openInBrowser: copying a link is
// something you do while still looking at the picture, and often while walking a
// gallery. Closing would make copying two images in a row a chore.
function onCopyLink(): void {
  void clipboard.copy(props.url);
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

  zoomAt(point, fillTarget());
}

// The scale that makes the contain-fitted image cover the stage on both axes
// (offsetWidth/Height are the fit size; a transform never changes them).
function coverScale(): number {
  const stage = stageEl.value;
  const image = imageEl.value;
  if (stage == null || image == null || image.offsetWidth === 0 || image.offsetHeight === 0)
    return MIN_ZOOM;

  return Math.max(stage.clientWidth / image.offsetWidth, stage.clientHeight / image.offsetHeight);
}

// "Screen fill" target for a fit<->fill toggle: cover the stage, but fall back to
// a modest zoom when the image already fills it, and never exceed MAX_ZOOM.
function fillTarget(): number {
  const cover = coverScale();
  return clamp(cover > MIN_ZOOM + 0.01 ? cover : FILL_FALLBACK_ZOOM, MIN_ZOOM, MAX_ZOOM);
}

function zoomAt(point: Point, nextScale: number): void {
  // A tap/button zoom is the same anchored transform as a pinch with both
  // fingers at the same point, so reuse anchoredPan rather than duplicating it.
  const nextPan = anchoredPan({
    fromCenter: point,
    toCenter: point,
    fromPanX: panX.value,
    fromPanY: panY.value,
    fromScale: scale.value,
    toScale: nextScale,
  });

  applyTransform(nextScale, nextPan.x, nextPan.y);
}

function applyTransform(nextScale: number, nextPanX: number, nextPanY: number): void {
  const clampedScale = clamp(nextScale, MIN_ZOOM, MAX_ZOOM);
  const clampedPan = clampPan(nextPanX, nextPanY, clampedScale);

  scale.value = clampedScale;
  panX.value = clampedPan.x;
  panY.value = clampedPan.y;
}

function resetZoom(): void {
  activePointers.clear();
  dragStart = null;
  pinchStart = null;
  pinchOccurred = false;
  lastTap = null;
  isDragging.value = false;
  isPinching.value = false;
  suppressNextClick.value = false;
  scale.value = MIN_ZOOM;
  panX.value = 0;
  panY.value = 0;
}

function beginDrag(clientX: number, clientY: number): void {
  dragStart = {
    point: { x: clientX, y: clientY },
    panX: panX.value,
    panY: panY.value,
  };
  isDragging.value = true;
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

  if (isZoomed.value) beginDrag(event.clientX, event.clientY);
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

  // Only pan once the pointer clears the slop threshold. Below it the gesture is
  // a click (toggle zoom), so panning here would nudge the image and then snap
  // it back when the trailing click resets the zoom.
  if (dragStart != null && isZoomed.value && pointerMoved(activePointer)) {
    const nextPanX = dragStart.panX + event.clientX - dragStart.point.x;
    const nextPanY = dragStart.panY + event.clientY - dragStart.point.y;
    applyTransform(scale.value, nextPanX, nextPanY);
    event.preventDefault();
  }
}

function onImagePointerEnd(event: PointerEvent): void {
  const ending = activePointers.get(event.pointerId);
  if (ending == null) return;

  // A clean single-finger tap: the last pointer lifting, touch input, no pinch
  // during the gesture, and no real movement.
  const wasTap =
    event.pointerType === 'touch' &&
    activePointers.size === 1 &&
    !pinchOccurred &&
    !pointerMoved(ending);

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
    beginDrag(remainingPointer.x, remainingPointer.y);
    return;
  }

  dragStart = null;
  isDragging.value = false;
  pinchOccurred = false;
  // suppressNextClick only gates the mouse click-after-drag path; clear it when a
  // touch gesture ends so a stale flag can't swallow the first trackpad/mouse
  // click on a hybrid device.
  if (event.pointerType === 'touch') suppressNextClick.value = false;

  if (wasTap) handleTap(event);
}

// Touch has no click-to-zoom; a double-tap toggles fit<->fill at the tap point,
// matching the platform convention. A lone tap just arms the next one.
function handleTap(event: PointerEvent): void {
  const point = pointFromClient(event.clientX, event.clientY);
  if (point == null) return;

  const isDoubleTap =
    lastTap != null &&
    event.timeStamp - lastTap.time < DOUBLE_TAP_MS &&
    Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < DOUBLE_TAP_SLOP_PX;

  if (isDoubleTap) {
    lastTap = null;
    toggleZoom(point);
    return;
  }

  lastTap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
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
  pinchOccurred = true;
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

  // When the pinch runs past the scale limits, re-anchor it to the clamped state
  // so reversing direction responds immediately instead of having to retrace the
  // out-of-range spread first.
  if (nextScale > MAX_ZOOM || nextScale < MIN_ZOOM) {
    pinchStart = {
      center: nextCenter,
      distance: nextDistance,
      panX: panX.value,
      panY: panY.value,
      scale: scale.value,
    };
  }
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
  const stage = stageEl.value;
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
  const stage = stageEl.value;
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
  const stage = stageEl.value;
  if (stage == null) return null;

  return {
    x: stage.clientWidth / 2,
    y: stage.clientHeight / 2,
  };
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
  // Only the image mode pans and pinches. Swallowing touches in the others would fight
  // the native <video>/<audio> controls for their own scrubbing gestures, and would
  // stop a long <pre> from being scrolled with a finger.
  if (kind.value !== 'image') return;
  if (event.touches.length > 1 || (isZoomed.value && event.touches.length > 0))
    event.preventDefault();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

onMounted(() => {
  overlayEl.value?.focus();
  // Listen on the stage (not just the image) so two-finger gestures that start on
  // the letterbox padding are also kept from triggering native page zoom; image
  // touches bubble up to the same handler.
  stageEl.value?.addEventListener('touchstart', preventNativeTouchGesture, { passive: false });
  stageEl.value?.addEventListener('touchmove', preventNativeTouchGesture, { passive: false });
  startLoading(props.url);
});

onBeforeUnmount(() => {
  stageEl.value?.removeEventListener('touchstart', preventNativeTouchGesture);
  stageEl.value?.removeEventListener('touchmove', preventNativeTouchGesture);
  clearLoadTimer();
});
</script>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: rgba(0, 0, 0, 0.84);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--space-4);
  padding: var(--space-7);
  outline: none;
  animation: lightbox-fade-in 100ms ease-out;
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

/* margin-right:auto rather than space-between on .topbar: with no caption (the
   single-image case) the controls must stay hard right, and space-between with one
   child already does that — but the moment a caption exists it would push the controls
   without this, and the caption itself needs to be the thing that flexes. */
.caption {
  margin-right: auto;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  padding-left: var(--space-2);
  color: var(--fg-muted);
}
.caption-name {
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.caption-count {
  white-space: nowrap;
}

/* Vertically centred against the whole overlay, not the stage: the stage letterboxes
   the image, so anchoring to it would move the arrows as the aspect ratio changed
   from one photo to the next. */
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1;
  background: rgba(0, 0, 0, 0.45);
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  font-size: var(--icon-lg);
  /* A generous hit area — this is the control you use repeatedly, and on a phone it
     has to be reachable with a thumb without covering the picture. */
  padding: var(--space-6) var(--space-5);
}
.nav:hover {
  color: var(--fg);
}
.nav-prev {
  left: var(--space-4);
}
.nav-next {
  right: var(--space-4);
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
  padding: var(--space-2) var(--space-4);
}
.control.copied,
.control.copied:hover:not(:disabled) {
  color: var(--good);
}
.control:hover:not(:disabled) {
  color: var(--accent);
}
/* Dimming comes from the global button:disabled { opacity } rule; only the
   cursor needs restating to beat the scoped .control { cursor: pointer }. */
.control:disabled {
  cursor: not-allowed;
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
}
/* Letterboxed like the image, but without the transform machinery — a video sizes to
   the stage and its own controls do the rest. */
.video {
  display: block;
  max-width: 92vw;
  max-height: 100%;
  /* A portrait phone clip in a landscape stage would otherwise be a sliver. */
  min-width: min(320px, 92vw);
  background: #000;
}

/* Just the player, in a box — the box exists only to give the native control strip a
   surface to sit on instead of floating in the black. */
.audio-card {
  padding: var(--space-6);
  width: min(480px, 92vw);
  background: var(--bg);
  border: 1px solid var(--border);
}
.audio {
  display: block;
  width: 100%;
}

/* A .txt is usually a pasted chat message, so it wants to read like one: themed,
   selectable, wrapped rather than scrolled sideways. */
.text {
  margin: 0;
  padding: var(--space-7);
  width: min(900px, 92vw);
  max-height: 100%;
  overflow: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--font-mono, monospace);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
  text-align: left;
}

.image--zoomed {
  cursor: zoom-out;
}
.image--dragging {
  cursor: grabbing;
}
/* Promote a compositor layer only while a zoom/pan is actually in play, rather
   than holding one for every lightbox the user never zooms. */
.image--zoomed,
.image--pinching {
  will-change: transform;
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
