// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Ref } from 'vue';
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
import { useIgnoresStore } from '../stores/ignores.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useRelayBotsStore } from '../stores/relayBots.js';
import { useFriendsStore } from '../stores/friends.js';
import { useWhoisStore } from '../stores/whois.js';
import { useBookmarksStore } from '../stores/bookmarks.js';
import { useDataExportStore } from '../stores/dataExport.js';
import { useToastsStore } from '../stores/toasts.js';
import { downloadTextFile } from '../utils/download.js';
import { notifyForEvent, playSound } from './useHighlightNotifier.js';

export interface AckResult {
  ok: boolean;
  error?: string;
}

export interface SocketAPI {
  connected: Ref<boolean>;
  send(payload: Record<string, unknown>): boolean;
  reconnect(): void;
}

type AckResolver = (result: AckResult) => void;

let socket: WebSocket | null = null;
// Scopes the current socket's event listeners. Aborting it detaches all of
// them at once — used by resetSocket to strip handlers before closing so the
// 'close' reconnect arm can't fire.
let socketListeners: AbortController | null = null;
// Module-level singleton: the live WS link to the lurker service. Exported so
// read-only consumers (e.g. the FRIENDS status dot) can reflect it without
// calling useSocket() (which would re-register the connect lifecycle).
export const connected = ref(false);
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const openHandlers = new Set<() => void>();
// Outstanding send/action ACKs keyed by clientId. Resolver is called with
// { ok, error } when the server returns a send-result, on socket close, or on
// timeout — whichever fires first.
const pendingAcks = new Map<string, AckResolver>();
const ACK_TIMEOUT_MS = 8000;
// Highest event id this client has ever received in any buffer. Sent on
// reconnect as `?since=N` so the server can ship just the gap instead of
// re-issuing the whole last-50-per-buffer backlog. Per-buffer dedupe in
// buffers.pushMessage handles any residual overlap if the gap is empty.
let lastSeenEventId = 0;

export function onSocketOpen(handler: () => void): () => void {
  openHandlers.add(handler);
  return () => openHandlers.delete(handler);
}

// If the tab has been hidden for more than this, ask the server for a fresh
// snapshot on return. This collapses a long queue of buffered live events
// (which would otherwise drip into the UI one frame at a time) into a single
// atomic backlog replace — i.e. the view "snaps" to current state.
const HIDDEN_RESNAPSHOT_MS = 30_000;
let hiddenSince: number | null = null;
let visibilityWired = false;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const base = `${proto}://${window.location.host}/ws`;
  return lastSeenEventId > 0 ? `${base}?since=${lastSeenEventId}` : base;
}

function trackSeenId(eventId: unknown): void {
  if (typeof eventId === 'number' && eventId > lastSeenEventId) {
    lastSeenEventId = eventId;
  }
}

function applyEvent(event: any): void {
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
        buffers.recordSpeaker(
          event.networkId,
          event.target,
          event.nick,
          Date.parse(event.time) || Date.now(),
        );
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
    case 'own-nick':
      networks.applyOwnNick(event);
      break;
    case 'topic':
      if (!buffers.pushMessage(event)) break;
      buffers.setTopic(event.networkId, event.target, event.text);
      break;
    case 'channel-topic':
      buffers.setTopic(event.networkId, event.target, event.topic);
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
      // A pending join (from the channel list or a typed /join) waits for this
      // confirmation before focusing the buffer (#260) — activate it now. No-op
      // for joins that weren't pending (e.g. reconnect rejoins).
      buffers.confirmPendingJoin(event.networkId, event.target);
      break;
    case 'join-error':
      // The server refused the join (invite-only, banned, needs registered
      // nick, …). The buffer was never opened, so just cancel the pending
      // activation and surface the reason as a toast on the channel (#260).
      buffers.cancelPendingJoin(event.networkId, event.target);
      useToastsStore().push({
        kind: 'warn',
        title: `Couldn’t join ${event.target}`,
        body: event.text || 'The server refused the join.',
        networkId: event.networkId,
        target: event.target,
        ttlMs: 6000,
      });
      break;
    case 'invite': {
      // Someone invited us to a channel we're not in. Surface it as an
      // actionable toast with a one-click Join — the durable record lives in the
      // system buffer (logged server-side), so a longer TTL here is just a
      // convenience window, not the only chance to act (#261).
      const channel = event.channel as string;
      const from = event.from as string;
      useToastsStore().push({
        kind: 'notify',
        title: `Invitation to ${channel}`,
        body: `${from} invited you`,
        ttlMs: 15000,
        action: { label: 'Join', onClick: () => buffers.joinOrActivate(event.networkId, channel) },
      });
      break;
    }
    case 'channel-parted':
      // Keep the buffer around so the user can still scroll history; just
      // mark it un-joined so it renders dimmed in the buffer list. /close
      // (or the server's buffer-closed broadcast) is what actually drops it.
      buffers.setJoined(event.networkId, event.target, false);
      buffers.setMembers(event.networkId, event.target, []);
      break;
    case 'typing':
      buffers.setTyping(
        event.networkId,
        event.target,
        event.nick,
        event.state,
        event.userhost ?? null,
      );
      break;
    case 'peer-presence': {
      // Capture the prior known state BEFORE applying the update — the
      // came-online toast must fire only on a transition we actually witnessed.
      const prevPeerState =
        networks.states[event.networkId]?.peerPresence?.[String(event.nick).toLowerCase()]?.state ??
        null;
      networks.applyPeerPresence(event.networkId, event.nick, {
        state: event.state,
        stateAt: event.stateAt,
        awayMessage: event.awayMessage,
      });
      const friends = useFriendsStore();
      // Came-online notification: only on a real offline→online transition. The
      // server also reports current state on the MONITOR seed and whenever a nick
      // is freshly added to the watch (RPL_MONONLINE with no prior presence row),
      // so keying purely off `state === 'online'` would fire when you add an
      // already-online friend or on a first connect. Gate on the prior client
      // state being 'offline' so only genuine transitions notify.
      //
      // In-app toast + sound only when the tab is visible — the hidden case is
      // the server-side push's job (wsHub.maybePushFriendOnline), gated on the
      // same Page Visibility signal, so exactly one of the two fires.
      if (
        event.state === 'online' &&
        prevPeerState === 'offline' &&
        typeof document !== 'undefined' &&
        !document.hidden
      ) {
        const contact = friends.notifyContactFor(event.networkId, event.nick);
        const settings = useSettingsStore();
        if (contact && settings.effective('notifications.friend_online.enabled')) {
          // Name the nick that actually signed on when it differs from the
          // display name — for a friend watched under several nicks/alts, "(as
          // nostimo)" says which identity, and matches the dot in the breakdown.
          const nick = String(event.nick);
          const asNick =
            nick && nick.toLowerCase() !== contact.displayName.toLowerCase() ? ` (as ${nick})` : '';
          useToastsStore().push({
            kind: 'notify',
            title: `${contact.displayName} came online${asNick}`,
            body: '',
            networkId: event.networkId,
            target: event.nick,
          });
          // Optional sound, same enable/choice/volume model as the DM/highlight/
          // always-notify toasts (shared playSound helper).
          if (settings.effective('notifications.friend_online.sound.enabled')) {
            playSound(
              (settings.effective('notifications.friend_online.sound.choice') as string) || 'knock',
              settings.effective('notifications.friend_online.sound.volume'),
            );
          }
        }
      }
      break;
    }
    case 'system': {
      // App-scoped system-buffer line. It now arrives as a normal buffer event
      // (the system buffer rides the unified backlog/irc/history path, #355), so
      // it just appends like any other — keyed to :system: by its null networkId.
      buffers.pushMessage(event);
      break;
    }
    case 'e2e': // RPE2E status line (#382) — same routing as a server notice.
    case 'ctcp': // CTCP request/reply/echo status line (#263) — same routing.
    case 'motd':
    case 'error': {
      const decorated = { ...event, target: event.target || `:server:${event.networkId}` };
      const fresh = buffers.pushMessage(decorated);
      // An unrecognized slash command (forwarded as raw IRC) only fails once
      // the server 421s, and that lands in the server buffer — invisible if
      // you typed in a channel. Mirror it as a toast so the feedback shows up
      // where you're looking. Gated on `fresh` so a resume-gap replay of the
      // same error can't re-fire it (same guard the message path uses).
      if (fresh && event.unknownCommand) {
        useToastsStore().push({
          kind: 'warn',
          title: 'Unknown command',
          body: event.unknownCommand,
          networkId: event.networkId,
          target: decorated.target,
          ttlMs: 6000,
        });
      }
      break;
    }
    case 'whois_result': {
      const whois = useWhoisStore();
      whois.applyResult(event.networkId, event.whois || {});
      break;
    }
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

function applySnapshot(snapshot: any[], globalIgnores: any[] = []): void {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const pins = usePinsStore();
  const nicklistCollapse = useNicklistCollapseStore();
  const channelNotify = useChannelNotifyStore();
  const ignores = useIgnoresStore();
  const nickNotes = useNickNotesStore();
  const relayBots = useRelayBotsStore();
  networks.applySnapshot(snapshot);
  pins.applySnapshot(snapshot);
  nicklistCollapse.applySnapshot(snapshot);
  channelNotify.applySnapshot(snapshot);
  ignores.applySnapshot(snapshot, globalIgnores);
  nickNotes.applySnapshot(snapshot);
  relayBots.applySnapshot(snapshot);
  // Highlight rules aren't in the snapshot; load them now so client-side
  // render-time highlight evaluation (#349) works app-wide, not just after the
  // settings pane has been opened.
  useHighlightRulesStore()
    .fetchAll()
    .catch(() => {
      /* ignore — server stamp (m.matched) still drives highlighting */
    });
  for (const net of snapshot) {
    for (const ch of net.channels) {
      // Snapshot members are already { nick, modes } objects from the server.
      // Tolerate the legacy plain-string shape in case an old snapshot is in flight.
      const normalized = ch.members.map((m: any) =>
        typeof m === 'string'
          ? { nick: m, modes: [], away: false }
          : { nick: m.nick, modes: m.modes || [], away: !!m.away },
      );
      buffers.setMembers(net.networkId, ch.name, normalized);
      buffers.setTopic(net.networkId, ch.name, ch.topic);
      buffers.setChannelModes(net.networkId, ch.name, ch.modes || '');
    }
  }
}

function applyBacklog(payload: any): void {
  const buffers = useBuffersStore();
  buffers.replaceBacklog(
    payload.networkId,
    payload.target,
    payload.events,
    payload.speakers,
    {
      lastReadId: payload.lastReadId,
      unread: payload.unread,
      highlights: payload.highlights,
      highlightsCapped: payload.highlightsCapped,
      clearedBeforeId: payload.clearedBeforeId,
      clearedAt: payload.clearedAt,
    },
    payload.joined,
    // reset: the resume gap overflowed the server cap, so `events` is a fresh
    // latest slice meant to replace the buffer rather than gap-fill onto it.
    { reset: !!payload.reset, hasMoreOlder: payload.hasMoreOlder },
  );
  if (payload.inputHistory) {
    const inputHistory = useInputHistoryStore();
    inputHistory.seed(payload.networkId, payload.target, payload.inputHistory);
  }
}

function handleMessage(raw: string): void {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    return;
  }

  if (payload.kind === 'snapshot') {
    applySnapshot(payload.networks, payload.globalIgnores || []);
    return;
  }
  if (payload.kind === 'backlog') {
    // The `?since` resume cursor tracks the `messages` id space only. The system
    // buffer (networkId null) has its own id sequence, so its ids must NOT feed
    // the cursor — it's delivered fresh every connect instead (#355).
    if (payload.networkId != null && Array.isArray(payload.events)) {
      for (const e of payload.events) trackSeenId(e?.id);
    }
    applyBacklog(payload);
    return;
  }
  if (payload.kind === 'history') {
    // 'around' / 'latest' / 'after' / 'before' (default). The detached jump
    // path replaces the slice; reattach replaces too; 'after' appends paged
    // forward; legacy 'before' prepends paged backward. All use the same
    // 'history' kind — disambiguated by `mode`.
    const buffers = useBuffersStore();
    const mode = payload.mode || 'before';
    if (mode === 'around') {
      buffers.applyAroundSlice(payload.networkId, payload.target, payload);
    } else if (mode === 'latest') {
      buffers.applyLatestReplace(payload.networkId, payload.target, payload);
    } else if (mode === 'after') {
      buffers.appendHistory(
        payload.networkId,
        payload.target,
        payload.events,
        payload.hasMoreNewer,
        payload.speakers,
      );
    } else {
      // 'before' or absent — historical legacy path. Pages of older events
      // don't advance the resume cursor; the existing prependHistory writes
      // hasMoreOlder under the new field name and consumes either field for
      // back-compat with server response shapes.
      const hasMoreOlder = payload.hasMoreOlder != null ? payload.hasMoreOlder : payload.hasMore;
      buffers.prependHistory(
        payload.networkId,
        payload.target,
        payload.events,
        hasMoreOlder,
        payload.speakers,
      );
    }
    return;
  }
  if (payload.kind === 'irc') {
    // System-buffer lines (networkId null) ride the same 'irc' frame now but
    // carry system-table ids — keep them out of the `messages`-space resume
    // cursor (#355).
    if (payload.networkId != null) trackSeenId(payload.id);
    applyEvent(payload);
    return;
  }
  if (payload.kind === 'account-state') {
    // The account was paused/resumed out-of-band (operator or control plane).
    // Flip the whole UI into/out of read-only in place; the server has already
    // torn down or re-established the IRC connections.
    useAuthStore().setPaused(!!payload.paused);
    return;
  }
  if (payload.kind === 'settings') {
    const settings = useSettingsStore();
    settings.applyRemote(payload);
    return;
  }
  if (payload.kind === 'highlight-rules-changed') {
    // Re-fetch on any change (another tab/device, or an auto-nick rule created on
    // (re)connect / nick change). Re-fetch unconditionally so the client-eval set
    // stays current even if the settings pane was never opened.
    useHighlightRulesStore().applyServerChanged();
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
  if (payload.kind === 'buffer-cleared') {
    const buffers = useBuffersStore();
    buffers.applyClearedState(payload.networkId, payload.target, {
      clearedBeforeId: payload.clearedBeforeId,
      clearedAt: payload.clearedAt,
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
  if (payload.kind === 'e2eExport') {
    // Response to `/e2e export` — download the JSON as a file rather than render
    // it (it carries the private key). Reaches only the requesting tab.
    if (payload.ok) {
      const stamp = new Date().toISOString().slice(0, 10);
      downloadTextFile(`lurker-e2e-keyring-${stamp}.json`, payload.json as string);
      const c = (payload.counts as Record<string, number>) || {};
      useToastsStore().push({
        kind: 'info',
        title: 'E2E keyring exported',
        body: `Saved ${c.peers ?? 0} peer(s), ${c.incoming ?? 0} session(s). Keep this file private — it contains your private key.`,
      });
    } else {
      useToastsStore().push({
        kind: 'error',
        title: 'E2E export failed',
        body: String(payload.reason ?? 'unknown error'),
      });
    }
    return;
  }
  if (payload.kind === 'e2eImport') {
    if (payload.ok) {
      const c = (payload.counts as Record<string, number>) || {};
      const idNote = payload.identityChanged
        ? ' Your account identity changed — peers will need to reverify you.'
        : '';
      useToastsStore().push({
        kind: payload.identityChanged ? 'warn' : 'info',
        title: 'E2E keyring imported',
        body: `Replaced with ${c.peers ?? 0} peer(s), ${c.incoming ?? 0} session(s).${idNote}`,
      });
    } else {
      useToastsStore().push({
        kind: 'error',
        title: 'E2E import failed',
        body: String(payload.reason ?? 'unknown error'),
      });
    }
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
    channelNotify.applyChange(payload.networkId, payload.target, {
      notifyAlways: !!payload.notifyAlways,
      muted: !!payload.muted,
    });
    return;
  }
  if (payload.kind === 'ignore-list-updated') {
    const ignores = useIgnoresStore();
    ignores.applyUpdate(payload.networkId, payload.masks || []);
    return;
  }
  if (payload.kind === 'nick-note-updated') {
    const nickNotes = useNickNotesStore();
    nickNotes.applyUpdate(payload.networkId, payload.nick, payload.note || '', payload.updatedAt);
    return;
  }
  if (payload.kind === 'relay-bot-updated') {
    const relayBots = useRelayBotsStore();
    relayBots.applyUpdate(payload.networkId, payload.nick, !!payload.marked, payload.pattern || '');
    return;
  }
  if (payload.kind === 'contacts-snapshot') {
    useFriendsStore().applySnapshot(payload.contacts || []);
    return;
  }
  if (payload.kind === 'contact-updated') {
    useFriendsStore().applyContactUpdated(payload.contact);
    return;
  }
  if (payload.kind === 'contact-deleted') {
    useFriendsStore().applyContactDeleted(payload.contactId);
    return;
  }
  if (payload.kind === 'bookmark-ids-snapshot') {
    const bookmarks = useBookmarksStore();
    bookmarks.applySnapshot(payload.ids || []);
    return;
  }
  if (payload.kind === 'bookmark-updated') {
    const bookmarks = useBookmarksStore();
    bookmarks.applyUpdate({ messageId: payload.messageId, saved: !!payload.saved });
    return;
  }
  if (payload.kind === 'buffer-opened') {
    // Reply to our own `open-buffer` request: the server resolved the
    // canonical target — reopened a since-closed buffer, or joined a new
    // channel. Focus it now. For a reopen the `backlog` frame sent just
    // before this already recreated the buffer; for a join the channel-joined
    // flow will. activate() ensures the buffer exists either way.
    const buffers = useBuffersStore();
    buffers.activate(payload.networkId, payload.target);
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
  if (payload.kind === 'export') {
    // Background data-export progress / completion. The data settings pane
    // renders from this store; it stays current even when that pane is closed.
    useDataExportStore().apply(payload.job);
    return;
  }
}

function open() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  )
    return;
  socket = new WebSocket(wsUrl());
  socketListeners = new AbortController();
  const opts = { signal: socketListeners.signal };
  socket.addEventListener(
    'open',
    () => {
      connected.value = true;
      // Detached buffers won't survive a reconnect cleanly — the incoming
      // snapshot/backlog would otherwise be short-circuited by replaceBacklog's
      // detached guard, leaving the slice stale and the buffer cut off from
      // live. Drop the detach (and wipe each slice) before any server message
      // can arrive on the new socket so the snapshot reseeds them as live.
      // Synchronous: messages from the new socket arrive on later event-loop
      // turns, so the reseed sees the cleared state.
      try {
        const buffers = useBuffersStore();
        for (const buf of buffers.list) {
          if (buf.detached) {
            buffers.clearDetached(buf.networkId, buf.target, { wipeMessages: true });
          }
        }
      } catch (_) {
        /* store not yet initialized; nothing to clear */
      }
      for (const handler of openHandlers) {
        try {
          handler();
        } catch (_) {
          /* ignore */
        }
      }
    },
    opts,
  );
  socket.addEventListener('message', (ev) => handleMessage(ev.data), opts);
  socket.addEventListener(
    'close',
    () => {
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
    },
    opts,
  );
  socket.addEventListener(
    'error',
    () => {
      if (socket) socket.close();
    },
    opts,
  );
}

function send(payload: Record<string, unknown>): boolean {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function failAllPendingAcks(error: string): void {
  if (!pendingAcks.size) return;
  const entries = Array.from(pendingAcks.values());
  pendingAcks.clear();
  for (const resolver of entries) resolver({ ok: false, error });
}

// Generate a clientId for an ACK-tracked send. Uses crypto.randomUUID where
// available and falls back to a random-base36 string otherwise (older Safari
// in non-secure contexts won't expose randomUUID).
function makeClientId(): string {
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
export function socketSendWithAck(payload: Record<string, unknown>): Promise<AckResult> | null {
  if (!socket || socket.readyState !== WebSocket.OPEN) return null;
  const clientId = makeClientId();
  const wire = { ...payload, clientId };
  return new Promise<AckResult>((resolve) => {
    // Three racing paths can finish this send — server ACK, timeout, or a
    // synchronous send failure. settle() lets whichever fires first win and
    // makes the rest no-ops.
    let settled = false;
    const settle = (result: AckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingAcks.delete(clientId);
      // The `settled` flag above already makes this resolve run exactly once;
      // the linter just can't see the guard across settle()'s call sites.
      // eslint-disable-next-line promise/no-multiple-resolved
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, error: 'timeout' }), ACK_TIMEOUT_MS);
    pendingAcks.set(clientId, settle);
    try {
      socket!.send(JSON.stringify(wire));
    } catch (_) {
      settle({ ok: false, error: 'disconnected' });
    }
  });
}

// Tear down the socket without triggering the auto-reconnect path. Used on
// logout (and any other session reset). Strips handlers before closing so the
// `onclose` reconnect arm can't fire even if `auth.user` is briefly truthy.
export function resetSocket(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    // Detach every listener at once so the 'close' reconnect arm can't fire.
    socketListeners?.abort();
    socketListeners = null;
    try {
      socket.close();
    } catch (_) {
      /* ignore */
    }
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

export function useSocket(): SocketAPI {
  onMounted(() => {
    wireVisibility();
    open();
  });
  onBeforeUnmount(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
  return { connected, send, reconnect: open };
}

export function socketSend(payload: Record<string, unknown>): boolean {
  return send(payload);
}
