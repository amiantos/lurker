<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  A persistent voice-call bar. Shown while a call is connecting or active so the
  user can keep reading/typing during the call. Mounted once, globally, in
  App.vue; it reads the singleton voice store, so it survives buffer switches.
  Deliberately plain — a first-pass surface for amiantos to restyle.
-->

<template>
  <div v-if="voice.active || voice.connecting" class="call-bar" role="dialog" aria-label="Voice call">
    <div class="call-head">
      <i class="fa-solid fa-phone"></i>
      <span class="call-title">{{ voice.label || 'Voice call' }}</span>
      <span class="call-status">{{ statusText }}</span>
    </div>

    <ul v-if="voice.participants.length" class="call-parts">
      <li v-for="id in voice.participants" :key="id" :class="{ talking: voice.speaking.includes(id) }">
        <i v-if="voice.speaking.includes(id)" class="fa-solid fa-volume-high"></i>
        <span>{{ id }}</span>
      </li>
    </ul>
    <p v-else class="call-empty">Just you so far…</p>

    <div class="call-actions">
      <button type="button" :class="{ muted: voice.muted }" @click="voice.toggleMute()">
        <i :class="voice.muted ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone'"></i>
        {{ voice.muted ? 'Unmute' : 'Mute' }}
      </button>
      <button type="button" class="leave" @click="voice.leave()">
        <i class="fa-solid fa-phone-slash"></i> Leave
      </button>
    </div>

    <p v-if="voice.error" class="call-error">{{ voice.error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useVoiceStore } from '../stores/voice.js';

const voice = useVoiceStore();
const statusText = computed(() => (voice.connecting ? 'Connecting…' : 'Connected'));
</script>

<style scoped>
.call-bar {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 60;
  width: 15rem;
  padding: 0.75rem;
  border-radius: 0.5rem;
  background: var(--panel-bg, #1b1d24);
  color: var(--text, #e7e9ee);
  border: 1px solid var(--border, #2c2f38);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  font-size: 0.85rem;
}
.call-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.5rem;
}
.call-title {
  font-weight: 600;
}
.call-status {
  margin-left: auto;
  opacity: 0.7;
  font-size: 0.75rem;
}
.call-parts {
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0;
  max-height: 8rem;
  overflow-y: auto;
}
.call-parts li {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.1rem 0;
}
.call-parts li.talking {
  color: var(--accent, #6ea8fe);
}
.call-empty {
  margin: 0 0 0.5rem;
  opacity: 0.6;
}
.call-actions {
  display: flex;
  gap: 0.4rem;
}
.call-actions button {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  padding: 0.35rem 0.5rem;
  border-radius: 0.35rem;
  border: 1px solid var(--border, #2c2f38);
  background: var(--button-bg, #262933);
  color: inherit;
  cursor: pointer;
}
.call-actions button.muted {
  background: var(--warn-bg, #5a4a1e);
}
.call-actions button.leave {
  background: var(--danger-bg, #6e2b2b);
}
.call-error {
  margin: 0.5rem 0 0;
  color: var(--danger, #ff6b6b);
  font-size: 0.75rem;
}
</style>
