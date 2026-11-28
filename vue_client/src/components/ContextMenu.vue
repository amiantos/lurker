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
        <div v-else-if="item.heading" class="heading" role="presentation">{{ item.heading }}</div>
        <div v-else-if="item.note" class="note" role="note">{{ item.note }}</div>
        <button
          v-else
          type="button"
          class="item"
          role="menuitem"
          :disabled="item.disabled"
          @click="activate(item)"
        >
          <span v-if="item.icon" class="icon"><component :is="item.icon" /></span>
          <span class="label">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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

// On touch, the tap that dismisses the menu does nothing else (#1492): without
// this the same tap's click reaches whatever is under the finger, so tapping a
// second message closed one menu and opened the next, and there was no way to
// just get rid of it. Cancelling the touchend is what stops the browser from
// synthesizing the mousedown/click (and the focus that rides on them); a click
// listener would be too late for the focus. A drag ends in a touchend that
// can't be cancelled and has no click behind it, so scrolling is unaffected.
// Mouse and pen never arm this: a click outside acts as it always has.
let swallowTap = false;

function onWindowPointerDown(e: PointerEvent): void {
  // A new gesture: whatever the last one armed is stale. Its touchend can go
  // missing (the touched node left the DOM mid-press, so the event never
  // reached window), and the swallow must not wait for some later tap.
  swallowTap = false;
  if (!state.open) return;
  if (menuEl.value && menuEl.value.contains(e.target as Node)) return;
  if (e.pointerType === 'touch') {
    // The opening trigger is not spared: a message's trigger is its whole row,
    // and the nicks, links and chips inside it act on their own click.
    menu.close();
    swallowTap = true;
    return;
  }
  // Leave a pointerdown on the opening trigger alone: its own click handler
  // fires next and re-calls open() with the same triggerEl, which toggles the
  // menu closed (see useContextMenu). Closing here would race that click and
  // reopen the menu — a mouse pointerdown can't cancel the click that follows.
  if (state.triggerEl && state.triggerEl.contains(e.target as Node)) return;
  menu.close();
}
function onWindowTouchEnd(e: TouchEvent): void {
  if (!swallowTap) return;
  swallowTap = false;
  if (e.type === 'touchend' && e.cancelable) e.preventDefault();
}
function onWindowKey(e: KeyboardEvent): void {
  if (state.open && e.key === 'Escape') menu.close();
}
// Close on a user-driven scroll gesture (wheel / touch drag) — the menu is
// pinned to fixed cursor/anchor coords, so once the user scrolls the content
// underneath it, it would float detached. We deliberately listen for the
// *gesture* (wheel/touchmove), NOT the 'scroll' event: a busy channel's
// auto-scroll on each new message fires 'scroll' programmatically and would
// otherwise slam the menu shut mid-interaction. A gesture that starts inside the
// menu itself (e.g. scrolling a long menu) is ignored.
function onWindowUserScroll(e: Event): void {
  if (!state.open) return;
  // e.target on a captured wheel/touchmove is normally the element under the
  // pointer, but guard the non-Node case (window/document) so contains() can't
  // throw. A non-Node target is never inside the menu, so fall through to close.
  const t = e.target;
  if (t instanceof Node && menuEl.value?.contains(t)) return;
  menu.close();
}
function onWindowResize(): void {
  if (state.open) menu.close();
}

// The scroll, key and resize listeners attach only while open, which avoids
// paying for them on every scroll during typical app use. The pointerdown and
// touch-end ones stay for the component's life: the swallow outlives the menu
// it closed, and WebKit settles whether a touchend can be cancelled when the
// touch starts, so a listener added mid-gesture may come too late.
// Capture-phase pointerdown — not mousedown — so the
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
      window.addEventListener('keydown', onWindowKey);
      window.addEventListener('resize', onWindowResize);
      window.addEventListener('wheel', onWindowUserScroll, { capture: true, passive: true });
      window.addEventListener('touchmove', onWindowUserScroll, { capture: true, passive: true });
    } else {
      window.removeEventListener('keydown', onWindowKey);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('wheel', onWindowUserScroll, true);
      window.removeEventListener('touchmove', onWindowUserScroll, true);
    }
  },
);

onMounted(() => {
  window.addEventListener('pointerdown', onWindowPointerDown, true);
  window.addEventListener('touchend', onWindowTouchEnd, { capture: true, passive: false });
  window.addEventListener('touchcancel', onWindowTouchEnd, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown, true);
  window.removeEventListener('touchend', onWindowTouchEnd, true);
  window.removeEventListener('touchcancel', onWindowTouchEnd, true);
  window.removeEventListener('keydown', onWindowKey);
  window.removeEventListener('resize', onWindowResize);
  window.removeEventListener('wheel', onWindowUserScroll, true);
  window.removeEventListener('touchmove', onWindowUserScroll, true);
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
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-size);
  flex-shrink: 0;
  color: var(--fg-muted);
}
.heading {
  /* A muted group label above a radio group (e.g. "Notifications"). Uppercased
     with letter-spacing so it reads as a header without changing font-size (the
     app keeps a single type size — hierarchy comes from color/weight/spacing). */
  padding: var(--space-3) var(--space-7) var(--space-2);
  color: var(--fg-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  user-select: none;
}
.note {
  padding: var(--space-2) var(--space-7) var(--space-3);
  color: var(--fg-muted);
  font-style: italic;
  user-select: none;
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
