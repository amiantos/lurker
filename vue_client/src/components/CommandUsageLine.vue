<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The usage of the slash command being typed, with the argument under the caret
  picked out (#1369). It sits in the footer of whichever composer popover is
  up, so it stays in view from the first argument to the last, with or without
  suggestions above it. What it says comes from usageHint in
  lib/commands/completion.ts.
-->

<template>
  <div class="usage-line">
    <span class="usage"
      ><template v-for="(part, i) in hint.parts" :key="i"
        ><template v-if="i > 0">{{ ' ' }}</template
        ><span :class="{ active: part.active }">{{ part.text }}</span></template
      ></span
    >
    <span class="summary">{{ hint.summary }}</span>
  </div>
</template>

<script setup lang="ts">
import type { UsageHint } from '../lib/commands/completion.js';

defineProps<{ hint: UsageHint }>();
</script>

<style scoped>
/* Wraps rather than clips: on a phone the usage and the summary rarely share a
   line, and both are worth reading. */
.usage-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2) var(--space-6);
  padding: var(--space-5) var(--space-6);
  color: var(--fg-muted);
  user-select: none;
}
.active {
  color: var(--fg);
  font-weight: 600;
}
.summary {
  text-align: right;
}
</style>
