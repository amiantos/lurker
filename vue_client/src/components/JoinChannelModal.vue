<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  "Join Channel" modal (#411). A lightweight entry point attached to the + button
  on each network header: type a channel name and join it directly, or fall
  through to the full channel-list browser. Network-scoped — the network is
  implied by the header/button the user opened it from. A future admin overhaul
  can grow this with instance-suggested channels (see the issue).
-->

<template>
  <AppModal word="join" :title="`join channel — ${networkLabel}`" size="sm" @close="$emit('close')">
    <form class="modal-form" @submit.prevent="onJoin">
      <div class="body">
        <input
          ref="inputEl"
          v-model="channel"
          class="chan-input"
          type="text"
          placeholder="#channel"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <button type="button" class="browse" @click="onBrowse">
          <i class="fa-solid fa-hashtag" aria-hidden="true"></i>
          Browse Channel List
        </button>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn-secondary" @click="$emit('close')">Cancel</button>
        <button type="submit" class="btn-primary" :disabled="!normalized">Join</button>
      </footer>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useChannelListModal } from '../composables/useChannelListModal.js';
import { ensureChannelPrefix } from '../utils/channelTarget.js';

const props = defineProps<{ networkId: number }>();
const emit = defineEmits<{ close: [] }>();

const networks = useNetworksStore();
const buffers = useBuffersStore();
const channelListModal = useChannelListModal();

const inputEl = ref<HTMLInputElement | null>(null);
const channel = ref('');

const networkLabel = computed(() => {
  const net = networks.networks.find((n) => n.id === props.networkId);
  return net?.name || `net:${props.networkId}`;
});

// Settle the channel prefix (ensureChannelPrefix: bare names get a leading #),
// then reject anything that isn't a valid target so the Join button stays
// disabled: channel names can't contain whitespace, and a lone prefix has no
// name — either would otherwise send a JOIN the server just rejects.
const normalized = computed(() => {
  const raw = channel.value.trim();
  if (!raw || /\s/.test(raw)) return '';
  const withPrefix = ensureChannelPrefix(raw);
  return withPrefix.length > 1 ? withPrefix : '';
});

function onJoin() {
  const target = normalized.value;
  if (!target) return;
  // joinOrToast switches to an already-open buffer or sends a JOIN, and warns
  // if the socket is closed so the click isn't a silent no-op. The modal still
  // closes either way.
  buffers.joinOrToast(props.networkId, target);
  emit('close');
}

// Hand off to the full channel-list browser for the same network. Close this
// modal first; the shared channel-list toggle then renders it (both live off
// singleton composables, so opening one and closing the other just works).
function onBrowse() {
  const id = props.networkId;
  emit('close');
  channelListModal.open(id);
}

onMounted(() => {
  setTimeout(() => inputEl.value?.focus(), 0);
});
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.chan-input {
  background: var(--bg-soft);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: var(--space-4) var(--space-5);
  font: inherit;
}
.chan-input:focus {
  outline: 1px solid var(--accent);
}
/* Secondary path — a full-width, quiet button that reads as "or, browse" rather
   than competing with the primary Join action in the footer. */
.browse {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  background: transparent;
  border: 1px solid var(--border);
  color: var(--accent);
  font: inherit;
  padding: var(--space-3) var(--space-5);
  cursor: pointer;
}
.browse:hover {
  border-color: var(--accent);
  color: var(--fg);
}
</style>
