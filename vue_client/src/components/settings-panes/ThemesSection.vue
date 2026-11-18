<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Themes: the leading section of the Appearance pane. Deliberately minimal
  foundation UI — list + apply + save + delete + the light/dark mode mapping —
  over the themes store; the bespoke theme EDITOR (live-preview panel over the
  chat view) is a separate design effort building on the same store. Everything
  here is also operable via /theme (slash-command-first).

  Applying a theme points look.theme.* at it and clears the per-setting
  overrides below (they'd otherwise keep overriding the new theme), so applying
  while modified asks first. "Save current look" snapshots what's rendered now —
  active theme plus your edits — into a named theme.
-->

<template>
  <h3 id="themes" class="subhead" data-setting-group="themes">Themes</h3>
  <p class="section-desc">
    A theme is a snapshot of the fonts, colors and modern-layout spacing below. Changes you make
    after applying one sit on top of it and can be saved as a new theme. Also managed with
    <code>/theme</code>.
  </p>
  <p v-if="error" class="error inline">{{ error }}</p>

  <ul class="device-list">
    <li v-for="t in themes.all" :key="t.id" class="device">
      <span class="ua">
        <span class="name">{{ t.name }}</span>
        <span v-if="t.builtin" class="tag">built-in</span>
        <span v-if="t.id === themes.activeThemeId" class="tag active">
          {{ drifted ? 'active · modified' : 'active' }}
        </span>
      </span>
      <span class="btn-bar">
        <button v-if="t.id !== themes.activeThemeId" :disabled="busy" @click="apply(t)">
          Apply
        </button>
        <template v-else-if="drifted">
          <button v-if="!t.builtin" :disabled="busy" @click="updateActive(t)">Save changes</button>
          <!-- Re-applying the active theme IS the discard-drift operation; without
               this, a drifted built-in row would render zero actions and the only
               ways back would be /theme apply or resetting keys one by one. -->
          <button :disabled="busy" @click="apply(t)">Discard changes</button>
        </template>
        <button v-if="!t.builtin" class="bad" :disabled="busy" @click="remove(t)">Delete</button>
      </span>
    </li>
  </ul>

  <div class="theme-save">
    <input
      :value="newName"
      @input="onNameInput"
      type="text"
      :maxlength="THEME_NAME_MAX"
      :disabled="busy"
      placeholder="Save current look as…"
      @keydown.enter.prevent="onNameEnter"
    />
    <button :disabled="busy || !newName.trim()" @click="saveNew">Save theme</button>
  </div>

  <div class="theme-mode">
    <label>
      <span class="mode-label">Theme selection</span>
      <select
        :value="mode"
        :disabled="busy"
        @change="setMode(($event.target as HTMLSelectElement).value)"
      >
        <option value="single">One theme everywhere</option>
        <option value="system">Follow system light/dark</option>
      </select>
    </label>
    <template v-if="mode === 'system'">
      <label>
        <span class="mode-label">In light mode</span>
        <select
          :value="slotValue('look.theme.light')"
          :disabled="busy"
          @change="setSlot('look.theme.light', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="t in themes.all" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
      </label>
      <label>
        <span class="mode-label">In dark mode</span>
        <select
          :value="slotValue('look.theme.dark')"
          :disabled="busy"
          @change="setSlot('look.theme.dark', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="t in themes.all" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
      </label>
      <p class="muted small">
        This device is in {{ prefersDark ? 'dark' : 'light' }} mode right now. The mapping syncs to
        every device; each device follows its own OS setting.
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useSettingsStore } from '../../stores/settings.js';
import { useThemesStore } from '../../stores/themes.js';
import { prefersDark } from '../../utils/prefersDark.js';
import { THEME_NAME_MAX, themeNameError } from '../../../../shared/themePresets.js';
import type { ThemePreset } from '../../../../shared/themePresets.js';
import { isImeKey, useImeSafeInput } from '../../composables/useImeSafeInput.js';

const settings = useSettingsStore();
const themes = useThemesStore();

const error = ref('');
const busy = ref(false);
const newName = ref('');
const onNameInput = useImeSafeInput(newName);

// Enter in this field saves the theme — but the Enter that CONFIRMS a CJK
// candidate is the IME's, not ours, and the model now holds raw preedit while a
// composition is live. Without the gate that keypress saves a theme named
// `nihao` and clears the field the user was still typing into. `.prevent` stays
// on the binding: the key is the IME's either way.
function onNameEnter(e: KeyboardEvent) {
  if (isImeKey(e)) return;
  saveNew();
}

const drifted = computed(() => settings.themeDriftKeys.length > 0);
const mode = computed(() => String(settings.effective('look.theme.mode') ?? 'single'));

// A slot pointing at a deleted theme reads as Dark, matching the resolver.
function slotValue(key: string): string {
  const id = String(settings.effective(key) ?? 'dark');
  return themes.byId(id) ? id : 'dark';
}

async function run(fn: () => Promise<void>) {
  // Reentrancy guard: Enter in the save box (and key auto-repeat) bypasses
  // button :disabled, so without this two create+apply sequences interleave
  // and the loser paints a spurious "already exists" error over a good save.
  if (busy.value) return;
  error.value = '';
  busy.value = true;
  try {
    await fn();
  } catch (e: any) {
    error.value = e?.message || 'failed';
  } finally {
    busy.value = false;
  }
}

function setMode(value: string) {
  void run(() => settings.setValue('look.theme.mode', value));
}

function setSlot(key: string, value: string) {
  void run(() => settings.setValue(key, value));
}

function apply(t: ThemePreset) {
  const n = settings.themeDriftKeys.length;
  if (
    n > 0 &&
    !confirm(
      `Applying ${t.name} resets ${n} modified appearance setting${n === 1 ? '' : 's'} to the theme. ` +
        `Save the current look as a theme first if you want to keep it.`,
    )
  ) {
    return;
  }
  void run(() => themes.applyTheme(t.id));
}

function updateActive(t: ThemePreset) {
  void run(async () => {
    await themes.saveCurrentInto(Number(t.id));
  });
}

function saveNew() {
  const name = newName.value.trim();
  if (!name) return;
  const err = themeNameError(name);
  if (err) {
    error.value = err;
    return;
  }
  void run(async () => {
    await themes.saveCurrentAs(name);
    newName.value = '';
  });
}

function remove(t: ThemePreset) {
  const active = t.id === themes.activeThemeId;
  // The dangling pointer resets to ITS default, which is per-slot: in system
  // mode on a light-scheme device that's the light built-in, not the dark one.
  const revertsTo = themes.byId(
    themes.activePointerKey === 'look.theme.light' ? 'light' : 'dark',
  )!.name;
  if (
    !confirm(
      `Delete theme ${t.name}? This can't be undone.${active ? ` Your appearance reverts to ${revertsTo}.` : ''}`,
    )
  ) {
    return;
  }
  void run(() => themes.remove(Number(t.id)));
}
</script>

<style src="./panes.css"></style>
<style scoped>
.tag {
  font-size: 0.85em;
  color: var(--fg-muted);
}
.tag.active {
  color: var(--accent);
}
.theme-save {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 10px 0 0;
}
.theme-save input {
  flex: 0 1 24ch;
  font: inherit;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  padding: 4px 8px;
}
.theme-mode {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.theme-mode label {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mode-label {
  min-width: 12ch;
  color: var(--fg-muted);
}
.theme-mode select {
  font: inherit;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  padding: 3px 6px;
}
</style>
