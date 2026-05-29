<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="ignore" :title="`ignore ${nick}`" size="md" @close="$emit('close')">
    <form class="body" @submit.prevent="confirm">
      <label class="field">
        <span class="label-text">Mask</span>
        <input
          ref="inputEl"
          v-model="mask"
          type="text"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
        />
      </label>
      <p class="hint">
        Plain nick (e.g. <code>{{ nick }}</code
        >) or <code>nick!user@host</code> with <code>*</code> wildcards. The default targets this
        user's identity (<code>user@host</code>) so it survives nick changes.
      </p>
      <p class="preview">
        Messages matching <code>{{ mask || '∅' }}</code> will be hidden on this network.
      </p>
      <div class="actions">
        <button type="button" class="btn-secondary" @click="$emit('close')">Cancel</button>
        <button type="submit" class="btn-primary" :disabled="!mask.trim()">Ignore</button>
      </div>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import { useIgnoresStore } from '../stores/ignores.js';

const props = withDefaults(
  defineProps<{
    nick: string;
    user?: string | null;
    host?: string | null;
    networkId?: number | null;
  }>(),
  {
    user: null,
    host: null,
    networkId: null,
  },
);
const emit = defineEmits<{ close: [] }>();

const ignores = useIgnoresStore();
const inputEl = ref<HTMLInputElement | null>(null);

// Default to a hostmask that hides the nick segment — IRCCloud convention.
// If we don't have an observed user@host yet (member entered before WHO
// completed and we never saw a join), fall back to nick!*@*.
const mask = ref(props.user && props.host ? `*!${props.user}@${props.host}` : `${props.nick}!*@*`);

function confirm() {
  const trimmed = mask.value.trim();
  if (!trimmed || !props.networkId) return;
  ignores.addMask(props.networkId, trimmed);
  emit('close');
}

onMounted(() => {
  // Focus the input next tick so Tab/Enter behave naturally on open.
  setTimeout(() => inputEl.value?.focus(), 0);
});
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.label-text {
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
input {
  background: var(--bg-soft);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: var(--space-3) var(--space-4);
  font: inherit;
}
input:focus {
  outline: 1px solid var(--accent);
}
.hint,
.preview {
  margin: 0;
  color: var(--fg-muted);
  line-height: 1.45;
}
.preview {
  color: var(--fg);
}
code {
  background: var(--bg-soft);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-4);
  margin-top: var(--space-2);
}
.btn-primary,
.btn-secondary {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg);
  padding: var(--space-3) var(--space-6);
  cursor: pointer;
  font: inherit;
}
.btn-primary {
  border-color: var(--accent);
  color: var(--accent);
}
.btn-primary:disabled {
  opacity: 0.4;
  cursor: default;
}
.btn-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}
.btn-secondary:hover {
  background: var(--bg-soft);
}
</style>
