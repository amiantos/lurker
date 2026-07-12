<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  The uploader config form (#514). Renders itself from a driver's `configSchema`,
  which is why there is no per-driver markup anywhere in the client: an S3 form
  (7 fields, required + optional, string + secret) and a Zipline form (2) are the
  same component with different input.

  Shared by the user pane (settings) and the admin pane (instance uploaders) —
  the two differ in policy, not in how a driver is configured.

  Secrets: an existing secret is shown as a "stored" placeholder, never a value.
  Leaving it blank on save keeps what's stored; typing replaces it.
-->

<template>
  <form class="uploader-form" @submit.prevent="onSubmit">
    <label>
      <span>Name</span>
      <input
        v-model="label"
        type="text"
        maxlength="64"
        :placeholder="driver.label"
        :disabled="busy"
      />
    </label>

    <label v-for="field in driver.configSchema" :key="field.key">
      <span>
        {{ field.label }}
        <em v-if="!field.required" class="optional">optional</em>
      </span>
      <input
        v-model="values[field.key]"
        :type="field.type === 'secret' ? 'password' : 'text'"
        :placeholder="placeholderFor(field)"
        :autocomplete="field.type === 'secret' ? 'new-password' : 'off'"
        :disabled="busy"
      />
      <span class="field-desc">{{ field.description }}</span>
    </label>

    <p v-if="error" class="error inline">{{ error }}</p>

    <div class="form-actions">
      <button class="link" type="submit" :disabled="busy || incomplete">
        {{ existing ? 'save' : 'add uploader' }}
      </button>
      <button class="link" type="button" :disabled="busy" @click="emit('cancel')">cancel</button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  type UploaderDriver,
  type UploaderConfigField,
  emptyValues,
  valuesFrom,
  missingRequired,
} from '../utils/uploaders.js';

const props = defineProps<{
  driver: UploaderDriver;
  /** Editing an existing uploader: its non-secret config + which secrets are set. */
  existing?: { label: string; config: Record<string, string>; secretsSet: Record<string, boolean> };
  busy?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'save', payload: { label: string; values: Record<string, string> }): void;
  (e: 'cancel'): void;
}>();

// Seeded ONCE, at setup. Callers must `:key` this component on the thing it's
// editing (the driver id when adding, the uploader id when editing) so switching
// target remounts it with fresh state.
//
// Deliberately NOT a watcher on `props.existing`: parents pass that as an inline
// object literal, so its identity changes on EVERY parent re-render — and a
// re-render is exactly what happens when a save fails and the parent sets an
// error. A watcher would re-seed the form at that moment and silently wipe what
// the user typed, right as we tell them to fix it.
const label = ref(props.existing?.label ?? '');
const values = ref<Record<string, string>>(
  props.existing ? valuesFrom(props.driver, props.existing.config) : emptyValues(props.driver),
);

const incomplete = computed(() =>
  missingRequired(props.driver, values.value, props.existing?.secretsSet ?? {}),
);

function placeholderFor(field: UploaderConfigField): string {
  if (field.type !== 'secret') return '';
  // Distinguishes "there's a key here, I just can't show it to you" from "empty".
  return props.existing?.secretsSet[field.key] ? '•••••••• (stored — leave blank to keep)' : '';
}

function onSubmit() {
  // Blank fields are dropped rather than sent as '': for a secret that's what
  // means "keep the stored one", and for an optional string it's the difference
  // between "unset" and "explicitly empty".
  const payload: Record<string, string> = {};
  for (const field of props.driver.configSchema) {
    const v = String(values.value[field.key] ?? '').trim();
    if (v) payload[field.key] = v;
  }
  emit('save', { label: label.value.trim() || props.driver.label, values: payload });
}
</script>

<style scoped>
.uploader-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.uploader-form label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

/* Hierarchy by color/weight only — no font-size anywhere (one-font-size rule). */
.uploader-form label > span:first-child {
  color: var(--fg);
}

.optional {
  color: var(--fg-muted);
  font-style: normal;
}

.field-desc {
  color: var(--fg-muted);
}

.form-actions {
  display: flex;
  gap: var(--space-3);
}
</style>
