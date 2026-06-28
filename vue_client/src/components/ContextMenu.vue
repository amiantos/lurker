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
  // Leave a pointerdown on the opening trigger alone: its own click handler
  // fires next and re-calls open() with the same triggerEl, which toggles the
  // menu closed (see useContextMenu). Closing here would race that click and
  // reopen the menu — pointerdown can't cancel the click that follows.
  if (state.triggerEl && state.triggerEl.contains(e.target as Node)) return;
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
  /* Same floating-card chrome as the per-message action bar (.row-actions in
     MessageList.vue): a --bg surface with a real 1px border, rounded corners,
     and the lighter drop shadow — so both popups read as the same family of
     floating surface. The vertical padding gives the list breathing room above
     the first row and below the last; the small horizontal padding insets the
     rounded item-hover chips from the card edge (Slack-style roomy menu). */
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  padding: var(--space-2) var(--space-1);
  color: var(--fg);
  user-select: none;
}
.item {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  width: 100%;
  /* Roomy padding (Slack-style), kept asymmetric — more on the right so the
     label has trailing breathing room from the menu edge. */
  padding: var(--space-4) var(--space-10) var(--space-4) var(--space-7);
  background: none;
  border: none;
  /* Round the hover/focus fill into a chip inset within the padded card,
     matching the action bar's rounded row buttons. */
  border-radius: var(--radius-sm);
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.item:hover:not(:disabled) {
  /* Neutral --bg-soft fill on hover, matching the action bar's row buttons:
     the row quiets to a soft background and the icon (below) pops to accent,
     rather than washing the whole row in accent. */
  background: var(--bg-soft);
}
.item:hover:not(:disabled) .icon {
  /* Brighten the muted icon to --fg on hover, matching the action bar's row
     buttons — accent is reserved for active/on states, not plain hover. */
  color: var(--fg);
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
  /* --border cuts a clean line through the --bg card surface (the old --bg
     divider would now vanish into the matching background). The vertical margin
     sets the rule apart from the rows above and below it (e.g. between Mute
     Channel and Close Channel) rather than letting them sit flush against it. */
  background: var(--border);
  margin: var(--space-2) 0;
}
</style>
