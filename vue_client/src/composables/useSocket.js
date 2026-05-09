import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useAuthStore } from '../stores/auth.js';
import { useSettingsStore } from '../stores/settings.js';
import { useHighlightRulesStore } from '../stores/highlightRules.js';

let socket = null;
const connected = ref(false);
let reconnectTimer = null;
const openHandlers = new Set();

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
  return `${proto}://${window.location.host}/ws`;
}

function applyEvent(event) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();

  switch (event.type) {
    case 'state':
      networks.applyState(event);
      break;
    case 'message':
    case 'action':
      buffers.pushMessage(event);
      if (event.nick) {
        buffers.recordSpeaker(event.networkId, event.target, event.nick,
          Date.parse(event.time) || Date.now());
      }
      if (!event.self && networks.activeKey !== `${event.networkId}::${event.target}`) {
        buffers.markUnread(event.networkId, event.target);
        if (event.matched || event.dm) {
          buffers.markHighlight(event.networkId, event.target);
        }
      }
      break;
    case 'notice':
      buffers.pushMessage(event);
      if (!event.self && networks.activeKey !== `${event.networkId}::${event.target}`) {
        buffers.markUnread(event.networkId, event.target);
        if (event.matched || event.dm) {
          buffers.markHighlight(event.networkId, event.target);
        }
      }
      break;
    case 'join':
      buffers.addMember(event.networkId, event.target, event.nick);
      buffers.pushMessage(event);
      break;
    case 'part':
    case 'quit':
      buffers.removeMember(event.networkId, event.target, event.nick);
      buffers.pushMessage(event);
      break;
    case 'kick':
      buffers.removeMember(event.networkId, event.target, event.kicked);
      buffers.pushMessage(event);
      break;
    case 'nick':
      buffers.renameMember(event.networkId, event.target, event.nick, event.newNick);
      buffers.pushMessage(event);
      break;
    case 'topic':
      buffers.setTopic(event.networkId, event.target, event.text);
      buffers.pushMessage(event);
      break;
    case 'mode':
      buffers.pushMessage(event);
      break;
    case 'usermode':
      networks.applyUserMode(event);
      break;
    case 'names':
      buffers.setMembers(event.networkId, event.target, event.members);
      break;
    case 'channel-joined':
      buffers.ensure(event.networkId, event.target);
      break;
    case 'channel-parted':
      buffers.drop(event.networkId, event.target);
      break;
    case 'typing':
      buffers.setTyping(event.networkId, event.target, event.nick, event.state);
      break;
    case 'motd':
    case 'error':
      buffers.pushMessage({ ...event, target: event.target || `:server:${event.networkId}` });
      break;
  }
}

function applySnapshot(snapshot) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.applySnapshot(snapshot);
  for (const net of snapshot) {
    for (const ch of net.channels) {
      // Snapshot members are already { nick, modes } objects from the server.
      // Tolerate the legacy plain-string shape in case an old snapshot is in flight.
      const normalized = ch.members.map((m) =>
        typeof m === 'string' ? { nick: m, modes: [] } : { nick: m.nick, modes: m.modes || [] }
      );
      buffers.setMembers(net.networkId, ch.name, normalized);
      buffers.setTopic(net.networkId, ch.name, ch.topic);
    }
  }
}

function applyBacklog(payload) {
  const buffers = useBuffersStore();
  buffers.replaceBacklog(payload.networkId, payload.target, payload.events, payload.speakers);
}

function handleMessage(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return; }

  if (payload.kind === 'snapshot') {
    applySnapshot(payload.networks);
    return;
  }
  if (payload.kind === 'backlog') {
    applyBacklog(payload);
    return;
  }
  if (payload.kind === 'history') {
    const buffers = useBuffersStore();
    buffers.prependHistory(payload.networkId, payload.target, payload.events, payload.hasMore, payload.speakers);
    return;
  }
  if (payload.kind === 'irc') {
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
  }
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

export function socketSend(payload) { send(payload); }
