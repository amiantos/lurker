import { defineStore } from 'pinia';

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
      unread: 0,
      highlighted: 0,
      typing: {},
      oldestId: null,
      hasMore: true,
      loadingHistory: false,
      speakers: {},
    };
  }
  if (!state.buffers[k].speakers) state.buffers[k].speakers = {};
  if (!state.buffers[k].typing) state.buffers[k].typing = {};
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
      if (!event.target) return;
      const buf = ensureBuffer(this, event.networkId, event.target);
      buf.messages.push(event);
      if (buf.messages.length > MAX_PER_BUFFER) buf.messages.splice(0, buf.messages.length - MAX_PER_BUFFER);
      if (buf.oldestId == null && event.id != null) buf.oldestId = event.id;
      if (event.nick && buf.typing[event.nick]) {
        clearTypingTimer(event.networkId, event.target, event.nick);
        delete buf.typing[event.nick];
      }
    },
    replaceBacklog(networkId, target, events, speakers) {
      const buf = ensureBuffer(this, networkId, target);
      buf.messages = events.slice(-MAX_PER_BUFFER);
      const first = buf.messages[0];
      buf.oldestId = first?.id ?? null;
      buf.hasMore = events.length >= 50;
      if (speakers !== undefined) this.seedSpeakers(networkId, target, speakers);
    },
    prependHistory(networkId, target, events, hasMore, speakers) {
      const buf = ensureBuffer(this, networkId, target);
      buf.messages = [...events, ...buf.messages];
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
    removeMember(networkId, target, nick) {
      const buf = ensureBuffer(this, networkId, target);
      buf.members = buf.members.filter((m) => (m.nick || m) !== nick);
    },
    addMember(networkId, target, nick) {
      const buf = ensureBuffer(this, networkId, target);
      const existing = buf.members.find((m) => (m.nick || m) === nick);
      if (!existing) buf.members.push({ nick, modes: [] });
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
    markRead(networkId, target) {
      const buf = this.buffers[key(networkId, target)];
      if (buf) {
        buf.unread = 0;
        buf.highlighted = 0;
      }
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
