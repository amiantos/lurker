// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useHighlightsStore } from '../stores/highlights.js';
import { useBookmarksStore } from '../stores/bookmarks.js';
import { useHighlightRulesStore } from '../stores/highlightRules.js';
import { useInputHistoryStore } from '../stores/inputHistory.js';
import { useNavHistoryStore } from '../stores/navHistory.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useDraftStore } from '../stores/drafts.js';
import { usePushSubscriptionsStore } from '../stores/pushSubscriptions.js';
import { usePinsStore } from '../stores/pins.js';
import { useFavoritesStore } from '../stores/favorites.js';
import { useNetworkPresetsStore } from '../stores/networkPresets.js';
import { useSplitsStore } from '../stores/splits.js';
import { resetSocket } from './useSocket.js';
import { resetPresence } from './usePresence.js';
import { resetAllScrollState } from './useScrollState.js';
import { resetViewedBuffers } from './useViewedBuffer.js';
import { resetPanes } from './usePaneRegistry.js';
import { resetOnboarding } from './useOnboarding.js';
import { clearAppBadgeNow } from './useAppBadge.js';

// Wipe every session-scoped piece of client state so the next user (after
// logout or invite redemption) starts from a clean slate. The auth store is
// the caller's responsibility — clear or set `auth.user` *before* invoking,
// so the WS reconnect arm in useSocket.onclose sees the right value if any
// late close handlers fire.
export function resetSession(): void {
  resetSocket();
  const buffers = useBuffersStore();
  buffers.resetTimers();
  buffers.$reset();
  useNetworksStore().$reset();
  useSettingsStore().$reset();
  useHighlightsStore().$reset();
  // Saved messages are per-account and this store holds fetched ROWS, not just ids —
  // leaving them would show the next user the previous one's saved conversations. It was
  // never in this list; the `bookmark-ids-snapshot` frame used to overwrite the id set on
  // every connect, which hid the gap for the ids and never covered the rows at all.
  useBookmarksStore().$reset();
  useHighlightRulesStore().$reset();
  useInputHistoryStore().$reset();
  useNavHistoryStore().$reset();
  useRecentBuffersStore().$reset();
  const drafts = useDraftStore();
  drafts.resetTimers();
  drafts.$reset();
  usePushSubscriptionsStore().$reset();
  usePinsStore().$reset();
  useFavoritesStore().$reset();
  // Instance policy is the same for everyone on the box, but the *fetched* flag
  // isn't — leaving it loaded would hand the next user a picker built from a
  // response fetched under someone else's session.
  useNetworkPresetsStore().$reset();
  // Pane layout is per-session view state — $reset() rather than the store's own
  // reset() for the same reason every other store here uses it: the buffers this
  // layout points at were wiped above, so there is no per-pane teardown left to
  // run, only state to drop.
  useSplitsStore().$reset();
  resetPresence();
  resetAllScrollState();
  resetViewedBuffers();
  // Module-level Map of pane handles, like the two above — not Pinia state, so
  // $reset() doesn't reach it. Panes unmount on logout and deregister
  // themselves, but clear it explicitly so a handle can't outlive the session
  // if teardown order ever changes.
  resetPanes();
  // Closing the first-run flow unmounts it, which is what drops the half-filled
  // form (nick, SASL password) with it — the next user re-evaluates from scratch.
  resetOnboarding();
  // Drop the PWA app-icon badge so a stale highlight count doesn't outlive the
  // session. buffers.$reset() above already zeroes the total, but clear
  // explicitly in case the Badging watcher isn't wired in this context.
  clearAppBadgeNow();
}
