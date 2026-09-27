<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Under a line that started a reply thread (#993): `╰─ 3 replies`, which opens
  the thread view. The last line of the message body, like ReactionRow, and in
  the reply quote's voice — the same arm, faded the same way — since it's the
  other end of the same link.
-->

<template>
  <button type="button" class="thread-chip" title="Open thread" @click.stop="emit('open')">
    <span class="arm" aria-hidden="true">╰─</span>{{ count }}
    {{ count === 1 ? 'reply' : 'replies' }}
  </button>
</template>

<script setup lang="ts">
defineProps<{ count: number }>();
const emit = defineEmits<{ open: [] }>();
</script>

<style scoped>
.thread-chip {
  display: block;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: var(--fg);
  opacity: 0.45;
  cursor: pointer;
  text-align: left;
}
.thread-chip:hover,
.thread-chip:focus-visible {
  opacity: 0.8;
}
.arm {
  margin-right: 1ch;
}
</style>
