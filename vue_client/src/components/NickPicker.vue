<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <!-- ARIA combobox + listbox pattern: focus stays on the host textarea
       (which carries role="combobox") while this panel renders the listbox
       popup. The textarea announces the active row via aria-activedescendant
       pointing at an option's id — see `optionId()` below for the format the
       host is expected to mirror. -->
  <div
    v-if="open && rows.length"
    ref="panelEl"
    class="nick-picker"
    :style="panelStyle"
    role="listbox"
    :id="listboxId"
    aria-label="Nick completion suggestions"
    @pointerdown.stop
  >
    <div
      v-for="row in renderedRows"
      :key="row.lc + ':' + row.index"
      class="row"
      :class="{ active: row.index === activeIndex }"
      role="option"
      :id="optionId(row.index)"
      :aria-selected="row.index === activeIndex"
      @pointerdown.prevent="pick(row.nick)"
      @mouseenter="activeIndex = row.index"
    >
      <span class="nick" :style="row.color ? { color: row.color } : null">{{ row.nick }}</span>
      <span v-if="row.recent" class="badge">recent</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { buildNickCandidates } from '../utils/nickCompletion.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useNickColors } from '../composables/useNickColors.js';
import type { Buffer } from '../stores/buffers.js';

const props = withDefaults(
  defineProps<{
    open?: boolean;
    query?: string;
    buffer?: Buffer | null;
    selfNick?: string;
    anchor?: HTMLElement | null;
    // ARIA wiring: the host (MessageInput) owns the id namespace so its
    // textarea can set aria-controls / aria-activedescendant against
    // matching ids without timing or ref-unwrap gymnastics.
    listboxId?: string;
  }>(),
  {
    open: false,
    query: '',
    buffer: null,
    selfNick: '',
    anchor: null,
    listboxId: '',
  },
);

const emit = defineEmits<{
  select: [nick: string];
  close: [];
  // Fires whenever the active option id changes — either because the user
  // moved the highlight or because the candidate list rebuilt. Empty string
  // means no active option (picker closed or no rows). The host mirrors this
  // value into the textarea's aria-activedescendant.
  'active-change': [optionId: string];
}>();

const ignores = useIgnoresStore();
const nickColors = useNickColors();
const panelEl = ref<HTMLElement | null>(null);
const panelBottom = ref(8);

// Index into `rows` (candidate order, 0 = best match) of the keyboard-
// highlighted entry. Rows render bottom-up — see `renderedRows` — so index 0
// sits visually at the bottom, nearest the input bar.
const activeIndex = ref(0);

const rows = computed(() => {
  // Bail before touching buffer/query/ignores while closed: a computed only
  // tracks the deps it reads, so this early return keeps `rows` (and the
  // watch that subscribes to it) from rebuilding the whole candidate list and
  // re-coloring every nick on each speakers/members update behind a closed
  // picker. Nothing renders when closed anyway — the panel's v-if gates on
  // `open` — so returning [] here is behavior-neutral.
  if (!props.open) return [];
  const networkId = props.buffer?.networkId;
  const isIgnored = networkId
    ? (nick: string, userhost: string | null) => ignores.isIgnored(networkId, nick, userhost ?? '')
    : null;
  return buildNickCandidates(props.buffer, props.selfNick, props.query, isIgnored)
    .slice(0, 50)
    .map((c, index) => ({
      nick: c.nick,
      lc: c.nick.toLowerCase(),
      recent: c.recent,
      index,
      color: nickColors.color(c.nick),
    }));
});

// The panel opens upward, so render candidates worst-to-best top-to-bottom —
// the most likely pick lands at the bottom, right under the user's eye and
// closest to the input bar.
const renderedRows = computed(() => rows.value.slice().reverse());

function pick(nick: string) {
  emit('select', nick);
}

// Stable per-row id for aria-activedescendant. Indexes the original
// candidate order, not the reversed render order, so the host's "active"
// pointer matches `activeIndex` directly.
function optionId(index: number): string {
  return `${props.listboxId}-opt-${index}`;
}

// Keyboard navigation, driven from MessageInput's textarea keydown handler:
// the textarea keeps focus while the picker is open, so the picker never
// receives key events itself. `delta` is in candidate-index space — +1 steps
// toward worse matches (visually up), -1 toward the best match (visually
// down) — and clamps at both ends rather than wrapping.
function moveActive(delta: number) {
  const n = rows.value.length;
  if (n === 0) return;
  activeIndex.value = Math.min(Math.max(activeIndex.value + delta, 0), n - 1);
  // Keyboard moves can land on a row scrolled out of the panel — pull it
  // back in. Mouse hover also sets activeIndex (see @mouseenter) but a
  // hovered row is necessarily already visible, so the scroll lives here
  // rather than in a blanket watch(activeIndex) that would also fire — as a
  // wasted no-op — on every cursor move across the list.
  nextTick(scrollActiveIntoView);
}

function confirmActive() {
  const row = rows.value[activeIndex.value];
  if (row) pick(row.nick);
}

function hasCandidates() {
  return rows.value.length > 0;
}

defineExpose({ moveActive, confirmActive, hasCandidates });

function scrollActiveIntoView() {
  const el = panelEl.value?.querySelector('.row.active');
  if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
}

function recomputePosition() {
  // Anchor the picker just above the input bar, riding above the iOS soft
  // keyboard via visualViewport.height. Without this, the picker gets
  // occluded as soon as the keyboard slides up.
  const anchor = props.anchor;
  if (!anchor) {
    panelBottom.value = 8;
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const vv = window.visualViewport;
  const viewportHeight = vv ? vv.height : window.innerHeight;
  // Distance from bottom of viewport to top of anchor.
  const distance = viewportHeight - rect.top;
  panelBottom.value = Math.max(distance + 4, 8);
}

const panelStyle = computed(() => ({ bottom: `${panelBottom.value}px` }));

function onDocPointerDown(e: PointerEvent) {
  if (!props.open) return;
  const panel = panelEl.value;
  const anchor = props.anchor;
  if (panel && panel.contains(e.target as Node)) return;
  if (anchor && anchor.contains(e.target as Node)) return;
  emit('close');
}

function onKey(e: KeyboardEvent) {
  if (!props.open) return;
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
// the highlight on the best match and pulls it back into view.
watch(rows, () => {
  activeIndex.value = 0;
  nextTick(scrollActiveIntoView);
});

watch(
  () => props.open,
  (v) => {
    if (v) {
      activeIndex.value = 0;
      recomputePosition();
      nextTick(scrollActiveIntoView);
    }
  },
);

// The id the host should expose via aria-activedescendant. Empty when the
// picker isn't actually showing anything (closed or no rows) so the host
// can clear the attribute and not point at a non-existent element.
const activeOptionId = computed(() =>
  props.open && rows.value.length > 0 ? optionId(activeIndex.value) : '',
);

watch(activeOptionId, (id) => emit('active-change', id), { immediate: true });
</script>

<style scoped>
.nick-picker {
  position: fixed;
  left: 8px;
  right: 8px;
  max-width: 480px;
  margin: 0 auto;
  max-height: 50vh;
  overflow-y: auto;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.4);
  z-index: 1000;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  min-height: 44px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.row:last-child {
  border-bottom: none;
}
/* Single highlight, shared by mouse and keyboard: hovering a row sets
   activeIndex (see @mouseenter), so .active alone covers both — no separate
   :hover rule that could double-highlight during keyboard nav. */
.row.active {
  background: var(--bg);
}
.nick {
  font-weight: 500;
}
.badge {
  font-size: 0.85em;
  color: var(--fg-muted);
  font-style: italic;
}
</style>
