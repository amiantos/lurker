// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Keeps voice-call presence badges correct across connect/reconnect edges. The
// server's `call-presence` frame only carries live join/leave deltas, so a
// client that connects (cold launch) or reconnects mid-call would otherwise
// never learn about a call that started while it had no socket. On each connect
// edge we re-snapshot every connected network's active calls from the server
// (which reads the SFU — correct even across a Lurker restart).
//
// Detached, idempotent module singleton — mirrors startBufferHydration so it
// survives the Desktop<->Mobile shell swap without double-registering.

import { computed, effectScope, watch } from 'vue';
import { connected } from './useSocket.js';
import { useNetworksStore } from '../stores/networks.js';
import { useConfigStore } from '../stores/config.js';
import { useCallPresenceStore } from '../stores/callPresence.js';

let started = false;

export function startCallPresenceHydration(): void {
  if (started) return;
  started = true;

  effectScope(true).run(() => {
    const networks = useNetworksStore();
    const config = useConfigStore();
    const presence = useCallPresenceStore();

    // The set of networks we can meaningfully hydrate right now, as a stable
    // string key. Watching this (not the raw `connected` edge) is what makes
    // hydration reliable: a network's per-connection state arrives over the WS
    // *after* the socket opens, and voiceEnabled lands after the config fetch —
    // so a one-shot fire on the connect edge would run before either was ready
    // and never retry. Re-deriving from all three reactive inputs means we fire
    // the moment a network actually becomes connected, on every reconnect, and
    // if voice is enabled late.
    const hydratableKey = computed(() => {
      if (!connected.value || !config.voiceEnabled) return '';
      return networks.networks
        .filter((n) => networks.states[n.id]?.state === 'connected')
        .map((n) => n.id)
        .sort((a, b) => a - b)
        .join(',');
    });

    watch(
      hydratableKey,
      (key) => {
        if (!key) return;
        for (const id of key.split(',')) void presence.hydrate(Number(id));
      },
      { immediate: true },
    );
  });
}
