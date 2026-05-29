<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <Teleport to="body">
    <div
      v-if="state.open"
      ref="menuEl"
      class="context-menu"
      :style="positionStyle"
      role="menu"
      @click.stop
      @contextmenu.prevent
    >
      <template v-for="(item, i) in state.items" :key="i">
        <div v-if="item.divider" class="divider" role="separator"></div>
        <button
          v-else
          type="button"
          class="item"
          role="menuitem"
          :disabled="item.disabled"
          @click="activate(item)"
        >
          <i v-if="item.icon" :class="['icon', item.icon]" aria-hidden="true"></i>
          <span class="label">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.js';

const menu = useContextMenu();
const { state } = menu;
const menuEl = ref<HTMLElement | null>(null);
// Position the panel from the raw cursor coords first; once mounted, measure
// actual size and clamp/flip so it stays in the viewport. Without the clamp,
// a right-click near the right/bottom edges would push the menu off-screen.
const clamped = ref({ x: 0, y: 0 });

const positionStyle = computed(() => ({
  left: `${clamped.value.x}px`,
  top: `${clamped.value.y}px`,
}));

watch(
  () => state.open,
  async (isOpen) => {
    if (!isOpen) return;
    clamped.value = { x: state.x, y: state.y };
    await nextTick();
    const el = menuEl.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 4;
    let x = state.x;
    let y = state.y;
    if (x + rect.width + pad > window.innerWidth) x = window.innerWidth - rect.width - pad;
    if (y + rect.height + pad > window.innerHeight) y = window.innerHeight - rect.height - pad;
    if (x < pad) x = pad;
    if (y < pad) y = pad;
    clamped.value = { x, y };
  },
);

function activate(item: ContextMenuItem): void {
  if (item.disabled) return;
  try {
    item.onClick?.();
  } finally {
    menu.close();
  }
}

function onWindowPointerDown(e: PointerEvent): void {
  if (!state.open) return;
  if (menuEl.value && menuEl.value.contains(e.target as Node)) return;
  // Re-clicking the same trigger should close (toggle behavior). Without
  // swallowing the event, the trigger's own @click handler runs next and
  // immediately reopens the menu on the same gesture.
  if (state.triggerEl && state.triggerEl.contains(e.target as Node)) {
    e.preventDefault();
    e.stopPropagation();
    menu.close();
    return;
  }
  menu.close();
}
function onWindowKey(e: KeyboardEvent): void {
  if (state.open && e.key === 'Escape') menu.close();
}
function onWindowResize(): void {
  if (state.open) menu.close();
}

// Attaching listeners only while open avoids paying for them on every scroll
// during typical app use. Capture-phase pointerdown — not mousedown — so the
// "tap a different message row" case still closes the menu on iOS: in the
// sticky-:hover mode that powers the row → dots → menu UX, a tap on a new
// row often doesn't synthesize a mousedown at the document level (iOS
// consumes that first tap to transfer the hover state), but a pointerdown
// always fires. Mouse and stylus paths land here too — pointerdown precedes
// mousedown for them with the same target and contains-checks behavior.
watch(
  () => state.open,
  (isOpen) => {
    if (isOpen) {
      window.addEventListener('pointerdown', onWindowPointerDown, true);
      window.addEventListener('keydown', onWindowKey);
      window.addEventListener('resize', onWindowResize);
      window.addEventListener('scroll', onWindowResize, true);
    } else {
      window.removeEventListener('pointerdown', onWindowPointerDown, true);
      window.removeEventListener('keydown', onWindowKey);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('scroll', onWindowResize, true);
    }
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown, true);
  window.removeEventListener('keydown', onWindowKey);
  window.removeEventListener('resize', onWindowResize);
  window.removeEventListener('scroll', onWindowResize, true);
});
</script>

<style scoped>
.context-menu {
  position: fixed;
  z-index: var(--z-menu);
  min-width: 160px;
  /* `width: auto` on a position:fixed element near the right edge gets
     shrink-wrapped to the available viewport space, which wraps long labels
     before the clamp watcher gets a chance to shift the menu left. `max-content`
     ignores the viewport constraint and sizes to the widest unwrapped item, so
     the clamp logic then sees the real width and repositions correctly. */
  width: max-content;
  /* --bg-soft elevates the menu visually above the page (which uses --bg) so
     the popup reads as a distinct surface without needing a visible border
     (--border resolves to --bg-soft in the default theme, so a plain border
     against page bg was invisible anyway). The drop shadow + the brighter
     surface together do the floating-layer job. */
  background: var(--bg-soft);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55);
  padding: 0;
  color: var(--fg);
  user-select: none;
}
.item {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  width: 100%;
  /* Asymmetric horizontal padding: more on the right so the label has
     breathing room from the menu edge — reads tight at 12px once the menu
     widens out for a long label. */
  padding: var(--space-4) var(--space-7) var(--space-4) var(--space-6);
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.item:hover:not(:disabled) {
  /* Stronger wash now that the surface beneath is --bg-soft rather than --bg,
     so the hover still reads against the elevated menu colour. */
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
.item:hover:not(:disabled) .icon {
  color: var(--accent);
}
.item:disabled {
  color: var(--fg-muted);
  cursor: default;
}
/* FontAwesome solid glyphs are biased toward the top of their em box (bell,
   thumbtack, etc. have visual weight near the top), so geometric centering
   reads as the icon sitting slightly high relative to the label's x-height.
   A 1px downward nudge optically aligns the icon body with the text. */
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex-shrink: 0;
  color: var(--fg-muted);
  transform: translateY(1px);
}
.divider {
  height: 1px;
  /* Use --bg as the divider colour now that the menu surface is --bg-soft —
     a 1px line in the page background colour cuts cleanly through the
     elevated surface. */
  background: var(--bg);
  margin: 0;
}
</style>
