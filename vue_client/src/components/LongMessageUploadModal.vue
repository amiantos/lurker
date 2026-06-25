<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal
    word="flood"
    :title="
      multiline ? `message will send as ${chunks} messages` : `message will flood ${chunks} lines`
    "
    size="md"
    @close="$emit('cancel')"
  >
    <p class="desc">
      <template v-if="multiline">
        This will send as {{ chunks }} separate messages. Upload it as a <code>.txt</code> file
        instead?
      </template>
      <template v-else>
        IRC will split this into {{ chunks }} separate lines. Upload it as a <code>.txt</code> file
        instead?
      </template>
    </p>
    <pre class="preview">{{ content }}</pre>
    <footer class="modal-footer">
      <button type="button" class="btn-secondary" @click="$emit('cancel')">Cancel</button>
      <button
        ref="primaryBtn"
        type="button"
        class="btn-primary"
        :disabled="uploading"
        @click="$emit('confirm')"
      >
        {{ uploading ? 'Uploading…' : 'Upload as .txt' }}
      </button>
    </footer>
  </AppModal>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import AppModal from './AppModal.vue';

withDefaults(
  defineProps<{
    content: string;
    chunks: number;
    multiline?: boolean;
    uploading?: boolean;
  }>(),
  {
    multiline: false,
    uploading: false,
  },
);

defineEmits<{ confirm: []; cancel: [] }>();

const primaryBtn = ref<HTMLButtonElement | null>(null);

onMounted(() => {
  // Focus the primary action so Enter confirms, matching the user's intent
  // (they already hit Send once to get here).
  primaryBtn.value?.focus();
});
</script>

<style scoped>
.desc {
  margin: 0 0 var(--space-6);
  color: var(--fg-muted);
}
.desc code {
  background: var(--bg-soft);
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
}
.preview {
  margin: 0 0 var(--space-6);
  padding: var(--space-4) var(--space-6);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  overflow: auto;
  flex: 1;
  min-height: 0;
  max-height: 40vh;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  color: var(--fg-muted);
}
</style>
