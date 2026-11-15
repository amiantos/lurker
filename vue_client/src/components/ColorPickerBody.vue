<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  The colour picker's controls, shell-agnostic: ColorPicker.vue wraps this in
  a floating card on desktop and an AppModal sheet on mobile, and owns the
  commit / revert semantics. This component only edits `modelValue`, which is
  the raw setting string — any CSS colour the row accepts today (hex, rgb(),
  var(--fg), color-mix()). The browser resolves it to sRGB for the sliders and
  the previews (resolveCssColor); the first slider move rewrites it as a lower-
  case #rrggbb literal. A value the browser can't resolve leaves the text field
  as the only live control.

  Top to bottom: old/new preview beside the text field; the saturation/value
  square and hue strip; the two pairings (the colour as text on the theme
  background, the theme text on the colour) with their contrast ratios;
  harmonies; the active theme's own colours; favourites (look.color.favorites),
  starred and unstarred with one button that acts on the CURRENT colour — to
  drop a favourite, pick it, then unstar it. No remove mode, no hover-only ×.
-->

<template>
  <div ref="rootEl" class="picker-body">
    <div class="top">
      <span class="preview" title="before / after">
        <span class="half" :style="{ background: initialCss }"></span>
        <span class="half" :style="{ background: currentCss }"></span>
      </span>
      <input
        class="raw"
        type="text"
        :value="modelValue"
        spellcheck="false"
        autocomplete="off"
        aria-label="color value"
        placeholder="#rrggbb or any CSS color"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
    </div>

    <div
      ref="squareEl"
      class="square"
      :class="{ disabled: !rgb }"
      :style="{ '--hue': `${Math.round(hsv.h)}` }"
      tabindex="0"
      role="slider"
      aria-label="saturation and brightness"
      :aria-valuetext="`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`"
      :aria-disabled="!rgb"
      @pointerdown="onSquareDown"
      @pointermove="onSquareMove"
      @pointerup="onSquareUp"
      @pointercancel="onSquareUp"
      @keydown="onSquareKey"
    >
      <span
        class="cursor"
        :style="{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: currentCss }"
      ></span>
    </div>
    <input
      class="hue"
      type="range"
      min="0"
      max="360"
      step="1"
      aria-label="hue"
      :value="Math.round(hsv.h)"
      :disabled="!rgb"
      @input="setHsv({ h: Number(($event.target as HTMLInputElement).value) })"
    />

    <template v-if="rgb">
      <div class="pairs">
        <span class="pair" :style="{ background: themeBgCss, color: currentCss }">
          <span>Aa text</span>
          <span class="ratio">{{ ratioOnBg }}</span>
        </span>
        <span class="pair" :style="{ background: currentCss, color: themeFgCss }">
          <span>Aa text</span>
          <span class="ratio">{{ ratioUnderFg }}</span>
        </span>
      </div>

      <div class="rowlab">harmony</div>
      <div class="swatches">
        <button
          v-for="sw in harmonyRow"
          :key="sw.hex"
          type="button"
          class="sw"
          :style="{ background: sw.hex }"
          :title="`${sw.label} ${sw.hex}`"
          :aria-label="`${sw.label} ${sw.hex}`"
          @click="emit('update:modelValue', sw.hex)"
        ></button>
      </div>
    </template>

    <div class="rowlab">
      theme
      <!-- One click, no mode: while the colour IS one of the theme's, offer
           the var() that names it, so the setting follows the theme colour
           instead of freezing its current value; while the value already is
           such a reference, offer the literal back. -->
      <button
        v-if="referenceSwap"
        type="button"
        class="link refswap"
        :title="referenceSwap.title"
        @click="emit('update:modelValue', referenceSwap.value)"
      >
        {{ referenceSwap.value }}
      </button>
    </div>
    <div class="swatches">
      <button
        v-for="sw in themeRow"
        :key="sw.key"
        type="button"
        class="sw"
        :class="{ picked: sw.hex === currentHex }"
        :style="{ background: sw.hex }"
        :title="sw.title"
        :aria-label="sw.title"
        @click="emit('update:modelValue', sw.hex)"
      ></button>
    </div>

    <div class="rowlab">
      favorites
      <button
        type="button"
        class="link star"
        :disabled="!currentHex"
        :title="isFavorite ? 'remove from favorites' : 'save to favorites'"
        :aria-pressed="isFavorite"
        @click="toggleFavorite"
      >
        <StarIcon :class="{ 'icon-filled': isFavorite }" />
      </button>
    </div>
    <div v-if="favorites.length" class="swatches">
      <button
        v-for="hex in favorites"
        :key="hex"
        type="button"
        class="sw"
        :class="{ picked: hex === currentHex }"
        :style="{ background: hex }"
        :title="hex"
        :aria-label="hex"
        @click="emit('update:modelValue', hex)"
      ></button>
    </div>
    <p v-else class="muted empty">Star a color to keep it here.</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { StarIcon } from '@lucide/vue';
import { useSettingsStore } from '../stores/settings.js';
import { COLOR_VARS } from '../composables/useTheme.js';
import { getOption } from '../../../shared/settingsRegistry.js';
import { contrastRatio, formatRatio, harmonies, hsvToRgb, rgbToHsv, toHex } from '../lib/color.js';
import type { HSV, RGB } from '../lib/color.js';
import { resolveCssColor } from '../lib/cssColor.js';

const FAVORITES_KEY = 'look.color.favorites';
const VAR_REF_RE = /^var\(\s*--[\w-]+\s*\)$/;

const props = defineProps<{
  modelValue: string;
  /** The value the picker opened with, for the before half of the preview. */
  initial: string;
  /** The registry key being edited, so the reference swap never names itself. */
  settingKey?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const settings = useSettingsStore();
const rootEl = ref<HTMLElement | null>(null);
const squareEl = ref<HTMLElement | null>(null);

// Resolution needs the DOM, so it lives in a ref refreshed by a watcher rather
// than a computed: a computed would run before mount with no host.
const rgb = ref<RGB | null>(null);
const themeBg = ref<RGB | null>(null);
const themeFg = ref<RGB | null>(null);

const hsv = reactive<HSV>({ h: 0, s: 0, v: 0 });
// The hex the sliders last wrote. The watcher below skips re-deriving hsv from
// it, so a slider drag doesn't fight the 8-bit rounding of its own output
// (h 200.4 → #… → h 200.1 → thumb twitch).
let sliderHex: string | null = null;

function refresh(): void {
  // An empty value (a colour that may be unset) starts from the text colour
  // it falls back to, so the square and strip work before anything is typed.
  rgb.value = resolveCssColor(props.modelValue.trim() || 'var(--fg)', rootEl.value);
  if (!rgb.value) return;
  const hex = toHex(rgb.value);
  if (hex === sliderHex) return;
  sliderHex = null;
  const next = rgbToHsv(rgb.value);
  // A grey carries no hue and black no saturation either; keep the strip where
  // the user left it instead of snapping to red.
  if (next.s > 0 && next.v > 0) hsv.h = next.h;
  if (next.v > 0) hsv.s = next.s;
  hsv.v = next.v;
}

onMounted(refresh);
watch(() => props.modelValue, refresh);

interface ThemeSwatch {
  key: string;
  cssVar: string;
  hex: string;
  title: string;
}
const themeRow = ref<ThemeSwatch[]>([]);
// Reference targets per hex: theme keys whose STORED value is a literal, minus
// the key being edited. A key holding a var() of its own is never a target —
// var(--link) where link is var(--accent) is one hop from a cycle, which the
// browser resolves to nothing at all — and the setting's own variable would
// point it at itself.
const referenceTargets = ref(new Map<string, ThemeSwatch>());

// The theme's colours go through the same probe, but only when the theme
// changes — never per keystroke or pointermove, which is what the draft
// watcher above runs on. Each probe is a forced style recalc, and the theme
// row alone is twenty of them.
function refreshTheme(): void {
  const host = rootEl.value;
  themeBg.value = resolveCssColor('var(--bg)', host);
  themeFg.value = resolveCssColor('var(--fg)', host);
  // One swatch per distinct colour the active look resolves to, labelled by
  // the first setting that produces it, so a theme whose link colour is
  // var(--fg) shows one foreground swatch, not two.
  const out: ThemeSwatch[] = [];
  const seen = new Set<string>();
  const targets = new Map<string, ThemeSwatch>();
  for (const [key, cssVar] of Object.entries(COLOR_VARS)) {
    const stored = String(settings.effective(key) ?? '');
    const resolved = resolveCssColor(stored, host);
    if (!resolved) continue;
    const hex = toHex(resolved);
    const sw: ThemeSwatch = { key, cssVar, hex, title: `${getOption(key)?.label ?? key} ${hex}` };
    if (!seen.has(hex)) {
      seen.add(hex);
      out.push(sw);
    }
    // Never a key that may be empty (the own-message colour): its variable
    // goes when it is cleared, and a reference to it would go blank with it.
    if (
      key !== props.settingKey &&
      getOption(key)?.default !== '' &&
      !VAR_REF_RE.test(stored.trim()) &&
      !targets.has(hex)
    ) {
      targets.set(hex, sw);
    }
  }
  themeRow.value = out;
  referenceTargets.value = targets;
}
const themeSignature = computed(() =>
  Object.keys(COLOR_VARS)
    .map((key) => String(settings.effective(key) ?? ''))
    .join('\n'),
);
onMounted(refreshTheme);
watch(themeSignature, refreshTheme);

const currentHex = computed(() => (rgb.value ? toHex(rgb.value) : ''));
// What the previews paint: the resolved literal when there is one, else the
// raw text — a broken value previews as transparent, which is honest.
const currentCss = computed(() => currentHex.value || props.modelValue);
const initialCss = computed(() => props.initial);
const themeBgCss = computed(() => (themeBg.value ? toHex(themeBg.value) : 'var(--bg)'));
const themeFgCss = computed(() => (themeFg.value ? toHex(themeFg.value) : 'var(--fg)'));

function setHsv(patch: Partial<HSV>): void {
  if (!rgb.value) return;
  Object.assign(hsv, patch);
  const hex = toHex(hsvToRgb(hsv));
  sliderHex = hex;
  emit('update:modelValue', hex);
}

// ─── saturation/value square ─────────────────────────────────────────────

let dragging = false;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
function squareFromEvent(e: PointerEvent): void {
  const el = squareEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const s = clamp01((e.clientX - r.left) / r.width);
  const v = 1 - clamp01((e.clientY - r.top) / r.height);
  setHsv({ s, v });
}
function onSquareDown(e: PointerEvent): void {
  if (!rgb.value) return;
  dragging = true;
  squareEl.value?.setPointerCapture(e.pointerId);
  squareEl.value?.focus();
  squareFromEvent(e);
  e.preventDefault();
}
function onSquareMove(e: PointerEvent): void {
  if (dragging) squareFromEvent(e);
}
function onSquareUp(e: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  squareEl.value?.releasePointerCapture(e.pointerId);
}
function onSquareKey(e: KeyboardEvent): void {
  if (!rgb.value) return;
  const step = e.shiftKey ? 0.1 : 0.01;
  switch (e.key) {
    case 'ArrowLeft':
      setHsv({ s: clamp01(hsv.s - step) });
      break;
    case 'ArrowRight':
      setHsv({ s: clamp01(hsv.s + step) });
      break;
    case 'ArrowUp':
      setHsv({ v: clamp01(hsv.v + step) });
      break;
    case 'ArrowDown':
      setHsv({ v: clamp01(hsv.v - step) });
      break;
    default:
      return;
  }
  e.preventDefault();
}

// ─── pairings + harmony ──────────────────────────────────────────────────

const ratioOnBg = computed(() =>
  rgb.value && themeBg.value ? formatRatio(contrastRatio(rgb.value, themeBg.value)) : '',
);
const ratioUnderFg = computed(() =>
  rgb.value && themeFg.value ? formatRatio(contrastRatio(rgb.value, themeFg.value)) : '',
);
const harmonyRow = computed(() => (rgb.value ? harmonies(rgb.value) : []));

// ─── theme colours ───────────────────────────────────────────────────────

// The swap button's target. A draft that already is a var() offers its
// resolved literal — the way out of a reference, including a self-reference
// typed into the field. Otherwise a draft matching a reference target (above)
// offers that target's var(). Any other colour: no button.
const referenceSwap = computed<{ value: string; title: string } | null>(() => {
  const hex = currentHex.value;
  if (!hex) return null;
  if (VAR_REF_RE.test(props.modelValue.trim())) {
    return { value: hex, title: 'Freeze the resolved color as a literal' };
  }
  const sw = referenceTargets.value.get(hex);
  if (!sw) return null;
  const label = getOption(sw.key)?.label ?? sw.key;
  return { value: `var(${sw.cssVar})`, title: `Follow the theme's ${label} color` };
});

// ─── favourites ──────────────────────────────────────────────────────────

// The stored list is also a plain textarea in Settings, so it can hold any
// casing, whitespace or duplicates. Display normalises and dedupes; the write
// below touches only the entry it is about and leaves the rest as typed.
const normalizeFavorite = (s: unknown) => String(s).trim().toLowerCase();
const storedFavorites = computed<string[]>(() => {
  const raw = settings.effective(FAVORITES_KEY);
  return Array.isArray(raw) ? raw.map(String) : [];
});
const favorites = computed<string[]>(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of storedFavorites.value) {
    const n = normalizeFavorite(entry);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
});
const isFavorite = computed(() => !!currentHex.value && favorites.value.includes(currentHex.value));

function toggleFavorite(): void {
  const hex = currentHex.value;
  if (!hex) return;
  const next = isFavorite.value
    ? storedFavorites.value.filter((f) => normalizeFavorite(f) !== hex)
    : [...storedFavorites.value, hex];
  // Fire and forget: the store writes nothing until the server answers, so a
  // refusal just leaves the star as it was. The picker has nowhere sensible
  // to print an error about a bookmark.
  void settings.setValue(FAVORITES_KEY, next).catch(() => {});
}
</script>

<style scoped>
.picker-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  /* The square's height; the mobile sheet widens it below. */
  --square-h: 150px;
}
.top {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.preview {
  flex: none;
  display: inline-flex;
  width: 2.4em;
  height: 1.6em;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.half {
  flex: 1;
}
.raw {
  flex: 1;
  min-width: 0;
}
.square {
  position: relative;
  height: var(--square-h);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  /* Value fades to black top→bottom over saturation fading from white to the
     pure hue left→right: the classic HSV square. --hue is set inline. */
  background:
    linear-gradient(to top, #000, rgba(0, 0, 0, 0)),
    linear-gradient(to right, #fff, hsl(var(--hue) 100% 50%));
  cursor: crosshair;
  touch-action: none;
  user-select: none;
}
.square.disabled {
  opacity: 0.35;
  cursor: default;
}
.square:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.cursor {
  position: absolute;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.hue {
  width: 100%;
  height: 14px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  appearance: none;
  -webkit-appearance: none;
  background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  cursor: pointer;
}
.hue:disabled {
  opacity: 0.35;
  cursor: default;
}
.hue:focus {
  border-color: var(--accent);
}
.hue::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 18px;
  border: 2px solid #fff;
  border-radius: var(--radius-sm);
  background: transparent;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
  cursor: ew-resize;
}
.hue::-moz-range-thumb {
  width: 6px;
  height: 14px;
  border: 2px solid #fff;
  border-radius: var(--radius-sm);
  background: transparent;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
  cursor: ew-resize;
}
.hue::-moz-range-track {
  background: transparent;
}
.pairs {
  display: flex;
  gap: var(--space-4);
}
.pair {
  flex: 1;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}
.ratio {
  font-variant-numeric: tabular-nums;
}
.rowlab {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-top: var(--space-2);
  color: var(--fg-muted);
  text-transform: lowercase;
}
.refswap {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  text-transform: none;
}
.refswap:hover {
  color: var(--fg);
}
.star {
  background: none;
  border: none;
  padding: 0 var(--space-2);
  color: var(--fg-muted);
  cursor: pointer;
  font-size: var(--icon-md);
  display: inline-flex;
}
.star:hover:not(:disabled),
.star[aria-pressed='true'] {
  color: var(--accent);
}
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.sw {
  width: 1.5em;
  height: 1.5em;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  touch-action: manipulation;
}
.sw:hover {
  outline: 1px solid var(--accent);
}
.sw.picked {
  outline: 2px solid var(--accent);
}
.sw:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.empty {
  margin: 0;
}
.muted {
  color: var(--fg-muted);
}

@media (max-width: 768px) {
  .picker-body {
    --square-h: 220px;
  }
  .sw {
    width: 2.2em;
    height: 2.2em;
  }
}
</style>
