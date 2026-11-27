<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A live readout of the idle tracker (useAttention), for QA. Off unless
  localStorage 'lurker.debug.attention' is '1' (see App.vue). It takes no
  pointer events, so it can't count as input itself.
-->
<template>
  <div class="attention-debug" aria-hidden="true">
    <span :class="snap.attended ? 'on' : 'off'">{{ snap.attended ? 'attended' : 'away' }}</span>
    <span>{{ snap.visible ? 'visible' : 'hidden' }}</span>
    <span>idle {{ seconds(snap.idleForMs) }} / {{ limit }}</span>
    <span>last: {{ snap.lastInputType }}</span>
    <span>active: {{ networks.activeKey || 'none' }}</span>
    <span v-if="active">read {{ active.lastReadId }} · divider {{ active.dividerAfterId }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { attentionSnapshot } from '../composables/useAttention.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const snap = ref(attentionSnapshot());
const seconds = (ms: number) => `${Math.floor(ms / 1000)}s`;
const limit = computed(() => (snap.value.limitMs ? seconds(snap.value.limitMs) : 'off'));
const active = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => (snap.value = attentionSnapshot()), 500);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.attention-debug {
  position: fixed;
  right: var(--space-2);
  bottom: var(--space-2);
  z-index: var(--z-popover);
  display: flex;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-2);
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  pointer-events: none;
}
.on {
  color: var(--good);
}
.off {
  color: var(--bad);
}
</style>
