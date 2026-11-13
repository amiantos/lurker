// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { useAuthStore } from './auth.js';
import { isVirtualKey } from '../lib/virtualBuffers.js';
import { dccChatPeer, isDccChatTarget } from '../../../shared/channels.js';
import type { MultilineLimits } from '../utils/messageSplit.js';
import { DEFAULT_PREFIX, type ModeSpec, type PrefixMode } from '../../../shared/channelModes.js';

export interface Network {
  id: number;
  name: string;
  host: string;
  port: number;
  nick: string;
  tls: boolean;
  [key: string]: unknown;
}

/** What a network payload says about its CertFP pair (#459): digests to
 *  register with services, never the PEM. `{unusable: true}` means a
 *  certificate IS attached but doesn't parse — which blocks the connection, so
 *  it must not read as "no certificate". */
export interface ClientCertDigest {
  sha256: string;
  sha1: string;
  sha512: string;
  subject: string;
  validFrom: string;
  validTo: string;
}
export type ClientCertInfo = ClientCertDigest | { unusable: true };

// IRCv3 metadata on a nick (#607), as the server shapes it: `avatarUrl` is
// server-minted and opaque (the media proxy or a CDN), null when the server
// can't serve it — the generated tile stands in then. Never the origin URL.
export interface UserMetadataEntry {
  displayName?: string;
  avatarUrl?: string | null;
  pronouns?: string;
  homepage?: string;
  status?: string;
}

export interface MetadataLimits {
  maxSubs: number | null;
  maxKeys: number | null;
  maxValueBytes: number | null;
  beforeConnect: boolean;
}

export interface PeerPresenceEntry {
  nick: string;
  state: string | null;
  stateAt: string | null;
  awayMessage: string | null;
}

// Self-presence on one network (#994), from the away-state stream.
// Mirrors the in-memory shape ircManager/IrcConnection hold (`AwayState`
// there); `message` and `since` stay populated after /back so the buffer
// dividers can render the completed away→back pair.
export interface AwayState {
  active: boolean;
  message: string | null;
  since: string | null;
  autoSet: boolean;
  backAt: string | null;
}

// A message of the user's held in a network's send queue (#1326).
export interface PendingSend {
  id: string;
  target: string;
  kind: 'privmsg' | 'action' | 'notice';
  text: string;
  /** When it was sent (ISO 8601). */
  at?: string;
}

export interface NetworkState {
  networkId: number;
  channels: string[];
  state?: string;
  nick?: string;
  userModes?: string;
  away?: AwayState | null;
  peerPresence?: Record<string, PeerPresenceEntry>;
  // IRCv3 metadata per nick, keyed by lowercase nick like peerPresence (#607).
  // Seeded by the snapshot, replaced record-by-record by `user-metadata`
  // frames (values: null forgets the nick).
  userMetadata?: Record<string, UserMetadataEntry>;
  // What the network's draft/metadata-2 cap advertised; null/absent when the
  // network doesn't speak it. Seeded by the snapshot.
  metadataLimits?: MetadataLimits | null;
  // Display nicks of peers with a live DCC chat session on this network. Seeded
  // by every snapshot — including a disconnected network's, since a chat socket
  // outlives the IRC link — and kept current by `dcc-chat-state` events.
  dccChats?: string[];
  // Peers whose current or LAST session was over TLS (an SCHAT, #1157): the
  // status bar's lock while live, and the "/dcc chat -secure" suggestion once
  // it has ended, so re-offering does not quietly drop to plain. The snapshot
  // lists only the live ones; an ended one is remembered here across
  // snapshots until a plain session with that peer replaces it.
  dccSecureChats?: string[];
  // Peers whose DCC chat offer to us is still awaiting an answer. Used to
  // retire an offer toast whose offer disappeared while this tab was offline.
  dccChatOffers?: string[];
  lagMs?: number | null;
  // The user's messages the network's outbound queue is holding (#1326): a
  // paste the server would otherwise kill us for, going out paced. Each shows
  // dimmed at the foot of its buffer until it goes. Seeded by the snapshot,
  // kept current by `send-pending` and `send-pending-done` frames.
  sendPending?: PendingSend[];
  // Advertised draft/multiline limits when the network negotiated the cap,
  // else null/absent. Drives the composer's multiline-aware SPLIT/FLOOD hint
  // and upload-as-.txt gate. Refreshed by the snapshot pushed on connect. (#381)
  multilineLimits?: MultilineLimits | null;
  // The network's channel-mode vocabulary, parsed from its ISUPPORT on the
  // server (#727). Seeded by the snapshot, replaced by `mode-spec` frames.
  modeSpec?: ModeSpec | null;
  // Whether this network can carry an IRCv3 reaction we send (message-tags,
  // echo-message, not denied by CLIENTTAGDENY). False until the registration
  // burst ends; seeded by the snapshot, replaced by `react-support` frames.
  canReact?: boolean;
  // The split answers (#1101): adding a reaction, taking one of ours back
  // (+draft/unreact allowed), and whether a reply carries its tag. canReact
  // above keeps its old meaning, both reaction directions. Same timing; absent
  // from a server that predates them — read all of it through tagSupport().
  canAddReaction?: boolean;
  canRemoveReaction?: boolean;
  canReply?: boolean;
  // Deleting a line (#1013): the network negotiated draft/message-redaction.
  // Same timing and fallback as the three above.
  canRedact?: boolean;
  // Bytes of our user@host as the network relays it (or the longest it could
  // be), the input to the composer's split estimate (#1043). Seeded by the
  // snapshot, replaced by `line-budget` frames; absent from a server that
  // predates it.
  userhostBytes?: number;
}

export interface ActiveBuffer {
  networkId: number;
  target: string;
  network: Network | undefined;
}

/**
 * Whether Disconnect is the action this network needs, rather than Connect.
 *
 * ⚠⚠ The question is "is Lurker holding a connection for this network", NOT "is it on the wire".
 * Since the auto-reconnect overhaul a dropped network keeps its IrcConnection for the whole
 * outage while the retry controller backs off, so `reconnecting` is a network Lurker is very
 * much still working on — and the retry ladder is deliberately unbounded. Testing for
 * `connected` instead made Reconnect the only offered action during a backoff, and Reconnect
 * routes through restartNetwork: it tears the connection down and starts a fresh loop. A
 * network stuck against a dead server therefore had NO reachable stop, which is #785. Turning
 * off `autoconnect` doesn't stop it either — that flag is about boot, not about retries.
 *
 * ⚠⚠ `connecting` is deliberately NOT included, though it is equally "Lurker is working on it".
 * `setState('connecting')` fires the moment irc-framework opens the socket — tens of milliseconds
 * after the POST, well inside a double-click. So a user who clicks Reconnect on a down network and
 * impatiently clicks again would hit a button that had already relabelled itself Disconnect, and
 * tear down the connection they just asked for. Before this predicate existed the second click
 * re-fired restartNetwork harmlessly, and it still does. A hung TLS handshake is real but
 * transient and self-resolving; the unbounded retry ladder is the stuck state #785 is about.
 *
 * An absent state means we've never heard about this network, which reads as Connect.
 */
export function canDisconnect(state: string | null | undefined): boolean {
  return state === 'connected' || state === 'reconnecting';
}

/**
 * What the network can carry right now: a reaction, taking one of ours back, a reply's tag. All
 * false unless it's connected. A network can allow +draft/react and still deny +draft/unreact
 * (irc.so's UnrealIRCd, #1101), so each is its own answer. A server that predates the split only
 * sent canReact, which covered all three — read them through it.
 */
export function tagSupport(state: NetworkState | null | undefined): {
  react: boolean;
  unreact: boolean;
  reply: boolean;
  redact: boolean;
} {
  if (state?.state !== 'connected') {
    return { react: false, unreact: false, reply: false, redact: false };
  }
  const legacy = !!state.canReact;
  return {
    react: state.canAddReaction ?? legacy,
    unreact: state.canRemoveReaction ?? legacy,
    reply: state.canReply ?? legacy,
    // No legacy answer stands in for this one: a server that never said is a
    // server that can't.
    redact: !!state.canRedact,
  };
}

export const useNetworksStore = defineStore('networks', {
  state: () => ({
    networks: [] as Network[],
    states: {} as Record<number | string, NetworkState>,
    activeKey: null as string | null,
    // False until the first fetchAll() resolves. Without this, an empty
    // `networks` array is ambiguous — it means both "this user has no networks"
    // and "we haven't asked yet" — and anything keying off "has no networks"
    // (the first-run flow, #300) would fire for every user on every boot,
    // during the window before /api/networks answers.
    loaded: false,
  }),
  getters: {
    networkById: (state) => (id: number) => state.networks.find((n) => n.id === id) || null,
    // The network's PREFIX, highest rank first: `modeSpec.prefix`, or the
    // conventional q/a/o/h/v table until its ISUPPORT has arrived.
    prefixFor:
      (state) =>
      (networkId: number | null | undefined): readonly PrefixMode[] =>
        (networkId != null ? state.states[networkId]?.modeSpec?.prefix : null) ?? DEFAULT_PREFIX,
    // Whether `nick` is the user's current nick on THAT network — for a line
    // shown away from its buffer (a search hit, a quote), where NickRef's guess
    // from the open buffer's network would be the wrong network. Folded the way
    // NickRef folds.
    isOwnNick:
      (state) =>
      (networkId: number | null | undefined, nick: string | null | undefined): boolean => {
        const own = networkId != null ? state.states[networkId]?.nick : null;
        return !!own && !!nick && own.toLowerCase() === nick.toLowerCase();
      },
    // Presence row for a (network, nick), disconnected-aware: a down network's
    // cached rows are stale, so report a synthetic 'offline'. Connected with no
    // row stays null (unknown = "potentially online", the no-MONITOR case).
    // Single source of truth for the sidebar, status bar, and profile.
    //
    // ⚠⚠ A `=nick` DCC chat has NO peer presence and must never be given the
    // synthetic offline. Its reachability has nothing to do with the IRC link —
    // the socket is peer-to-peer and keeps working while the network is down —
    // so "=bob is offline" the moment you disconnect is both wrong and exactly
    // backwards. Nothing MONITORs a DCC peer either, so there is no real row to
    // fall through to. Handled here rather than in each of the sidebar, status
    // bar and profile, because this getter is where they all agree.
    peerFor:
      (state) =>
      (networkId: number | string, nick: string): PeerPresenceEntry | null => {
        if (isDccChatTarget(nick)) return null;
        const netState = state.states[networkId];
        if (netState && netState.state !== 'connected')
          return { nick, state: 'offline', stateAt: null, awayMessage: null };
        return netState?.peerPresence?.[nick.toLowerCase()] ?? null;
      },
    // A nick's IRCv3 metadata on a network (#607), or null when none is known.
    metadataFor:
      (state) =>
      (networkId: number | string | null | undefined, nick: string): UserMetadataEntry | null => {
        if (networkId == null || !nick) return null;
        return state.states[networkId]?.userMetadata?.[nick.toLowerCase()] ?? null;
      },
    // Whether a `=nick` buffer (or a bare peer nick) has a live DCC session.
    // The DCC counterpart to peerFor, and deliberately independent of the IRC
    // link's state: the chat keeps working while the network is down.
    isDccChatLive:
      (state) =>
      (networkId: number | string, target: string): boolean => {
        const peer = dccChatPeer(target).toLowerCase();
        return (state.states[networkId]?.dccChats ?? []).some((n) => n.toLowerCase() === peer);
      },
    // Whether the current or last session with that peer was over TLS (#1157).
    wasDccChatSecure:
      (state) =>
      (networkId: number | string, target: string): boolean => {
        const peer = dccChatPeer(target).toLowerCase();
        return (state.states[networkId]?.dccSecureChats ?? []).some(
          (n) => n.toLowerCase() === peer,
        );
      },
    // Whether that live session is over TLS (#1157).
    isDccChatSecure(): (networkId: number | string, target: string) => boolean {
      return (networkId, target) =>
        this.isDccChatLive(networkId, target) && this.wasDccChatSecure(networkId, target);
    },
    activeBuffer(state): ActiveBuffer | null {
      if (!state.activeKey) return null;
      // Virtual buffers (:system:) use a flat sentinel key (no `::`).
      // They have no IRC send target, so report "no IRC buffer active" — the
      // views drive their own header/rendering; the system buffer still renders
      // messages via buffers.byKey(activeKey) directly, not through this getter.
      if (isVirtualKey(state.activeKey)) return null;
      if (!state.activeKey.includes('::')) return null;
      const [networkId, name] = state.activeKey.split('::');
      const id = Number(networkId);
      return { networkId: id, target: name, network: state.networks.find((n) => n.id === id) };
    },
  },
  actions: {
    async fetchAll() {
      const { networks } = await api('/api/networks');
      this.networks = networks;
      this.loaded = true;
    },
    async create(payload: Partial<Network>) {
      const { network } = await api('/api/networks', { method: 'POST', body: payload });
      this.networks.push(network);
      return network as Network;
    },
    async update(id: number, patch: Partial<Network>) {
      const { network } = await api(`/api/networks/${id}`, { method: 'PATCH', body: patch });
      const idx = this.networks.findIndex((n) => n.id === id);
      if (idx >= 0) this.networks[idx] = network;
      return network as Network;
    },
    // Rewrite sidebar order. Server validates the id set; on 409 it echoes the
    // authoritative list, which we apply so the UI snaps back to truth instead
    // of staying out of sync after a concurrent add/delete from another tab.
    async reorder(ids: number[]) {
      try {
        const { networks } = await api('/api/networks/reorder', {
          method: 'POST',
          body: { ids },
        });
        this.networks = networks;
      } catch (err: any) {
        if (err?.status === 409 && Array.isArray(err.data?.networks)) {
          this.networks = err.data.networks;
        }
        throw err;
      }
    },
    // CertFP (#459). The pair itself never reaches the client: `mode` says
    // whether the server mints one or takes the PEM the user already has, and
    // what comes back is a description — the digests to register at NickServ.
    async attachCertificate(
      id: number,
      payload: { mode: 'generate' } | { mode: 'import'; cert: string; key: string },
    ) {
      const { network, certificate } = await api(`/api/networks/${id}/certificate`, {
        method: 'POST',
        body: payload,
      });
      const idx = this.networks.findIndex((n) => n.id === id);
      if (idx >= 0) this.networks[idx] = network;
      // Always the readable variant: the route validated the pair on the way in.
      return certificate as ClientCertDigest;
    },
    async removeCertificate(id: number) {
      const { network } = await api(`/api/networks/${id}/certificate`, { method: 'DELETE' });
      const idx = this.networks.findIndex((n) => n.id === id);
      if (idx >= 0) this.networks[idx] = network;
    },
    async remove(id: number) {
      await api(`/api/networks/${id}`, { method: 'DELETE' });
      this.networks = this.networks.filter((n) => n.id !== id);
      delete this.states[id];
      if (this.activeKey?.startsWith(`${id}::`)) this.activeKey = null;
    },
    // The IRC connection toggles are the writes most reachable from the
    // read-only browse view (header toggle, network context menu), so they get
    // a client-side short-circuit to avoid firing a request the server would
    // 403 anyway. Config mutations (create/update/remove) are reached only from
    // editing UI a paused user shouldn't be in, and stay server-enforced.
    async connect(id: number) {
      if (useAuthStore().isPaused) return;
      await api(`/api/networks/${id}/connect`, { method: 'POST' });
    },
    async disconnect(id: number, reason?: string) {
      if (useAuthStore().isPaused) return;
      await api(`/api/networks/${id}/disconnect`, {
        method: 'POST',
        ...(reason ? { body: { reason } } : {}),
      });
    },
    async reconnect(id: number) {
      if (useAuthStore().isPaused) return;
      await api(`/api/networks/${id}/reconnect`, { method: 'POST' });
    },
    // Lifecycle hooks (lib/bufferLifecycle.ts): the active pointer follows a
    // rename and clears on a close.
    dropBuffer(networkId: number | string | null, target: string) {
      const k = networkId == null ? target : `${networkId}::${target}`;
      if (this.activeKey === k) this.activeKey = null;
    },
    rekeyBuffer(networkId: number | string | null, from: string, to: string) {
      const fromKey = networkId == null ? from : `${networkId}::${from}`;
      if (this.activeKey === fromKey) {
        this.activeKey = networkId == null ? to : `${networkId}::${to}`;
      }
    },
    setActive(networkId: number | string | null, target: string) {
      // The app-scoped system buffer (#355) has no network — it keys on the bare
      // sentinel target, matching the buffers store's key() helper.
      this.activeKey = networkId == null ? target : `${networkId}::${target}`;
    },
    // Leave no buffer active WITHOUT closing anything — the buffer stays in the
    // store and the list. Exists for backing out of an optimistically created
    // buffer (#744): it has no server row id, so no URL can name it, and "back
    // to the list" can only be expressed by clearing the active pointer.
    clearActive() {
      this.activeKey = null;
    },
    // Virtual buffers (the system console) aren't tied to an IRC network.
    // They use a flat sentinel key (no `::`) so the existing
    // `${networkId}::${target}` parsers ignore them.
    activateVirtual(key: string) {
      this.activeKey = key;
    },
    applySnapshot(networks: NetworkState[]) {
      const map: Record<number | string, NetworkState> = {};
      for (const snap of networks) {
        // The snapshot's secure list is the LIVE secure sessions. Keep what we
        // remember of ended ones (#1157), unless the snapshot shows a plain
        // session with that peer now.
        const has = (list: string[] | undefined, nick: string) =>
          (list ?? []).some((n) => n.toLowerCase() === nick.toLowerCase());
        const remembered = (this.states[snap.networkId]?.dccSecureChats ?? []).filter(
          (n) => !has(snap.dccSecureChats, n) && !has(snap.dccChats, n),
        );
        map[snap.networkId] = remembered.length
          ? { ...snap, dccSecureChats: [...(snap.dccSecureChats ?? []), ...remembered] }
          : snap;
      }
      this.states = map;
    },
    applyState(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        state: event.state,
        nick: event.nick || existing.nick,
      };
    },
    applyOwnNick(event: any) {
      const existing = this.states[event.networkId];
      if (!existing || !event.nick) return;
      this.states[event.networkId] = { ...existing, nick: event.nick };
    },
    applyUserMode(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        userModes: typeof event.modes === 'string' ? event.modes : '',
      };
    },
    applyModeSpec(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = { ...existing, modeSpec: event.modeSpec ?? null };
    },
    applyReactSupport(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        canReact: !!event.canReact,
        canAddReaction: event.canAddReaction,
        canRemoveReaction: event.canRemoveReaction,
        canReply: event.canReply,
        canRedact: event.canRedact,
      };
    },
    applyLineBudget(event: any) {
      if (typeof event.userhostBytes !== 'number') return;
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = { ...existing, userhostBytes: event.userhostBytes };
    },
    applyAwayState(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        away: event.away || null,
      };
    },
    // Per-(network, nick) peer presence. Single most-recent-event shape:
    // { state, stateAt } where state ∈ {online, offline, away, back}.
    // Stored under the network state bucket so the snapshot apply seeds it
    // instantly; readers (MessageList marker, BufferList decoration,
    // StatusBar segment) look up by lowercase nick.
    applyPeerPresence(networkId: number | string, nick: string, payload: any) {
      if (!networkId || !nick) return;
      const existing = this.states[networkId] || { networkId: Number(networkId), channels: [] };
      const peerPresence = { ...existing.peerPresence };
      peerPresence[nick.toLowerCase()] = {
        nick,
        state: payload?.state || null,
        stateAt: payload?.stateAt || null,
        awayMessage: payload?.awayMessage || null,
      };
      this.states[networkId] = { ...existing, peerPresence };
    },
    // One nick's whole metadata record (#607), or null to forget it — a rename
    // sends the old nick's null and the new nick's record.
    // In place, one key: a SYNC on a big channel is one frame per nick, and
    // copying the map (or replacing the network state) for each would make
    // every reader of the network state recompute per line.
    applyUserMetadata(networkId: number | string, nick: string, values: UserMetadataEntry | null) {
      if (!networkId || !nick) return;
      if (!this.states[networkId]) {
        this.states[networkId] = { networkId: Number(networkId), channels: [] };
      }
      const state = this.states[networkId];
      if (!state.userMetadata) state.userMetadata = {};
      if (values) state.userMetadata[nick.toLowerCase()] = values;
      else delete state.userMetadata[nick.toLowerCase()];
    },
    applyDccChatState(networkId: number | string, nick: string, live: boolean, secure = false) {
      if (!networkId || !nick) return;
      const existing = this.states[networkId] || { networkId: Number(networkId), channels: [] };
      const lower = nick.toLowerCase();
      const others = (existing.dccChats ?? []).filter((n) => n.toLowerCase() !== lower);
      const otherSecure = (existing.dccSecureChats ?? []).filter((n) => n.toLowerCase() !== lower);
      // An ended session keeps its kind on record; a new one sets it.
      const secureChats = !live
        ? (existing.dccSecureChats ?? [])
        : secure
          ? [...otherSecure, nick]
          : otherSecure;
      this.states[networkId] = {
        ...existing,
        dccChats: live ? [...others, nick] : others,
        dccSecureChats: secureChats,
      };
    },
    applyLag(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      const v = event.lagMs;
      this.states[event.networkId] = {
        ...existing,
        lagMs: typeof v === 'number' ? v : null,
      };
    },
    applySendPending(event: any) {
      const pending = event.pending;
      if (typeof pending?.id !== 'string' || typeof pending.target !== 'string') return;
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      const held = existing.sendPending ?? [];
      if (held.some((p) => p.id === pending.id)) return;
      this.states[event.networkId] = {
        ...existing,
        sendPending: [
          ...held,
          {
            id: pending.id,
            target: pending.target,
            kind: pending.kind,
            text: String(pending.text ?? ''),
            at: pending.at,
          },
        ],
      };
    },
    // It went, or was dropped: either way the server sends this once the row
    // that says so (ours, the echo's, or a "not sent" line) is out.
    applySendPendingDone(event: any) {
      const existing = this.states[event.networkId];
      if (!existing?.sendPending?.some((p) => p.id === event.pendingId)) return;
      this.states[event.networkId] = {
        ...existing,
        sendPending: existing.sendPending.filter((p) => p.id !== event.pendingId),
      };
    },
  },
});
