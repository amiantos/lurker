<template>
  <div class="modal" @click.self="$emit('close')">
    <div class="card">
      <header class="head">
        <h2>highlights</h2>
        <button class="link" @click="$emit('close')" title="close">×</button>
      </header>
      <ul v-if="matches.length" class="match-list">
        <li
          v-for="m in matches"
          :key="`${m.networkId}::${m.target}::${m.id}`"
          class="match"
          :class="{ dm: m.dm }"
          @click="onJump(m)"
        >
          <span class="time">{{ time(m.time) }}</span>
          <span class="loc">
            <span class="net">{{ networkName(m.networkId) }}</span>
            <span class="target">{{ targetLabel(m) }}</span>
          </span>
          <span class="nick" :style="nickStyle(m)">{{ m.nick }}</span>
          <span class="text">{{ m.text }}</span>
        </li>
      </ul>
      <p v-else class="empty">No highlights in loaded buffers yet.</p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNickColors } from '../composables/useNickColors.js';
import { formatTimestamp } from '../utils/timestamp.js';

const emit = defineEmits(['close', 'jump']);

const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const nicks = useNickColors();

const tsFormat = computed(() => settings.effective('look.buffer.time_format'));

const matches = computed(() => {
  const out = [];
  for (const buf of Object.values(buffers.buffers)) {
    for (const m of buf.messages) {
      if (m.matched || m.dm) {
        out.push({ ...m, networkId: buf.networkId, target: buf.target });
      }
    }
  }
  out.sort((a, b) => {
    const ta = Date.parse(a.time) || 0;
    const tb = Date.parse(b.time) || 0;
    return tb - ta;
  });
  return out.slice(0, 200);
});

function time(iso) {
  return formatTimestamp(iso, tsFormat.value);
}

function networkName(id) {
  return networks.networks.find((n) => n.id === id)?.name || `net:${id}`;
}

function targetLabel(m) {
  if (m.target.startsWith(':server:')) return '[server]';
  return m.target;
}

function nickStyle(m) {
  const c = nicks.color(m.nick);
  return c ? { color: c } : null;
}

function onJump(m) {
  emit('jump', { networkId: m.networkId, target: m.target, messageId: m.id });
  emit('close');
}
</script>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.card {
  background: var(--bg);
  border: 1px solid var(--accent);
  width: min(720px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.head h2 {
  margin: 0;
  flex: 1;
  color: var(--accent);
  font-weight: 600;
  text-transform: lowercase;
}
.link {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 4px;
}
.link:hover { color: var(--fg); }

.match-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.match {
  display: grid;
  grid-template-columns: max-content max-content max-content 1fr;
  gap: 8px;
  align-items: baseline;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.match:hover { background: var(--bg-soft); }
.match.dm { box-shadow: inset 3px 0 0 0 var(--warn); }

.time { color: var(--fg-muted); }
.loc { color: var(--fg-muted); display: flex; gap: 4px; }
.loc .net { color: var(--accent); }
.nick { font-weight: 600; }
.text {
  white-space: pre-wrap;
  word-break: break-word;
}
.empty {
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
  padding: 32px;
}
</style>
