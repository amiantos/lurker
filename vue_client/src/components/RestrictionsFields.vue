<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  The three controls that edit an account restriction set
  (shared/accountRestrictions.ts), as a v-model. Used by the Users pane to edit
  a member's limits and by the Invites pane to set what an invite's account is
  born with, so the two never drift.

  "Any network" is its own switch rather than an empty host box: an empty list
  is a real value (no networks at all), and saving a set that has one must not
  quietly turn it into "any". The host box appears only once that switch is
  off. The server folds and de-duplicates the hosts, so the admin can type
  freely. Renders as `display: contents`, so the labels flow
  in whatever row the parent lays out.
-->

<template>
  <div class="restrictions-fields">
    <label class="check">
      <input :checked="any" type="checkbox" :disabled="disabled" @change="onAny" />
      <span>any network</span>
    </label>
    <!-- Only once "any" is off: under it the box has nothing to say, and the
         placeholder is the whole tip. -->
    <label v-if="!any">
      <span>networks</span>
      <input
        :value="hosts"
        :disabled="disabled"
        placeholder="hostnames, comma-separated"
        spellcheck="false"
        autocapitalize="off"
        @input="onHosts"
      />
    </label>
    <label class="check">
      <input
        :checked="modelValue.uploads"
        type="checkbox"
        :disabled="disabled"
        @change="onUploads"
      />
      <span>may upload</span>
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AccountRestrictions } from '../../../shared/accountRestrictions.js';

const props = defineProps<{ modelValue: AccountRestrictions; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: AccountRestrictions] }>();

const any = computed(() => props.modelValue.networks === null);

// The host box is text while it is being typed; the model holds the parsed
// list. Re-seeded when the parent swaps the set (a different row opened), not
// on every keystroke, or the caret would jump as the text was normalized.
const hosts = ref(props.modelValue.networks?.join(', ') ?? '');
watch(
  () => props.modelValue.networks,
  (networks, previous) => {
    if (networks === null) return;
    if (previous !== undefined && sameList(networks, parseHosts(hosts.value))) return;
    hosts.value = networks.join(', ');
  },
);

function parseHosts(text: string): string[] {
  return text
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}
function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}

function onAny(e: Event): void {
  const on = (e.target as HTMLInputElement).checked;
  emit('update:modelValue', {
    ...props.modelValue,
    networks: on ? null : parseHosts(hosts.value),
  });
}
function onHosts(e: Event): void {
  hosts.value = (e.target as HTMLInputElement).value;
  emit('update:modelValue', { ...props.modelValue, networks: parseHosts(hosts.value) });
}
function onUploads(e: Event): void {
  emit('update:modelValue', {
    ...props.modelValue,
    uploads: (e.target as HTMLInputElement).checked,
  });
}
</script>

<style scoped>
.restrictions-fields {
  display: contents;
}
.restrictions-fields label {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.restrictions-fields input:not([type='checkbox']) {
  width: 28ch;
}
</style>
