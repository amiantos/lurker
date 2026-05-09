<template>
  <div class="chat">
    <aside class="sidebar">
      <div class="sidebar-head">
        <span class="logo">caint</span>
        <span class="status" :class="{ on: connected, off: !connected }">{{ connected ? '●' : '○' }}</span>
        <button class="link" @click="openAddNetwork" title="Add network">+</button>
      </div>
      <BufferList @edit-network="openEditNetwork" />
      <div class="sidebar-foot">
        <button class="link" @click="showHighlights = true" title="highlights">@</button>
        <RouterLink class="link" to="/settings">settings</RouterLink>
        <button class="link" @click="signOut">sign out</button>
      </div>
    </aside>

    <header v-if="active" class="topic">
      <span class="buffer">{{ bufferLabel }}</span>
      <span v-if="memberCount != null" class="count">{{ '{' + memberCount + '}' }}</span>
      <template v-if="topic">
        <span class="sep">│</span>
        <span class="topic-text">{{ topic }}</span>
      </template>
    </header>
    <div v-if="active" class="topic-divider"></div>

    <MessageList :pending-scroll-id="pendingScrollId" />
    <MemberList v-if="active" />
    <MessageInput />

    <NetworkForm
      v-if="showNetworkForm"
      :network="editingNetwork"
      @close="closeNetworkForm"
    />
    <HighlightsModal
      v-if="showHighlights"
      @close="showHighlights = false"
      @jump="onJumpToMessage"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useAuthStore } from '../stores/auth.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useSocket } from '../composables/useSocket.js';
import { startPresenceReporter, reportNow } from '../composables/usePresence.js';
import { registerSW, syncWithSetting, onSWPushMessage } from '../composables/usePush.js';
import BufferList from '../components/BufferList.vue';
import MessageList from '../components/MessageList.vue';
import MessageInput from '../components/MessageInput.vue';
import MemberList from '../components/MemberList.vue';
import NetworkForm from '../components/NetworkForm.vue';
import HighlightsModal from '../components/HighlightsModal.vue';

const auth = useAuthStore();
const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const router = useRouter();
const { connected } = useSocket();

const showNetworkForm = ref(false);
const editingNetwork = ref(null);
const showHighlights = ref(false);
const pendingScrollId = ref(null);
const { activeKey } = storeToRefs(networks);

function onJumpToMessage({ networkId, target, messageId }) {
  networks.setActive(networkId, target);
  buffers.markRead(networkId, target);
  pendingScrollId.value = messageId;
}

function openAddNetwork() {
  editingNetwork.value = null;
  showNetworkForm.value = true;
}
function openEditNetwork(net) {
  editingNetwork.value = net;
  showNetworkForm.value = true;
}
function closeNetworkForm() {
  showNetworkForm.value = false;
  editingNetwork.value = null;
}

const active = computed(() => networks.activeBuffer);
const activeBuf = computed(() => (activeKey.value ? buffers.byKey(activeKey.value) : null));
const topic = computed(() => activeBuf.value?.topic);

const bufferLabel = computed(() => {
  const t = active.value?.target;
  if (!t) return '';
  if (t.startsWith(':server:')) return '[server]';
  return `[${t}]`;
});

const memberCount = computed(() => {
  const t = active.value?.target;
  if (!t || !t.startsWith('#')) return null;
  return activeBuf.value?.members?.length ?? null;
});

onMounted(async () => {
  if (!settings.loaded) settings.fetchAll().catch(() => {});
  await networks.fetchAll();
  startPresenceReporter();
  reportNow();
  registerSW().catch(() => { /* ignore */ });
  onSWPushMessage((data) => {
    if (data?.kind === 'jump') onJumpToMessage(data);
  });
  if (settings.effective('notifications.enabled')) {
    syncWithSetting(true);
  }
});

watch(() => settings.effective('notifications.enabled'), (enabled, prev) => {
  if (enabled === prev) return;
  syncWithSetting(!!enabled);
});

async function signOut() {
  await auth.logout();
  router.replace('/login');
}
</script>

<style scoped>
/* WeeChat-style frame: the sidebar runs full height on the left; the topic
   and input bars span the full width to the right of it; and the message
   list + nicklist sit between them. */
.chat {
  display: grid;
  grid-template-columns: 220px 1fr 180px;
  /* The 1px row owns the topic/messages divider as its own grid track,
     outside the scroll container. Putting the line inside .message-list
     (border-top, inset box-shadow) lets row backgrounds and hover states
     paint over it as content scrolls past — the line appears to be eaten
     by the scrolling rows. A dedicated row sits between the two children
     and nothing can paint on top of it. */
  grid-template-rows: auto auto 1fr auto;
  grid-template-areas:
    "sidebar topic    topic"
    "sidebar divider  divider"
    "sidebar messages members"
    "sidebar input    input";
  height: 100vh;
  overflow: hidden;
}
/* min-height/min-width 0 lets flex/scrolling children stay inside their row. */
.chat > * { min-width: 0; min-height: 0; }

.sidebar {
  grid-area: sidebar;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.sidebar-head {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.logo { color: var(--accent); font-weight: bold; flex: 1; }
.status.on { color: var(--good); }
.status.off { color: var(--bad); }
.sidebar-foot {
  margin-top: auto;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 2px 4px;
  cursor: pointer;
  font: inherit;
}
.link:hover { color: var(--fg); }

.topic {
  grid-area: topic;
  padding: 0 12px 1ch;
  display: flex;
  align-items: baseline;
  gap: 1ch;
  white-space: nowrap;
  overflow: hidden;
}
.topic-divider {
  grid-area: divider;
  background: var(--border);
  height: 1px;
}
.topic .buffer { color: var(--accent); }
.topic .count  { color: var(--fg-muted); }
.topic .sep    { color: var(--border); }
.topic .topic-text {
  color: var(--fg-muted);
  text-overflow: ellipsis;
  overflow: hidden;
}

/* These selectors target the root elements of the imported components.
   Vue 3 scoped CSS attaches the parent's data-v attribute to a child
   component's root element, so .message-list / .members / .input here
   match the rendered roots of MessageList / MemberList / MessageInput. */
.message-list { grid-area: messages; }
.members      { grid-area: members; border-left: 1px solid var(--border); }
.input        { grid-area: input; }
</style>
