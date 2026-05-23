<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Settings shell: master/detail layout with a category sidebar on the left
  and one pane component on the right. The active category comes from the
  route param (/settings/:category) and falls back to the first non-admin
  category in CATEGORIES.

  Each category maps to either a dedicated bespoke pane (NotificationsPane,
  HighlightsPane, …) or the generic RegistryPane for registry-only ones.
  The shell stays thin: it owns navigation and category routing. Everything
  else lives in the pane components.
-->

<template>
  <div class="settings-page">
    <header class="bar">
      <RouterLink to="/" class="back">← back</RouterLink>
      <h1>settings</h1>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="body">
      <SettingsSidebar
        :active-category-id="activeCategoryId"
        :visible-categories="visibleCategories"
      />

      <main class="content" ref="contentEl">
        <component
          v-if="activePaneComponent"
          :is="activePaneComponent"
          :category-id="activeCategoryId"
        />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import type { Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSettingsStore } from '../stores/settings.js';
import { useAuthStore } from '../stores/auth.js';
import { useSocket } from '../composables/useSocket.js';
import { CATEGORIES } from '../utils/settingsRegistry.js';
import SettingsSidebar from '../components/SettingsSidebar.vue';
import RegistryPane from '../components/settings-panes/RegistryPane.vue';
import NotificationsPane from '../components/settings-panes/NotificationsPane.vue';
import HighlightsPane from '../components/settings-panes/HighlightsPane.vue';
import IgnoresPane from '../components/settings-panes/IgnoresPane.vue';
import UsersPane from '../components/settings-panes/UsersPane.vue';
import NetworksPane from '../components/settings-panes/NetworksPane.vue';
import AccountPane from '../components/settings-panes/AccountPane.vue';
import ApiTokensPane from '../components/settings-panes/ApiTokensPane.vue';
import DataPane from '../components/settings-panes/DataPane.vue';
import AboutPane from '../components/settings-panes/AboutPane.vue';

useSocket();

const settings = useSettingsStore();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const isAdmin = computed(() => auth.user?.role === 'admin');
const error = ref('');

// One component per bespoke category. Registry-driven categories all share
// RegistryPane and pick out their items by `categoryId` prop.
const BESPOKE_PANES: Record<string, Component> = {
  notifications: NotificationsPane,
  highlights: HighlightsPane,
  ignores: IgnoresPane,
  users: UsersPane,
  networks: NetworksPane,
  account: AccountPane,
  'api-tokens': ApiTokensPane,
  data: DataPane,
  about: AboutPane,
};

const visibleCategories = computed(() => CATEGORIES.filter((c) => !c.adminOnly || isAdmin.value));

const firstCategoryId = computed(() => visibleCategories.value[0]?.id || 'appearance');

const activeCategoryId = computed((): string => {
  const param = route.params.category;
  const id = Array.isArray(param) ? param[0] : param;
  if (id && visibleCategories.value.some((c) => c.id === id)) return id;
  return firstCategoryId.value;
});

const activePaneComponent = computed(() => {
  const cat = visibleCategories.value.find((c) => c.id === activeCategoryId.value);
  if (!cat) return null;
  if (cat.kind === 'bespoke') return BESPOKE_PANES[cat.id] || null;
  return RegistryPane;
});

// Redirect bare /settings (or /settings/<unknown>) to the canonical first
// category so the URL always names the visible pane. Mirrors the macOS-Settings
// behavior: closing and re-opening lands you somewhere concrete, not on a
// blank screen.
watch(
  [() => route.params.category, activeCategoryId, isAdmin],
  ([param, active], _old, onCleanup) => {
    if (!auth.checked) return;
    if (param !== active) {
      router.replace({ name: 'settings', params: { category: active } });
    }
    onCleanup(() => {});
  },
  { immediate: true },
);

const contentEl = ref<HTMLElement | null>(null);

onMounted(() => {
  if (!settings.loaded) {
    settings.fetchAll().catch((e) => {
      error.value = e.message;
    });
  }
});

// Switching panels swaps the pane component inside the same scrolling
// .content container, so the previous pane's scrollTop carries over to the
// new one — leaving long panes (Appearance, Notifications) scrolled into
// their middle when first revealed. Snap to the top on every category change,
// unless the route carries a hash (the hash watcher below will scroll the
// targeted row into view itself).
watch(activeCategoryId, async () => {
  await nextTick();
  if (route.hash) return;
  const root = contentEl.value;
  if (root) root.scrollTop = 0;
});

// Search-results in the sidebar route to /settings/<cat>#<setting.key>. When
// the hash changes (or the route resolves with a hash), find the row tagged
// with [data-setting-key="<key>"] inside the active pane and scroll it into
// view. Two ticks of nextTick let the pane swap and finish its initial render.
watch(
  [() => route.params.category, () => route.hash],
  async ([, hash]) => {
    if (!hash) return;
    await nextTick();
    await nextTick();
    const target = hash.startsWith('#') ? hash.slice(1) : hash;
    const root = contentEl.value;
    if (!root) return;
    const el = root.querySelector(`[data-setting-key="${CSS.escape(target)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash-target');
      setTimeout(() => el.classList.remove('flash-target'), 1400);
    }
  },
  { immediate: true },
);
</script>

<style scoped>
.settings-page {
  /* See issue #85: previous `position: fixed + transform: translateY`
     workaround caused visible jank and was removed. iOS scrolls the
     page naturally when an input is focused; fields above the
     auto-scroll point may end up offscreen above. */
  height: 100dvh;
  display: flex;
  flex-direction: column;
}

/* ── Top bar ──────────────────────────────────────────────────────── */
/* Matches MobileChat.vue's .bar so the height/padding feel consistent with
   the channel list / buffer screens when navigating between them. */
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
  /* Anchor for the absolutely-positioned title so it can centre across the
     full bar width rather than within the space leftover after the back link. */
  position: relative;
}
.bar h1 {
  /* Float over the flex row so "settings" sits dead centre regardless of the
     back link's text width. pointer-events: none keeps the back link clickable
     where the two visually overlap.

     Desktop: start at the sidebar's right edge and cap at the pane's readable
     column (70ch + 16px padding on each side) so the title centres directly
     over the settings rows below, not over the full viewport.
     Mobile (below): override back to a full-width span — there's no sidebar
     to offset for. */
  position: absolute;
  left: 14em;
  right: 0;
  margin: 0;
  padding: 0 16px;
  max-width: calc(70ch + 32px);
  text-align: center;
  pointer-events: none;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: inherit;
  font-weight: 600;
}
@media (max-width: 720px) {
  .bar h1 {
    left: 0;
    padding: 0;
    max-width: none;
  }
}
.bar .back {
  color: var(--accent);
  text-decoration: none;
  /* MobileChat's .bar gets its 57px height from the 36px-tall icon buttons.
     Mirror that on the back link so Settings doesn't collapse to ~43px. */
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 0 4px;
}
.bar .back:hover {
  color: var(--fg);
}

.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 2px 6px;
  cursor: pointer;
  font: inherit;
}
.link:hover:not(:disabled) {
  color: var(--fg);
}
.link:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.link.danger {
  color: var(--bad);
}

.error {
  color: var(--bad);
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  margin: 0;
}

/* ── Body: sidebar + scrolling content ───────────────────────────── */
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
@media (max-width: 720px) {
  .body {
    flex-direction: column;
  }
}

/* Brief highlight applied to a row that the user jumped to via search, so
   it's visually located within the dense pane. */
.content :deep(.flash-target) {
  animation: flash-target 1.4s ease-out;
}
@keyframes flash-target {
  0% {
    background: var(--bg-soft);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  100% {
    background: transparent;
    box-shadow: inset 0 0 0 1px transparent;
  }
}
</style>
