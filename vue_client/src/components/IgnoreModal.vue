<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="ignore" :title="`ignore ${nick}`" size="md" @close="$emit('close')">
    <form class="modal-form" @submit.prevent="confirm">
      <div class="body">
        <label class="field">
          <span class="label-text">Mask</span>
          <input
            ref="inputEl"
            :value="mask"
            @input="onMaskInput"
            @keydown.enter="blockImeEnter"
            type="text"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
          />
        </label>
        <p class="hint">
          Plain nick (e.g. <code>{{ nick }}</code>) or <code>nick!user@host</code> with
          <code>*</code> wildcards. The default targets this user's identity
          (<code>user@host</code>) so it survives nick changes.
        </p>
        <div v-if="networkId" class="scope" role="radiogroup" aria-label="Scope">
          <button
            type="button"
            role="radio"
            :aria-checked="scope === 'global'"
            :class="{ active: scope === 'global' }"
            @click="scope = 'global'"
          >
            Everywhere
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="scope === 'network'"
            :class="{ active: scope === 'network' }"
            @click="scope = 'network'"
          >
            This network
          </button>
        </div>
        <p class="preview">
          Messages matching <code>{{ mask || '∅' }}</code> will be hidden
          {{ scope === 'network' ? 'on this network' : 'on every network' }}.
        </p>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn-secondary" @click="$emit('close')">Cancel</button>
        <button type="submit" class="btn-primary" :disabled="!mask.trim()">Ignore</button>
      </footer>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import { useIgnoresStore } from '../stores/ignores.js';
import { blockImeEnter, useImeSafeInput } from '../composables/useImeSafeInput.js';

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

// Scope: global (default, #350) hides the mask on every network; 'network'
// scopes it to the buffer it was opened from. Only offered when we know the
// network — otherwise it's always global.
const scope = ref<'global' | 'network'>('global');

// Default to a hostmask that hides the nick segment — IRCCloud convention.
// If we don't have an observed user@host yet (member entered before WHO
// completed and we never saw a join), fall back to nick!*@*.
const mask = ref(props.user && props.host ? `*!${props.user}@${props.host}` : `${props.nick}!*@*`);
const onMaskInput = useImeSafeInput(mask);

function confirm() {
  const trimmed = mask.value.trim();
  if (!trimmed) return;
  const networkId = scope.value === 'network' ? props.networkId : null;
  ignores.addMask(networkId, trimmed);
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
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Breathing room so the last content doesn't butt against the footer divider
     when scrolled to the bottom. */
  padding-bottom: var(--space-7);
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
.scope {
  display: flex;
  gap: var(--space-2);
}
.scope button {
  flex: 1;
  background: var(--bg-soft);
  color: var(--fg-muted);
  border: 1px solid var(--border);
  padding: var(--space-2) var(--space-3);
  font: inherit;
  cursor: pointer;
}
.scope button.active {
  color: var(--fg);
  border-color: var(--accent);
  outline: 1px solid var(--accent);
}
code {
  background: var(--bg-soft);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
}
</style>
