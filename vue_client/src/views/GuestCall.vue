<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Public guest voice-call page (/call/:token). Someone without an account opens
  the capability link, picks a display name, and joins the call. It exchanges
  the link token for a room-scoped LiveKit token and connects via the shared
  voice store; the global CallBar then provides the in-call controls.
-->

<template>
  <div class="guest-call">
    <div class="card">
      <h1><i class="fa-solid fa-phone"></i> Join voice call</h1>

      <p v-if="!config.voiceEnabled" class="err">Voice calling isn't available here.</p>

      <template v-else-if="!voice.active && !voice.connecting">
        <p class="hint">You've been invited to a voice call. Pick a name to join.</p>
        <input
          v-model="name"
          class="name"
          placeholder="Your name"
          maxlength="24"
          spellcheck="false"
          @keyup.enter="join"
        />
        <button class="join" type="button" :disabled="!name.trim() || joining" @click="join">
          {{ joining ? 'Joining…' : 'Join call' }}
        </button>
        <p v-if="error" class="err">{{ error }}</p>
      </template>

      <template v-else-if="voice.connecting">
        <p class="hint">Connecting…</p>
      </template>

      <template v-else>
        <p class="ok"><i class="fa-solid fa-check"></i> You're in the call.</p>
        <p class="hint">Use the call controls in the corner to mute or leave.</p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import { useVoiceStore } from '../stores/voice.js';
import { useConfigStore } from '../stores/config.js';
import { api } from '../api.js';

const route = useRoute();
const voice = useVoiceStore();
const config = useConfigStore();

const token = String(route.params.token || '');
const name = ref('');
const joining = ref(false);
const error = ref('');

async function join() {
  if (!name.value.trim() || joining.value) return;
  joining.value = true;
  error.value = '';
  try {
    const r = await api<{ token: string; url: string }>('/api/voice/guest-token', {
      method: 'POST',
      body: { token, name: name.value.trim() },
    });
    await voice.connectWithToken(r.url, r.token, 'Guest call', { guest: true });
    if (voice.error) error.value = voice.error;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'could not join the call';
  } finally {
    joining.value = false;
  }
}
</script>

<style scoped>
.guest-call {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: var(--bg, #0f1116);
  color: var(--text, #e7e9ee);
}
.card {
  width: 100%;
  max-width: 22rem;
  padding: 1.5rem;
  border-radius: 0.75rem;
  background: var(--panel-bg, #1b1d24);
  border: 1px solid var(--border, #2c2f38);
  text-align: center;
}
.card h1 {
  font-size: 1.15rem;
  margin: 0 0 0.75rem;
}
.hint {
  opacity: 0.75;
  margin: 0 0 1rem;
  font-size: 0.9rem;
}
.name {
  width: 100%;
  padding: 0.5rem 0.6rem;
  margin-bottom: 0.75rem;
  border-radius: 0.4rem;
  border: 1px solid var(--border, #2c2f38);
  background: var(--bg-soft, #14161c);
  color: inherit;
  font-size: 1rem;
}
.join {
  width: 100%;
  padding: 0.55rem;
  border-radius: 0.4rem;
  border: none;
  background: var(--accent, #6ea8fe);
  color: #08101f;
  font-weight: 600;
  cursor: pointer;
}
.join:disabled {
  opacity: 0.55;
  cursor: default;
}
.ok {
  color: var(--accent, #6ea8fe);
  font-weight: 600;
}
.err {
  color: var(--danger, #ff6b6b);
  font-size: 0.85rem;
  margin: 0.5rem 0 0;
}
</style>
