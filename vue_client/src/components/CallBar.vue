<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  A persistent voice-call bar. Shown while a call is connecting or active so the
  user can keep reading/typing during the call. Mounted once, globally, in
  App.vue; it reads the singleton voice store, so it survives buffer switches.
  Deliberately plain — a first-pass surface for amiantos to restyle.
-->

<template>
  <div
    v-if="voice.active || voice.connecting"
    class="call-bar"
    :class="{ 'has-video': voice.videoTiles.length }"
    role="dialog"
    aria-label="Voice call"
  >
    <div class="call-head">
      <i class="fa-solid fa-phone"></i>
      <span class="call-title">{{ voice.label || 'Voice call' }}</span>
      <span class="call-status">{{ statusText }}</span>
    </div>

    <div v-if="voice.videoTiles.length" class="video-grid">
      <VideoTile
        v-for="t in voice.videoTiles"
        :key="`${t.identity}|${t.source}`"
        :identity="t.identity"
        :source="t.source"
        :self="t.self"
      />
    </div>

    <ul v-if="voice.participants.length" class="call-parts">
      <li
        v-for="id in voice.participants"
        :key="id"
        :class="{ talking: voice.speaking.includes(id) }"
      >
        <div class="part-row">
          <i
            class="fa-solid"
            :class="voice.speaking.includes(id) ? 'fa-volume-high' : 'fa-user'"
          ></i>
          <span class="part-nick" :title="id">{{ id }}</span>
          <button
            v-if="amOp"
            type="button"
            class="mod"
            title="Mute in call"
            @click="moderate(id, 'mute')"
          >
            <i class="fa-solid fa-microphone-slash"></i>
          </button>
          <button
            v-if="amOp"
            type="button"
            class="mod danger"
            title="Remove from call"
            @click="moderate(id, 'remove')"
          >
            <i class="fa-solid fa-user-slash"></i>
          </button>
        </div>
        <input
          class="vol"
          type="range"
          min="0"
          max="100"
          :value="volPct(id)"
          :aria-label="`Volume for ${id}`"
          @input="onVol(id, $event)"
        />
      </li>
    </ul>
    <p v-else class="call-empty">Just you so far…</p>

    <div class="call-actions">
      <button type="button" :class="{ muted: voice.muted }" @click="voice.toggleMute()">
        <i :class="voice.muted ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone'"></i>
        {{ voice.muted ? 'Unmute' : 'Mute' }}
      </button>
      <button
        type="button"
        class="icon-btn"
        :class="{ on: voice.cameraOn }"
        title="Toggle camera"
        @click="voice.toggleCamera()"
      >
        <i :class="voice.cameraOn ? 'fa-solid fa-video' : 'fa-solid fa-video-slash'"></i>
      </button>
      <button
        type="button"
        class="icon-btn"
        :class="{ on: voice.screenOn }"
        title="Share screen"
        @click="voice.toggleScreen()"
      >
        <i class="fa-solid fa-desktop"></i>
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
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { api } from '../api.js';
import VideoTile from './VideoTile.vue';

const voice = useVoiceStore();
const buffers = useBuffersStore();
const networks = useNetworksStore();
const statusText = computed(() => (voice.connecting ? 'Connecting…' : 'Connected'));

// Am I an operator of the call's channel? Gates the mute/remove controls (the
// server enforces this too). Guests never moderate.
const MODERATE_MODES = ['q', 'a', 'o', 'h'];
const amOp = computed(() => {
  if (voice.isGuest || voice.networkId == null) return false;
  const b = buffers.byKey(`${voice.networkId}::${voice.target.toLowerCase()}`);
  const selfNick = networks.states[voice.networkId]?.nick;
  if (!b || !selfNick) return false;
  const me = b.members?.find((m) => m.nick.toLowerCase() === selfNick.toLowerCase());
  return !!me?.modes?.some((mm) => MODERATE_MODES.includes(mm));
});

function volPct(id: string): number {
  return Math.round((voice.volumes[id] ?? 1) * 100);
}
function onVol(id: string, e: Event) {
  voice.setVolume(id, Number((e.target as HTMLInputElement).value) / 100);
}

async function moderate(identity: string, action: 'mute' | 'remove') {
  if (voice.networkId == null) return;
  try {
    await api('/api/voice/moderate', {
      method: 'POST',
      body: { networkId: voice.networkId, target: voice.target, action, identity },
    });
  } catch {
    /* server enforces; ignore transient failures */
  }
}
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
  padding: 0.15rem 0;
}
.part-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.part-nick {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.call-parts li.talking .part-nick {
  color: var(--accent, #6ea8fe);
}
.part-row .mod {
  border: none;
  background: transparent;
  color: var(--fg-muted, #9aa0ac);
  cursor: pointer;
  padding: 0 0.15rem;
}
.part-row .mod:hover {
  color: var(--text, #e7e9ee);
}
.part-row .mod.danger:hover {
  color: var(--danger, #ff6b6b);
}
.vol {
  width: 100%;
  height: 0.6rem;
  margin-top: 0.1rem;
  cursor: pointer;
}
.call-bar.has-video {
  width: 30rem;
  max-width: calc(100vw - 2rem);
}
.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
  gap: 0.35rem;
  margin-bottom: 0.5rem;
  max-height: 24rem;
  overflow-y: auto;
}
.call-empty {
  margin: 0 0 0.5rem;
  opacity: 0.6;
}
.call-actions .icon-btn {
  flex: 0 0 auto;
}
.call-actions button.on {
  background: var(--accent, #6ea8fe);
  color: #08101f;
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
