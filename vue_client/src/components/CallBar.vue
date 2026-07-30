<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Persistent, floating voice/video call window. Mounted once globally in App.vue
  (reads the singleton voice store, so it survives buffer switches). Draggable by
  its header, resizable from the bottom-right, and grows a video tile grid when
  anyone shares camera/screen. Individual tiles can go fullscreen.
-->

<template>
  <div
    v-if="voice.active || voice.connecting"
    class="call-bar"
    :class="{ 'has-video': voice.videoTiles.length }"
    :style="barStyle"
    role="dialog"
    aria-label="Voice call"
  >
    <div class="call-head" @pointerdown="onHeaderDown">
      <span class="dot" :class="{ live: voice.active }"></span>
      <span class="call-title">{{ voice.label || 'Voice call' }}</span>
      <span class="call-status">{{ statusText }}</span>
    </div>

    <div class="call-body">
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
    </div>

    <div class="call-actions">
      <button
        type="button"
        class="act"
        :class="{ active: !voice.muted }"
        :title="voice.muted ? 'Unmute' : 'Mute'"
        @click="voice.toggleMute()"
      >
        <i :class="voice.muted ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone'"></i>
      </button>
      <button
        type="button"
        class="act"
        :class="{ active: voice.cameraOn }"
        title="Toggle camera"
        @click="voice.toggleCamera()"
      >
        <i :class="voice.cameraOn ? 'fa-solid fa-video' : 'fa-solid fa-video-slash'"></i>
      </button>
      <button
        type="button"
        class="act"
        :class="{ active: voice.screenOn }"
        title="Share screen"
        @click="voice.toggleScreen()"
      >
        <i class="fa-solid fa-desktop"></i>
      </button>
      <button type="button" class="act leave" title="Leave call" @click="voice.leave()">
        <i class="fa-solid fa-phone-slash"></i>
      </button>
    </div>

    <p v-if="voice.error" class="call-error">{{ voice.error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';
import { useVoiceStore } from '../stores/voice.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { api } from '../api.js';
import VideoTile from './VideoTile.vue';

const voice = useVoiceStore();
const buffers = useBuffersStore();
const networks = useNetworksStore();
const statusText = computed(() => (voice.connecting ? 'Connecting…' : 'Connected'));

// ─── Drag ──────────────────────────────────────────────────────────────────
const pos = ref<{ x: number; y: number } | null>(null);
let offset = { x: 0, y: 0 };
const barStyle = computed(() =>
  pos.value
    ? { left: `${pos.value.x}px`, top: `${pos.value.y}px`, right: 'auto', bottom: 'auto' }
    : {},
);
function onHeaderDown(e: PointerEvent) {
  const bar = (e.currentTarget as HTMLElement).closest('.call-bar') as HTMLElement | null;
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  offset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
function onMove(e: PointerEvent) {
  const x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - offset.x));
  const y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - offset.y));
  pos.value = { x, y };
}
function onUp() {
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
}
onBeforeUnmount(onUp);

// ─── Op moderation ─────────────────────────────────────────────────────────
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
  display: flex;
  flex-direction: column;
  width: 16rem;
  max-width: calc(100vw - 2rem);
  max-height: calc(100vh - 2rem);
  min-width: 13rem;
  min-height: 5rem;
  border-radius: 0.6rem;
  background: var(--panel-bg, #1b1d24);
  color: var(--text, #e7e9ee);
  border: 1px solid var(--border, #2c2f38);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  font-size: 0.85rem;
  overflow: hidden;
  resize: both;
}
.call-bar.has-video {
  width: 32rem;
  min-height: 16rem;
}
.call-head {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.5rem 0.65rem;
  border-bottom: 1px solid var(--border, #2c2f38);
  cursor: move;
  user-select: none;
  touch-action: none;
  flex: 0 0 auto;
}
.dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: var(--fg-muted, #9aa0ac);
  flex: 0 0 auto;
}
.dot.live {
  background: #3ddc84;
  box-shadow: 0 0 0 3px rgba(61, 220, 132, 0.18);
}
.call-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.call-status {
  margin-left: auto;
  opacity: 0.65;
  font-size: 0.72rem;
}
.call-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0.6rem;
  min-height: 0;
}
.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.4rem;
  margin-bottom: 0.5rem;
}
.call-parts {
  list-style: none;
  margin: 0;
  padding: 0;
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
  height: 0.55rem;
  margin-top: 0.1rem;
  cursor: pointer;
  accent-color: var(--accent, #6ea8fe);
}
.call-empty {
  margin: 0;
  opacity: 0.55;
}
.call-actions {
  display: flex;
  gap: 0.4rem;
  padding: 0.5rem 0.6rem;
  border-top: 1px solid var(--border, #2c2f38);
  flex: 0 0 auto;
}
.call-actions .act {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 2rem;
  border-radius: 0.4rem;
  border: 1px solid var(--border, #2c2f38);
  background: var(--button-bg, #262933);
  color: inherit;
  cursor: pointer;
  font-size: 0.9rem;
}
.call-actions .act:hover {
  border-color: var(--accent, #6ea8fe);
}
.call-actions .act.active {
  background: var(--accent, #6ea8fe);
  color: #08101f;
  border-color: transparent;
}
.call-actions .act.leave {
  background: var(--danger-bg, #6e2b2b);
  color: #ffdede;
}
.call-error {
  margin: 0;
  padding: 0 0.6rem 0.5rem;
  color: var(--danger, #ff6b6b);
  font-size: 0.75rem;
}
</style>
