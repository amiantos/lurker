<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Master list for the Settings shell. Two modes:

  - Browse (search empty): vertical list of categories. The active one is
    highlighted. Clicking navigates to /settings/:category.
  - Search (search non-empty): flat list of matching settings drawn from the
    registry, with a category-name breadcrumb. Match is case-insensitive
    substring on `label` (weight 3), `description` (weight 2), `key` (weight 1).
    Clicking navigates to the matching category and scrolls the row into view.

  Matching is intentionally simple — no fuzzy, no stemming. Power users typing
  `smart_filter` still land it via the key field; new users typing "highlight
  color" find it via the label/description.
-->

<template>
  <nav class="settings-sidebar" aria-label="settings sections">
    <div class="search-wrap">
      <input
        v-model="searchInput"
        type="search"
        class="search"
        placeholder="Search settings…"
        autocomplete="off"
        spellcheck="false"
        ref="searchEl"
      />
    </div>

    <!-- Browse mode: category list (desktop) or compact picker (mobile). -->
    <template v-if="!searchActive">
      <select
        class="mobile-picker"
        :value="activeCategoryId"
        @change="onPickCategory(($event.target as HTMLSelectElement).value)"
        aria-label="settings category"
      >
        <option v-for="cat in visibleCategories" :key="cat.id" :value="cat.id">
          {{ cat.label }}
        </option>
      </select>
      <template v-for="cat in visibleCategories" :key="cat.id">
        <RouterLink
          :to="{ name: 'settings', params: { category: cat.id } }"
          class="sidebar-link"
          :class="{ active: cat.id === activeCategoryId }"
          >{{ cat.label }}</RouterLink
        >
        <Transition name="sidebar-subnav">
          <nav
            v-if="
              cat.id === 'appearance' &&
              activeCategoryId === 'appearance' &&
              appearanceSubsections.length > 1
            "
            class="sidebar-subnav"
            aria-label="appearance subsections"
          >
            <RouterLink
              v-for="subsection in appearanceSubsections"
              :key="subsection.id"
              class="sidebar-sublink"
              :class="{ active: subsection.id === activeAppearanceSubsectionId }"
              :to="{
                name: 'settings',
                params: { category: 'appearance' },
                hash: `#${subsection.id}`,
              }"
              @click="$emit('selectAppearanceSubsection', subsection.id)"
            >
              {{ subsection.label }}
            </RouterLink>
          </nav>
        </Transition>
      </template>
    </template>

    <!-- Search mode: flat list of matching settings with breadcrumb. -->
    <template v-else>
      <button
        v-for="r in searchResults"
        :key="r.key"
        type="button"
        class="result"
        @click="onSelectResult(r)"
      >
        <span class="result-label">{{ r.label }}</span>
        <span class="result-breadcrumb">{{ r.categoryLabel }}</span>
        <code class="result-key">{{ r.key }}</code>
      </button>
      <p v-if="!searchResults.length" class="muted small no-match">No settings match.</p>
    </template>
  </nav>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import type { SettingCategory } from '../../../shared/settingsRegistry.js';
import { REGISTRY, CATEGORIES } from '../utils/settingsRegistry.js';

const props = defineProps<{
  activeCategoryId: string;
  visibleCategories: SettingCategory[];
  appearanceSubsections: SettingsSubsection[];
  activeAppearanceSubsectionId: string;
}>();

defineEmits<{
  selectAppearanceSubsection: [id: string];
}>();

interface SettingsSubsection {
  id: string;
  label: string;
}

const router = useRouter();
const searchInput = ref('');
const searchEl = ref<HTMLInputElement | null>(null);

const searchActive = computed(() => searchInput.value.trim().length > 0);

// Build the searchable index once: every registry entry, tagged with its
// resolved category label for breadcrumb display. Bespoke-only state (highlight
// rule lists, ignore masks, push subscriptions) is intentionally NOT searchable
// — that's list data, not settings.
const SEARCH_INDEX = REGISTRY.filter((opt) => CATEGORIES.some((c) => c.id === opt.category)).map(
  (opt) => {
    const cat = CATEGORIES.find((c) => c.id === opt.category);
    return {
      key: opt.key,
      label: opt.label || opt.key,
      description: opt.description || '',
      categoryId: opt.category,
      categoryLabel: cat?.label || opt.category,
    };
  },
);

const searchResults = computed(() => {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const row of SEARCH_INDEX) {
    let score = 0;
    if (row.label.toLowerCase().includes(q)) score = 3;
    else if (row.description.toLowerCase().includes(q)) score = 2;
    else if (row.key.toLowerCase().includes(q)) score = 1;
    if (score) out.push({ ...row, score });
  }
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out;
});

function onPickCategory(categoryId: string) {
  router.push({ name: 'settings', params: { category: categoryId } });
}

interface SearchResult {
  key: string;
  label: string;
  description: string;
  categoryId: string;
  categoryLabel: string;
  score: number;
}

function onSelectResult(r: SearchResult) {
  // Navigate to the result's category and use the URL hash to point at the
  // specific row. The Settings shell watches the hash and scrolls the matching
  // [data-setting-key] element into view after the pane mounts.
  router.push({
    name: 'settings',
    params: { category: r.categoryId },
    hash: `#${r.key}`,
  });
  // Clearing the search collapses the sidebar back to browse mode so the user
  // sees the destination category highlighted; the row scroll happens via the
  // hash watcher in the parent. Doing this after nextTick avoids a render
  // hiccup where results disappear before the route commits.
  nextTick(() => {
    searchInput.value = '';
  });
}

// Mobile/cramped sidebar: surface focus management so the user can clear and
// retype quickly. Autofocus on desktop only — focusing a search input on
// mobile pops the soft keyboard and steals layout space the user did not ask
// for.
watch(searchEl, (el) => {
  if (!el) return;
  if (window.matchMedia('(min-width: 720px)').matches) {
    el.focus();
  }
});
</script>

<style scoped>
.settings-sidebar {
  flex: 0 0 auto;
  width: 14em;
  border-right: 1px solid var(--border);
  padding: var(--space-4) 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.search-wrap {
  padding: var(--space-2) var(--space-6) var(--space-4);
}
.search {
  width: 100%;
  font: inherit;
  padding: var(--space-2) var(--space-3);
  line-height: 1.4;
}
.search:focus {
  outline: none;
  border-color: var(--accent);
}

.sidebar-link {
  color: var(--fg-muted);
  text-decoration: none;
  padding: var(--space-2) var(--space-7);
  text-transform: lowercase;
  letter-spacing: 0.04em;
  border-left: 2px solid transparent;
}
.sidebar-link:hover {
  color: var(--fg);
  background: var(--bg-soft);
}
.sidebar-link.active {
  color: var(--fg);
  background: var(--bg-soft);
  border-left-color: var(--accent);
}

.sidebar-subnav {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  margin-bottom: var(--space-2);
  max-height: 240px;
  overflow: hidden;
}
.sidebar-subnav-enter-active,
.sidebar-subnav-leave-active {
  transition:
    max-height 220ms ease-out,
    opacity 220ms ease;
}
.sidebar-subnav-enter-from,
.sidebar-subnav-leave-to {
  max-height: 0;
  opacity: 0;
}
.sidebar-sublink {
  color: var(--fg-muted);
  text-decoration: none;
  padding: var(--space-2) var(--space-7) var(--space-2) 30px;
  line-height: 1.35;
  text-transform: lowercase;
  letter-spacing: 0.03em;
  position: relative;
}
.sidebar-sublink::before {
  content: '';
  position: absolute;
  left: 18px;
  top: 0;
  height: 50%;
  width: 8px;
  border-left: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  pointer-events: none;
}
.sidebar-sublink:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 18px;
  top: 50%;
  bottom: 0;
  width: 0;
  border-left: 1px solid var(--border);
  pointer-events: none;
}
.sidebar-sublink:hover,
.sidebar-sublink.active {
  color: var(--fg);
  background: var(--bg-soft);
}

.result {
  background: none;
  border: none;
  border-left: 2px solid transparent;
  text-align: left;
  font: inherit;
  cursor: pointer;
  padding: var(--space-3) var(--space-7);
  display: flex;
  flex-direction: column;
  gap: 1px;
  color: var(--fg);
}
.result:hover {
  background: var(--bg-soft);
  border-left-color: var(--accent);
}
.result-label {
  font-weight: 600;
}
.result-breadcrumb {
  color: var(--fg-muted);
  text-transform: lowercase;
  letter-spacing: 0.04em;
}
.result-key {
  color: var(--fg-muted);
  background: var(--bg-soft);
  padding: 0 var(--space-2);
  align-self: flex-start;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.no-match {
  color: var(--fg-muted);
  padding: var(--space-4) var(--space-7);
}

/* The compact picker is mobile-only — the full vertical list of RouterLinks
   gives a better at-a-glance overview when there's horizontal room. */
.mobile-picker {
  display: none;
}

@media (max-width: 720px) {
  .settings-sidebar {
    flex-direction: column;
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .mobile-picker {
    display: block;
    width: calc(100% - 24px);
    margin: 0 var(--space-6) var(--space-4);
    font: inherit;
    /* Strip the native dropdown chrome so the select sizes identically to the
       search input above (UA select styling otherwise trims its vertical
       size below an <input>'s, even with the same padding/border). */
    appearance: none;
    -webkit-appearance: none;
    padding: var(--space-2) var(--space-9) var(--space-2) var(--space-3);
    line-height: 1.4;
    /* Inline SVG chevron replaces the now-stripped native arrow so the user
       still has a visual "I can tap this" cue. Color follows --fg-muted. */
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23939293' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    background-size: 10px 6px;
  }
  .sidebar-link {
    display: none;
  }
  .sidebar-subnav {
    display: none;
  }
}
</style>
