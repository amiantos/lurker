<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <li
    class="row"
    :class="{ modified }"
    :data-setting-key="opt.key"
    :title="modified ? 'modified from default' : ''"
  >
    <div class="head">
      <span class="headline">{{ opt.label || opt.key }}</span>
      <span class="type">{{ opt.type }}</span>
      <button v-if="modified" class="link reset" @click="$emit('reset')" title="reset to default">
        reset
      </button>
    </div>
    <div class="key-sub">
      <code>{{ opt.key }}</code>
    </div>
    <div class="desc">{{ opt.description }}</div>
    <div class="editor">
      <label v-if="opt.type === 'bool'" class="bool">
        <input
          type="checkbox"
          :checked="!!value"
          @change="$emit('commit', ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ value ? 'on' : 'off' }}</span>
      </label>
      <input
        v-else-if="opt.type === 'int'"
        type="number"
        :min="opt.min"
        :max="opt.max"
        :value="value"
        @change="$emit('commit', Number(($event.target as HTMLInputElement).value))"
      />
      <select
        v-else-if="opt.type === 'enum'"
        :value="value"
        @change="$emit('commit', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="c in opt.choices" :key="c" :value="c">{{ c }}</option>
      </select>
      <span v-else-if="opt.type === 'color'" class="color-edit">
        <span class="swatch" :style="{ background: value as string }"></span>
        <input
          type="text"
          :value="value"
          @change="$emit('commit', ($event.target as HTMLInputElement).value)"
        />
      </span>
      <textarea
        v-else-if="opt.type === 'string-list'"
        :value="(Array.isArray(value) ? value : []).join('\n')"
        @change="
          $emit(
            'commit',
            ($event.target as HTMLTextAreaElement).value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        "
        rows="6"
      ></textarea>
      <span v-else-if="opt.type === 'secret'" class="secret-edit">
        <input
          :type="revealed ? 'text' : 'password'"
          autocomplete="off"
          spellcheck="false"
          :value="value"
          @change="$emit('commit', ($event.target as HTMLInputElement).value)"
        />
        <button type="button" class="link reveal" @click="revealed = !revealed">
          {{ revealed ? 'hide' : 'show' }}
        </button>
      </span>
      <input
        v-else
        type="text"
        :value="value"
        @change="$emit('commit', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <div v-if="modified" class="default-line">
      default: <code>{{ formatDefault(opt) }}</code>
    </div>
  </li>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { SettingOption, SettingValue } from '../../../shared/settingsRegistry.js';

withDefaults(
  defineProps<{
    opt: SettingOption;
    value?: SettingValue;
    modified?: boolean;
  }>(),
  {
    value: undefined,
    modified: false,
  },
);

defineEmits<{
  commit: [value: SettingValue];
  reset: [];
}>();

const revealed = ref(false);

function formatDefault(opt: SettingOption): string {
  const v = opt.default;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}
</script>

<style scoped>
.row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4) 0 var(--space-4) var(--space-4);
  border-top: 1px solid var(--border);
  border-left: 2px solid transparent;
  list-style: none;
}
.row:first-child {
  border-top: none;
}
.row:hover {
  background: var(--bg-soft);
}
.row.modified {
  border-left-color: var(--warn);
}
.row.modified .headline {
  color: var(--warn);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-5);
}
.headline {
  font-weight: 600;
}
.type {
  color: var(--fg-muted);
  border: 1px solid var(--border);
  padding: 0 var(--space-2);
  text-transform: lowercase;
}
.key-sub code {
  color: var(--fg-muted);
  background: var(--bg-soft);
  padding: 0 var(--space-2);
}
.desc {
  color: var(--fg-muted);
}

.editor {
  margin-top: var(--space-1);
}
.editor input[type='text'],
.editor select {
  min-width: 280px;
}
.editor input[type='number'] {
  width: 120px;
}
.editor textarea {
  width: 100%;
  max-width: 480px;
  resize: vertical;
}
.editor .bool {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
}
.editor .color-edit {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.editor .secret-edit {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.editor .secret-edit input {
  flex: 1;
}
.editor .secret-edit .reveal {
  white-space: nowrap;
}
.editor .swatch {
  width: 14px;
  height: 14px;
  border: 1px solid var(--border);
  display: inline-block;
}
.default-line {
  color: var(--fg-muted);
}
.default-line code {
  background: var(--bg-soft);
  padding: 0 var(--space-2);
}

.link {
  background: none;
  border: 0;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-decoration: underline;
}
.link:hover {
  color: var(--fg);
}
.link:disabled {
  color: var(--fg-muted);
  text-decoration: none;
  cursor: default;
}
.link.danger {
  color: var(--bad);
}
.link.reset {
  color: var(--fg-muted);
}
</style>
