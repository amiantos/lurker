<template>
  <Teleport to="body">
    <div v-if="toasts.items.length" class="toast-stack" role="status" aria-live="polite">
      <div
        v-for="t in toasts.items"
        :key="t.id"
        class="toast"
        :class="{ clickable: !!t.networkId }"
        @click="onClick(t)"
      >
        <div class="row">
          <span class="title">{{ t.title }}</span>
          <button
            class="x"
            title="dismiss"
            @click.stop="toasts.dismiss(t.id)"
          ><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div v-if="t.body" class="body">{{ t.body }}</div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { useToastsStore } from '../stores/toasts.js';
import { useBuffersStore } from '../stores/buffers.js';

const toasts = useToastsStore();
const buffers = useBuffersStore();

function onClick(t) {
  if (!t.networkId || !t.target) return;
  // The buffer can be closed between the toast firing and the user clicking
  // it; activating would recreate an empty shell. Replace the toast with a
  // "closed" notice instead.
  if (!buffers.isOpen(t.networkId, t.target)) {
    toasts.dismiss(t.id);
    toasts.push({ kind: 'info', title: 'Buffer is closed', ttlMs: 4000 });
    return;
  }
  buffers.activate(t.networkId, t.target);
  toasts.dismiss(t.id);
}
</script>

<style scoped>
.toast-stack {
  position: fixed;
  top: 12px;
  right: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 200;
  pointer-events: none;
  max-width: min(360px, calc(100vw - 24px));
}
.toast {
  pointer-events: auto;
  background: var(--bg);
  border: 1px solid var(--accent);
  border-left-width: 3px;
  padding: 8px 10px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  color: var(--fg);
  font-size: 0.95em;
  animation: toast-in 140ms ease-out;
}
.toast.clickable { cursor: pointer; }
.toast.clickable:hover { background: var(--bg-soft); }
.row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.title {
  flex: 1;
  font-weight: 600;
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.x {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 2px;
}
.x:hover { color: var(--fg); }
.body {
  color: var(--fg);
  margin-top: 2px;
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
@keyframes toast-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
