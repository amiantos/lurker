<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Standard modal shell for Lurker. Renders a centered card over a
  configurable backdrop (look.modal.overlay, desktop only): the tiled-word
  wallpaper (a quirk borrowed from Postalgic, the default), a dimmed scrim,
  or nothing at all. Callers pass a `word` for the wallpaper and provide
  content via slots:
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
    :class="`overlay-${overlayStyle}`"
    tabindex="-1"
    ref="modalEl"
    @keydown.esc="$emit('close')"
  >
    <WordBackdrop v-if="overlayStyle === 'wordmark'" :word="backdropWord" />

    <div
      class="card"
      :class="[`size-${size}`, { 'fill-height': fillHeight }]"
      tabindex="-1"
      ref="cardEl"
    >
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
import { useSettingsStore } from '../stores/settings.js';
import { useViewport } from '../composables/useViewport.js';

const props = withDefaults(
  defineProps<{
    word?: string;
    title?: string;
    size?: string;
    closeTitle?: string;
    // Pin the card to full height on desktop (mobile is already a full sheet),
    // so content changes — e.g. a filtering list — don't resize the modal.
    fillHeight?: boolean;
  }>(),
  {
    word: '',
    title: '',
    size: 'lg',
    closeTitle: 'close',
    fillHeight: false,
  },
);

defineEmits<{ close: [] }>();

const modalEl = ref<HTMLElement | null>(null);
const cardEl = ref<HTMLElement | null>(null);

const settings = useSettingsStore();
const { isMobile } = useViewport();

// Known backdrop styles, coupled to the .overlay-* CSS rules below and to
// look.modal.overlay's choices. Writes are validated against the registry, but
// a stale value (a future-removed choice, a manual DB edit) would otherwise
// render an overlay-* class with no matching CSS — so clamp reads to this set.
const OVERLAY_STYLES = ['wordmark', 'dimmed', 'clear'] as const;
type OverlayStyle = (typeof OVERLAY_STYLES)[number];

// Backdrop style (look.modal.overlay): wordmark | dimmed | clear. Desktop-only —
// on mobile every modal is a full-frame opaque sheet, so we always render the
// wordmark wallpaper there regardless of the stored setting.
const overlayStyle = computed<OverlayStyle>(() => {
  if (isMobile.value) return 'wordmark';
  const raw = String(settings.effective('look.modal.overlay') || '');
  return (OVERLAY_STYLES as readonly string[]).includes(raw) ? (raw as OverlayStyle) : 'wordmark';
});

// Fall back to the title when the caller didn't supply an explicit word,
// so the wallpaper always says *something* even for one-off modals.
const backdropWord = computed(() => (props.word || props.title || '').trim());

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
  display: flex;
  justify-content: center;
  /* Every modal centers vertically — one positioning rule, no center/top split.
     Scrollable "browser" modals stay put while filtering by locking their
     height (.fill-height) rather than top-anchoring, so a filtering list never
     shifts the header and an empty list reads as a stable centered card instead
     of being stranded at the top. */
  align-items: center;
  z-index: var(--z-modal);
  overflow: hidden;
  outline: none;
}

/* Backdrop variants (look.modal.overlay). Desktop-only — the script forces
   `wordmark` on mobile, so on phone-sized viewports the modal is always the
   opaque full-frame sheet below. */
.modal.overlay-wordmark {
  /* Opaque page-colored wallpaper behind the tiled WordBackdrop. */
  background: var(--bg);
}
.modal.overlay-dimmed {
  /* Translucent scrim over the live app — same backdrop as the quick switcher,
     so the chat stays visible (just darkened) behind the card. */
  background: var(--scrim);
}
.modal.overlay-clear {
  /* App fully visible behind; the card stands on its border + shadow alone. */
  background: transparent;
}

.card {
  position: relative;
  width: min(720px, 92vw);
  /* dvh, not vh — see the note on .modal above. */
  max-height: 85dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  /* Same floating-surface chrome as the context menu / action bar / Cmd-K:
     a subtle --border (not the old loud --accent), a hair of radius, and the
     shared drop shadow — so a dialog reads as the same family of surface, just
     larger. The card floats on the tiled WordBackdrop rather than being welded
     to it by an accent frame. */
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  /* Card horizontal padding lives in a custom property so scrolling
     children can break out with margin: 0 calc(-1 * var(--card-pad-x))
     and have their scrollbar sit against the card border. */
  --card-pad-x: var(--space-9);
  padding: var(--space-9) var(--card-pad-x);
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

/* On mobile every modal is a full-frame sheet. Placed AFTER the .card.size-*
   widths on purpose: the overrides share their specificity, so they have to
   come later in source order to win — otherwise the size-specific 92vw widths
   leave a left/right margin. The card fills the viewport edge-to-edge. */
@media (max-width: 768px) {
  .modal {
    align-items: stretch;
    /* Full-frame — no wallpaper sliver, and the card drops its border/radius
       below (see the .card overrides). */
    padding: 0;
  }
  .card,
  .card.size-sm,
  .card.size-md,
  .card.size-lg,
  .card.size-xl {
    width: 100%;
    max-height: none;
    height: 100%;
    border: none;
    border-radius: 0;
  }
}

/* Pin to full height on desktop so content changes (e.g. a filtering list)
   don't resize the modal. */
@media (min-width: 769px) {
  .card.fill-height {
    height: 85dvh;
  }
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-6);
  /* Compact header bar. Tightened now that the title is base-size — it used to
     hold the clamp() giant title, which needed the extra room above the rule. */
  padding: 0 0 var(--space-5);
  margin-bottom: var(--space-6);
  border-bottom: 1px solid var(--border);
}
.title-wrap {
  min-width: 0;
  flex: 1;
}
.title-wrap :slotted(h2),
.title-wrap h2 {
  margin: 0;
  /* No font-size override — the title inherits the user's base size like every
     other piece of text (the one-font-size rule; this retires the last
     clamp() exception). De-bolded too: accent color alone marks it as the
     title. Hierarchy comes from the accent color + position (alone atop the
     card, above the divider rule), not size or weight. */
  color: var(--accent);
  font-weight: var(--font-weight);
  text-transform: lowercase;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.subtitle {
  margin: var(--space-4) 0 0;
  color: var(--fg-muted);
}
.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-shrink: 0;
}
.close-btn {
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
.close-btn:hover {
  color: var(--accent);
}
</style>
