// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { useNetworksStore } from './networks.js';
import { useToastsStore } from './toasts.js';
import { socketSend } from '../composables/useSocket.js';
import { isBufferViewed } from '../composables/useViewedBuffer.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';
import { historyCountBy } from '../lib/historyPaging.js';
import { isChannelTarget } from '../../../shared/channels.js';

const MAX_PER_BUFFER = 500;
// The most rows one INCREMENTAL merge (prepend/append) may take from a single
// page. Deliberately well under MAX_PER_BUFFER, so a merge can never evict the
// rows the reader is looking at.
//
// `countBy:'renderable'` makes this reachable: a page is sized in rows that
// render standalone, and the presence churn rides along with them, so one page
// can legitimately be several times the ring. Merging it wholesale would drop
// the entire held slice — appendHistory would leave nothing of the previous
// tail, MessageList would read both ends changing as a wholesale replace
// (`MessageList.vue:1644`), and a detached reader's scrollTop would be left
// pointing at content that no longer exists.
//
// Nothing is lost by trimming: we keep the end ADJACENT to what we already
// hold, so the slice stays contiguous and the pager fetches the remainder on
// the next scroll — which is why a trim forces the matching hasMore flag true
// regardless of what the server reported for the full page.
const MAX_MERGE_ROWS = 250;
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

// Targets THIS tab has asked the server to open.
//
// `buffer-opened` carries two meanings now that the server fans it out. To the
// tab that asked it's a reply — "here's the canonical casing, focus it". To the
// user's other devices it's a state signal — "this buffer is open now" — and
// acting on that by activating would yank someone to a buffer they opened on
// their phone. The frame looks identical either way, so the only thing that can
// tell them apart is whether we asked.
//
// Claimed once (a reply answers one request), and dropped on a timeout, on
// socket close, and on logout — because "focus the next open of this target" is
// a dangerous thing to leave armed. `open-buffer` can be refused outright (a
// paused account answers `{kind:'error'}` and never sends `buffer-opened`), and
// without a backstop that request would sit here for the life of the session and
// then claim someone else's open from another device. Same reasoning and the
// same backstop as `pendingJoins`.
const pendingOpens = new Map<string, ReturnType<typeof setTimeout>>();
const PENDING_OPEN_TIMEOUT = 10000;

// bufferId → storage key. The id fast path for frame application: a frame
// carrying a known bufferId resolves to its buffer even when the NAME
// disagrees (a rename raced the frame), which string keys alone cannot do.
// Module-level like typingTimers — cleared by resetTimers() on logout and
// pruned by drop().
const keyById = new Map<number, string>();

/** The storage key for a server buffer id, when we've learned it. */
export function bufferKeyForId(bufferId: number): string | undefined {
  return keyById.get(bufferId);
}

/** The server id for (networkId, target), when we've learned it — the verb
 *  send-sites attach this so the server can address by id (undefined keys are
 *  dropped by JSON.stringify, so unknown ids simply omit the field). */
export function idFor(networkId: number | string | null, target: string): number | undefined {
  const store = useBuffersStore();
  const k = resolveExistingKey(store.buffers, networkId, target);
  return k ? store.buffers[k].id : undefined;
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

// App-scoped buffers (the system buffer, issue #355) have no network: they're
// keyed by their bare `:sentinel:` target (e.g. `:system:`) so the
// `${networkId}::${target}` parsers — and every network-scoped consumer
// (forNetwork, the sidebar) — skip them. Network buffers keep the
// `${networkId}::${target}` form. networkId == null is what makes a buffer
// app-scoped; there is no magic network value.
// Exported because it is also the format networks.activeKey holds, and so the
// format the navHistory/recentBuffers stores key their trails by: anything
// ranking a buffer against those trails has to derive the same string from a
// (networkId, target) pair. activate() canonicalizes casing before setActive(),
// so a key built from a stored buffer's `target` always matches the activeKey
// recorded for it.
export function bufferKey(networkId: number | string | null, target: string) {
  return networkId == null ? target : `${networkId}::${target}`;
}

// Resolve the storage key of an already-open buffer for (networkId, target),
// folding case so an inconsistently-cased name reuses the open buffer instead
// of forking a second one. IRC targets are case-insensitive and some servers
// hand us divergent casing (#289 for channels; #327 for live DMs), so exact-key
// identity alone forks duplicates. Exact key is tried first as the common fast
// path; the O(n) folded scan only runs on a miss. The flat ':'-sentinels
// (`:server:`…) are fixed keys — exact only, never folded.
function resolveExistingKey(
  buffers: Record<string, Buffer>,
  networkId: number | string | null,
  target: string,
): string | null {
  const exact = bufferKey(networkId, target);
  if (buffers[exact]) return exact;
  if (target.startsWith(':')) return null;
  const nid = Number(networkId);
  const lower = target.toLowerCase();
  for (const [k, b] of Object.entries(buffers)) {
    if (b.networkId === nid && b.target.toLowerCase() === lower) return k;
  }
  return null;
}

function typingKey(networkId: number | string | null, target: string, nick: string) {
  return `${networkId}::${target}::${nick.toLowerCase()}`;
}

function clearTypingTimer(networkId: number | string | null, target: string, nick: string) {
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
  // Services account (extended-join / account-notify, #508). A string means
  // logged in; null means the server told us they're logged out; undefined
  // means we never learned. Both falsy states render as nothing today — the
  // distinction is kept so a later WHOX backfill can merge without clobbering.
  account?: string | null;
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
  // null for the app-scoped system buffer (issue #355), which carries no
  // network; a real id for every IRC buffer.
  networkId: number | null;
  target: string;
  type: string;
  nick?: string;
  body?: string;
  createdAt?: string;
  [key: string]: unknown;
}

// What a buffer *is*, so capabilities (sendable, input, nicklist, server
// round-trips) dispatch off an explicit discriminant instead of sniffing the
// target string. 'system' is the app-scoped buffer with no network.
export type BufferKind = 'channel' | 'dm' | 'server' | 'system';

// Classify a buffer from its identity. App-scoped buffers (networkId == null)
// are the system buffer today; network buffers split by target shape.
function deriveKind(networkId: number | null, target: string): BufferKind {
  if (networkId == null) return 'system';
  if (isChannelTarget(target)) return 'channel';
  if (target.startsWith(':server:')) return 'server';
  return 'dm';
}

export interface Buffer {
  // The server's stable buffer id (buffers.id on the wire, schema 17+).
  // Undefined until the first id-carrying frame lands — a buffer created
  // optimistically (typing /join, opening a DM) has no id until the server
  // answers. Never changes once learned; a rename keeps it (that's the point).
  id?: number;
  // null == app-scoped (the system buffer); a real id for every IRC buffer.
  networkId: number | null;
  kind: BufferKind;
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
  // Set when the server shipped this buffer as an unhydrated SHELL (a backlog
  // frame with no message rows but hasMoreOlder=true — the fresh-connect
  // optimization). Distinct from `messages.length === 0` because a live line can
  // arrive on a shell before the user opens it: activate() must still fetch the
  // real backlog (and must NOT mark-read to that stray line) until a proper
  // hydrate (reattachToLive → applyLatestReplace) clears the flag.
  unseeded: boolean;
  modes?: string;
}

function makeBuffer(networkId: number | string | null, target: string): Buffer {
  const nid = networkId == null ? null : Number(networkId);
  return {
    networkId: nid,
    kind: deriveKind(nid, target),
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
    // Provisional; the buffer's `backlog` frame sets the real value on connect.
    // The system buffer gets a backlog frame too now (#355), so it's no longer
    // special-cased here.
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
    // A brand-new buffer created locally (e.g. before any frame arrives) is not
    // a server shell; replaceBacklog sets this true when a shell frame lands.
    unseeded: false,
  };
}

// Does this buffer need a `history latest` fetch before it can render real
// content? One predicate shared by activate() (the click path) and the
// hydration reconciler (useBufferHydration — the reconnect/retry path) so the
// two can never disagree about what "unhydrated" means. True for: a buffer
// whose slice was wiped on switch-away-from-detached (pendingRefetch), a
// fresh-connect SHELL (unseeded), and a locally-materialized empty buffer
// (brand-new DM, channel-joined pre-backlog). `hasMoreOlder` gates the empty
// case so a genuinely-empty buffer (empty latest reply flipped it false)
// doesn't refetch forever. Detached and in-flight buffers are never "in need"
// — the jump slice is deliberate, and a pending fetch will resolve or be
// failed by failInFlightHistory on socket close.
/**
 * Trim an `around` slice to at most `max` rows while KEEPING THE ANCHOR, with as
 * much context either side as the budget allows.
 *
 * The naive `slice(-max)` keeps the newest rows, which is right for a `latest`
 * reply and wrong for this one: the point of an around slice is the anchor and
 * its surroundings. Reports which end(s) were trimmed so the pager flags stay
 * honest — unlike the tail-only case, either end can now lose rows.
 */
export function windowAroundAnchor(
  events: BufferMessage[],
  anchorId: unknown,
  max: number,
): { events: BufferMessage[]; trimmedOlder: boolean; trimmedNewer: boolean } {
  if (events.length <= max) return { events, trimmedOlder: false, trimmedNewer: false };
  const idx = typeof anchorId === 'number' ? events.findIndex((e) => e.id === anchorId) : -1;
  // Anchor not in the slice (or not told what it is) — nothing to centre on, so
  // the newest rows are as good a choice as any.
  if (idx === -1) return { events: events.slice(-max), trimmedOlder: true, trimmedNewer: false };
  const half = Math.floor(max / 2);
  // Clamp at both ends so an anchor near either edge still yields a full window
  // rather than a short one.
  let start = Math.max(0, idx - half);
  const end = Math.min(events.length, start + max);
  start = Math.max(0, end - max);
  return {
    events: events.slice(start, end),
    trimmedOlder: start > 0,
    trimmedNewer: end < events.length,
  };
}

export function bufferNeedsHydration(buf: Buffer): boolean {
  if (buf.networkId == null) return false;
  if (buf.detached || buf.loadingHistory) return false;
  if (buf.pendingRefetch) return true;
  return (buf.messages.length === 0 || buf.unseeded) && buf.hasMoreOlder;
}

function ensureBuffer(
  state: { buffers: Record<string, Buffer> },
  networkId: number | string | null,
  target: string,
  bufferId?: number | null,
): Buffer {
  // Id fast path first: a frame carrying a bufferId we know resolves to that
  // buffer even if the name disagrees (rename/casing races) — the id is the
  // identity, the name is an attribute (CLIENT_PROTOCOL §5.2).
  if (typeof bufferId === 'number') {
    const known = keyById.get(bufferId);
    if (known && state.buffers[known]) return state.buffers[known];
  }
  // Resolve case-insensitively before creating: a DM/channel already open under
  // a different casing is the same buffer (#327), so reuse it rather than fork a
  // second entry. Only materialize when nothing exists under any casing — and
  // then under the target's own casing, so the first writer's case is canonical.
  const existing = resolveExistingKey(state.buffers, networkId, target);
  if (existing) {
    recordBufferId(state.buffers[existing], existing, bufferId);
    return state.buffers[existing];
  }
  const k = bufferKey(networkId, target);
  state.buffers[k] = makeBuffer(networkId, target);
  recordBufferId(state.buffers[k], k, bufferId);
  return state.buffers[k];
}

/** Learn (or confirm) a buffer's server id. First id wins; the server never
 *  reassigns one, so a conflicting id on the same key means the entry was
 *  re-minted server-side — adopt the new id and drop the stale index entry. */
function recordBufferId(buf: Buffer, key: string, bufferId?: number | null): void {
  if (typeof bufferId !== 'number') return;
  if (buf.id === bufferId && keyById.get(bufferId) === key) return;
  if (buf.id !== undefined && buf.id !== bufferId) keyById.delete(buf.id);
  buf.id = bufferId;
  keyById.set(bufferId, key);
}

export const useBuffersStore = defineStore('buffers', {
  state: () => ({
    // The system buffer (issue #355) is app-scoped (no network) and always
    // present, so the "Lurker" sidebar header always has a real buffer to open
    // and command output / lifecycle log lines have somewhere to land before
    // any network exists. $reset re-seeds it.
    buffers: { [SYSTEM_KEY]: makeBuffer(null, SYSTEM_KEY) } as Record<string, Buffer>,
  }),
  getters: {
    list: (state) => Object.values(state.buffers),
    byKey: (state) => (k: string) => state.buffers[k] || null,
    // Buffer by its server id — the REACTIVE counterpart to bufferKeyForId
    // above. Both answer the same question, and the split is deliberate:
    // bufferKeyForId reads the module-level keyById Map, which is the right
    // shape for the hot frame-application path (O(1), no proxy) but is invisible
    // to Vue, so a watcher built on it never re-fires when an id is learned.
    // Anything reactive — the URL route resolver waiting on a cold-start deep
    // link (#744) — has to come through here instead. O(buffers) per call, which
    // is why it's for the route paths and not for frame application.
    byId: (state) => (id: number) => {
      for (const b of Object.values(state.buffers)) if (b.id === id) return b;
      return null;
    },
    // App-wide highlight total — the sum of every buffer's server-owned
    // `highlighted` count: channel mentions, every unread DM, and notable system
    // lines (see the server's computeUnreadFor). The active buffer always reads
    // 0 (applyReadState/activate force it), so the focused conversation never
    // inflates the total. Drives the PWA app-icon badge (#451); reactive for
    // free since the per-buffer counts are kept authoritative by the server.
    totalHighlights: (state) =>
      Object.values(state.buffers).reduce((sum, b) => sum + (b.highlighted || 0), 0),
    // True only while a buffer for (networkId, target) is live in the store,
    // resolved case-insensitively (#327) like its findByTarget/findDm siblings.
    // A closed buffer is dropped entirely (see drop()), so this is how callers
    // tell "open" from "closed/parted-away" before activating — activate() would
    // otherwise recreate an empty shell and strand the UI in a half-state. The
    // case fold matters because the toast/jump focus guards gate activate() on
    // the raw server-cased target (highlight toast → event.target): an
    // exact-key lookup would report a buffer that's open under a different
    // casing as closed and refuse to focus its own notification.
    isOpen: (state) => (networkId: number | string, target: string) =>
      resolveExistingKey(state.buffers, networkId, target) !== null,
    forNetwork: (state) => (networkId: number | string) =>
      Object.values(state.buffers).filter((b) => b.networkId === networkId),
    // The services account we've learned for a nick anywhere on this network,
    // from extended-join / account-notify (#508). Account is per-network, not
    // per-channel, so any channel we share is an equally good source — take the
    // first that actually knows. Returns undefined when no shared channel has
    // data (we joined after them, or the network lacks the caps), which is
    // distinct from null ("server told us they're logged out").
    accountFor:
      (state) =>
      (networkId: number | string, nick: string): string | null | undefined => {
        if (!nick) return undefined;
        const lc = nick.toLowerCase();
        // Coerce before comparing: buffers store networkId as a number, but the
        // signature accepts a string, and `'3' !== 3` would silently match
        // nothing rather than fail loudly. Same guard resolveExistingKey uses.
        const nid = Number(networkId);
        for (const b of Object.values(state.buffers)) {
          if (b.networkId !== nid) continue;
          const m = b.members?.find(
            (x) => typeof x === 'object' && (x.nick || '').toLowerCase() === lc,
          );
          if (m && m.account !== undefined) return m.account;
        }
        return undefined;
      },
    // The peer's ident@hostname for a DM header (#695 QA follow-up — the slot
    // a channel's topic occupies). Live shared-channel member data first (the
    // freshest source, present even for a history-less DM opened from the
    // nicklist); the DM's own persisted rows as fallback (covers a peer with
    // no shared channel — every message row carries the sender's userhost).
    userhostFor:
      (state) =>
      (networkId: number | string, nick: string): string | null => {
        if (!nick) return null;
        const lc = nick.toLowerCase();
        const nid = Number(networkId);
        for (const b of Object.values(state.buffers)) {
          if (b.networkId !== nid) continue;
          const m = b.members?.find(
            (x) => typeof x === 'object' && (x.nick || '').toLowerCase() === lc,
          );
          if (m?.user && m?.host) return `${m.user}@${m.host}`;
        }
        for (const b of Object.values(state.buffers)) {
          if (b.networkId !== nid || b.target.toLowerCase() !== lc) continue;
          for (let i = b.messages.length - 1; i >= 0; i--) {
            const msg = b.messages[i];
            if (msg.self || (msg.nick || '').toLowerCase() !== lc) continue;
            const uh = msg.userhost;
            if (typeof uh === 'string' && uh) {
              // Rows store the full mask (nick!user@host); the header wants
              // the identity half.
              const bang = uh.indexOf('!');
              return bang === -1 ? uh : uh.slice(bang + 1);
            }
          }
        }
        return null;
      },
    // The open DM buffer for a (network, nick), matched case-insensitively so we
    // resolve to whatever case is already open rather than forking a second
    // buffer that differs only by nick case. Channels and the flat virtual
    // sentinels (`:server:`…) are excluded. One home for the
    // resolution the sidebar and keyboard nav both need.
    findDm:
      (state) =>
      (networkId: number | string, nick: string): Buffer | null => {
        const lower = nick.toLowerCase();
        return (
          Object.values(state.buffers).find(
            (b) =>
              b.networkId === Number(networkId) &&
              b.target.toLowerCase() === lower &&
              !isChannelTarget(b.target) &&
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
    // flat ':'-sentinels (`:server:`…) are fixed keys — exact only.
    findByTarget:
      (state) =>
      (networkId: number | string | null, target: string): Buffer | null => {
        const k = resolveExistingKey(state.buffers, networkId, target);
        return k ? state.buffers[k] : null;
      },
  },
  actions: {
    ensure(networkId: number | string, target: string, bufferId?: number | null) {
      return ensureBuffer(this, networkId, target, bufferId);
    },
    pushMessage(event: BufferMessage) {
      if (!event.target) return false;
      const buf = ensureBuffer(
        this,
        event.networkId,
        event.target,
        typeof event.bufferId === 'number' ? event.bufferId : undefined,
      );
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
      if (buf.messages.length > MAX_PER_BUFFER) {
        buf.messages.splice(0, buf.messages.length - MAX_PER_BUFFER);
        // The ring just evicted the rows `oldestId` pointed at — reachable
        // whenever paging up has grown the buffer past the cap, since
        // prependHistory doesn't trim (the reader is walking backwards; the ring
        // is re-imposed here, on the next live line). Leaving the cursor stale
        // makes the next upward page ask for `before: <an id we no longer hold>`
        // and prepend a slice that isn't contiguous with what's on screen — a
        // silent hole between the two, with nothing to signal it. Re-anchor on
        // what survived, and re-arm the pager: there is now provably more older
        // history than we hold.
        buf.oldestId = buf.messages[0]?.id ?? buf.oldestId;
        buf.hasMoreOlder = true;
      }
      if (buf.oldestId == null && event.id != null) buf.oldestId = event.id;
      // Active-divider tracking + live mark-read. Applies to the system buffer
      // too (#355): it's now a normal buffer with a server-owned read pointer
      // (buffer_reads, null networkId), so a live line marks read the same way —
      // bufferKey() folds the null networkId to the bare :system: key, and the
      // mark-read below rides through with networkId null.
      if (event.id != null) {
        const networks = useNetworksStore();
        // Compare against the resolved buffer's canonical key, not the event's
        // (possibly divergently-cased) target — otherwise a live DM arriving as
        // `bob` while the user sits in the `Bob` buffer reads as inactive and
        // the divider/read-sync below silently skips (#327). Mirrors the same
        // resolve-then-compare applyReadState does.
        // "The user is sitting in this buffer" is what this gates, and in a
        // split frame that stopped being the same as "this is THE active
        // buffer": a side pane is on screen and being read while another pane
        // holds focus. Left as an activeKey test, such a pane accrued an unread
        // badge and a growing divider and never advanced the server's read
        // pointer — while its toasts WERE suppressed, because suppression asks
        // the viewed set. Ask the same question here so the two halves of "can
        // the user see this" cannot disagree.
        //
        // activeKey stays beside it for the states where no message list is
        // mounted at all yet the buffer is still the active one — the Settings
        // route and the mobile list/members screens, where this has always
        // marked read.
        const key = bufferKey(buf.networkId, buf.target);
        const isActive = isBufferViewed(key) || networks.activeKey === key;
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
              bufferId: buf.id,
              networkId: buf.networkId,
              target: buf.target,
              messageId: event.id,
            });
          }
        }
      }
      const speakerKey = event.nick?.toLowerCase();
      if (speakerKey && buf.typing[speakerKey]) {
        // Key off the resolved buffer's target, not event.target — setTyping
        // armed the expiry timer under buf.target, so a divergently-cased event
        // would otherwise miss it and strand the timer (#327).
        clearTypingTimer(buf.networkId, buf.target, event.nick!);
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
      opts: { reset?: boolean; hasMoreOlder?: boolean; bufferId?: number | null } = {},
    ) {
      const buf = ensureBuffer(this, networkId, target, opts.bufferId);
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
        // pre-flap). Take the backlog wholesale. Prefer the server's explicit
        // hasMoreOlder (computed from a real "is there older history?" check)
        // and fall back to the length heuristic only when it's absent. This is
        // also what keeps an offline SHELL frame (events:[], hasMoreOlder:true)
        // fetchable: without it, `[].length >= 50` would be false and activate()
        // would never lazy-load the buffer on open.
        buf.messages = filtered.slice(-MAX_PER_BUFFER);
        buf.hasMoreOlder = opts.hasMoreOlder ?? filtered.length >= 50;
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
        // The system buffer (networkId null) ships a latest-N slice with no
        // resume cursor, so a long disconnect can yield a slice whose OLDEST id
        // is still newer than our tail — meaning rows were missed in between.
        // Appending would splice a permanent hole (the gap is never refetched:
        // 'before' paging only goes downward from our stale tail). Detect the
        // non-overlapping case and replace wholesale instead — land on the live
        // tail and page up for the rest, honoring the server's hasMoreOlder
        // (mirrors the opts.reset branch). Network buffers ride a contiguous
        // since-cursor slice, so this never trips for them (#355).
        const oldestIncomingId = filtered.find((e) => e.id != null)?.id;
        if (networkId == null && oldestIncomingId != null && oldestIncomingId > existingMaxId) {
          buf.messages = filtered.slice(-MAX_PER_BUFFER);
          buf.hasMoreOlder = opts.hasMoreOlder ?? filtered.length >= 50;
        } else if (fresh.length > 0) {
          const combined = [...buf.messages, ...fresh];
          buf.messages =
            combined.length > MAX_PER_BUFFER ? combined.slice(-MAX_PER_BUFFER) : combined;
        }
      }
      // Track shell state independently of messages.length. Real backlog content
      // seeds the buffer; an empty frame with hasMoreOlder (a shell) marks it
      // unhydrated — but only if it's empty or already a shell, so re-shelling an
      // already-loaded buffer (an isFreshNetwork re-snapshot) doesn't un-hydrate
      // it, and a stray live line arriving on a shell before open doesn't clear
      // the flag. activate() reads this (not messages.length) to decide whether
      // to fetch the real backlog on open.
      if (filtered.length > 0) buf.unseeded = false;
      else if (existingMaxId === 0 || buf.unseeded) buf.unseeded = buf.hasMoreOlder;
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
      // Keep the NEWEST rows of an oversized page — they're the ones adjacent to
      // what we hold, so the merged slice stays contiguous.
      const trimmed = fresh.length > MAX_MERGE_ROWS;
      const page = trimmed ? fresh.slice(-MAX_MERGE_ROWS) : fresh;
      buf.messages = [...page, ...buf.messages];
      const first = buf.messages[0];
      buf.oldestId = first?.id ?? buf.oldestId;
      buf.hasMoreOlder = trimmed || !!hasMoreOlder;
      buf.loadingHistory = false;
      buf.unseeded = false;
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
      // Keep the OLDEST rows of an oversized page — the ones adjacent to our
      // tail — so the merged slice stays contiguous and the reader's context
      // survives the ring's eviction.
      const trimmed = fresh.length > MAX_MERGE_ROWS;
      const page = trimmed ? fresh.slice(0, MAX_MERGE_ROWS) : fresh;
      const combined = [...buf.messages, ...page];
      const evictedOlder = combined.length > MAX_PER_BUFFER;
      buf.messages = evictedOlder ? combined.slice(combined.length - MAX_PER_BUFFER) : combined;
      buf.oldestId = buf.messages[0]?.id ?? buf.oldestId;
      buf.newestId = buf.messages[buf.messages.length - 1]?.id ?? buf.newestId;
      buf.hasMoreNewer = trimmed || !!hasMoreNewer;
      // We just evicted rows off the old edge, so there is provably more older
      // history than we hold — whatever the pager thought before. Re-arming it
      // here is what keeps the eviction from reading as "start of buffer".
      if (evictedOlder) buf.hasMoreOlder = true;
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
    // Returns the request token so a caller (useJumpToMessage) can correlate the
    // eventual applyAroundSlice, or null if the socket was closed and nothing was
    // sent — in which case no response will ever arrive to scroll to.
    loadAround(
      networkId: number | string,
      target: string,
      anchorId: number,
      halfLimit = 100,
    ): number | null {
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
        bufferId: buf.id,
        anchorId,
        token,
        limit: halfLimit,
        countBy: historyCountBy(),
      });
      // Same rollback rationale as reattachToLive — a failed send leaves no
      // response to clear the loading flag. Restoring detached to its prior
      // state too (rather than forcing false) avoids stomping on a buffer
      // that was already detached from a previous jump.
      if (!sent) {
        buf.loadingHistory = false;
        buf.pendingHistoryToken = null;
        buf.detached = wasDetached;
        return null;
      }
      return token;
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
      // Centred on the anchor, NOT `slice(-MAX)`. An `around` window is
      // symmetrical about the anchor by construction (the server sends up to
      // halfLimit either side), and a busy channel's noise easily pushes it past
      // the ring — 963 rows for a 200-row request was the case that exposed
      // this. Keeping the tail throws away the older half, which lands the
      // anchor a handful of rows from the top with no context above it, and when
      // more than MAX rows follow the anchor it discards the anchor itself and
      // the jump reports that it couldn't find the message.
      const win = windowAroundAnchor(filtered, payload.anchorId, MAX_PER_BUFFER);
      buf.messages = win.events;
      buf.oldestId = buf.messages[0]?.id ?? null;
      buf.newestId = buf.messages[buf.messages.length - 1]?.id ?? null;
      // Trimming can now happen at EITHER end, so each flag follows its own end.
      buf.hasMoreOlder = win.trimmedOlder || !!payload.hasMoreOlder;
      buf.hasMoreNewer = win.trimmedNewer || !!payload.hasMoreNewer;
      buf.pendingHistoryToken = null;
      buf.loadingHistory = false;
    },
    // Snap back to the live tail. Sent by the StatusBar "Return to present"
    // button. Same token discipline as loadAround — detached stays true
    // until the response lands, so any fanOut between request and response
    // continues to be dropped by pushMessage.
    // Returns true when the request actually went out over the socket, so
    // callers (ensureHydrated) can decide whether to consume one-shot intent
    // flags like pendingRefetch — a failed send must leave them armed for the
    // next attempt.
    reattachToLive(networkId: number | string, target: string, limit = 200): boolean {
      const buf = ensureBuffer(this, networkId, target);
      // No detached guard: this is also called by activate() to refetch
      // the live tail after a switch-away from a detached buffer wiped
      // the slice. In that case detached is already false. The applyLatestReplace
      // handler is idempotent (re-clearing already-clear flags is a no-op).
      if (buf.loadingHistory) return false;
      const token = nextHistoryToken();
      buf.pendingHistoryToken = token;
      buf.loadingHistory = true;
      const sent = socketSend({
        type: 'history',
        mode: 'latest',
        networkId,
        target,
        bufferId: buf.id,
        token,
        limit,
        // This is the hydrate — the fetch that fills the FIRST screenful, and so
        // the one the spin-loop was most visible on.
        countBy: historyCountBy(),
      });
      // socketSend returns false when the socket isn't open. No response will
      // arrive to clear loadingHistory — so without this rollback the buffer
      // would be stranded "loading" until the socket-close sweep
      // (failInFlightHistory) ran, and every fetch guard (this function's
      // early-return, MessageList's requestMoreHistory) would block until then.
      // Relevant when activate fires before the socket has (re)connected, e.g.
      // push-notification deep-link into a cold PWA.
      if (!sent) {
        buf.loadingHistory = false;
        buf.pendingHistoryToken = null;
        return false;
      }
      return true;
    },
    // Fire the initial `latest` fetch for the active-path buffer if (and only
    // if) it still needs one — see bufferNeedsHydration. Safe to call
    // repeatedly: it no-ops once a fetch is in flight or the buffer is
    // hydrated. pendingRefetch is consumed only when the request really went
    // out; a send into a closed socket leaves it armed so the hydration
    // reconciler retries on reconnect instead of silently downgrading the
    // wiped-slice case to "maybe the empty-arm catches it".
    ensureHydrated(networkId: number | string | null, target: string) {
      const buf = this.findByTarget(networkId, target);
      if (!buf || buf.networkId == null || !bufferNeedsHydration(buf)) return;
      const sent = this.reattachToLive(buf.networkId, buf.target);
      if (sent && buf.pendingRefetch) buf.pendingRefetch = false;
    },
    // Socket died. Any in-flight history request (latest/around/before/after)
    // will never get a response, and every fetch path early-returns while
    // loadingHistory is set — historically a permanently wedged, blank,
    // un-refetchable buffer. Called from the socket 'close' handler (the same
    // seam that fails pending ACKs) so the flags are clean before the
    // reconnect's snapshot and the hydration reconciler's refetch arrive.
    failInFlightHistory() {
      for (const buf of Object.values(this.buffers)) {
        if (buf.loadingHistory || buf.pendingHistoryToken != null) {
          buf.loadingHistory = false;
          buf.pendingHistoryToken = null;
        }
      }
      // Same reasoning, different latch: a reply that can no longer arrive must
      // not leave us primed to treat someone else's open as ours. See pendingOpens.
      // Timers first — clearing the Map alone would leave them to fire into an
      // empty Map across the reconnect.
      for (const id of pendingOpens.values()) clearTimeout(id);
      pendingOpens.clear();
    },
    // Ask the server to OPEN a buffer. This is a WRITE — it reopens a closed
    // row, mints a DM row for a bare nick, or JOINs an unjoined channel — so it
    // belongs to deliberate user intent ("open this DM", a clicked channel
    // name), never to filling in a shell. Hydration goes through
    // ensureHydrated/reattachToLive, which read and change nothing.
    //
    // The send lives here rather than at the call site so the pendingOpens
    // bookkeeping can't be forgotten by the next caller that needs this verb —
    // forgetting it doesn't fail loudly, it just makes another device's open
    // steal this tab's focus.
    openBuffer(networkId: number | string, target: string): boolean {
      const key = joinKey(networkId, target);
      const existing = pendingOpens.get(key);
      if (existing) clearTimeout(existing);
      pendingOpens.set(
        key,
        setTimeout(() => pendingOpens.delete(key), PENDING_OPEN_TIMEOUT),
      );
      const sent = socketSend({
        type: 'open-buffer',
        networkId,
        target,
        // Present only when the buffer already exists locally — the id form
        // addresses an existing row; minting/JOINing is inherently name-first.
        bufferId: idFor(networkId, target),
        // The reply re-seeds history for a since-closed buffer, so it's a first
        // screenful like any other hydrate (§8).
        countBy: historyCountBy(),
      });
      if (!sent) {
        clearTimeout(pendingOpens.get(key)!);
        pendingOpens.delete(key);
      }
      return sent;
    },
    // Did THIS tab ask for `target` to be opened? Consumes the record, so the
    // reply focuses exactly once.
    claimPendingOpen(networkId: number | string, target: string): boolean {
      const key = joinKey(networkId, target);
      const timer = pendingOpens.get(key);
      if (timer === undefined) return false;
      clearTimeout(timer);
      pendingOpens.delete(key);
      return true;
    },
    applyLatestReplace(networkId: number | string, target: string, payload: any) {
      const buf = ensureBuffer(this, networkId, target);
      if (payload.token !== buf.pendingHistoryToken) return;
      const filtered = (payload.events || []).filter(
        (e: BufferMessage) => e.type !== 'away' && e.type !== 'back',
      );
      buf.messages = filtered.slice(-MAX_PER_BUFFER);
      // The ring dropped rows off the old edge. `payload.hasMoreOlder` was
      // computed by the server against the WHOLE slice it sent, so honoring a
      // `false` here would strand the pager on history we evicted ourselves —
      // and countBy:'renderable' can legitimately make a slice bigger than the
      // ring (a netsplit's worth of noise rides along with the page).
      const evictedOlder = filtered.length > buf.messages.length;
      buf.oldestId = buf.messages[0]?.id ?? null;
      buf.newestId = buf.messages[buf.messages.length - 1]?.id ?? null;
      // A token-matched latest reply is TERMINAL hydration even when every row
      // filtered out client-side (a legacy away/back tail can blank the whole
      // slice). Honoring the server's hasMoreOlder on an empty slice would
      // leave `messages.length === 0 && hasMoreOlder` standing forever —
      // bufferNeedsHydration true, the reconciler refetching the same empty
      // slice every throttle window, and the pane claiming a settled "No
      // messages yet." between attempts. Clamping to false costs nothing: an
      // empty buffer has no anchor row, so the upward pager can't page it
      // anyway.
      buf.hasMoreOlder = filtered.length > 0 ? evictedOlder || !!payload.hasMoreOlder : false;
      buf.hasMoreNewer = false;
      buf.detached = false;
      buf.liveDuringDetach = 0;
      buf.pendingHistoryToken = null;
      buf.loadingHistory = false;
      // Fully hydrated now (this reply is the shell's real backlog) — clear the
      // shell flag so activate() stops trying to refetch it.
      buf.unseeded = false;
      // Seed the recent-speaker map from the reply so nick autocomplete works the
      // moment you open a channel — not only after someone speaks. This is the
      // primary place speakers load now (the connect snapshot no longer ships
      // them); seedSpeakers merges, so it composes with recordSpeaker's live map.
      if (payload.speakers !== undefined) this.seedSpeakers(networkId, target, payload.speakers);
      // We're back on live: advance the read pointer to the new tail in the
      // same way activate() does on focus-in. Server clamps with MAX(), so
      // sending mark-read against the latest known id is idempotent.
      const lastMsg = buf.messages[buf.messages.length - 1];
      const lastId = lastMsg?.id ?? 0;
      if (lastId > buf.lastReadId) {
        buf.lastReadId = lastId;
        socketSend({
          type: 'mark-read',
          bufferId: buf.id,
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
    clearDetached(
      networkId: number | string | null,
      target: string,
      { wipeMessages = false } = {},
    ) {
      const buf = this.buffers[bufferKey(networkId, target)];
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
    setLoadingHistory(networkId: number | string | null, target: string, loading: boolean) {
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
    // Patch attributes on one member in place, leaving fields the caller didn't
    // mention alone. Matched case-insensitively: a CHGHOST/ACCOUNT echoes the
    // nick as the server holds it, which needn't match the case NAMES gave us.
    updateMember(
      networkId: number | string,
      target: string,
      nick: string | undefined,
      patch: Partial<BufferMember> | undefined,
    ) {
      if (!nick || !patch) return;
      // Resolve, never create. Unlike addMember/removeMember — which ride a
      // join/part that legitimately implies the buffer should exist — a pure
      // attribute patch has no business materializing a buffer, and doing so
      // would leave an empty one in the sidebar when the target isn't open.
      const bufKey = resolveExistingKey(this.buffers, networkId, target);
      if (!bufKey) return;
      const buf = this.buffers[bufKey];
      const lc = nick.toLowerCase();
      const m = buf.members.find(
        (x) => typeof x === 'object' && (x.nick || '').toLowerCase() === lc,
      );
      if (!m) return;
      // Never let a patch blank out a nick, and skip keys the sender omitted so
      // a chghost carrying only the changed half can't wipe the other one.
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'nick' || v === undefined) continue;
        (m as unknown as Record<string, unknown>)[k] = v;
      }
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
      // Resolve case-insensitively (#327) so a divergently-cased close target
      // (the server doesn't canonicalize DM casing — the #327 root cause) still
      // removes the buffer instead of silently leaving a sidebar ghost. Key all
      // bookkeeping off the resolved buffer's canonical target below.
      const bufKey = resolveExistingKey(this.buffers, networkId, target);
      if (!bufKey) return;
      const buf = this.buffers[bufKey];
      // Cancel any pending typing-expiry timers for this buffer before it (and
      // its typing entries) vanishes — otherwise a timer armed while a peer was
      // typing sits in the module-level map until it fires on its own. Timers
      // are keyed by the canonical target (setTyping uses buf.target), so the
      // prefix has to match that, not the raw close-event casing.
      const prefix = `${buf.networkId}::${buf.target}::`;
      for (const [k, id] of typingTimers) {
        if (k.startsWith(prefix)) {
          clearTimeout(id);
          typingTimers.delete(k);
        }
      }
      if (buf.id !== undefined) keyById.delete(buf.id);
      delete this.buffers[bufKey];
    },
    // Lifecycle hooks (lib/bufferLifecycle.ts). This store must be swept
    // FIRST — the others may resolve through it.
    dropBuffer(networkId: number | string | null, target: string) {
      if (networkId == null) return; // the system buffer is permanent
      this.drop(networkId, target);
    },
    // Move the entry to its new name, keeping the same Buffer object (and
    // therefore its id — a rename never changes identity). If an entry
    // already exists under the destination (the server announced a merge and
    // the frames raced), the destination wins and the source is dropped —
    // matching the server's source-survives merge from the other side.
    rekeyBuffer(networkId: number | string | null, from: string, to: string) {
      if (networkId == null) return;
      const fromKey = resolveExistingKey(this.buffers, networkId, from);
      if (!fromKey) return;
      const toKey = bufferKey(networkId, to);
      if (fromKey === toKey) return;
      if (this.buffers[toKey]) {
        this.drop(networkId, from);
        return;
      }
      const buf = this.buffers[fromKey];
      // Move typing timers to the new composite prefix — their keys embed the
      // canonical target.
      const oldPrefix = `${buf.networkId}::${buf.target}::`;
      const newPrefix = `${buf.networkId}::${to}::`;
      const moved: Array<[string, ReturnType<typeof setTimeout>]> = [];
      for (const [k, id] of typingTimers) {
        if (k.startsWith(oldPrefix)) moved.push([k, id]);
      }
      for (const [k, id] of moved) {
        typingTimers.delete(k);
        typingTimers.set(newPrefix + k.slice(oldPrefix.length), id);
      }
      buf.target = to;
      buf.kind = deriveKind(buf.networkId, to);
      this.buffers[toKey] = buf;
      delete this.buffers[fromKey];
      if (buf.id !== undefined) keyById.set(buf.id, toKey);
    },
    // Called from useSessionReset before $reset(). The state reset will wipe
    // every buffer (and therefore every typing indicator), but the
    // module-level Map of pending setTimeouts isn't part of Pinia state —
    // clear it explicitly so timers don't linger after logout.
    resetTimers() {
      keyById.clear();
      for (const id of typingTimers.values()) clearTimeout(id);
      typingTimers.clear();
      for (const id of pendingJoins.values()) clearTimeout(id);
      pendingJoins.clear();
      // Also module-level, and logout doesn't reach the socket-close path that
      // normally clears it (resetSocket aborts the listeners, so 'close' never
      // fires). A latch surviving into the NEXT account's session would let a
      // cross-device open of the same target steal that user's focus.
      for (const id of pendingOpens.values()) clearTimeout(id);
      pendingOpens.clear();
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
    joinOrActivate(networkId: number | string, channel: string, key?: string): boolean {
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
        return socketSend({ type: 'join', networkId: nid, channel: existing.target, key });
      }
      // Brand-new channel: don't open optimistically (#260). Join and wait for
      // the channel-joined confirmation; requestJoin focuses on success and
      // toasts on rejection.
      const ok = socketSend({ type: 'join', networkId: nid, channel, key });
      if (ok) this.requestJoin(nid, channel);
      return ok;
    },
    // "Join a channel from a button" — the shared path behind JoinChannelModal
    // and the channel-list browser. joinOrActivate returns false only when a
    // JOIN had to go out over a closed socket; surface that as an offline toast
    // so the click isn't a silent no-op. Returns joinOrActivate's result.
    joinOrToast(networkId: number | string, target: string): boolean {
      const ok = this.joinOrActivate(networkId, target);
      if (!ok) {
        useToastsStore().push({
          kind: 'warn',
          title: 'Not connected',
          body: `Can't join ${target} while disconnected.`,
          networkId: typeof networkId === 'string' ? Number(networkId) : networkId,
          ttlMs: 5000,
        });
      }
      return ok;
    },
    setJoined(networkId: number | string, target: string, joined: boolean) {
      // Resolve case-insensitively (#327): channel-joined/-parted already arrive
      // canonical from the server (canonicalChannelTarget), but fold here too so
      // a divergently-cased target never misses the open buffer and leaves it
      // stuck rendering dimmed.
      const buf = this.findByTarget(networkId, target);
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
      // sidebar (#319). findByTarget resolves case-insensitively and returns null
      // when nothing is open, so a broadcast whose target case differs from the
      // open buffer's key (servers hand us inconsistently-cased names, #289)
      // still lands on the right buffer instead of silently dropping the badge —
      // the same resolve-don't-materialize the typing path uses. Snapshot callers
      // (replaceBacklog) ensureBuffer before delegating here.
      const buf = this.findByTarget(networkId, target);
      if (!buf) return;
      const lastReadId = Number(payload?.lastReadId) || 0;
      const networks = useNetworksStore();
      // Compare against the resolved buffer's canonical key, not the (possibly
      // differently-cased) broadcast target, so badge suppression tracks the
      // buffer the user is actually sitting in. bufferKey() also yields the bare
      // sentinel for the app-scoped system buffer (networkId null).
      const isActive = networks.activeKey === bufferKey(buf.networkId, buf.target);
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
      const wasCleared = buf.clearedBeforeId > 0;
      buf.clearedBeforeId = Number(payload?.clearedBeforeId) || 0;
      buf.clearedAt = payload?.clearedAt || null;
      // UNCLEAR resets the buffer to the latest chat, it doesn't excavate.
      // Whatever hidden rows accumulated in memory during the cleared state
      // (up to a full page from before the clear) would otherwise all render
      // at once — the user asked for their buffer back, not an archaeology
      // dig. Trim to the newest standard page, flag that older history
      // exists, and let the ordinary scroll pager re-fetch on demand. Local
      // trim only — no refetch — so the multi-tab fan-out costs nothing.
      // Detached views ignore the clear filter entirely and keep their slice.
      if (wasCleared && buf.clearedBeforeId === 0 && !buf.detached) {
        const KEEP = 200; // one standard backlog page (server's latest slice)
        if (buf.messages.length > KEEP) {
          buf.messages = buf.messages.slice(-KEEP);
          buf.hasMoreOlder = true;
        }
        buf.oldestId = null;
        buf.newestId = null;
      }
    },
    // /clear: anchor the marker at the current tail (server picks the exact
    // boundary id). Best-effort send; the server's fan-out echoes back and
    // applyClearedState moves the local mirror to the authoritative value.
    clearBuffer(networkId: number | string, target: string) {
      socketSend({ type: 'clear-buffer', networkId, target, bufferId: idFor(networkId, target) });
    },
    // Drop the /clear marker so hidden messages reappear. Fired by the
    // "Show earlier messages" affordance on the divider and by `/clear off`.
    unclearBuffer(networkId: number | string, target: string) {
      socketSend({ type: 'unclear-buffer', networkId, target, bufferId: idFor(networkId, target) });
    },
    // "The user stopped looking at this buffer." Drops the visit-scoped local
    // state: the pinned unread divider, the unread/highlight counters, and any
    // detached history slice.
    //
    // Split out of activate() because focus and visibility are the same thing in
    // a single-pane shell and different things in a split one. With one pane,
    // switching away IS stopping looking, so activate() calls this for the
    // previous buffer. With a split, a pane you focused away from is still on
    // screen and still being read — what means "stopped looking" there is
    // closing that pane, so the splits store calls this itself.
    leaveBuffer(bufKey: string) {
      const prev = this.buffers[bufKey];
      if (!prev) return;
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
      if (prev.detached) this.clearDetached(prev.networkId, prev.target, { wipeMessages: true });
    },
    // Switch to a buffer. We mark the entered buffer read on focus-IN (not
    // on focus-OUT of the previous one) so that a tab close / reload / lost
    // socket before switch-away still leaves the buffer marked read — no
    // phantom divider on the next session. The previous buffer's pointer
    // is already current because pushMessage keeps it synced live while
    // focused (see pushMessage), so leaving it just drops local state.
    //
    // `retainPrevious` suppresses the leave-teardown of the outgoing buffer, for
    // callers where focusing elsewhere doesn't mean the old buffer left the
    // screen — i.e. a split layout, which owns that lifecycle itself.
    activate(
      networkId: number | string | null,
      target: string,
      opts: { retainPrevious?: boolean } = {},
    ) {
      const networks = useNetworksStore();
      // Resolve to the canonical open buffer first (case-insensitive): a DM
      // activated from a member-list nick, /query, the profile modal, or a
      // deep-link may carry a different casing than the buffer that's already
      // open (#327). Focusing the raw casing would fork a duplicate via
      // ensureBuffer and — worse — point activeKey at a key no buffer is stored
      // under, so useActiveBuffer's byKey(activeKey) returns null and blanks the
      // chat view. canonTarget is the existing buffer's casing, or the raw
      // target when none is open yet (first writer's case becomes canonical).
      const existing = this.findByTarget(networkId, target);
      const canonTarget = existing ? existing.target : target;
      // bufferKey() yields the bare sentinel for the app-scoped system buffer
      // (networkId null) and the usual `${networkId}::${target}` otherwise.
      const newKey = bufferKey(networkId, canonTarget);
      const prevKey = networks.activeKey;
      // Activating a buffer that is ALREADY rendered on screen is a focus
      // change, not a switch — so the outgoing buffer hasn't gone anywhere and
      // must keep its divider and counters. That case only exists in a split
      // layout (focus pane B while pane A stays up), and it arrives through the
      // paths the splits store doesn't own: the quick switcher, /query, a
      // jump-to-message, a deep link. With one pane the only on-screen buffer
      // IS the active one, so this never fires — prevKey === newKey is already
      // excluded on the next line.
      const focusingVisiblePane = isBufferViewed(newKey);
      if (!opts.retainPrevious && !focusingVisiblePane && prevKey && prevKey !== newKey)
        this.leaveBuffer(prevKey);
      networks.setActive(networkId, canonTarget);
      const buf = ensureBuffer(this, networkId, canonTarget);
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
      //
      // Also skip while unseeded: a shell that received a stray live line before
      // open has that one line as its "tail", but the real backlog (including
      // everything between lastReadId and that line) hasn't loaded yet. Marking
      // up to the stray line would clear unread for messages the user never saw.
      // The reattachToLive fired below does its own mark-read against the real
      // tail once hydrated.
      if (!buf.detached && !buf.unseeded) {
        const lastMsg = buf.messages[buf.messages.length - 1];
        const lastId = lastMsg?.id ?? 0;
        if (lastId > buf.lastReadId) {
          buf.lastReadId = lastId;
          socketSend({
            type: 'mark-read',
            bufferId: buf.id,
            networkId,
            target: canonTarget,
            messageId: lastId,
          });
        }
      }
      // Fire the initial fetch if the buffer still needs one: a slice wiped on
      // switch-away-from-detached (pendingRefetch), a fresh-connect SHELL
      // (unseeded), or a locally-materialized empty buffer — profile-modal
      // "Send DM" to a never-DM'd nick, the channel-joined handler's ensure()
      // racing its backlog, a push-notification deep-link onto a shell. The
      // decision (and its guards) lives in bufferNeedsHydration so this click
      // path and the hydration reconciler (useBufferHydration — which retries
      // when THIS send loses the race with a closed/half-dead socket) can
      // never disagree about what "needs a fetch" means.
      this.ensureHydrated(networkId, canonTarget);
      // For DMs, ask the server to WHOIS-probe the peer so the banner/sidebar
      // dim reflect current state rather than a possibly-stale cached value.
      // The probe is silent (no /whois reply in the server buffer); only the
      // resulting peer-presence event flows back to update local state.
      // DMs only — channels (#…) and the flat sentinels (:server:, :system:) have
      // no peer to probe.
      if (canonTarget && !isChannelTarget(canonTarget) && !canonTarget.startsWith(':')) {
        socketSend({ type: 'probe-presence', networkId, nick: canonTarget });
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
        const b = this.buffers[bufferKey(networkId, tkTarget)];
        if (b && b.typing[canon]) {
          delete b.typing[canon];
        }
        typingTimers.delete(typingKey(networkId, tkTarget, nick));
      }, duration);
      typingTimers.set(typingKey(networkId, tkTarget, nick), timer);
    },
  },
});
