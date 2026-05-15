// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useAuthStore } from '../stores/auth.js';
import { useSettingsStore } from '../stores/settings.js';
import { useHighlightRulesStore } from '../stores/highlightRules.js';
import { useInputHistoryStore } from '../stores/inputHistory.js';
import { useDraftStore } from '../stores/drafts.js';
import { useChanlistStore } from '../stores/chanlist.js';
import { useSearchStore } from '../stores/search.js';
import { usePinsStore } from '../stores/pins.js';
import { useNicklistCollapseStore } from '../stores/nicklistCollapse.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { notifyForEvent } from './useHighlightNotifier.js';

let socket = null;
const connected = ref(false);
let reconnectTimer = null;
const openHandlers = new Set();
// Outstanding send/action ACKs keyed by clientId. Resolver is called with
// { ok, error } when the server returns a send-result, on socket close, or on
// timeout — whichever fires first.
const pendingAcks = new Map();
const ACK_TIMEOUT_MS = 8000;
// Highest event id this client has ever received in any buffer. Sent on
// reconnect as `?since=N` so the server can ship just the gap instead of
// re-issuing the whole last-50-per-buffer backlog. Per-buffer dedupe in
// buffers.pushMessage handles any residual overlap if the gap is empty.
let lastSeenEventId = 0;

export function onSocketOpen(handler) {
  openHandlers.add(handler);
  return () => openHandlers.delete(handler);
}

// If the tab has been hidden for more than this, ask the server for a fresh
// snapshot on return. This collapses a long queue of buffered live events
// (which would otherwise drip into the UI one frame at a time) into a single
// atomic backlog replace — i.e. the view "snaps" to current state.
const HIDDEN_RESNAPSHOT_MS = 30_000;
let hiddenSince = null;
let visibilityWired = false;

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const base = `${proto}://${window.location.host}/ws`;
  return lastSeenEventId > 0 ? `${base}?since=${lastSeenEventId}` : base;
}

function trackSeenId(eventId) {
  if (typeof eventId === 'number' && eventId > lastSeenEventId) {
    lastSeenEventId = eventId;
  }
}

function applyEvent(event) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();

  switch (event.type) {
    case 'state':
      networks.applyState(event);
      break;
    case 'message':
    case 'action': {
      // pushMessage returns false on dedupe (a replayed event we already had).
      // Skip the speaker side effect in that case — replaying would re-seed
      // speakers with stale times. Unread/highlight counts come from the
      // server's read-state broadcast (fired after every countable event),
      // so we don't increment them here.
      if (!buffers.pushMessage(event)) break;
      // Speakers feeds tab-complete and the nick-picker. Our own messages
      // would just clutter our own suggestions, so they don't count as
      // "people who recently spoke here."
      if (event.nick && !event.self) {
        buffers.recordSpeaker(event.networkId, event.target, event.nick,
          Date.parse(event.time) || Date.now());
      }
      // Skipped on dedupe (above), so replayed events from a resume gap
      // can't re-fire a toast or sound for highlights we've already seen.
      notifyForEvent(event);
      break;
    }
    case 'notice':
      if (!buffers.pushMessage(event)) break;
      notifyForEvent(event);
      break;
    // For events that carry an id AND mutate buffer state (member list,
    // topic), run the dedupe in pushMessage first. On a replay the mutation
    // would re-apply stale state (e.g. revert the topic) — skip both.
    case 'join':
      if (!buffers.pushMessage(event)) break;
      buffers.addMember(event.networkId, event.target, event.nick);
      break;
    case 'part':
    case 'quit':
      if (!buffers.pushMessage(event)) break;
      buffers.removeMember(event.networkId, event.target, event.nick);
      break;
    case 'kick':
      if (!buffers.pushMessage(event)) break;
      buffers.removeMember(event.networkId, event.target, event.kicked);
      break;
    case 'nick':
      if (!buffers.pushMessage(event)) break;
      buffers.renameMember(event.networkId, event.target, event.nick, event.newNick);
      break;
    case 'topic':
      if (!buffers.pushMessage(event)) break;
      buffers.setTopic(event.networkId, event.target, event.text);
      break;
    case 'mode':
      buffers.pushMessage(event);
      break;
    case 'channel-modes':
      buffers.setChannelModes(event.networkId, event.target, event.modes);
      break;
    case 'lag':
      networks.applyLag(event);
      break;
    case 'usermode':
      networks.applyUserMode(event);
      break;
    case 'away-state':
      networks.applyAwayState(event);
      break;
    case 'names':
      buffers.setMembers(event.networkId, event.target, event.members);
      break;
    case 'channel-joined':
      buffers.ensure(event.networkId, event.target);
      buffers.setJoined(event.networkId, event.target, true);
      break;
    case 'channel-parted':
      // Keep the buffer around so the user can still scroll history; just
      // mark it un-joined so it renders dimmed in the buffer list. /close
      // (or the server's buffer-closed broadcast) is what actually drops it.
      buffers.setJoined(event.networkId, event.target, false);
      buffers.setMembers(event.networkId, event.target, []);
      break;
    case 'typing':
      buffers.setTyping(event.networkId, event.target, event.nick, event.state);
      break;
    case 'peer-presence':
      networks.applyPeerPresence(event.networkId, event.nick, {
        state: event.state,
        stateAt: event.stateAt,
        awayMessage: event.awayMessage,
      });
      break;
    case 'motd':
    case 'error':
      buffers.pushMessage({ ...event, target: event.target || `:server:${event.networkId}` });
      break;
    case 'chanlist-start': {
      const chanlist = useChanlistStore();
      chanlist.applyStart(event.networkId);
      break;
    }
    case 'chanlist-progress': {
      const chanlist = useChanlistStore();
      chanlist.applyProgress(event.networkId, event.total);
      break;
    }
    case 'chanlist-end': {
      const chanlist = useChanlistStore();
      chanlist.applyEnd(event.networkId, event.total);
      // Re-run the current search so the just-cached rows replace whatever
      // was on screen. The modal listens for inProgress=false and triggers
      // its own refresh; rather than couple the two paths, we let the modal
      // own the resync since it knows the current filter + scroll position.
      break;
    }
  }
}

function applySnapshot(snapshot) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const pins = usePinsStore();
  const nicklistCollapse = useNicklistCollapseStore();
  const channelNotify = useChannelNotifyStore();
  networks.applySnapshot(snapshot);
  pins.applySnapshot(snapshot);
  nicklistCollapse.applySnapshot(snapshot);
  channelNotify.applySnapshot(snapshot);
  for (const net of snapshot) {
    for (const ch of net.channels) {
      // Snapshot members are already { nick, modes } objects from the server.
      // Tolerate the legacy plain-string shape in case an old snapshot is in flight.
      const normalized = ch.members.map((m) =>
        typeof m === 'string'
          ? { nick: m, modes: [], away: false }
          : { nick: m.nick, modes: m.modes || [], away: !!m.away }
      );
      buffers.setMembers(net.networkId, ch.name, normalized);
      buffers.setTopic(net.networkId, ch.name, ch.topic);
      buffers.setChannelModes(net.networkId, ch.name, ch.modes || '');
    }
  }
}

function applyBacklog(payload) {
  const buffers = useBuffersStore();
  buffers.replaceBacklog(payload.networkId, payload.target, payload.events, payload.speakers, {
    lastReadId: payload.lastReadId,
    unread: payload.unread,
    highlights: payload.highlights,
    highlightsCapped: payload.highlightsCapped,
  }, payload.joined);
  if (payload.inputHistory) {
    const inputHistory = useInputHistoryStore();
    inputHistory.seed(payload.networkId, payload.target, payload.inputHistory);
  }
}

function handleMessage(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return; }

  if (payload.kind === 'snapshot') {
    applySnapshot(payload.networks);
    return;
  }
  if (payload.kind === 'backlog') {
    if (Array.isArray(payload.events)) {
      for (const e of payload.events) trackSeenId(e?.id);
    }
    applyBacklog(payload);
    return;
  }
  if (payload.kind === 'history') {
    // History pages are *older* events than what we already have — they
    // shouldn't advance the resume cursor.
    const buffers = useBuffersStore();
    buffers.prependHistory(payload.networkId, payload.target, payload.events, payload.hasMore, payload.speakers);
    return;
  }
  if (payload.kind === 'irc') {
    trackSeenId(payload.id);
    applyEvent(payload);
    return;
  }
  if (payload.kind === 'settings') {
    const settings = useSettingsStore();
    settings.applyRemote(payload);
    return;
  }
  if (payload.kind === 'highlight-rules-changed') {
    const rules = useHighlightRulesStore();
    if (rules.loaded) rules.applyServerChanged();
    return;
  }
  if (payload.kind === 'read-state') {
    const buffers = useBuffersStore();
    buffers.applyReadState(payload.networkId, payload.target, {
      lastReadId: payload.lastReadId,
      unread: payload.unread,
      highlights: payload.highlights,
      highlightsCapped: payload.highlightsCapped,
    });
    return;
  }
  if (payload.kind === 'buffer-closed') {
    const networks = useNetworksStore();
    const buffers = useBuffersStore();
    const inputHistory = useInputHistoryStore();
    const drafts = useDraftStore();
    const closedKey = `${payload.networkId}::${payload.target}`;
    if (networks.activeKey === closedKey) networks.activeKey = null;
    buffers.drop(payload.networkId, payload.target);
    // History rows survive on the server (re-seeded if the buffer reopens);
    // we just drop the in-memory mirror so it doesn't go stale.
    inputHistory.drop(payload.networkId, payload.target);
    // Drafts for a closed buffer are cleared server-side too (wsHub's
    // close-buffer handler). Mirror that locally so a future reopen starts
    // empty rather than restoring the pre-close draft.
    drafts.drop(payload.networkId, payload.target);
    return;
  }
  if (payload.kind === 'input-history-added') {
    const inputHistory = useInputHistoryStore();
    inputHistory.add(payload.networkId, payload.target, payload.text);
    return;
  }
  if (payload.kind === 'draft-snapshot') {
    const drafts = useDraftStore();
    drafts.seed(payload.drafts || []);
    return;
  }
  if (payload.kind === 'draft-updated') {
    const drafts = useDraftStore();
    drafts.applyRemoteUpdate(payload.networkId, payload.target, payload.body);
    return;
  }
  if (payload.kind === 'chanlist-state') {
    const chanlist = useChanlistStore();
    chanlist.applyState(payload);
    return;
  }
  if (payload.kind === 'chanlist-result') {
    const chanlist = useChanlistStore();
    chanlist.applyResult(payload);
    return;
  }
  if (payload.kind === 'search-result') {
    const search = useSearchStore();
    search.applyResult(payload);
    return;
  }
  if (payload.kind === 'pins-changed') {
    const pins = usePinsStore();
    pins.setNetwork(payload.networkId, payload.pinned || []);
    return;
  }
  if (payload.kind === 'nicklist-collapsed-changed') {
    const nicklistCollapse = useNicklistCollapseStore();
    nicklistCollapse.applyChange(payload.networkId, payload.target, !!payload.collapsed);
    return;
  }
  if (payload.kind === 'channel-notify-changed') {
    const channelNotify = useChannelNotifyStore();
    channelNotify.applyChange(payload.networkId, payload.target, !!payload.notifyAlways);
    return;
  }
  if (payload.kind === 'buffer-reopened') {
    // Server cleared the closed flag because a new persisted message landed.
    // The client doesn't need to do anything here — the matching `irc` event
    // will recreate the buffer via pushMessage/ensureBuffer. We accept this
    // signal silently so future tabs/devices don't keep filtering.
    return;
  }
  if (payload.kind === 'send-result') {
    const resolver = pendingAcks.get(payload.clientId);
    if (resolver) resolver({ ok: !!payload.ok, error: payload.error });
    return;
  }
}

function open() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socket = new WebSocket(wsUrl());
  socket.onopen = () => {
    connected.value = true;
    for (const handler of openHandlers) {
      try { handler(); } catch (_) { /* ignore */ }
    }
  };
  socket.onmessage = (ev) => handleMessage(ev.data);
  socket.onclose = () => {
    connected.value = false;
    socket = null;
    // Anything we were waiting on is gone with the socket. Settle every
    // pending ACK as a disconnect so callers can surface the failure now
    // instead of waiting out the timeout.
    failAllPendingAcks('disconnected');
    const auth = useAuthStore();
    if (auth.user) {
      reconnectTimer = setTimeout(open, 2000);
    }
  };
  socket.onerror = () => {
    if (socket) socket.close();
  };
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function failAllPendingAcks(error) {
  if (!pendingAcks.size) return;
  const entries = Array.from(pendingAcks.values());
  pendingAcks.clear();
  for (const resolver of entries) resolver({ ok: false, error });
}

// Generate a clientId for an ACK-tracked send. Uses crypto.randomUUID where
// available and falls back to a random-base36 string otherwise (older Safari
// in non-secure contexts won't expose randomUUID).
function makeClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Send a payload that expects a `send-result` ACK from the server. Returns
// null synchronously if the socket isn't open — so the caller can detect
// "not even sent" before doing anything destructive (clearing the input,
// recording history). On a successful queue, returns a Promise<{ok, error}>
// that resolves when the server ACKs, the socket closes, or ACK_TIMEOUT_MS
// elapses — whichever fires first.
export function socketSendWithAck(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return null;
  const clientId = makeClientId();
  const wire = { ...payload, clientId };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingAcks.delete(clientId)) resolve({ ok: false, error: 'timeout' });
    }, ACK_TIMEOUT_MS);
    pendingAcks.set(clientId, (result) => {
      clearTimeout(timer);
      pendingAcks.delete(clientId);
      resolve(result);
    });
    try {
      socket.send(JSON.stringify(wire));
    } catch (_) {
      if (pendingAcks.delete(clientId)) {
        clearTimeout(timer);
        resolve({ ok: false, error: 'disconnected' });
      }
    }
  });
}

// Tear down the socket without triggering the auto-reconnect path. Used on
// logout (and any other session reset). Strips handlers before closing so the
// `onclose` reconnect arm can't fire even if `auth.user` is briefly truthy.
export function resetSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try { socket.close(); } catch (_) { /* ignore */ }
    socket = null;
  }
  connected.value = false;
  hiddenSince = null;
  lastSeenEventId = 0;
  failAllPendingAcks('disconnected');
}

function refreshSnapshot() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    send({ type: 'snapshot' });
    return;
  }
  // Socket isn't open — pull the reconnect forward instead of waiting on the
  // 2s backoff timer. The fresh connection will trigger the server-side
  // sendSnapshot path on its own.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  open();
}

function wireVisibility() {
  if (visibilityWired || typeof document === 'undefined') return;
  visibilityWired = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenSince = Date.now();
      return;
    }
    const elapsed = hiddenSince ? Date.now() - hiddenSince : 0;
    hiddenSince = null;
    if (elapsed > HIDDEN_RESNAPSHOT_MS) refreshSnapshot();
  });
}

export function useSocket() {
  onMounted(() => {
    wireVisibility();
    open();
  });
  onBeforeUnmount(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
  return { connected, send, reconnect: open };
}

export function socketSend(payload) { return send(payload); }
