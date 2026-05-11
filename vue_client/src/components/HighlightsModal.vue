<template>
  <div class="modal" @click.self="$emit('close')">
    <div class="card">
      <header class="head">
        <h2>highlights</h2>
        <button class="link" @click="$emit('close')" title="close"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <p v-if="store.error" class="error inline">{{ store.error }}</p>
      <ul v-if="store.items.length" class="match-list">
        <li
          v-for="m in store.items"
          :key="`${m.networkId}::${m.target}::${m.id}`"
          class="match"
          @click="onJump(m)"
        >
          <span class="time">{{ time(m.time) }}</span>
          <span class="loc">
            <span class="net">{{ m.networkName || networkName(m.networkId) }}</span>
            <span class="target">{{ targetLabel(m) }}</span>
          </span>
          <span class="nick" :style="nickStyle(m)">{{ m.nick }}</span>
          <span class="text">{{ m.text }}</span>
        </li>
      </ul>
      <p v-else-if="store.loading" class="empty">Loading…</p>
      <p v-else class="empty">No highlights yet.</p>
      <footer v-if="store.hasMore || store.loading" class="foot">
        <button
          class="link"
          :disabled="store.loading || !store.hasMore"
          @click="store.loadMore()"
        >{{ store.loading ? 'Loading…' : 'Load more' }}</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useHighlightsStore } from '../stores/highlights.js';
import { useNickColors } from '../composables/useNickColors.js';
import { formatTimestamp } from '../utils/timestamp.js';

const emit = defineEmits(['close', 'jump']);

const networks = useNetworksStore();
const settings = useSettingsStore();
const store = useHighlightsStore();
const nicks = useNickColors();

const tsFormat = computed(() => settings.effective('look.buffer.time_format'));

onMounted(() => {
  store.loadInitial();
});

function time(iso) {
  return formatTimestamp(iso, tsFormat.value);
}

function networkName(id) {
  return networks.networks.find((n) => n.id === id)?.name || `net:${id}`;
}

function targetLabel(m) {
  if (m.target && m.target.startsWith(':server:')) return '[server]';
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
.link:disabled { opacity: 0.5; cursor: default; }

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
.error.inline {
  color: var(--error, #d66);
  padding: 8px 16px;
  margin: 0;
}
.foot {
  border-top: 1px solid var(--border);
  padding: 8px 16px;
  display: flex;
  justify-content: center;
}
</style>
