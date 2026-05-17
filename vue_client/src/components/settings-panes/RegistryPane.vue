<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0

  Generic registry-driven settings pane. Filters REGISTRY by `categoryId`,
  groups items by their `group` field, and renders one SettingsRow per item.
  Used for any category whose `kind: 'registry'` entry in CATEGORIES — i.e.
  the categories that are just a list of options with no contextual UI.
-->

<template>
  <section :id="categoryId" class="settings-pane">
    <h2>{{ categoryLabel }}</h2>
    <p v-if="error" class="error inline">{{ error }}</p>

    <template v-for="grp in groups" :key="grp.id">
      <h3 v-if="groups.length > 1" class="subhead">{{ grp.title }}</h3>
      <ul class="rows">
        <SettingsRow
          v-for="opt in grp.items"
          :key="opt.key"
          :opt="opt"
          :value="settings.effective(opt.key)"
          :modified="settings.isModified(opt.key)"
          @commit="(v) => onCommit(opt.key, v)"
          @reset="onReset(opt.key)"
        />
      </ul>
    </template>

    <p v-if="!groups.length" class="muted small">No settings in this category.</p>
  </section>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useSettingsStore } from '../../stores/settings.js';
import { CATEGORIES, GROUPS } from '../../utils/settingsRegistry.js';
import SettingsRow from '../SettingsRow.vue';

const props = defineProps({
  categoryId: { type: String, required: true },
});

const settings = useSettingsStore();
const error = ref('');

const categoryLabel = computed(() => {
  const cat = CATEGORIES.find((c) => c.id === props.categoryId);
  return cat?.label || props.categoryId;
});

const groups = computed(() => {
  const items = settings.registry.filter((opt) => opt.category === props.categoryId);
  if (!items.length) return [];
  const groupsMap = new Map();
  for (const opt of items) {
    const gid = opt.group || '_';
    if (!groupsMap.has(gid)) groupsMap.set(gid, []);
    groupsMap.get(gid).push(opt);
  }
  return Array.from(groupsMap, ([gid, gItems]) => ({
    id: gid,
    title: GROUPS[gid] || gid,
    items: gItems,
  }));
});

async function onCommit(key, value) {
  error.value = '';
  try {
    await settings.setValue(key, value);
  } catch (e) {
    error.value = e.message || 'failed to save';
  }
}

async function onReset(key) {
  error.value = '';
  try {
    await settings.reset(key);
  } catch (e) {
    error.value = e.message || 'failed to reset';
  }
}
</script>

<style src="./panes.css"></style>
<style scoped>
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
</style>
