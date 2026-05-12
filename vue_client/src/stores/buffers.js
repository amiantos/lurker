import { defineStore } from 'pinia';
import { useNetworksStore } from './networks.js';
import { socketSend } from '../composables/useSocket.js';

const MAX_PER_BUFFER = 500;
const MAX_SPEAKERS = 128;
const TYPING_DURATIONS = { active: 6000, paused: 30000 };

const typingTimers = new Map();

function key(networkId, target) {
  return `${networkId}::${target}`;
}

function typingKey(networkId, target, nick) {
  return `${networkId}::${target}::${nick.toLowerCase()}`;
}

function clearTypingTimer(networkId, target, nick) {
  const k = typingKey(networkId, target, nick);
  const id = typingTimers.get(k);
  if (id) {
    clearTimeout(id);
    typingTimers.delete(k);
  }
}

function ensureBuffer(state, networkId, target) {
  const k = key(networkId, target);
  if (!state.buffers[k]) {
    state.buffers[k] = {
      networkId,
      target,
      messages: [],
      members: [],
      topic: null,
      // Channels flip to false on PART/KICK and back to true on JOIN. DMs and
      // server pseudo-buffers have no join concept; default true so they
      // never render dimmed.
      joined: true,
      unread: 0,
      highlighted: 0,
      highlightsCapped: false,
      // Server-owned "have I seen this" pointer. Drives unread counts and
      // survives across devices/sessions.
      lastReadId: 0,
      // Local snapshot of lastReadId taken when the user activates this
      // buffer. The unread divider in MessageList renders after the message
      // with this id; it stays pinned until switch-away (matching WeeChat),
      // not advanced live as new messages arrive in the focused buffer.
      dividerAfterId: null,
      typing: {},
      oldestId: null,
      hasMore: true,
      loadingHistory: false,
      speakers: {},
    };
  }
  return state.buffers[k];
}

export const useBuffersStore = defineStore('buffers', {
  state: () => ({
    buffers: {},
  }),
  getters: {
    list: (state) => Object.values(state.buffers),
    byKey: (state) => (k) => state.buffers[k] || null,
    forNetwork: (state) => (networkId) => Object.values(state.buffers).filter((b) => b.networkId === networkId),
  },
  actions: {
    ensure(networkId, target) {
      return ensureBuffer(this, networkId, target);
    },
    pushMessage(event) {
      if (!event.target) return false;
      const buf = ensureBuffer(this, event.networkId, event.target);
      const prevMaxId = buf.messages[buf.messages.length - 1]?.id ?? 0;
      // Server inserts persisted events in id order per buffer, so any event
      // with id <= prevMaxId is a replay (e.g. a WS resume that overlapped
      // with an event we already saw live). Drop it — and signal the caller
      // so it can skip unread/highlight side effects too.
      if (event.id != null && event.id <= prevMaxId) return false;
      buf.messages.push(event);
      if (buf.messages.length > MAX_PER_BUFFER) buf.messages.splice(0, buf.messages.length - MAX_PER_BUFFER);
      if (buf.oldestId == null && event.id != null) buf.oldestId = event.id;
      // While the user is sitting in this buffer, keep the divider tracking
      // the bottom UNLESS there's already an unread boundary visible (i.e.
      // they entered with unread and may not have caught up). The check
      // `dividerAfterId >= prevMaxId` is "no boundary currently shown" — in
      // that case a fresh arrival shouldn't materialize one. If a boundary
      // exists, leave it pinned until switch-away.
      if (event.id != null && buf.dividerAfterId != null) {
        const networks = useNetworksStore();
        const isActive = networks.activeKey === `${event.networkId}::${event.target}`;
        if (isActive && buf.dividerAfterId >= prevMaxId) {
          buf.dividerAfterId = event.id;
        }
      }
      if (event.nick && buf.typing[event.nick]) {
        clearTypingTimer(event.networkId, event.target, event.nick);
        delete buf.typing[event.nick];
      }
      return true;
    },
    replaceBacklog(networkId, target, events, speakers, readState, joined) {
      const buf = ensureBuffer(this, networkId, target);
      // Drop legacy per-buffer away/back rows. The server stopped persisting
      // these once self-presence moved to the away-state stream, but rows
      // written before that change linger in the DB and would still render
      // here. They age out naturally as new content arrives.
      const filtered = events.filter((e) => e.type !== 'away' && e.type !== 'back');
      const existingMaxId = buf.messages[buf.messages.length - 1]?.id ?? 0;
      if (existingMaxId === 0) {
        // Initial seed (first connect, or a brand-new buffer we hadn't seen
        // pre-flap). Take the backlog wholesale.
        buf.messages = filtered.slice(-MAX_PER_BUFFER);
        buf.hasMore = filtered.length >= 50;
      } else {
        // Gap-fill on reconnect: filter to events newer than what we already
        // have and append. Keeps live state intact when the server's backlog
        // overlaps with messages we received before the flap.
        const fresh = filtered.filter((e) => e.id == null || e.id > existingMaxId);
        if (fresh.length > 0) {
          const combined = [...buf.messages, ...fresh];
          buf.messages = combined.length > MAX_PER_BUFFER
            ? combined.slice(-MAX_PER_BUFFER)
            : combined;
        }
      }
      buf.oldestId = buf.messages[0]?.id ?? null;
      if (speakers !== undefined) this.seedSpeakers(networkId, target, speakers);
      if (readState) this.applyReadState(networkId, target, readState);
      if (typeof joined === 'boolean') buf.joined = joined;
    },
    prependHistory(networkId, target, events, hasMore, speakers) {
      const buf = ensureBuffer(this, networkId, target);
      // Dedupe against ids we already hold AND drop legacy away/back rows
      // (no longer persisted; same rationale as replaceBacklog).
      const existing = new Set();
      for (const m of buf.messages) {
        if (m.id != null) existing.add(m.id);
      }
      const fresh = events.filter((e) =>
        (e.id == null || !existing.has(e.id))
        && e.type !== 'away' && e.type !== 'back',
      );
      buf.messages = [...fresh, ...buf.messages];
      const first = buf.messages[0];
      buf.oldestId = first?.id ?? buf.oldestId;
      buf.hasMore = !!hasMore;
      buf.loadingHistory = false;
      if (speakers !== undefined) this.seedSpeakers(networkId, target, speakers);
    },
    setLoadingHistory(networkId, target, loading) {
      const buf = ensureBuffer(this, networkId, target);
      buf.loadingHistory = loading;
    },
    setMembers(networkId, target, members) {
      const buf = ensureBuffer(this, networkId, target);
      buf.members = members;
    },
    setTopic(networkId, target, topic) {
      const buf = ensureBuffer(this, networkId, target);
      buf.topic = topic;
    },
    setChannelModes(networkId, target, modes) {
      const buf = ensureBuffer(this, networkId, target);
      buf.modes = modes || '';
    },
    removeMember(networkId, target, nick) {
      const buf = ensureBuffer(this, networkId, target);
      buf.members = buf.members.filter((m) => (m.nick || m) !== nick);
    },
    addMember(networkId, target, nick) {
      const buf = ensureBuffer(this, networkId, target);
      const existing = buf.members.find((m) => (m.nick || m) === nick);
      if (!existing) buf.members.push({ nick, modes: [], away: false });
    },
    renameMember(networkId, target, oldNick, newNick) {
      const buf = ensureBuffer(this, networkId, target);
      for (const m of buf.members) {
        if ((m.nick || m) === oldNick) {
          if (typeof m === 'object') m.nick = newNick;
        }
      }
      const oldLc = oldNick?.toLowerCase();
      const newLc = newNick?.toLowerCase();
      if (oldLc && newLc && buf.speakers[oldLc]) {
        const lastTime = buf.speakers[oldLc].lastTime;
        delete buf.speakers[oldLc];
        const existing = buf.speakers[newLc];
        if (!existing || existing.lastTime < lastTime) {
          buf.speakers[newLc] = { nick: newNick, lastTime };
        }
      }
    },
    recordSpeaker(networkId, target, nick, time) {
      if (!nick || !time) return;
      const buf = ensureBuffer(this, networkId, target);
      const lc = nick.toLowerCase();
      const existing = buf.speakers[lc];
      if (existing && existing.lastTime >= time) return;
      buf.speakers[lc] = { nick, lastTime: time };
      const keys = Object.keys(buf.speakers);
      if (keys.length > MAX_SPEAKERS) {
        let oldestKey = keys[0];
        for (const k of keys) {
          if (buf.speakers[k].lastTime < buf.speakers[oldestKey].lastTime) oldestKey = k;
        }
        delete buf.speakers[oldestKey];
      }
    },
    seedSpeakers(networkId, target, list) {
      if (!Array.isArray(list)) return;
      const buf = ensureBuffer(this, networkId, target);
      const next = {};
      for (const s of list) {
        if (!s?.nick || !s?.lastTime) continue;
        next[s.nick.toLowerCase()] = { nick: s.nick, lastTime: s.lastTime };
      }
      for (const [lc, existing] of Object.entries(buf.speakers || {})) {
        if (!next[lc] || next[lc].lastTime < existing.lastTime) next[lc] = existing;
      }
      buf.speakers = next;
    },
    drop(networkId, target) {
      delete this.buffers[key(networkId, target)];
    },
    // Called from useSessionReset before $reset(). The state reset will wipe
    // every buffer (and therefore every typing indicator), but the
    // module-level Map of pending setTimeouts isn't part of Pinia state —
    // clear it explicitly so timers don't linger after logout.
    _resetTimers() {
      for (const id of typingTimers.values()) clearTimeout(id);
      typingTimers.clear();
    },
    setJoined(networkId, target, joined) {
      const buf = this.buffers[key(networkId, target)];
      if (!buf) return;
      buf.joined = !!joined;
    },
    // Server is the source of truth for lastReadId / unread / highlights.
    // Apply on backlog (initial snapshot) and on every read-state broadcast
    // (mark-read from this or another device).
    applyReadState(networkId, target, payload) {
      const buf = ensureBuffer(this, networkId, target);
      const lastReadId = Number(payload?.lastReadId) || 0;
      const networks = useNetworksStore();
      const isActive = networks.activeKey === `${networkId}::${target}`;
      // Suppress the unread badge for the buffer the user is sitting in. We
      // intentionally don't fire mark-read until switch-away, so the server's
      // count for the active buffer can be > 0 right after a reconnect (new
      // messages arrived while disconnected). The badge would otherwise
      // appear on a buffer they're actively viewing.
      buf.unread = isActive ? 0 : (Number(payload?.unread) || 0);
      buf.highlighted = isActive ? 0 : (Number(payload?.highlights) || 0);
      buf.highlightsCapped = isActive ? false : !!payload?.highlightsCapped;
      // Don't slide the divider out from under a user who's currently in the
      // buffer. dividerAfterId is set on activate and only cleared on
      // deactivate; the count refreshes live, the divider stays pinned.
      if (buf.dividerAfterId == null) buf.lastReadId = lastReadId;
      else buf.lastReadId = Math.max(buf.lastReadId, lastReadId);
    },
    markUnread(networkId, target) {
      const buf = this.buffers[key(networkId, target)];
      if (!buf) return;
      buf.unread += 1;
    },
    markHighlight(networkId, target) {
      const buf = this.buffers[key(networkId, target)];
      if (!buf) return;
      buf.highlighted += 1;
    },
    // Switch to a buffer: send mark-read for the one we're leaving, snapshot
    // the divider position on the one we're entering, and clear its local
    // unread/highlighted counts. Single entry point so the BufferList click
    // and the highlights-modal jump go through the same flow.
    activate(networkId, target) {
      const networks = useNetworksStore();
      const newKey = `${networkId}::${target}`;
      const prevKey = networks.activeKey;
      if (prevKey && prevKey !== newKey) {
        const prev = this.buffers[prevKey];
        if (prev) {
          const lastMsg = prev.messages[prev.messages.length - 1];
          const lastId = lastMsg?.id ?? 0;
          if (lastId > prev.lastReadId) {
            // Optimistically advance local pointer so a fast re-activate
            // doesn't re-show the just-read divider before the server's
            // read-state broadcast lands. Server clamps with MAX().
            prev.lastReadId = lastId;
            socketSend({
              type: 'mark-read',
              networkId: prev.networkId,
              target: prev.target,
              messageId: lastId,
            });
          }
          prev.dividerAfterId = null;
          // Local clear is also optimistic; the server's read-state broadcast
          // will overwrite with authoritative values shortly.
          prev.unread = 0;
          prev.highlighted = 0;
          prev.highlightsCapped = false;
        }
      }
      networks.setActive(networkId, target);
      const buf = ensureBuffer(this, networkId, target);
      // Snapshot the divider on first activation. Re-activating without
      // having left (shouldn't happen given prevKey check above, but defensive)
      // leaves the existing snapshot alone.
      if (buf.dividerAfterId == null) buf.dividerAfterId = buf.lastReadId || 0;
      buf.unread = 0;
      buf.highlighted = 0;
      buf.highlightsCapped = false;
    },
    setTyping(networkId, target, nick, state) {
      if (!nick) return;
      const buf = ensureBuffer(this, networkId, target);
      clearTypingTimer(networkId, target, nick);

      if (state === 'done') {
        delete buf.typing[nick];
        return;
      }

      const duration = TYPING_DURATIONS[state];
      if (!duration) return;
      buf.typing[nick] = { state, expiresAt: Date.now() + duration };

      const timer = setTimeout(() => {
        const b = this.buffers[key(networkId, target)];
        if (b && b.typing[nick]) {
          delete b.typing[nick];
        }
        typingTimers.delete(typingKey(networkId, target, nick));
      }, duration);
      typingTimers.set(typingKey(networkId, target, nick), timer);
    },
  },
});
