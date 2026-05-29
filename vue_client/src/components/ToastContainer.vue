<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <Teleport to="body">
    <div v-if="toasts.items.length" class="toast-stack" role="status" aria-live="polite">
      <div
        v-for="t in toasts.items"
        :key="t.id"
        class="toast"
        :class="[`kind-${t.kind}`, { clickable: !!t.networkId }]"
        @click="onClick(t)"
      >
        <div class="row">
          <span class="title">{{ t.title }}</span>
          <button class="x" title="dismiss" @click.stop="toasts.dismiss(t.id)">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div v-if="t.body" class="body">{{ t.body }}</div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useToastsStore } from '../stores/toasts.js';
import type { Toast } from '../stores/toasts.js';
import { useBuffersStore } from '../stores/buffers.js';

const toasts = useToastsStore();
const buffers = useBuffersStore();

function onClick(t: Toast) {
  if (!t.networkId || !t.target) return;
  // The buffer can be closed between the toast firing and the user clicking
  // it; activating would recreate an empty shell. Replace the toast with a
  // "closed" notice instead.
  if (!buffers.isOpen(t.networkId, t.target)) {
    toasts.dismiss(t.id);
    toasts.push({ kind: 'info', title: 'Buffer is closed', body: '', ttlMs: 4000 });
    return;
  }
  buffers.activate(t.networkId, t.target);
  toasts.dismiss(t.id);
}
</script>

<style scoped>
.toast-stack {
  position: fixed;
  top: var(--space-6);
  right: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  z-index: var(--z-toast);
  pointer-events: none;
  max-width: min(360px, calc(100vw - var(--space-9)));
}
.toast {
  pointer-events: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-left: 4px solid var(--toast-accent, var(--accent));
  padding: var(--space-5) var(--space-6);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  color: var(--fg);
  animation: toast-in 160ms ease-out;
}
/* Each kind drives a single CSS variable so the left bar and title pick up the
   same color without duplicating selectors. Defaults to --accent (purple) for
   any future kind that doesn't get its own rule. */
.toast.kind-highlight {
  --toast-accent: var(--warn);
}
.toast.kind-dm,
.toast.kind-notify {
  --toast-accent: var(--accent);
}
.toast.kind-always_notify {
  --toast-accent: var(--good);
}
.toast.kind-info {
  --toast-accent: var(--fg-muted);
}
.toast.kind-warn {
  --toast-accent: var(--warn);
}
.toast.kind-error {
  --toast-accent: var(--bad);
}
.toast.clickable {
  cursor: pointer;
}
.toast.clickable:hover {
  background: var(--bg-soft);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.title {
  flex: 1;
  font-weight: 600;
  color: var(--toast-accent, var(--accent));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toast.kind-info .title {
  color: var(--fg);
}
.x {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-1);
  line-height: 1;
}
.x:hover {
  color: var(--fg);
}
.body {
  color: var(--fg);
  margin-top: var(--space-2);
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateX(8px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
</style>
