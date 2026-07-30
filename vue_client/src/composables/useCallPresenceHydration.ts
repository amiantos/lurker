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

import { effectScope, watch } from 'vue';
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

    const hydrateAll = (): void => {
      if (!connected.value || !config.voiceEnabled) return;
      for (const n of networks.networks) {
        if (networks.states[n.id]?.state === 'connected') void presence.hydrate(n.id);
      }
    };

    // immediate: reconcile the initial connected state on cold launch, not just
    // later transitions. Re-runs on every reconnect edge.
    watch(
      connected,
      (isUp) => {
        if (isUp) hydrateAll();
      },
      { immediate: true },
    );
  });
}
