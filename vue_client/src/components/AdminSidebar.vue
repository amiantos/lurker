<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Master list for the admin panel shell — a vertical list of admin tabs (Users,
  Invites, …). The active one is highlighted; clicking navigates to
  /admin/:tab. A compact <select> replaces the list on mobile. Simpler than
  SettingsSidebar (no search, no subsections) since admin tabs are a short,
  fixed set of bespoke panes.
-->

<template>
  <nav class="admin-sidebar" aria-label="admin sections">
    <select
      class="mobile-picker"
      :value="activeTabId"
      @change="onPick(($event.target as HTMLSelectElement).value)"
      aria-label="admin section"
    >
      <option v-for="tab in tabs" :key="tab.id" :value="tab.id">{{ tab.label }}</option>
    </select>
    <RouterLink
      v-for="tab in tabs"
      :key="tab.id"
      :to="{ name: 'admin', params: { tab: tab.id } }"
      class="sidebar-link"
      :class="{ active: tab.id === activeTabId }"
      >{{ tab.label }}</RouterLink
    >
  </nav>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { ADMIN_TABS } from '../utils/adminRegistry.js';

defineProps<{
  activeTabId: string;
}>();

const router = useRouter();
const tabs = ADMIN_TABS;

function onPick(tabId: string) {
  router.push({ name: 'admin', params: { tab: tabId } });
}
</script>

<style scoped>
.admin-sidebar {
  flex: 0 0 auto;
  width: 14em;
  border-right: 1px solid var(--border);
  padding: var(--space-4) 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
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

/* The compact picker is mobile-only — the full vertical list gives a better
   at-a-glance overview when there's horizontal room. */
.mobile-picker {
  display: none;
}

@media (max-width: 720px) {
  .admin-sidebar {
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
    appearance: none;
    -webkit-appearance: none;
    padding: var(--space-2) var(--space-9) var(--space-2) var(--space-3);
    line-height: 1.4;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23939293' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    background-size: 10px 6px;
  }
  .sidebar-link {
    display: none;
  }
}
</style>
