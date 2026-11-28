<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  The DCC button in the desktop rail. (A phone has a DCC row in its buffer-list
  bar's menu instead, #1484: lib/listBarMenu.) It opens the DCC window (#1085),
  apart from shares.
  It shows for an account with DCC (a grant, or transfers or files from before
  one went), and while the window is open. Color-as-signal (house style, no
  count badge): the glyph turns warn-colored while an offer waits for an answer.
-->

<template>
  <button
    v-if="dcc.entryShown"
    class="dcc-btn"
    :class="{ pending: dcc.pendingCount > 0 }"
    :title="title"
    @click="dcc.open()"
  >
    <ArchiveIcon />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDccStore } from '../stores/dcc.js';
import { ArchiveIcon } from '@lucide/vue';

const dcc = useDccStore();
const title = computed(() => {
  const n = dcc.pendingCount;
  if (n === 0) return 'DCC';
  return `DCC — ${n} ${n === 1 ? 'offer' : 'offers'} waiting`;
});
</script>

<style scoped>
/* The :hover arm outranks the view's own button:hover, whichever sheet loads
   last, so the signal holds under the pointer. */
.dcc-btn.pending,
.dcc-btn.pending:hover {
  color: var(--warn);
}
</style>
