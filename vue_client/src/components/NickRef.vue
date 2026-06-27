<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <span class="nick-ref" :class="{ interactive }" :style="style"
    ><span v-if="glyph" class="mode-glyph" :class="glyphClass">{{ glyph }}</span
    >{{ nick }}</span
  >
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNickColors } from '../composables/useNickColors.js';
import { prefixOf } from '../utils/memberPrefix.js';

const props = defineProps<{
  nick: string;
  // Channel user-mode glyph (#376). Both must be supplied for the glyph to
  // render; callers that aren't a channel speaker just omit them.
  modes?: string[];
  showPrefix?: boolean;
  // Pointer affordance for clickable nicks (#238). The click handler is
  // attached by the consumer and reaches the root span via Vue's attribute
  // fallthrough — this prop only drives the cursor styling. Nicks open their
  // menu on left-click/tap only; right-click is left to the browser so the
  // text stays selectable for copy/paste (#426).
  interactive?: boolean;
}>();

const networks = useNetworksStore();
const buffers = useBuffersStore();
const nicks = useNickColors();

const glyph = computed(() => (props.showPrefix ? prefixOf(props.modes) : ''));
const glyphClass = computed(() => `mode-${glyph.value}`);

const selfLower = computed(() => {
  const key = networks.activeKey;
  if (!key) return null;
  const buf = buffers.byKey(key);
  const sn = buf && buf.networkId != null ? networks.states[buf.networkId]?.nick : null;
  return sn ? sn.toLowerCase() : null;
});

const isSelf = computed(() => {
  const sl = selfLower.value;
  return !!(sl && props.nick && props.nick.toLowerCase() === sl);
});

const style = computed(() => {
  if (isSelf.value) return { color: nicks.selfColor.value };
  const c = nicks.color(props.nick);
  return c ? { color: c } : null;
});
</script>

<style scoped>
.nick-ref {
  color: inherit;
}
.nick-ref.interactive {
  cursor: pointer;
}
/* The mode glyph reuses the nicklist's per-mode colors so it reads as a status
   marker rather than part of the (separately-colored) nick. */
.mode-glyph.mode-\~ {
  color: var(--member-owner);
}
.mode-glyph.mode-\& {
  color: var(--member-admin);
}
.mode-glyph.mode-\@ {
  color: var(--member-op);
}
.mode-glyph.mode-\% {
  color: var(--member-halfop);
}
.mode-glyph.mode-\+ {
  color: var(--member-voice);
}
</style>
