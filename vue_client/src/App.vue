<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="app-shell" :class="{ 'is-paused': auth.isPaused }">
    <PausedBanner v-if="auth.isPaused" />
    <RouterView />
  </div>
  <ToastContainer />
  <ContextMenu />
  <CallBar />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useAuthStore } from './stores/auth.js';
import { useSettingsStore } from './stores/settings.js';
import { useConfigStore } from './stores/config.js';
import { useTheme } from './composables/useTheme.js';
import ToastContainer from './components/ToastContainer.vue';
import ContextMenu from './components/ContextMenu.vue';
import PausedBanner from './components/PausedBanner.vue';
import CallBar from './components/CallBar.vue';

const auth = useAuthStore();
const settings = useSettingsStore();
const config = useConfigStore();

useTheme();

onMounted(async () => {
  // /api/config is public, so it can go out immediately.
  if (!config.checked) config.fetch().catch(() => {});
  // The router guard resolves the session on the first navigation and fetchMe
  // coalesces, so awaiting it here costs no extra request.
  const user = auth.checked ? auth.user : await auth.fetchMe();
  // /api/settings/bootstrap is requireAuth. Firing it before the session is
  // known 401s on every logged-out load of `/` — and because this mount races
  // the guard's redirect, `window.location.pathname` is often still `/` when
  // that 401 lands, which trips api.ts's stale-session bounce and costs a
  // gratuitous full-page reload. Chat (useChatBootstrap) and Settings both
  // fetch settings themselves, so waiting here delays nothing that matters:
  // useTheme watches the store and repaints when the values land.
  if (user && !settings.loaded) settings.fetchAll().catch(() => {});
});
</script>
