<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal :word="word" :title="label" size="lg" @close="$emit('close')">
    <div class="body">
      <p v-if="!topic" class="empty">No topic set.</p>
      <p v-else class="topic-text"><LinkedText :text="topic" /></p>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import AppModal from './AppModal.vue';
import LinkedText from './LinkedText.vue';

withDefaults(
  defineProps<{
    topic?: string;
    label?: string;
  }>(),
  { topic: '', label: '' },
);

defineEmits<{
  close: [];
}>();

// The label is the channel name and includes characters like '#' that
// don't tile as nicely as a plain word, so just say "topic" on the wall.
const word = 'topic';
</script>

<style scoped>
.body {
  /* Break out of card padding so the scrollbar sits against the card
     border; padding keeps content visually aligned with the rest. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: var(--space-7) var(--card-pad-x) 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.topic-text {
  margin: 0;
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.55;
}
.empty {
  margin: 0;
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
}
</style>
