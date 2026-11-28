// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import {
  compileIgnoreRules,
  evaluateIgnores,
  isMemberHidden,
  channelMutesUnread,
  type IgnoreRule,
  type IgnoreInput,
  type IgnoreVerdict,
} from '../utils/ignoreMatch.js';
import { isChannelTarget } from '../../../shared/channels.js';

// The two "mute" modifier levels (issue #359). A per-buffer or per-network mute
// rung is a canonical rule carrying only these (no hide levels, no mask/pattern/
// except), so the notification menus can find, read, and toggle it.
const MUTE_LEVELS = new Set(['NOUNREAD', 'NONOTIFY']);
function isMuteOnlyLevels(levels: string[]): boolean {
  return levels.length > 0 && levels.every((l) => MUTE_LEVELS.has(l));
}
// "Suppress Highlights" (#1414) is a canonical rule of its own beside the mute
// rule: the same shape, carrying NOHIGHLIGHT and nothing else. Kept apart so
// ticking the box never rewrites a mute rule (its levels, its expiry), and so
// a client that knows only the mute rule still reads the level correctly.
function isSuppressOnlyLevels(levels: string[]): boolean {
  return levels.length === 1 && levels[0] === 'NOHIGHLIGHT';
}

// Find the canonical mute rule (unmasked, unpatterned, non-except, mute-only
// levels) matching a scope predicate, searching the network bucket then globals.
// Returns it annotated with its scope (networkId null = global) so the caller
// removes it from the right bucket. Shared by bufferMuteRule/networkMuteRule.
function findMuteRule(
  netList: IgnoreEntry[],
  globalList: IgnoreEntry[],
  networkId: number,
  scopeMatches: (e: IgnoreEntry) => boolean,
  levelsMatch: (levels: string[]) => boolean = isMuteOnlyLevels,
): IgnoreEntryWithNetwork | null {
  // A lapsed timed rule is gone as far as the menus show (silencingAt), so it
  // is not one to reconcile against either: the server sweeps it within a
  // minute, and until then a tap would find it and do nothing.
  const now = Date.now();
  const ok = (e: IgnoreEntry) =>
    !e.mask &&
    !e.pattern &&
    !e.isExcept &&
    !lapsed(e, now) &&
    scopeMatches(e) &&
    levelsMatch(e.levels);
  const net = netList.find(ok);
  if (net) return { ...net, networkId };
  const g = globalList.find(ok);
  return g ? { ...g, networkId: null } : null;
}

// What the notification menus show for a scope, read from EVERY silencing rule
// there, not only the ones the menus write. A rule counts when it has no mask,
// pattern or exception, hides nothing, and has not lapsed: those are the rules
// that silence the whole channel, DM or network.
//
// `levels` is all of theirs together. The two `custom` flags say which part of
// the menu must not edit, because the rules behind it are not exactly the
// shapes the menu writes and a change from the menu would rewrite or strand
// something the user typed:
//   muteCustom      the level rows. The menu writes one untimed rule, NONOTIFY
//                   or NOUNREAD+NONOTIFY.
//   suppressCustom  the Suppress Highlights box. The menu writes one untimed
//                   rule, NOHIGHLIGHT alone.
// A rule mixing the two (`NOUNREAD NONOTIFY NOHIGHLIGHT`) sets both; a timed
// rule, a second rule of a kind, or a NOUNREAD with no NONOTIFY sets its own.
export interface ScopeSilencing {
  levels: string[];
  muteCustom: boolean;
  suppressCustom: boolean;
}
const SILENCING_LEVELS = new Set(['NOUNREAD', 'NONOTIFY', 'NOHIGHLIGHT']);
function lapsed(e: IgnoreEntry, now: number): boolean {
  return !!e.expiresAt && Date.parse(e.expiresAt) <= now;
}
function silencingAt(
  netList: IgnoreEntry[],
  globalList: IgnoreEntry[],
  scopeMatches: (e: IgnoreEntry) => boolean,
  now: number = Date.now(),
): ScopeSilencing {
  const levels = new Set<string>();
  let mutes = 0;
  let suppresses = 0;
  let muteCustom = false;
  let suppressCustom = false;
  for (const e of [...netList, ...globalList]) {
    if (e.mask || e.pattern || e.isExcept || !scopeMatches(e)) continue;
    if (!e.levels.length || !e.levels.every((l) => SILENCING_LEVELS.has(l))) continue;
    if (lapsed(e, now)) continue;
    for (const l of e.levels) levels.add(l);
    const timed = !!e.expiresAt;
    if (isSuppressOnlyLevels(e.levels)) {
      suppresses += 1;
      if (timed) suppressCustom = true;
    } else if (isMuteOnlyLevels(e.levels)) {
      mutes += 1;
      if (timed || !e.levels.includes('NONOTIFY')) muteCustom = true;
    } else {
      muteCustom = true;
      suppressCustom = true;
    }
  }
  if (mutes > 1) muteCustom = true;
  if (suppresses > 1) suppressCustom = true;
  return { levels: [...levels], muteCustom, suppressCustom };
}

// Ignore rules (issue #301; global-vs-network scoping #350). Server is the
// source of truth — adds/removes ship over WS and the server fans an
// `ignore-list-updated` event to every session (cross-device sync). Filtering
// happens client-side in MessageList's renderRows computed, so /unignore reveals
// previously-hidden rows without a backlog reload. Each entry is a full
// irssi-style rule (mask / channels / pattern / levels / except / expiry).
//
// Two buckets: `global` rules apply on every network (the default), `byNetwork`
// rules are scoped to one. The effective set for a network is global ∪ that
// network's rules — every matcher getter unions them, and the merge is compiled
// once and cached so the render hot path stays cheap.

export interface IgnoreEntry extends IgnoreRule {
  id: number;
  createdAt: string;
}

export interface IgnoreEntryWithNetwork extends IgnoreEntry {
  // null = a global rule (applies on every network); a number scopes it to one.
  networkId: number | null;
}

type Compiled = ReturnType<typeof compileIgnoreRules>;

// Compile lazily, keyed by the entry-array identity. applySnapshot/applyUpdate
// assign fresh arrays, so a replaced list misses the cache and recompiles; old
// arrays are GC'd.
const compiledCache = new WeakMap<object, Compiled>();
function compiledFor(list: IgnoreEntry[]): Compiled {
  let c = compiledCache.get(list);
  if (!c) {
    c = compileIgnoreRules(list);
    compiledCache.set(list, c);
  }
  return c;
}

// Stable empty array so a network with no own rules keeps a constant identity
// (otherwise the merge cache below would miss on every call).
const EMPTY: IgnoreEntry[] = [];

// The merged (global ∪ network) compiled set, memoized per network. Invalidates
// only when either source array's identity changes — which is exactly when the
// server pushes a new list — so steady-state reads are a Map lookup + two ===.
const mergedCache = new Map<number, { g: IgnoreEntry[]; n: IgnoreEntry[]; c: Compiled }>();
function mergedCompiled(globalList: IgnoreEntry[], netList: IgnoreEntry[], key: number): Compiled {
  const hit = mergedCache.get(key);
  if (hit && hit.g === globalList && hit.n === netList) return hit.c;
  let c: Compiled;
  if (globalList.length === 0) c = compiledFor(netList);
  else if (netList.length === 0) c = compiledFor(globalList);
  else c = [...compiledFor(globalList), ...compiledFor(netList)];
  mergedCache.set(key, { g: globalList, n: netList, c });
  return c;
}

export const useIgnoresStore = defineStore('ignores', {
  state: () => ({
    byNetwork: {} as Record<number | string, IgnoreEntry[]>,
    global: [] as IgnoreEntry[],
  }),
  getters: {
    // A network's own (network-scoped) rules, excluding globals — used by the
    // settings pane's per-network grouping and the /ignore command listing.
    masksFor: (state) => (networkId: number | string) =>
      state.byNetwork[networkId] || state.byNetwork[Number(networkId)] || EMPTY,

    // The hot path called from MessageList. networkId may be a number or string
    // depending on call site (Vue templates often stringify keys). Unions the
    // global rules with this network's.
    evaluate:
      (state) =>
      (networkId: number | string, ctx: IgnoreInput): IgnoreVerdict => {
        const nid = Number(networkId);
        const net = state.byNetwork[nid] || EMPTY;
        const g = state.global;
        if (g.length === 0 && net.length === 0)
          return { hide: false, nohilight: false, nonotify: false };
        return evaluateIgnores(mergedCompiled(g, net, nid), ctx);
      },

    // Buffer-list mute check (issue #359): does a whole-buffer NOUNREAD rule
    // cover this target? Includes network-wide rules (channels null) and globals,
    // so muting a network downgrades every child buffer's unread here. Serves
    // channels (#chan) and DMs (peer nick) alike.
    bufferMutesUnread:
      (state) =>
      (networkId: number | string, target: string): boolean => {
        const nid = Number(networkId);
        const net = state.byNetwork[nid] || EMPTY;
        const g = state.global;
        if (g.length === 0 && net.length === 0) return false;
        return channelMutesUnread(mergedCompiled(g, net, nid), target);
      },

    // The canonical per-buffer notification rule for the given target — an
    // unmasked, unpatterned, non-except rule carrying only mute levels, whose
    // channel scope is exactly [target]. Searches the network bucket then globals
    // (so a hand-typed global `/ignore #chan NOUNREAD NONOTIFY` — global is the
    // default scope — is still recognized, matching bufferMutesUnread). The
    // returned `networkId` (null = global) tells the menu which bucket to remove
    // from. Serves channels (#chan) and DMs (peer nick) alike.
    bufferMuteRule:
      (state) =>
      (networkId: number | string, target: string): IgnoreEntryWithNetwork | null => {
        const nid = Number(networkId);
        const t = target.toLowerCase();
        return findMuteRule(
          state.byNetwork[nid] || EMPTY,
          state.global,
          nid,
          (e) => e.channels?.length === 1 && e.channels[0].toLowerCase() === t,
        );
      },

    // The canonical network-wide notification rule — like bufferMuteRule but
    // scoped to the whole network (no channel scope). Used by the network menu.
    // A global no-channel mute rule is "mute everything, every network"; toggling
    // it from a single network's menu removes it globally, which is the honest
    // consequence of having created a global rule.
    networkMuteRule:
      (state) =>
      (networkId: number | string): IgnoreEntryWithNetwork | null => {
        const nid = Number(networkId);
        return findMuteRule(
          state.byNetwork[nid] || EMPTY,
          state.global,
          nid,
          (e) => !e.channels || e.channels.length === 0,
        );
      },

    // The Suppress Highlights rule for a channel, and for a whole network:
    // found like the mute rules above, global bucket included.
    bufferSuppressRule:
      (state) =>
      (networkId: number | string, target: string): IgnoreEntryWithNetwork | null => {
        const nid = Number(networkId);
        const t = target.toLowerCase();
        return findMuteRule(
          state.byNetwork[nid] || EMPTY,
          state.global,
          nid,
          (e) => e.channels?.length === 1 && e.channels[0].toLowerCase() === t,
          isSuppressOnlyLevels,
        );
      },
    networkSuppressRule:
      (state) =>
      (networkId: number | string): IgnoreEntryWithNetwork | null => {
        const nid = Number(networkId);
        return findMuteRule(
          state.byNetwork[nid] || EMPTY,
          state.global,
          nid,
          (e) => !e.channels || e.channels.length === 0,
          isSuppressOnlyLevels,
        );
      },

    // What is in force for a channel or DM, and for a whole network, and
    // whether the menus may edit it. See silencingAt.
    bufferSilencing:
      (state) =>
      (networkId: number | string, target: string): ScopeSilencing => {
        const t = target.toLowerCase();
        return silencingAt(
          state.byNetwork[Number(networkId)] || EMPTY,
          state.global,
          (e) => e.channels?.length === 1 && e.channels[0].toLowerCase() === t,
        );
      },
    networkSilencing:
      (state) =>
      (networkId: number | string): ScopeSilencing =>
        silencingAt(
          state.byNetwork[Number(networkId)] || EMPTY,
          state.global,
          (e) => !e.channels || e.channels.length === 0,
        ),

    isHidden:
      (state) =>
      (networkId: number | string, ctx: IgnoreInput): boolean => {
        const nid = Number(networkId);
        const net = state.byNetwork[nid] || EMPTY;
        const g = state.global;
        if (g.length === 0 && net.length === 0) return false;
        return evaluateIgnores(mergedCompiled(g, net, nid), ctx).hide;
      },

    // Full-context "is this message hidden?" for surfaces that hold the message
    // object (search/highlights/bookmarks results). Unlike isIgnored it honors
    // level/channel/pattern rules, so a /ignore x PUBLIC or -pattern rule keeps
    // those messages out of search. Result rows carry the body as `body` and
    // omit `type` (they're always chat), so default type to 'message' — which
    // still resolves PUBLIC/MSGS/channel/pattern correctly.
    isMessageHidden:
      (state) =>
      (
        networkId: number | string,
        m: {
          nick?: string | null;
          userhost?: string | null;
          target: string;
          type?: string;
          text?: string | null;
          body?: string | null;
        },
      ): boolean => {
        if (!m.nick) return false;
        const nid = Number(networkId);
        const net = state.byNetwork[nid] || EMPTY;
        const g = state.global;
        if (g.length === 0 && net.length === 0) return false;
        return evaluateIgnores(mergedCompiled(g, net, nid), {
          nick: m.nick,
          userhost: m.userhost ?? null,
          target: m.target,
          text: m.text ?? m.body ?? '',
          type: m.type ?? 'message',
          isDm: !isChannelTarget(m.target) && !m.target.startsWith(':server:'),
        }).hide;
      },

    // "Is this sender broadly ignored?" — a non-except, no-pattern, ALL-level
    // rule that hides them regardless of content (no channel scope, so applies
    // everywhere). For nick-only callers that have no message context
    // (autocomplete, the typing indicator). A NOHIGHLIGHT, content-pattern,
    // single-level, or channel-scoped rule deliberately does NOT count here —
    // those need full event context (use isMessageHidden / isHidden).
    isIgnored:
      (state) =>
      (networkId: number | string, nick: string, userhost: string): boolean => {
        const nid = Number(networkId);
        const net = state.byNetwork[nid] || EMPTY;
        const g = state.global;
        if (g.length === 0 && net.length === 0) return false;
        return isMemberHidden(mergedCompiled(g, net, nid), nick, userhost || null, '');
      },

    // Nicklist filter — only whole-identity ALL rules remove a member (see
    // isMemberHidden). channel is the open buffer's target.
    isMemberHidden:
      (state) =>
      (
        networkId: number | string,
        nick: string,
        userhost: string | null,
        channel: string,
      ): boolean => {
        const nid = Number(networkId);
        const net = state.byNetwork[nid] || EMPTY;
        const g = state.global;
        if (g.length === 0 && net.length === 0) return false;
        return isMemberHidden(mergedCompiled(g, net, nid), nick, userhost, channel);
      },

    // Every rule for the settings pane. Globals come first with networkId null
    // (the pane renders them under a "Global" group); per-network rules follow.
    allEntries: (state): IgnoreEntryWithNetwork[] => {
      const out: IgnoreEntryWithNetwork[] = [];
      for (const entry of state.global) out.push({ ...entry, networkId: null });
      for (const [networkId, list] of Object.entries(state.byNetwork)) {
        for (const entry of list || []) out.push({ ...entry, networkId: Number(networkId) });
      }
      return out;
    },
  },
  actions: {
    applySnapshot(networks: any[], globalIgnores: IgnoreEntry[] = []) {
      const next: Record<number | string, IgnoreEntry[]> = {};
      for (const n of networks || []) {
        if (n?.networkId != null) next[n.networkId] = [...(n.ignoredMasks || [])];
      }
      this.byNetwork = next;
      this.global = [...(globalIgnores || [])];
    },
    // networkId null targets the global bucket; a number targets that network.
    applyUpdate(networkId: number | string | null, masks: IgnoreEntry[]) {
      if (networkId == null) {
        this.global = [...(masks || [])];
      } else {
        this.byNetwork[networkId] = [...(masks || [])];
      }
    },
    // Add a full rule (from the /ignore parser). networkId null = global (the
    // default); a number scopes it to that network. The server re-validates.
    addRule(networkId: number | null, rule: IgnoreRule) {
      socketSend({ type: 'add-ignore', networkId, rule });
    },
    // Remove by id (from the listed index) or by mask string. networkId is the
    // scope for by-mask removal (server clears globals + that network); for
    // by-id it just routes the fanned-out list back to the right bucket.
    removeRule(networkId: number | null, by: { id?: number; mask?: string }) {
      if (by.id == null && !by.mask) return;
      socketSend({ type: 'remove-ignore', networkId, id: by.id, mask: by.mask });
    },
    // Shim for the quick-ignore modal, which only knows a mask: an ALL-level
    // rule. The server expands a bare `mask` the same way. Defaults to global.
    addMask(networkId: number | null, mask: string) {
      const trimmed = (mask || '').trim();
      if (!trimmed) return;
      socketSend({ type: 'add-ignore', networkId, mask: trimmed });
    },
    // Remove every rule matching a bare mask string (server deletes by mask).
    removeMask(networkId: number | null, mask: string) {
      const trimmed = (mask || '').trim();
      if (!trimmed) return;
      this.removeRule(networkId, { mask: trimmed });
    },
  },
});
