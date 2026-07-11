<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The mIRC-style desktop: the whole area right of the sidebar, holding N buffer
  windows plus a taskbar of the minimized ones.

  This component owns the two-way reconciliation between the windows store and
  the app's single-active-buffer model:

    sidebar click -> networks.activeKey changes -> open (or un-minimize) a window
    window focus  -> networks.activeKey follows it

  Focus is the join between the two. Everything else in the app still asks
  "what's the active buffer" and gets the focused window's, so the buffer list
  highlight, the scoped search/highlight modals and the keyboard shortcuts all
  keep working without knowing windows exist.

  Focusing away from a window does NOT mark its buffer as left — it's still on
  screen and still being read. Closing or minimizing does. That's why the
  activate() calls here pass retainPrevious and the close/minimize handlers call
  buffers.leaveBuffer() explicitly.
-->

<template>
  <div class="window-canvas">
    <!-- The stage is the positioning context and the maximize bounds, so a
         maximized window fills it without sliding under the taskbar. -->
    <div ref="stageEl" class="stage">
      <WindowFrame
        v-for="win in windows.visible"
        :key="win.key"
        :win="win"
        :label="labelFor(win.key)"
        :unread="unreadFor(win.key)"
        :highlighted="highlightedFor(win.key)"
        :is-focused="win.key === windows.focusedKey"
        :canvas-width="stageWidth"
        :canvas-height="stageHeight"
        @close="onClose(win.key)"
        @minimize="onMinimize(win.key)"
      >
        <BufferPane
          :buffer-key="win.key"
          :show-nav="false"
          :pending-scroll-id="
            win.key === networks.activeKey ? (props.pendingScrollId ?? null) : null
          "
          @open-search="(scoped: boolean) => emit('open-search', scoped)"
          @open-highlights="(scoped: boolean) => emit('open-highlights', scoped)"
          @show-topic="emit('show-topic')"
          @view-activity="(q: string) => emit('view-activity', q)"
        />
      </WindowFrame>

      <div v-if="windows.visible.length === 0" class="empty">
        {{
          windows.minimized.length > 0
            ? 'Every window is minimized.'
            : 'Pick a buffer from the list to open a window.'
        }}
      </div>
    </div>

    <!-- Taskbar: minimized windows keep their geometry but drop their pane, so
         this is the only way back to them. -->
    <footer v-if="windows.minimized.length > 0" class="taskbar">
      <button
        v-for="win in windows.minimized"
        :key="win.key"
        type="button"
        class="task"
        :class="{ highlight: highlightedFor(win.key) > 0 }"
        :title="`Restore ${labelFor(win.key)}`"
        @click="onRestore(win.key)"
      >
        <span class="task-label">{{ labelFor(win.key) }}</span>
        <span v-if="unreadFor(win.key) > 0" class="task-unread">{{ unreadFor(win.key) }}</span>
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useWindowsStore } from '../stores/windows.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useFriendsStore } from '../stores/friends.js';
import { FRIENDS_KEY, virtualConfig } from '../lib/virtualBuffers.js';
import WindowFrame from './WindowFrame.vue';
import BufferPane from './BufferPane.vue';

const props = defineProps<{ pendingScrollId?: number | null }>();

const emit = defineEmits<{
  (e: 'open-search', scoped: boolean): void;
  (e: 'open-highlights', scoped: boolean): void;
  (e: 'show-topic'): void;
  (e: 'view-activity', query: string): void;
}>();

const windows = useWindowsStore();
const networks = useNetworksStore();
const buffers = useBuffersStore();
const friends = useFriendsStore();

const stageEl = ref<HTMLElement | null>(null);
const stageWidth = ref(0);
const stageHeight = ref(0);

// Titles and badges come from the buffer, so a minimized window's taskbar entry
// keeps counting while it's hidden.
function labelFor(key: string): string {
  const cfg = virtualConfig(key);
  if (cfg) return cfg.label;
  const parsed = networks.bufferFor(key);
  if (!parsed) return key;
  if (parsed.target.startsWith(':server:')) return parsed.network?.name ?? 'server';
  return parsed.target;
}
function unreadFor(key: string): number {
  return buffers.byKey(key)?.unread ?? 0;
}
function highlightedFor(key: string): number {
  return buffers.byKey(key)?.highlighted ?? 0;
}

// Point the app's active buffer at `key`, going through the same entry paths
// the sidebar uses so read-state, history seeding and presence probes all run.
// retainPrevious: the buffer we're focusing away from still has a window on
// screen, so it hasn't been left.
function activateKey(key: string): void {
  if (networks.activeKey === key) return;
  if (key === FRIENDS_KEY) {
    friends.open();
    return;
  }
  const cfg = virtualConfig(key);
  if (cfg) {
    buffers.activate(null, key, { retainPrevious: true });
    return;
  }
  const parsed = networks.bufferFor(key);
  if (parsed) buffers.activate(parsed.networkId, parsed.target, { retainPrevious: true });
}

// Sidebar (or /query, or a push deep-link) made a buffer active: give it a
// window, or raise and un-minimize the one it has.
watch(
  () => networks.activeKey,
  (key) => {
    if (key) windows.open(key);
  },
  { immediate: true },
);

// The focused window is the active buffer. When the last window goes away
// (closed, or all minimized) there is no active buffer — which is also what
// makes re-picking the same buffer in the sidebar a change, and so re-opens it.
// Guarded by the equality check in activateKey, so this and the watcher above
// settle rather than ping-pong.
watch(
  () => windows.focusedKey,
  (key) => {
    if (key) activateKey(key);
    else networks.clearActive();
  },
);

// Closing and minimizing are the two gestures that mean "I'm done looking at
// this for now", so they're where the unread divider and any detached history
// slice get dropped — not on focus change, where the window is still on screen.
function onClose(key: string): void {
  buffers.leaveBuffer(key);
  windows.close(key);
}
function onMinimize(key: string): void {
  buffers.leaveBuffer(key);
  windows.minimize(key);
}
function onRestore(key: string): void {
  windows.restore(key);
}

// The taskbar appearing shrinks the stage, so this also re-clamps when the last
// window is minimized — a window pinned to the old bottom edge stays grabbable.
let observer: ResizeObserver | null = null;
function measure(): void {
  const el = stageEl.value;
  if (!el) return;
  stageWidth.value = el.clientWidth;
  stageHeight.value = el.clientHeight;
  windows.clampTo(stageWidth.value, stageHeight.value);
}

onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && stageEl.value) {
    observer = new ResizeObserver(measure);
    observer.observe(stageEl.value);
  }
});
onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<style scoped>
.window-canvas {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
/* Lighter than the window bodies so the frames read as floating on a desktop
   rather than as panels welded to the shell. */
.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-soft);
}

.empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
}

.taskbar {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border);
  background: var(--bg);
}
.task {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  background: none;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
  font: inherit;
  max-width: 220px;
}
.task:hover {
  color: var(--fg);
}
.task.highlight {
  color: var(--warn);
}
.task-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-unread {
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
</style>
