<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Standard modal shell for Lurker. Renders the tiled-word backdrop
  (a quirk borrowed from Postalgic) and a centered card. Callers pass
  a `word` for the backdrop and provide content via slots:
    - default slot: body
    - `title` slot or `title` prop: header label
    - `subtitle` slot: smaller text under the title
    - `actions` slot: extra header buttons (left of the close button)
    - `head` slot: replaces the entire header (escape hatch for the
       search bar that lives inside the head)
-->

<template>
  <div
    class="modal"
    :class="[`align-${align}`]"
    tabindex="-1"
    ref="modalEl"
    @click.self="onBackdropClick"
    @keydown.esc="$emit('close')"
  >
    <WordBackdrop :word="backdropWord" />

    <div class="card" :class="[`size-${size}`]" tabindex="-1" ref="cardEl">
      <slot name="head">
        <header v-if="title || $slots.title || $slots.subtitle || $slots.actions" class="head">
          <div class="title-wrap">
            <slot name="title">
              <h2 v-if="title">{{ title }}</h2>
            </slot>
            <p v-if="$slots.subtitle" class="subtitle"><slot name="subtitle" /></p>
          </div>
          <div class="head-actions">
            <slot name="actions" />
            <button
              class="link close-btn"
              type="button"
              :title="closeTitle"
              @click="$emit('close')"
            >
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        </header>
      </slot>
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import WordBackdrop from './WordBackdrop.vue';

const props = withDefaults(
  defineProps<{
    word?: string;
    title?: string;
    size?: string;
    align?: string;
    closeOnBackdrop?: boolean;
    closeTitle?: string;
  }>(),
  {
    word: '',
    title: '',
    size: 'lg',
    align: 'center',
    closeOnBackdrop: true,
    closeTitle: 'close',
  },
);

const emit = defineEmits<{ close: [] }>();

const modalEl = ref<HTMLElement | null>(null);
const cardEl = ref<HTMLElement | null>(null);

// Fall back to the title when the caller didn't supply an explicit word,
// so the wallpaper always says *something* even for one-off modals.
const backdropWord = computed(() => (props.word || props.title || '').trim());

function onBackdropClick() {
  if (props.closeOnBackdrop) emit('close');
}

onMounted(() => {
  // Focus the modal root so esc keydown gets caught even when the body
  // has no inherently focusable element. Children that focus an input
  // themselves still take precedence.
  modalEl.value?.focus();
});
</script>

<style scoped>
.modal {
  /* Overlay the page, sized to the dynamic viewport. See issue #85:
     previous `transform: translateY(--viewport-y)` workaround was
     removed because it caused visible jank. */
  position: fixed;
  inset: 0;
  height: 100dvh;
  background: var(--bg);
  display: flex;
  justify-content: center;
  z-index: 100;
  overflow: hidden;
  outline: none;
}
.modal.align-center {
  align-items: center;
}
.modal.align-top {
  align-items: flex-start;
  padding-top: 2dvh;
}
/* Match the 2dvh top so a fully-tall card has equal breathing room
   above and below. Default .card max-height: 85dvh would otherwise
   leave a ~13dvh gap at the bottom. dvh (dynamic viewport height)
   tracks the visible area as the iPad URL bar collapses; plain vh
   would lock to the layout viewport and overflow. */
.modal.align-top .card {
  max-height: 96dvh;
}

/* On mobile every modal becomes a full-screen sheet — the card fills the
   viewport so the title is glued to the top and the body extends to the
   bottom. Vertical centering reads as "off-center" when the card already
   takes ~92vw of horizontal space. */
@media (max-width: 768px) {
  .modal,
  .modal.align-top {
    align-items: stretch;
    padding: 16px;
  }
  .card,
  .card.size-sm,
  .card.size-md,
  .card.size-lg,
  .card.size-xl {
    width: 100%;
    max-height: none;
    height: 100%;
  }
}

.card {
  position: relative;
  width: min(720px, 92vw);
  /* dvh, not vh — see the note on .modal above. */
  max-height: 85dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--accent);
  /* Card horizontal padding lives in a custom property so scrolling
     children can break out with margin: 0 calc(-1 * var(--card-pad-x))
     and have their scrollbar sit against the card border. */
  --card-pad-x: 28px;
  padding: 24px var(--card-pad-x);
  outline: none;
}
.card.size-sm {
  width: min(520px, 92vw);
}
.card.size-md {
  width: min(640px, 92vw);
}
.card.size-lg {
  width: min(720px, 92vw);
}
.card.size-xl {
  width: min(900px, 92vw);
}

.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  padding: 0 0 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.title-wrap {
  min-width: 0;
  flex: 1;
}
.title-wrap :slotted(h2),
.title-wrap h2 {
  margin: 0;
  color: var(--accent);
  font-weight: 700;
  text-transform: lowercase;
  font-size: clamp(2rem, 4.5vw, 3rem);
  /* Needs headroom for descenders (g/y/p) — line-height: 1 clips them
     because the h2 itself has overflow: hidden for the ellipsis. */
  line-height: 1.15;
  letter-spacing: -0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.subtitle {
  margin: 8px 0 0;
  color: var(--fg-muted);
  font-size: 0.9em;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.close-btn {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  font-size: 1.2em;
  padding: 4px 8px;
}
.close-btn:hover {
  color: var(--accent);
}
</style>
