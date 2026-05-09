<template>
  <nav class="buffer-list">
    <div v-for="net in networks.networks" :key="net.id" class="net">
      <div class="net-head" @click="toggleNet(net.id)">
        <span class="indicator" :class="stateClass(net.id)"></span>
        <span class="name">{{ net.name }}</span>
        <button
          class="settings"
          title="Edit network"
          @click.stop="$emit('edit-network', net)"
        >⚙</button>
      </div>
      <ul class="channels">
        <li
          v-for="buf in netBuffers(net.id)"
          :key="buf.target"
          :class="{
            active: isActive(net.id, buf.target),
            unread: buf.unread > 0,
            highlighted: buf.highlighted > 0,
            server: isServerBuffer(buf),
          }"
          @click="select(net.id, buf.target)"
        >
          <span class="bullet">{{ bulletFor(buf) }}</span>
          <span class="label" :style="labelStyle(buf)">{{ labelFor(buf) }}</span>
          <span
            v-if="buf.highlighted > 0"
            class="badge highlight"
            :title="`${buf.highlighted} highlight${buf.highlighted === 1 ? '' : 's'}`"
          >●</span>
          <span v-if="buf.unread > 0" class="badge">{{ buf.unread }}</span>
          <button
            v-if="buf.target.startsWith('#')"
            class="part"
            title="Leave channel"
            @click.stop="part(net.id, buf.target)"
          >×</button>
        </li>
      </ul>
      <div class="add">
        <input
          v-model="joinInput[net.id]"
          placeholder="#channel"
          @keydown.enter="join(net.id)"
        />
      </div>
    </div>
    <p v-if="!networks.networks.length" class="empty">No networks yet — add one with the + button.</p>
  </nav>
</template>

<script setup>
import { reactive } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { socketSend } from '../composables/useSocket.js';
import { useNickColors } from '../composables/useNickColors.js';

defineEmits(['edit-network']);

const networks = useNetworksStore();
const buffers = useBuffersStore();
const nicks = useNickColors();

const joinInput = reactive({});

function isServerBuffer(buf) {
  return buf.target.startsWith(':server:');
}

function isDmBuffer(buf) {
  return !isServerBuffer(buf) && !buf.target.startsWith('#');
}

function labelStyle(buf) {
  if (!isDmBuffer(buf)) return null;
  const selfNick = networks.states[buf.networkId]?.nick;
  if (selfNick && buf.target.toLowerCase() === selfNick.toLowerCase()) return null;
  const c = nicks.color(buf.target);
  return c ? { color: c } : null;
}

function bulletFor(buf) {
  if (isServerBuffer(buf)) return '⚙';
  if (buf.target.startsWith('#')) return '#';
  return '@';
}

function labelFor(buf) {
  if (isServerBuffer(buf)) return 'server';
  return buf.target.replace(/^#/, '');
}

function bufferOrder(buf) {
  if (isServerBuffer(buf)) return 0;
  if (buf.target.startsWith('#')) return 1;
  return 2;
}

function netBuffers(networkId) {
  return buffers.forNetwork(networkId).sort((a, b) => {
    const oa = bufferOrder(a);
    const ob = bufferOrder(b);
    if (oa !== ob) return oa - ob;
    return a.target.localeCompare(b.target);
  });
}

function select(networkId, target) {
  networks.setActive(networkId, target);
  buffers.markRead(networkId, target);
}

function isActive(networkId, target) {
  return networks.activeKey === `${networkId}::${target}`;
}

function stateClass(networkId) {
  const s = networks.states[networkId]?.state;
  if (s === 'connected') return 'good';
  if (s === 'connecting' || s === 'reconnecting') return 'warn';
  return 'bad';
}

function join(networkId) {
  const value = (joinInput[networkId] || '').trim();
  if (!value) return;
  const channel = value.startsWith('#') ? value : `#${value}`;
  socketSend({ type: 'join', networkId, channel });
  joinInput[networkId] = '';
}

function part(networkId, channel) {
  socketSend({ type: 'part', networkId, channel });
}

function toggleNet(_) {
  // Reserved for collapse/expand later.
}
</script>

<style scoped>
.buffer-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0;
}
.net { padding: 4px 0 6px; }
.net + .net { border-top: 1px solid var(--border); margin-top: 4px; }
.net-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.name { flex: 1; color: var(--fg); }
.indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--bad);
  flex: 0 0 auto;
}
.indicator.good { background: var(--good); }
.indicator.warn { background: var(--warn); }
.indicator.bad { background: var(--bad); }

.channels { list-style: none; margin: 0; padding: 0; }
.channels li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.channels li:hover { background: var(--bg-soft); }
.channels li.active {
  background: var(--bg-soft);
  border-left-color: var(--accent);
}
.channels li.unread .label { font-weight: 600; color: var(--fg); }
.channels li.highlighted .label { color: var(--warn); }
.channels li.server .label { color: var(--fg-muted); font-style: italic; }
.bullet { color: var(--fg-muted); width: 10px; text-align: center; }
.label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  color: var(--accent);
  padding: 0 2px;
}
.badge.highlight { color: var(--warn); }
.part {
  background: none;
  border: none;
  color: var(--fg-muted);
  padding: 0 4px;
  cursor: pointer;
  visibility: hidden;
}
.channels li:hover .part,
.channels li.active .part { visibility: visible; }
.part:hover { color: var(--bad); }

.settings {
  background: none;
  border: none;
  color: var(--fg-muted);
  padding: 0 2px;
  cursor: pointer;
}
.settings:hover { color: var(--fg); }

.add { padding: 4px 10px; }
.add input { width: 100%; }

.empty { padding: 12px; color: var(--fg-muted); font-style: italic; }
</style>
