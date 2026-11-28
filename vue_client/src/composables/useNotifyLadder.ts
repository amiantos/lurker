// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The notification "quietness" ladder (issue #359), shared by the channel/DM
// buffer menu (useBufferActions) and the network menu (useNetworkActions). A
// single monotonically-quieter radio group per buffer/network:
//
//   Channel:  All messages · Highlights only (default) · Nothing · Muted
//   DM:       All messages (default) · Nothing · Muted     (no "Highlights only"
//             — every DM is already the signal)
//   Network:  Highlights only (default) · Nothing · Muted  (no "All" — a network
//             firehose makes no sense)
//
// Beside the ladder, channels and networks get a "Suppress Highlights" box
// (#1414): on any rung, nothing said there highlights. Muted alone still
// badges a highlight, which is the point of muting a room you follow; the box
// is for a room where a mention of your nick is noise too. Not on DMs, where
// the conversation itself is the signal, not a matched word.
//
// Under the hood the suppressor rungs are ignore rules: "Nothing" = a NONOTIFY
// rule, "Muted" = NONOTIFY + NOUNREAD, both scoped to the buffer (channel/DM
// target) or the whole network. "All messages" is the channel-only notify_always
// flag. The box adds NOHIGHLIGHT to that same rule (or is a rule of its own on
// the rungs that have none). A highlight is stamped as a line arrives, so the
// box changes what happens from then on, not lines already there.
// The rungs are mutually exclusive, so no conflicting state can be created
// from the menu; if a hand-typed /ignore contradicts, the ignore veto wins.

import { CircleDotIcon, CircleIcon } from '@lucide/vue';
import { checkboxItem, type ContextMenuItem } from './useContextMenu.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { canonicalizeLevels, type IgnoreRule } from '../utils/ignoreMatch.js';

type Rung = 'all' | 'highlights' | 'nothing' | 'muted';

// The rule's levels for a rung and the Suppress Highlights box; null when it
// takes no rule at all ('all'/'highlights' with the box clear).
function levelsFor(rung: Rung, suppress: boolean): string[] | null {
  const levels: string[] = [];
  if (rung === 'nothing' || rung === 'muted') levels.push('NONOTIFY');
  if (rung === 'muted') levels.push('NOUNREAD');
  if (suppress) levels.push('NOHIGHLIGHT');
  return levels.length ? canonicalizeLevels(levels) : null;
}

function suppresses(rule: { levels: string[] } | null): boolean {
  return !!rule && rule.levels.includes('NOHIGHLIGHT');
}

function sameLevels(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((l) => set.has(l));
}

// Which rung a mute rule's levels represent. Keyed on NONOTIFY (the notify
// dimension): NONOTIFY+NOUNREAD = Muted, NONOTIFY alone = Nothing. A NOUNREAD-only
// rule (badge hidden but notifications still fire — only reachable by hand-typed
// /ignore) falls through to `base`, since it is neither "Nothing" nor "Muted".
function rungFromLevels(levels: string[], base: Rung): Rung {
  if (levels.includes('NONOTIFY')) return levels.includes('NOUNREAD') ? 'muted' : 'nothing';
  return base;
}

export function useNotifyLadder() {
  const ignores = useIgnoresStore();
  const channelNotify = useChannelNotifyStore();

  function rungItem(label: string, active: boolean, onClick: () => void): ContextMenuItem {
    return { label, icon: active ? CircleDotIcon : CircleIcon, onClick };
  }

  // Reconcile the per-buffer (or, when channels is null, per-network) mute rule
  // to the desired rung: remove a stale rule and add the wanted one. Idempotent
  // when the current rule already matches. A new rule is added at `addNetworkId`
  // (network scope), but a stale rule is removed from ITS OWN scope
  // (existing.networkId, null = global) so a hand-typed global mute is cleared
  // from the right bucket rather than orphaned.
  function reconcileRule(
    addNetworkId: number,
    existing: { id: number; levels: string[]; networkId: number | null } | null,
    want: string[] | null,
    channels: string[] | null,
  ): void {
    if (existing && want && sameLevels(existing.levels, want)) return;
    if (existing) ignores.removeRule(existing.networkId, { id: existing.id });
    if (want) {
      const rule: IgnoreRule = {
        mask: null,
        channels,
        pattern: null,
        patternKind: 'substr',
        levels: want,
        isExcept: false,
        expiresAt: null,
      };
      ignores.addRule(addNetworkId, rule);
    }
  }

  // ---- Channel: 4 rungs (notify_always + buffer mute rule) ------------------
  function channelItems(networkId: number, target: string): ContextMenuItem[] {
    const notifyAlways = channelNotify.notifyAlways(networkId, target);
    const shown = ignores.bufferMuteRule(networkId, target);
    const rungOf = (levels: string[]): Rung =>
      channelNotify.notifyAlways(networkId, target) ? 'all' : rungFromLevels(levels, 'highlights');
    const current: Rung = notifyAlways ? 'all' : rungFromLevels(shown?.levels ?? [], 'highlights');
    // Each rung is a target, so it reconciles against the state as it is when
    // tapped, not as it was when the menu opened (#1136). A rung keeps the box
    // as it stands, and the box keeps the rung.
    const write = (rung: Rung, suppress: boolean) => {
      const rule = ignores.bufferMuteRule(networkId, target);
      reconcileRule(networkId, rule, levelsFor(rung, suppress), [target.toLowerCase()]);
    };
    const set = (rung: Rung) => {
      if ((rung === 'all') !== channelNotify.notifyAlways(networkId, target)) {
        channelNotify.setNotifyAlways(networkId, target, rung === 'all');
      }
      write(rung, suppresses(ignores.bufferMuteRule(networkId, target)));
    };
    return [
      { heading: 'Notifications' },
      rungItem('All messages', current === 'all', () => set('all')),
      rungItem('Highlights only', current === 'highlights', () => set('highlights')),
      rungItem('Nothing', current === 'nothing', () => set('nothing')),
      rungItem('Muted', current === 'muted', () => set('muted')),
      checkboxItem('Suppress Highlights', suppresses(shown), (next) =>
        write(rungOf(ignores.bufferMuteRule(networkId, target)?.levels ?? []), next),
      ),
    ];
  }

  // ---- DM: 3 rungs (buffer mute rule only, no notify_always) ----------------
  function dmItems(networkId: number, target: string): ContextMenuItem[] {
    const levels = ignores.bufferMuteRule(networkId, target)?.levels ?? [];
    const current: Rung = rungFromLevels(levels, 'all');
    // No box here, but a hand-typed NOHIGHLIGHT on the rule is kept.
    const set = (rung: Rung) => {
      const rule = ignores.bufferMuteRule(networkId, target);
      reconcileRule(networkId, rule, levelsFor(rung, suppresses(rule)), [target.toLowerCase()]);
    };
    return [
      { heading: 'Notifications' },
      rungItem('All messages', current === 'all', () => set('all')),
      rungItem('Nothing', current === 'nothing', () => set('nothing')),
      rungItem('Muted', current === 'muted', () => set('muted')),
    ];
  }

  // ---- Network: 3 rungs (network-wide mute rule) ----------------------------
  function networkItems(networkId: number): ContextMenuItem[] {
    const shown = ignores.networkMuteRule(networkId);
    const current: Rung = rungFromLevels(shown?.levels ?? [], 'highlights');
    const write = (rung: Rung, suppress: boolean) =>
      reconcileRule(networkId, ignores.networkMuteRule(networkId), levelsFor(rung, suppress), null);
    const set = (rung: Rung) => write(rung, suppresses(ignores.networkMuteRule(networkId)));
    return [
      { heading: 'Notifications' },
      rungItem('Highlights only', current === 'highlights', () => set('highlights')),
      rungItem('Nothing', current === 'nothing', () => set('nothing')),
      rungItem('Muted', current === 'muted', () => set('muted')),
      checkboxItem('Suppress Highlights', suppresses(shown), (next) =>
        write(rungFromLevels(ignores.networkMuteRule(networkId)?.levels ?? [], 'highlights'), next),
      ),
    ];
  }

  return { channelItems, dmItems, networkItems };
}
