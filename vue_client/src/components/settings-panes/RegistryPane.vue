<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Generic registry-driven settings pane. Filters REGISTRY by `categoryId`,
  groups items by their `group` field, and renders one SettingsRow per item.
  Used for any category whose `kind: 'registry'` entry in CATEGORIES — i.e.
  the categories that are just a list of options with no contextual UI.

  It's also embeddable: a BESPOKE pane whose category still has ordinary registry
  options can render them here rather than hand-rolling SettingsRows. Pass
  `embedded` (drops the <h2> and the category id, so the host pane keeps a single
  DOM id) and optionally `only` to restrict it to certain groups. UploadsPane uses
  both: its destination/uploader UI is table-backed and bespoke, but the image
  pipeline underneath it is still just registry options.
-->

<template>
  <section
    :id="embedded ? undefined : categoryId"
    :class="embedded ? 'registry-embed' : 'settings-pane'"
  >
    <h2 v-if="!embedded">{{ categoryLabel }}</h2>
    <p v-if="error" class="error inline">{{ error }}</p>

    <template v-for="grp in groups" :key="grp.id">
      <h3
        v-if="embedded || groups.length > 1"
        :id="grp.id"
        class="subhead"
        :data-setting-group="grp.id"
      >
        {{ grp.title }}
      </h3>
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

    <p v-if="!groups.length && !embedded" class="muted small">No settings in this category.</p>
  </section>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useSettingsStore } from '../../stores/settings.js';
import { useConfigStore } from '../../stores/config.js';
import { CATEGORIES, GROUPS, optionVisible } from '../../utils/settingsRegistry.js';
import type { SettingOption, SettingValue } from '../../../../shared/settingsRegistry.js';
import SettingsRow from '../SettingsRow.vue';

const props = defineProps<{
  categoryId: string;
  /** Render for embedding in a bespoke pane: no <h2>, no category id. */
  embedded?: boolean;
  /** Restrict to these group ids (in this order). Omit for every group. */
  only?: string[];
}>();

const settings = useSettingsStore();
const config = useConfigStore();
const error = ref('');

const categoryLabel = computed(() => {
  const cat = CATEGORIES.find((c) => c.id === props.categoryId);
  return cat?.label || props.categoryId;
});

const groups = computed(() => {
  const items = settings.registry.filter(
    (opt) =>
      opt.category === props.categoryId &&
      (!props.only || props.only.includes(opt.group || '_')) &&
      optionVisible(opt, { isNode: config.isNode }),
  );
  if (!items.length) return [];
  const groupsMap = new Map<string, SettingOption[]>();
  for (const opt of items) {
    const gid = opt.group || '_';
    if (!groupsMap.has(gid)) groupsMap.set(gid, []);
    groupsMap.get(gid)!.push(opt);
  }
  const built = Array.from(groupsMap, ([gid, gItems]) => ({
    id: gid,
    title: GROUPS[gid] || gid,
    items: gItems,
  }));
  // `only` is an explicit ordering, not just a filter.
  if (!props.only) return built;
  const order = props.only;
  return built.toSorted((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
});

async function onCommit(key: string, value: SettingValue) {
  error.value = '';
  try {
    await settings.setValue(key, value);
  } catch (e: any) {
    error.value = e.message || 'failed to save';
  }
}

async function onReset(key: string) {
  error.value = '';
  try {
    await settings.reset(key);
  } catch (e: any) {
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
