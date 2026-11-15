<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Message layout: the third bespoke section of the Appearance pane. One picker
  over look.message.layout and look.message.avatars (lib/layoutChoice.ts), in
  place of an enum row and a switch that only did anything in one of the
  enum's values. Both keys stay reachable with /set (slash-command-first).
-->

<template>
  <h3 id="layout" class="subhead" data-setting-group="layout">Message layout</h3>
  <LayoutPicker :model-value="current" :disabled="busy" @update:model-value="pick" />
  <p v-if="error" class="error inline">{{ error }}</p>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import LayoutPicker from '../LayoutPicker.vue';
import { useSettingsStore } from '../../stores/settings.js';
import { useViewport } from '../../composables/useViewport.js';
import {
  AVATARS_KEY,
  LAYOUT_KEY,
  currentLayoutChoice,
  layoutChoiceWrites,
  type LayoutChoice,
} from '../../lib/layoutChoice.js';

const settings = useSettingsStore();
const { isMobile } = useViewport();

const current = computed(() =>
  currentLayoutChoice(
    settings.effective(LAYOUT_KEY),
    settings.effective(AVATARS_KEY),
    isMobile.value,
  ),
);

const busy = ref(false);
const error = ref('');

async function pick(choice: LayoutChoice) {
  if (busy.value || choice === current.value) return;
  error.value = '';
  busy.value = true;
  try {
    await settings.patchMany(layoutChoiceWrites(choice, { isMobile: isMobile.value }));
  } catch (e: any) {
    error.value = e?.message || 'failed to save';
  } finally {
    busy.value = false;
  }
}
</script>

<style src="./panes.css"></style>
<style scoped>
.error.inline {
  padding-top: var(--space-3);
}
</style>
