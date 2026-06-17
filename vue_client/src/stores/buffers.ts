// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { useNetworksStore } from './networks.js';
import { useToastsStore } from './toasts.js';
import { socketSend } from '../composables/useSocket.js';

const MAX_PER_BUFFER = 500;
const MAX_SPEAKERS = 128;
const TYPING_DURATIONS: Record<string, number> = { active: 6000, paused: 30000 };

const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Pending joins (#260): a join from the channel list or a typed /join no longer
// opens its buffer optimistically — requestJoin records the intent here and the
// buffer is only activate()d once the server confirms with channel-joined. A
// timeout backstops the silent case where the server drops the JOIN with no
// numeric at all (the original symptom — a blank buffer with no error anywhere).
const pendingJoins = new Map<string, ReturnType<typeof setTimeout>>();
const PENDING_JOIN_TIMEOUT = 10000;
function joinKey(networkId: number | string, channel: string) {
  return `${networkId}::${channel.toLowerCase()}`;
}

// Monotonic token tagged onto each loadAround / reattachToLive request. The
// response handler drops slices whose token has been superseded (e.g. user
// clicked a second jump while the first was in flight, or reattached before
// the around-response landed). Mirrors search.js's `token` pattern.
let historyTokenCounter = 0;
function nextHistoryToken() {
  historyTokenCounter += 1;
  return historyTokenCounter;
}

function key(networkId: number | string, target: string) {
  return `${networkId}::${target}`;
}

function typingKey(networkId: number | string, target: string, nick: string) {
  return `${networkId}::${target}::${nick.toLowerCase()}`;
}

function clearTypingTimer(networkId: number | string, target: string, nick: string) {
  const k = typingKey(networkId, target, nick);
  const id = typingTimers.get(k);
  if (id) {
    clearTimeout(id);
    typingTimers.delete(k);
  }
}

export interface BufferMember {
  nick: string;
  modes: string[];
  away: boolean;
  // user/host are sent by the server alongside the nicklist; they're optional
  // because pre-upgrade backlog and bare JOIN-derived members may lack them.
  user?: string | null;
  host?: string | null;
}

export interface TypingEntry {
  // Display nick as it arrived on the wire. The map that holds these entries is
  // keyed by the *lowercased* nick (so a peer who sends case-variant tags, or
  // runs a case-only /nick, occupies one entry instead of stranding a ghost),
  // so the original case has to ride along here for rendering.
  nick: string;
  state: string;
  expiresAt: number;
  userhost: string | null;
}

export interface SpeakerEntry {
  nick: string;
  lastTime: number;
}

export interface BufferMessage {
  id?: number | null;
  networkId: number;
  target: string;
  type: string;
  nick?: string;
  body?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface Buffer {
  networkId: number;
  target: string;
  messages: BufferMessage[];
  members: BufferMember[];
  topic: string | null;
  joined: boolean;
  unread: number;
  highlighted: number;
  highlightsCapped: boolean;
  lastReadId: number;
  dividerAfterId: number | null;
  // /clear marker. Render-time filter hides messages with id <= clearedBeforeId
  // (0 = no clear). clearedAt is the wall-clock time the user issued /clear,
  // shown in the "cleared at …" divider; null when no clear is in effect.
  // Filter only applies in live tail — detached/jump views ignore it so
  // search/highlight navigation always lands on the target row.
  clearedBeforeId: number;
  clearedAt: string | null;
  typing: Record<string, TypingEntry>;
  oldestId: number | null;
  newestId: number | null;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  loadingHistory: boolean;
  speakers: Record<string, SpeakerEntry>;
  detached: boolean;
  liveDuringDetach: number;
  pendingHistoryToken: number | null;
  pendingRefetch: boolean;
  modes?: string;
}

function makeBuffer(networkId: number | string, target: string): Buffer {
  return {
    networkId: Number(networkId),
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
    // /clear marker — server-owned, mirrored here for render-time filtering.
    // 0 / null mean no clear active.
    clearedBeforeId: 0,
    clearedAt: null,
    typing: {},
    oldestId: null,
    // Symmetric to oldestId. Only authoritative while detached or mid-page-
    // down — otherwise messages[length-1].id is the implicit "newest" and
    // this is left null. Set on around/after/latest responses.
    newestId: null,
    // Split of the old `hasMore` flag. hasMoreOlder drives the existing
    // upward pager; hasMoreNewer is only meaningful while detached or while
    // the user has paged past the live tail (not currently possible
    // outside detach mode, but the field is here for future symmetry).
    hasMoreOlder: true,
    hasMoreNewer: false,
    loadingHistory: false,
    speakers: {},
    // Detached mode: buffer is viewing a bounded historical slice around
    // some anchor message id rather than the live tail. While detached,
    // pushMessage drops fanOut (and counts via liveDuringDetach), activate
    // skips its mark-read advance, and replaceBacklog (snapshot resume)
    // is a no-op. The user exits via the StatusBar "Return to present"
    // button (reattachToLive), via switching to another buffer, or via WS
    // reconnect — all three reset the flag.
    detached: false,
    liveDuringDetach: 0,
    pendingHistoryToken: null,
    // Set when the buffer's slice was wiped on switch-away from detach.
    // activate() consumes it on re-entry to fire a fresh latest fetch, so
    // the user doesn't sit on a permanently empty buffer (the server only
    // ships backlog unsolicited via sendSnapshot, so there's no other
    // automatic source of history once the slice has been wiped).
    pendingRefetch: false,
  };
}

function ensureBuffer(
  state: { buffers: Record<string, Buffer> },
  networkId: number | string,
  target: string,
): Buffer {
  const k = key(networkId, target);
  if (!state.buffers[k]) {
    state.buffers[k] = makeBuffer(networkId, target);
  }
  return state.buffers[k];
}

export const useBuffersStore = defineStore('buffers', {
  state: () => ({
    buffers: {} as Record<string, Buffer>,
  }),
  getters: {
    list: (state) => Object.values(state.buffers),
    byKey: (state) => (k: string) => state.buffers[k] || null,
    // True only while the buffer is live in the store. A closed buffer is
    // dropped entirely (see drop()), so this is how callers tell "open" from
    // "closed/parted-away" before activating — activate() would otherwise
    // recreate an empty shell and strand the UI in a half-state.
    isOpen: (state) => (networkId: number | string, target: string) =>
      !!state.buffers[`${networkId}::${target}`],
    forNetwork: (state) => (networkId: number | string) =>
      Object.values(state.buffers).filter((b) => b.networkId === networkId),
    // The open DM buffer for a (network, nick), matched case-insensitively so we
    // resolve to whatever case is already open rather than forking a second
    // buffer that differs only by nick case. Channels and the flat virtual
    // sentinels (`:server:`, `:friends:`…) are excluded. One home for the
    // resolution the Friends sidebar, overview, and keyboard nav all need.
    findDm:
      (state) =>
      (networkId: number | string, nick: string): Buffer | null => {
        const lower = nick.toLowerCase();
        return (
          Object.values(state.buffers).find(
            (b) =>
              b.networkId === Number(networkId) &&
              b.target.toLowerCase() === lower &&
              !b.target.startsWith('#') &&
              !b.target.startsWith(':'),
          ) ?? null
        );
      },
    // Resolve an already-open buffer for (networkId, target) without creating
    // one, matching channels and DMs case-insensitively. IRC targets are
    // case-insensitive and some servers hand us inconsistently-cased names
    // (#289), so an exact-key lookup alone would miss the open buffer and drop
    // ephemeral signals (e.g. typing) on the floor. Exact key is tried first as
    // the common fast path; the folded scan only runs on a case mismatch. The
    // flat ':'-sentinels (`:server:`, `:friends:`…) are fixed keys — exact only.
    findByTarget:
      (state) =>
      (networkId: number | string, target: string): Buffer | null => {
        const exact = state.buffers[`${networkId}::${target}`];
        if (exact) return exact;
        if (target.startsWith(':')) return null;
        const nid = Number(networkId);
        const lower = target.toLowerCase();
        return (
          Object.values(state.buffers).find(
            (b) => b.networkId === nid && b.target.toLowerCase() === lower,
          ) ?? null
        );
      },
  },
  actions: {
    ensure(networkId: number | string, target: string) {
      return ensureBuffer(this, networkId, target);
    },
    pushMessage(event: BufferMessage) {
      if (!event.target) return false;
      const buf = ensureBuffer(this, event.networkId, event.target);
      // Detached: the user is reading a historical slice that doesn't include
      // the live tail. Drop the event so nothing materializes inside the
      // slice, and bump the badge so the StatusBar "Return to present" button
      // can surface a hint that fresh activity has happened. The caller's
      // unread/highlight side effects still fire — those are buffer-state
      // counts, independent of whether we render the row right now.
      if (buf.detached) {
        buf.liveDuringDetach += 1;
        return false;
      }
      const prevMaxId = buf.messages[buf.messages.length - 1]?.id ?? 0;
      // Server inserts persisted events in id order per buffer, so any event
      // with id <= prevMaxId is a replay (e.g. a WS resume that overlapped
      // with an event we already saw live). Drop it — and signal the caller
      // so it can skip unread/highlight side effects too.
      if (event.id != null && event.id <= prevMaxId) return false;
      buf.messages.push(event);
      if (buf.messages.length > MAX_PER_BUFFER)
        buf.messages.splice(0, buf.messages.length - MAX_PER_BUFFER);
      if (buf.oldestId == null && event.id != null) buf.oldestId = event.id;
      if (event.id != null) {
        const networks = useNetworksStore();
        const isActive = networks.activeKey === `${event.networkId}::${event.target}`;
        if (isActive) {
          // While the user is sitting in this buffer, keep the divider
          // tracking the bottom UNLESS there's already an unread boundary
          // visible (i.e. they entered with unread and may not have caught
          // up). `dividerAfterId >= prevMaxId` is "no boundary currently
          // shown" — in that case a fresh arrival shouldn't materialize one.
          if (buf.dividerAfterId != null && buf.dividerAfterId >= prevMaxId) {
            buf.dividerAfterId = event.id;
          }
          // Keep the server's lastReadId synced live. Sending on each live
          // message (rather than only on switch-away) means a tab close,
          // reload, or dropped socket while the user is reading still
          // leaves the buffer fully marked read. Server clamps with MAX(),
          // so this is idempotent and safe under reorder.
          if (event.id > buf.lastReadId) {
            buf.lastReadId = event.id;
            socketSend({
              type: 'mark-read',
              networkId: event.networkId,
              target: event.target,
              messageId: event.id,
            });
          }
        }
      }
      const speakerKey = event.nick?.toLowerCase();
      if (speakerKey && buf.typing[speakerKey]) {
        clearTypingTimer(event.networkId, event.target, event.nick!);
        delete buf.typing[speakerKey];
      }
      return true;
    },
    replaceBacklog(
      networkId: number | string,
      target: string,
      events: BufferMessage[],
      speakers: SpeakerEntry[] | undefined,
      readState: any,
      joined: boolean | undefined,
      opts: { reset?: boolean; hasMoreOlder?: boolean } = {},
    ) {
      const buf = ensureBuffer(this, networkId, target);
      // Detached: snapshot resume during detach is a no-op. The gap-fill
      // events would land at id values inside or past the detached slice and
      // either corrupt its boundaries or get conflated with paged-in history.
      // Reattach (via the "Return to present" button) is always a fresh
      // full-fetch via reattachToLive, so we don't need the data here.
      // Speakers / readState / joined still apply (they're slice-independent
      // buffer-level state).
      if (buf.detached) {
        if (speakers !== undefined) this.seedSpeakers(networkId, target, speakers);
        if (readState) this.applyReadState(networkId, target, readState);
        if (typeof joined === 'boolean') buf.joined = joined;
        return;
      }
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
        buf.hasMoreOlder = filtered.length >= 50;
      } else if (opts.reset) {
        // The resume gap exceeded the server's cap, so it sent a fresh latest
        // slice instead of the missed-since-cursor rows. Appending would splice
        // a permanent hole between our stale tail and this slice — and the
        // dropped middle is larger than MAX_PER_BUFFER anyway, so we'd evict it
        // immediately. Replace wholesale; the user lands on the live tail and
        // pages upward (hasMoreOlder) for the rest. This is the self-healing
        // path for issue #205 — no full reload required.
        buf.messages = filtered.slice(-MAX_PER_BUFFER);
        buf.hasMoreOlder = opts.hasMoreOlder ?? filtered.length >= 50;
      } else {
        // Gap-fill on reconnect: filter to events newer than what we already
        // have and append. Keeps live state intact when the server's backlog
        // overlaps with messages we received before the flap.
        const fresh = filtered.filter((e) => e.id == null || e.id > existingMaxId);
        if (fresh.length > 0) {
          const combined = [...buf.messages, ...fresh];
          buf.messages =
            combined.length > MAX_PER_BUFFER ? combined.slice(-MAX_PER_BUFFER) : combined;
        }
      }
      buf.oldestId = buf.messages[0]?.id ?? null;
      if (speakers !== undefined) this.seedSpeakers(networkId, target, speakers);
      if (readState) this.applyReadState(networkId, target, readState);
      if (typeof joined === 'boolean') buf.joined = joined;
    },
    prependHistory(
      networkId: number | string,
      target: string,
      events: BufferMessage[],
      hasMoreOlder: boolean,
      speakers: SpeakerEntry[] | undefined,
    ) {
      const buf = ensureBuffer(this, networkId, target);
      // Dedupe against ids we already hold AND drop legacy away/back rows
      // (no longer persisted; same rationale as replaceBacklog).
      const existing = new Set<number>();
      for (const m of buf.messages) {
        if (m.id != null) existing.add(m.id);
      }
      const fresh = events.filter(
        (e) => (e.id == null || !existing.has(e.id)) && e.type !== 'away' && e.type !== 'back',
      );
      buf.messages = [...fresh, ...buf.messages];
      const first = buf.messages[0];
      buf.oldestId = first?.id ?? buf.oldestId;
      buf.hasMoreOlder = !!hasMoreOlder;
      buf.loadingHistory = false;
      if (speakers !== undefined) this.seedSpeakers(networkId, target, speakers);
    },
    // Symmetric to prependHistory but appends. Used by the 'after' mode
    // pager that fires while detached when the user scrolls toward the
    // bottom edge of the loaded slice. The MAX_PER_BUFFER cap evicts from
    // the OLDER edge — the user is reading downward, so the newer rows are
    // the ones we want to keep resident.
    appendHistory(
      networkId: number | string,
      target: string,
      events: BufferMessage[],
      hasMoreNewer: boolean,
      speakers: SpeakerEntry[] | undefined,
    ) {
      const buf = ensureBuffer(this, networkId, target);
      const existing = new Set<number>();
      for (const m of buf.messages) {
        if (m.id != null) existing.add(m.id);
      }
      const fresh = events.filter(
        (e) => (e.id == null || !existing.has(e.id)) && e.type !== 'away' && e.type !== 'back',
      );
      const combined = [...buf.messages, ...fresh];
      buf.messages =
        combined.length > MAX_PER_BUFFER
          ? combined.slice(combined.length - MAX_PER_BUFFER)
          : combined;
      buf.oldestId = buf.messages[0]?.id ?? buf.oldestId;
      buf.newestId = buf.messages[buf.messages.length - 1]?.id ?? buf.newestId;
      buf.hasMoreNewer = !!hasMoreNewer;
      buf.loadingHistory = false;
      if (speakers !== undefined) this.seedSpeakers(networkId, target, speakers);
    },
    // Flip the buffer into detached mode without fetching a slice. Used by
    // jump-to-message when the target row is already loaded but filtered out
    // at render time (today: hidden by the /clear marker). The MessageList
    // filter is suppressed while detached, so the row becomes visible and
    // pendingScrollId can scroll to it on the next tick — no around-fetch
    // needed, and the "Return to present" affordance shows up the same way
    // it does after a real jump.
    detachForJump(networkId: number | string, target: string) {
      const buf = ensureBuffer(this, networkId, target);
      if (buf.detached) return;
      buf.detached = true;
      buf.liveDuringDetach = 0;
    },
    // Jump-to-message entry point. Synchronously flips the buffer into
    // detached mode before the WS send so that any live fanOut arriving
    // between the request and its response is dropped by pushMessage rather
    // than leaking into the soon-to-be-replaced slice. The token is matched
    // by applyAroundSlice — a second loadAround (or a reattach) before the
    // first response lands mints a new token, so the stale response is
    // discarded on arrival.
    loadAround(networkId: number | string, target: string, anchorId: number, halfLimit = 100) {
      const buf = ensureBuffer(this, networkId, target);
      const token = nextHistoryToken();
      const wasDetached = buf.detached;
      buf.detached = true;
      buf.pendingHistoryToken = token;
      buf.loadingHistory = true;
      const sent = socketSend({
        type: 'history',
        mode: 'around',
        networkId,
        target,
        anchorId,
        token,
        limit: halfLimit,
      });
      // Same rollback rationale as reattachToLive — a failed send leaves no
      // response to clear the loading flag. Restoring detached to its prior
      // state too (rather than forcing false) avoids stomping on a buffer
      // that was already detached from a previous jump.
      if (!sent) {
        buf.loadingHistory = false;
        buf.pendingHistoryToken = null;
        buf.detached = wasDetached;
      }
    },
    // Token-guarded replace for the 'around' response. A mismatched token
    // means a fresher request superseded this one — drop the stale slice
    // entirely; the in-flight winner will land soon.
    applyAroundSlice(networkId: number | string, target: string, payload: any) {
      const buf = ensureBuffer(this, networkId, target);
      if (payload.token !== buf.pendingHistoryToken) return;
      const filtered = (payload.events || []).filter(
        (e: BufferMessage) => e.type !== 'away' && e.type !== 'back',
      );
      buf.messages = filtered.slice(-MAX_PER_BUFFER);
      buf.oldestId = buf.messages[0]?.id ?? null;
      buf.newestId = buf.messages[buf.messages.length - 1]?.id ?? null;
      buf.hasMoreOlder = !!payload.hasMoreOlder;
      buf.hasMoreNewer = !!payload.hasMoreNewer;
      buf.pendingHistoryToken = null;
      buf.loadingHistory = false;
    },
    // Snap back to the live tail. Sent by the StatusBar "Return to present"
    // button. Same token discipline as loadAround — detached stays true
    // until the response lands, so any fanOut between request and response
    // continues to be dropped by pushMessage.
    reattachToLive(networkId: number | string, target: string, limit = 200) {
      const buf = ensureBuffer(this, networkId, target);
      // No detached guard: this is also called by activate() to refetch
      // the live tail after a switch-away from a detached buffer wiped
      // the slice. In that case detached is already false. The applyLatestReplace
      // handler is idempotent (re-clearing already-clear flags is a no-op).
      if (buf.loadingHistory) return;
      const token = nextHistoryToken();
      buf.pendingHistoryToken = token;
      buf.loadingHistory = true;
      const sent = socketSend({
        type: 'history',
        mode: 'latest',
        networkId,
        target,
        token,
        limit,
      });
      // socketSend returns false when the socket isn't open. No response will
      // arrive to clear loadingHistory, and there's no reconnect handler that
      // resets it per-buffer — so without this rollback the buffer would be
      // permanently stranded "loading" and every subsequent fetch guard
      // (this function's early-return, MessageList's requestMoreHistory) would
      // block forever. Relevant when activate fires before the socket has
      // (re)connected, e.g. push-notification deep-link into a cold PWA.
      if (!sent) {
        buf.loadingHistory = false;
        buf.pendingHistoryToken = null;
      }
    },
    applyLatestReplace(networkId: number | string, target: string, payload: any) {
      const buf = ensureBuffer(this, networkId, target);
      if (payload.token !== buf.pendingHistoryToken) return;
      const filtered = (payload.events || []).filter(
        (e: BufferMessage) => e.type !== 'away' && e.type !== 'back',
      );
      buf.messages = filtered.slice(-MAX_PER_BUFFER);
      buf.oldestId = buf.messages[0]?.id ?? null;
      buf.newestId = buf.messages[buf.messages.length - 1]?.id ?? null;
      buf.hasMoreOlder = !!payload.hasMoreOlder;
      buf.hasMoreNewer = false;
      buf.detached = false;
      buf.liveDuringDetach = 0;
      buf.pendingHistoryToken = null;
      buf.loadingHistory = false;
      // We're back on live: advance the read pointer to the new tail in the
      // same way activate() does on focus-in. Server clamps with MAX(), so
      // sending mark-read against the latest known id is idempotent.
      const lastMsg = buf.messages[buf.messages.length - 1];
      const lastId = lastMsg?.id ?? 0;
      if (lastId > buf.lastReadId) {
        buf.lastReadId = lastId;
        socketSend({
          type: 'mark-read',
          networkId,
          target,
          messageId: lastId,
        });
      }
    },
    // Drop detached state without re-fetching. Called when the user switches
    // buffers (the prev buffer's slice becomes stale; re-entry should reseed
    // from snapshot) and on WS reconnect (the resume snapshot will reseed
    // cleanly, but only if we let replaceBacklog through — which means
    // detached has to be cleared first).
    clearDetached(networkId: number | string, target: string, { wipeMessages = false } = {}) {
      const buf = this.buffers[key(networkId, target)];
      if (!buf || !buf.detached) return;
      buf.detached = false;
      buf.liveDuringDetach = 0;
      buf.pendingHistoryToken = null;
      buf.hasMoreNewer = false;
      buf.newestId = null;
      buf.loadingHistory = false;
      if (wipeMessages) {
        buf.messages = [];
        buf.oldestId = null;
        buf.hasMoreOlder = true;
        // Mark so the next activate() of this buffer re-pulls the live
        // tail. Without this flag, the user would return to an empty
        // buffer and the only path to repopulate it would be a full
        // reconnect-triggered snapshot.
        buf.pendingRefetch = true;
      }
    },
    setLoadingHistory(networkId: number | string, target: string, loading: boolean) {
      const buf = ensureBuffer(this, networkId, target);
      buf.loadingHistory = loading;
    },
    setMembers(networkId: number | string, target: string, members: BufferMember[]) {
      const buf = ensureBuffer(this, networkId, target);
      buf.members = members;
    },

    setTopic(networkId: number | string, target: string, topic: string | null) {
      const buf = ensureBuffer(this, networkId, target);
      buf.topic = topic;
    },
    setChannelModes(networkId: number | string, target: string, modes: string) {
      const buf = ensureBuffer(this, networkId, target);
      buf.modes = modes || '';
    },
    removeMember(networkId: number | string, target: string, nick: string) {
      const buf = ensureBuffer(this, networkId, target);
      buf.members = buf.members.filter((m) => (m.nick || m) !== nick);
    },
    addMember(networkId: number | string, target: string, nick: string) {
      const buf = ensureBuffer(this, networkId, target);
      const existing = buf.members.find((m) => (m.nick || m) === nick);
      if (!existing) buf.members.push({ nick, modes: [], away: false });
    },
    renameMember(networkId: number | string, target: string, oldNick: string, newNick: string) {
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
    recordSpeaker(networkId: number | string, target: string, nick: string, time: number) {
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
    seedSpeakers(networkId: number | string, target: string, list: SpeakerEntry[]) {
      if (!Array.isArray(list)) return;
      const buf = ensureBuffer(this, networkId, target);
      const next: Record<string, SpeakerEntry> = {};
      for (const s of list) {
        if (!s?.nick || !s?.lastTime) continue;
        next[s.nick.toLowerCase()] = { nick: s.nick, lastTime: s.lastTime };
      }
      for (const [lc, existing] of Object.entries(buf.speakers || {})) {
        if (!next[lc] || next[lc].lastTime < existing.lastTime) next[lc] = existing;
      }
      buf.speakers = next;
    },
    drop(networkId: number | string, target: string) {
      // Cancel any pending typing-expiry timers for this buffer before it (and
      // its typing entries) vanishes — otherwise a timer armed while a peer was
      // typing sits in the module-level map until it fires on its own.
      const prefix = `${networkId}::${target}::`;
      for (const [k, id] of typingTimers) {
        if (k.startsWith(prefix)) {
          clearTimeout(id);
          typingTimers.delete(k);
        }
      }
      delete this.buffers[key(networkId, target)];
    },
    // Called from useSessionReset before $reset(). The state reset will wipe
    // every buffer (and therefore every typing indicator), but the
    // module-level Map of pending setTimeouts isn't part of Pinia state —
    // clear it explicitly so timers don't linger after logout.
    resetTimers() {
      for (const id of typingTimers.values()) clearTimeout(id);
      typingTimers.clear();
      for (const id of pendingJoins.values()) clearTimeout(id);
      pendingJoins.clear();
    },
    // Register intent to join a channel without opening its buffer yet (#260).
    // confirmPendingJoin() activates it on the channel-joined confirmation;
    // cancelPendingJoin() drops it on a join-error. The timeout is the backstop
    // for a server that never replies at all.
    requestJoin(networkId: number | string, channel: string) {
      const k = joinKey(networkId, channel);
      const existing = pendingJoins.get(k);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        pendingJoins.delete(k);
        useToastsStore().push({
          kind: 'warn',
          title: `No response joining ${channel}`,
          body: 'The server didn’t confirm the join.',
          networkId: typeof networkId === 'string' ? Number(networkId) : networkId,
          target: channel,
          ttlMs: 6000,
        });
      }, PENDING_JOIN_TIMEOUT);
      pendingJoins.set(k, timer);
    },
    confirmPendingJoin(networkId: number | string, channel: string) {
      const k = joinKey(networkId, channel);
      const timer = pendingJoins.get(k);
      if (!timer) return; // no pending join for this channel — leave focus untouched
      clearTimeout(timer);
      pendingJoins.delete(k);
      this.activate(networkId, channel);
    },
    cancelPendingJoin(networkId: number | string, channel: string) {
      const k = joinKey(networkId, channel);
      const timer = pendingJoins.get(k);
      if (!timer) return;
      clearTimeout(timer);
      pendingJoins.delete(k);
    },
    // Switch to a channel buffer if it's already open; otherwise join it. This
    // is what /join and the channel-list both call. Channels are
    // case-insensitive on IRC but buffers key by exact string, so match an
    // existing buffer case-insensitively and reuse its real target — never open
    // a second buffer for a different-cased name. Returns false only when a
    // JOIN had to be sent but the socket was closed, so the caller can surface
    // an offline toast.
    joinOrActivate(networkId: number | string, channel: string): boolean {
      // forNetwork compares networkId with === against the numeric
      // Buffer.networkId, so coerce a numeric-string id first — otherwise an
      // existing buffer wouldn't match and we'd send a duplicate JOIN.
      const nid = typeof networkId === 'string' ? Number(networkId) : networkId;
      const existing = this.forNetwork(nid).find(
        (b) => b.target.toLowerCase() === channel.toLowerCase(),
      );
      if (existing) {
        // Already open (joined, or parted with history) — never blank, so focus
        // it immediately. Re-send JOIN if we're not currently in it.
        this.activate(nid, existing.target);
        if (existing.joined) return true;
        return socketSend({ type: 'join', networkId: nid, channel: existing.target });
      }
      // Brand-new channel: don't open optimistically (#260). Join and wait for
      // the channel-joined confirmation; requestJoin focuses on success and
      // toasts on rejection.
      const ok = socketSend({ type: 'join', networkId: nid, channel });
      if (ok) this.requestJoin(nid, channel);
      return ok;
    },
    setJoined(networkId: number | string, target: string, joined: boolean) {
      const buf = this.buffers[key(networkId, target)];
      if (!buf) return;
      buf.joined = !!joined;
    },
    // Server is the source of truth for lastReadId / unread / highlights.
    // Applied on backlog (initial snapshot) and on every read-state broadcast
    // — the server fires one after each countable message and after every
    // mark-read, so badges stay in sync without client-side increments.
    applyReadState(networkId: number | string, target: string, payload: any) {
      // Update an existing buffer only — never materialize one. A closed buffer
      // is absent from the store (see isOpen), and a stray read-state broadcast
      // for it (e.g. mark-all-read fans out over every target with history, open
      // or not) would otherwise re-create the entry and pop it back into the
      // sidebar (#319). A buffer that isn't open has no badge to update anyway.
      // Snapshot callers (replaceBacklog) ensureBuffer before delegating here.
      const buf = this.buffers[key(networkId, target)];
      if (!buf) return;
      const lastReadId = Number(payload?.lastReadId) || 0;
      const networks = useNetworksStore();
      const isActive = networks.activeKey === `${networkId}::${target}`;
      // Suppress the unread badge for the buffer the user is sitting in.
      // A read-state broadcast can briefly carry a non-zero unread for the
      // active buffer when an IRC event lands before the mark-read echo;
      // the badge shouldn't flash on the buffer the user is reading.
      buf.unread = isActive ? 0 : Number(payload?.unread) || 0;
      buf.highlighted = isActive ? 0 : Number(payload?.highlights) || 0;
      buf.highlightsCapped = isActive ? false : !!payload?.highlightsCapped;
      // Don't slide the divider out from under a user who's currently in the
      // buffer. dividerAfterId is set on activate and only cleared on
      // deactivate; the count refreshes live, the divider stays pinned.
      if (buf.dividerAfterId == null) buf.lastReadId = lastReadId;
      else buf.lastReadId = Math.max(buf.lastReadId, lastReadId);
      // The /clear marker rides in the same payload on backlog frames so the
      // filter survives reconnects. Only honor it when both keys are present —
      // a plain read-state broadcast (no clear fields) shouldn't stomp the
      // current marker.
      if (
        Object.prototype.hasOwnProperty.call(payload ?? {}, 'clearedBeforeId') ||
        Object.prototype.hasOwnProperty.call(payload ?? {}, 'clearedAt')
      ) {
        buf.clearedBeforeId = Number(payload?.clearedBeforeId) || 0;
        buf.clearedAt = payload?.clearedAt || null;
      }
    },
    // Dedicated dispatch for the `buffer-cleared` fan-out (both set-clear and
    // unset-clear). Distinct from applyReadState so a buffer-cleared frame
    // that doesn't carry read-state fields doesn't blank them out.
    applyClearedState(networkId: number | string, target: string, payload: any) {
      const buf = ensureBuffer(this, networkId, target);
      buf.clearedBeforeId = Number(payload?.clearedBeforeId) || 0;
      buf.clearedAt = payload?.clearedAt || null;
    },
    // /clear: anchor the marker at the current tail (server picks the exact
    // boundary id). Best-effort send; the server's fan-out echoes back and
    // applyClearedState moves the local mirror to the authoritative value.
    clearBuffer(networkId: number | string, target: string) {
      socketSend({ type: 'clear-buffer', networkId, target });
    },
    // Drop the /clear marker so hidden messages reappear. Fired by the
    // "Show earlier messages" affordance on the divider and by `/clear off`.
    unclearBuffer(networkId: number | string, target: string) {
      socketSend({ type: 'unclear-buffer', networkId, target });
    },
    // Switch to a buffer. We mark the entered buffer read on focus-IN (not
    // on focus-OUT of the previous one) so that a tab close / reload / lost
    // socket before switch-away still leaves the buffer marked read — no
    // phantom divider on the next session. The previous buffer's pointer
    // is already current because pushMessage keeps it synced live while
    // focused (see pushMessage), so leaving it just drops local state.
    activate(networkId: number | string, target: string) {
      const networks = useNetworksStore();
      const newKey = `${networkId}::${target}`;
      const prevKey = networks.activeKey;
      if (prevKey && prevKey !== newKey) {
        const prev = this.buffers[prevKey];
        if (prev) {
          prev.dividerAfterId = null;
          prev.unread = 0;
          prev.highlighted = 0;
          prev.highlightsCapped = false;
          // Carrying a detached slice across buffer switches gets weird fast
          // (the user can't see the detach status on a buffer they aren't
          // viewing, the live counter ticks invisibly, the next entry has
          // to remember whether to render the slice or live). Drop it and
          // wipe the slice on switch-away — re-entry then reseeds from
          // snapshot or the next history fetch as if it were fresh.
          if (prev.detached)
            this.clearDetached(prev.networkId, prev.target, { wipeMessages: true });
        }
      }
      networks.setActive(networkId, target);
      const buf = ensureBuffer(this, networkId, target);
      // Snapshot the divider from the CURRENT lastReadId before we advance
      // it below. The divider stays pinned to this snapshot for the
      // duration of the visit (cleared on switch-away).
      if (buf.dividerAfterId == null) buf.dividerAfterId = buf.lastReadId || 0;
      buf.unread = 0;
      buf.highlighted = 0;
      buf.highlightsCapped = false;
      // Advance the read pointer to the latest known message id. Server
      // clamps with MAX(), so this is a safe no-op when there's nothing
      // newer than lastReadId. The optimistic local bump prevents a fast
      // re-activate from re-snapshotting an out-of-date divider before
      // the server's read-state echo lands.
      //
      // Skip while detached — the visible "tail" is some historical row,
      // not the live present. Marking up to that row would advance the
      // server's read pointer past messages the user hasn't seen.
      if (!buf.detached) {
        const lastMsg = buf.messages[buf.messages.length - 1];
        const lastId = lastMsg?.id ?? 0;
        if (lastId > buf.lastReadId) {
          buf.lastReadId = lastId;
          socketSend({
            type: 'mark-read',
            networkId,
            target,
            messageId: lastId,
          });
        }
      }
      // Re-entry after the slice was wiped on switch-away-from-detached.
      // Fire a fresh latest fetch so the user lands on live tail content
      // instead of an empty buffer. The applyLatestReplace response will
      // do its own mark-read against the new tail.
      if (buf.pendingRefetch) {
        buf.pendingRefetch = false;
        this.reattachToLive(networkId, target);
      } else if (
        buf.messages.length === 0 &&
        buf.hasMoreOlder &&
        !buf.detached &&
        !buf.loadingHistory
      ) {
        // First-load fetch. The buffer shell exists but has no messages —
        // either it's brand new (profile-modal "Send DM" to a nick we've
        // never DM'd before) or it was pre-created by a side channel
        // (the channel-joined handler calls ensure() before any backlog
        // arrives) and the initial backlog snapshot only covers
        // buffers that were already open at socket-connect. Push-notification
        // deep-links land here too, since isOpen() is satisfied by any shell
        // in the store regardless of message contents. Kick a latest fetch
        // here so every entry path is uniformly seeded — the MessageList
        // lifecycle's ensureViewportFilled() goes back to being a safety
        // net rather than the load-bearing initial-fetch trigger.
        //
        // hasMoreOlder gates against the truly-empty case: a brand-new
        // DM/channel with no server history returns an empty latest slice
        // that leaves messages.length=0 but flips hasMoreOlder to false —
        // without this guard we'd refire the same empty fetch on every
        // re-activate.
        this.reattachToLive(networkId, target);
      }
      // For DMs, ask the server to WHOIS-probe the peer so the banner/sidebar
      // dim reflect current state rather than a possibly-stale cached value.
      // The probe is silent (no /whois reply in the server buffer); only the
      // resulting peer-presence event flows back to update local state.
      if (target && !target.startsWith('#') && !target.startsWith(':server:')) {
        socketSend({ type: 'probe-presence', networkId, nick: target });
      }
    },
    setTyping(
      networkId: number | string,
      target: string,
      nick: string,
      state: string,
      userhost: string | null = null,
    ) {
      if (!nick) return;
      // Resolve to an *existing* buffer only — a typing tag (TAGMSG +typing)
      // must never materialize a phantom DM buffer for a peer who never
      // actually messages us; the incoming PRIVMSG is what opens a DM (#292).
      // findByTarget matches channels and DMs case-insensitively, so a tag
      // whose target case differs from the open buffer still lands rather than
      // being dropped — whether that's a DM /query'd as `bob` vs a server-
      // reported `Bob`, or a server echoing `#Chan` for a buffer joined as
      // `#chan` (inconsistent server casing has bitten us before, #289). An
      // unknown nick/channel simply has its typing notice dropped until there's
      // a real message.
      const buf = this.findByTarget(networkId, target);
      // Key all timer bookkeeping off the resolved buffer's actual target, not
      // the event's nick case, so the clear/set/expiry callbacks all line up on
      // the same buffer. Falls back to the raw target when there's no buffer.
      const tkTarget = buf ? buf.target : target;
      // Cancel any pending expiry timer first, unconditionally: the buffer may
      // have been closed while a timer was still pending, and the early-return
      // below would otherwise strand that timer until it expires on its own.
      // clearTypingTimer is a no-op when there's no timer for this nick.
      clearTypingTimer(networkId, tkTarget, nick);
      if (!buf) return;

      // Canonical (lowercased) map key so case-variant tags from one peer share
      // a single entry; the display nick rides along in the value (see
      // TypingEntry). Matches the lowercasing typingKey() already applies.
      const canon = nick.toLowerCase();
      const duration = TYPING_DURATIONS[state];
      if (!duration) {
        // 'done', or any unrecognized +typing value a client might send: stop
        // showing this peer as typing. Returning without this delete (the old
        // behavior for unknown states) stranded the prior entry with no live
        // timer to expire it — a permanently stuck indicator.
        delete buf.typing[canon];
        return;
      }
      buf.typing[canon] = { nick, state, expiresAt: Date.now() + duration, userhost };

      const timer = setTimeout(() => {
        const b = this.buffers[key(networkId, tkTarget)];
        if (b && b.typing[canon]) {
          delete b.typing[canon];
        }
        typingTimers.delete(typingKey(networkId, tkTarget, nick));
      }, duration);
      typingTimers.set(typingKey(networkId, tkTarget, nick), timer);
    },
  },
});
