// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Declarative hydration reconciler for the active buffer's message list.
//
// Fresh-connect snapshots ship channel/DM buffers as empty SHELLS; the actual
// messages load lazily via a `history latest` fetch. Historically that fetch
// fired from exactly one place — activate(), at the instant of the click — so
// any bad instant produced a persistently blank buffer with no recovery:
//   - click while the socket is closed (mobile foregrounding races the 2s
//     reconnect timer) → send fails silently, nothing retries;
//   - reply lost to a socket drop mid-flight → loadingHistory wedged forever;
//   - reconnect wipes a detached buffer (pendingRefetch) but the flag was only
//     consumed by activate(), which never re-runs for the buffer you're
//     already in;
//   - a resume snapshot re-shells a never-hydrated buffer (empty gap frame).
//
// This watcher inverts that: hydration is an INVARIANT, not an event. Whenever
// the active buffer needs hydration (bufferNeedsHydration) AND the socket is
// connected, fire the fetch — on activate-while-offline followed by reconnect,
// on socket-close flag cleanup (failInFlightHistory makes the wedged buffer
// eligible again), on a resume re-shell flipping `unseeded` back on. The bad
// instant no longer matters; the invariant re-asserts itself as soon as its
// preconditions come back.
//
// Module-level singleton (like the socket itself): started once from
// useChatBootstrap and never stopped — the Desktop<->Mobile shell swap
// remounts that composable, and a component-scoped watcher would either die
// with the old shell or double-register with the new one.

import { computed, watch } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore, bufferNeedsHydration } from '../stores/buffers.js';
import { connected } from './useSocket.js';

// Floor between automatic attempts for the SAME buffer. Normal operation never
// hits it (the first attempt per buffer/reconnect fires immediately, and
// loadingHistory suppresses `needs` while a fetch is in flight). It exists to
// bound the pathological loop where a fetch "succeeds" yet leaves the buffer
// still-needy — e.g. a latest reply whose rows all filter out client-side —
// turning what would be a tight refetch spin into a slow, self-limiting retry.
const RETRY_THROTTLE_MS = 5000;

let started = false;
let lastAttemptKey: string | null = null;
let lastAttemptAt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export function startBufferHydration(): void {
  if (started) return;
  started = true;
  const networks = useNetworksStore();
  const buffers = useBuffersStore();

  const needs = computed(() => {
    if (!connected.value) return false;
    const key = networks.activeKey;
    if (!key) return false;
    // Virtual buffers without a store entry (the FRIENDS overview) resolve to
    // null; the system buffer is excluded inside bufferNeedsHydration.
    const buf = buffers.byKey(key);
    return !!buf && bufferNeedsHydration(buf);
  });

  const attempt = (): void => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    // Re-check on entry: state may have moved while a retry timer was pending
    // (fetch landed, buffer switched, socket dropped).
    if (!needs.value) return;
    const key = networks.activeKey;
    if (!key) return;
    const now = Date.now();
    if (key === lastAttemptKey && now - lastAttemptAt < RETRY_THROTTLE_MS) {
      // Too soon for the same buffer — re-arm rather than drop, so a throttled
      // attempt still happens once the window opens (there may be no further
      // reactive transition to re-trigger us).
      retryTimer = setTimeout(attempt, RETRY_THROTTLE_MS - (now - lastAttemptAt));
      return;
    }
    lastAttemptKey = key;
    lastAttemptAt = now;
    const buf = buffers.byKey(key);
    if (buf) buffers.ensureHydrated(buf.networkId, buf.target);
  };

  // immediate: the app can start with a persisted activeKey pointing at a
  // shell (cold PWA launch) — reconcile the initial state, not just changes.
  watch(
    needs,
    (n) => {
      if (n) attempt();
    },
    { immediate: true },
  );
}
