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
// during typical app use. Capture-phase pointerdown so we catch the press
// before it can mutate state that the menu was anchored to (e.g. deselecting
// a row the menu was launched from). pointerdown — not mousedown — so the
// synthesized mousedown iOS Safari fires after touchend on a long-press
// (issue #8) doesn't reach this handler and close the menu we just opened:
// the original touch's pointerdown fires before the menu opens, and no
// pointerdown is synthesized from the touch release, so the menu stays put.
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
  z-index: 300;
  min-width: 140px;
  background: var(--bg);
  border: 1px solid var(--border);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
  font-size: 0.95em;
  color: var(--fg);
  user-select: none;
}
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.item:hover:not(:disabled) {
  background: var(--bg-soft);
}
.item:disabled {
  color: var(--fg-muted);
  cursor: default;
}
.icon {
  display: inline-flex;
  width: 14px;
  justify-content: center;
  color: var(--fg-muted);
}
.divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
</style>
