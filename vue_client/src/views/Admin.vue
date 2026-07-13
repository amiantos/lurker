<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Admin panel shell (Milestone 4): a dedicated, admin-only surface for instance
  administration, kept deliberately separate from the per-user Settings pane.
  Master/detail layout — an AdminSidebar of tabs on the left, one pane component
  on the right — mirroring Settings.vue but simpler (no search, no scroll-spy).

  The active tab comes from the route param (/admin/:tab) and falls back to the
  first tab. Admin-gated by the router guard (router.ts), which redirects anyone
  else to /settings, so this shell assumes it is only ever mounted for an admin.
-->

<template>
  <div class="admin-page">
    <header class="bar">
      <RouterLink to="/" class="back">← back</RouterLink>
      <h1>admin</h1>
    </header>

    <div class="body">
      <AdminSidebar :active-tab-id="activeTabId" />

      <main class="content" ref="contentEl">
        <component v-if="activePaneComponent" :is="activePaneComponent" />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import type { Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSocket } from '../composables/useSocket.js';
import { DEFAULT_ADMIN_TAB, isAdminTab } from '../utils/adminRegistry.js';
import AdminSidebar from '../components/AdminSidebar.vue';
import UsersPane from '../components/admin-panes/UsersPane.vue';
import InvitesPane from '../components/admin-panes/InvitesPane.vue';
import UploadersPane from '../components/admin-panes/UploadersPane.vue';
import NetworksPane from '../components/admin-panes/NetworksPane.vue';

useSocket();

const route = useRoute();
const router = useRouter();

// One component per admin tab, keyed by the tab id from adminRegistry.
const PANES: Record<string, Component> = {
  users: UsersPane,
  invites: InvitesPane,
  uploaders: UploadersPane,
  networks: NetworksPane,
};

const activeTabId = computed((): string => {
  const param = route.params.tab;
  const id = Array.isArray(param) ? param[0] : param;
  return isAdminTab(id) ? id : DEFAULT_ADMIN_TAB;
});

const activePaneComponent = computed(() => PANES[activeTabId.value] || null);

// Redirect bare /admin (or /admin/<unknown>) to the canonical first tab so the
// URL always names the visible pane — same behavior as the Settings shell.
watch(
  [() => route.params.tab, activeTabId],
  ([param, active]) => {
    if (param !== active) {
      // Best-effort: a redirected/duplicated navigation (e.g. the route guard
      // resolving the same target concurrently) rejects; swallow it like the
      // other navigation call sites rather than surfacing an unhandled rejection.
      router.replace({ name: 'admin', params: { tab: active } }).catch(() => {});
    }
  },
  { immediate: true },
);

// Switching tabs swaps the pane inside the same scroller, so a long pane's
// scrollTop can carry over. Snap to top on every tab change.
const contentEl = ref<HTMLElement | null>(null);
watch(activeTabId, async () => {
  await nextTick();
  const root = contentEl.value;
  if (root) root.scrollTop = 0;
});
</script>

<style scoped>
.admin-page {
  height: 100dvh;
  display: flex;
  flex-direction: column;
}

/* ── Top bar ── mirrors Settings.vue / MobileChat.vue for a consistent header. */
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
  position: relative;
}
.bar h1 {
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
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 0 4px;
}
.bar .back:hover {
  color: var(--fg);
}

/* ── Body: sidebar + scrolling content ── */
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
</style>
