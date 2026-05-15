// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useHighlightsStore } from '../stores/highlights.js';
import { useHighlightRulesStore } from '../stores/highlightRules.js';
import { useInputHistoryStore } from '../stores/inputHistory.js';
import { useDraftStore } from '../stores/drafts.js';
import { usePushSubscriptionsStore } from '../stores/pushSubscriptions.js';
import { usePinsStore } from '../stores/pins.js';
import { resetSocket } from './useSocket.js';
import { resetPresence } from './usePresence.js';
import { resetScrollState } from './useScrollState.js';

// Wipe every session-scoped piece of client state so the next user (after
// logout or invite redemption) starts from a clean slate. The auth store is
// the caller's responsibility — clear or set `auth.user` *before* invoking,
// so the WS reconnect arm in useSocket.onclose sees the right value if any
// late close handlers fire.
export function resetSession() {
  resetSocket();
  const buffers = useBuffersStore();
  buffers._resetTimers();
  buffers.$reset();
  useNetworksStore().$reset();
  useSettingsStore().$reset();
  useHighlightsStore().$reset();
  useHighlightRulesStore().$reset();
  useInputHistoryStore().$reset();
  const drafts = useDraftStore();
  drafts._resetTimers();
  drafts.$reset();
  usePushSubscriptionsStore().$reset();
  usePinsStore().$reset();
  resetPresence();
  resetScrollState();
}
