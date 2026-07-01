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
// Under the hood the suppressor rungs are ignore rules: "Nothing" = a NONOTIFY
// rule, "Muted" = NONOTIFY + NOUNREAD, both scoped to the buffer (channel/DM
// target) or the whole network. "All messages" is the channel-only notify_always
// flag. The rungs are mutually exclusive, so no conflicting state can be created
// from the menu; if a hand-typed /ignore contradicts, the ignore veto wins.

import type { ContextMenuItem } from './useContextMenu.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { canonicalizeLevels, type IgnoreRule } from '../utils/ignoreMatch.js';

type Rung = 'all' | 'highlights' | 'nothing' | 'muted';

// Levels for the suppressor rungs; 'all'/'highlights' carry no ignore rule.
function levelsForRung(rung: Rung): string[] | null {
  if (rung === 'nothing') return canonicalizeLevels(['NONOTIFY']);
  if (rung === 'muted') return canonicalizeLevels(['NOUNREAD', 'NONOTIFY']);
  return null;
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
    return { label, icon: active ? 'fa-solid fa-circle-dot' : 'fa-regular fa-circle', onClick };
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
    const levels = ignores.bufferMuteRule(networkId, target)?.levels ?? [];
    const current: Rung = notifyAlways ? 'all' : rungFromLevels(levels, 'highlights');
    const set = (rung: Rung) => {
      if ((rung === 'all') !== notifyAlways) {
        channelNotify.setNotifyAlways(networkId, target, rung === 'all');
      }
      reconcileRule(networkId, ignores.bufferMuteRule(networkId, target), levelsForRung(rung), [
        target.toLowerCase(),
      ]);
    };
    return [
      { heading: 'Notifications' },
      rungItem('All messages', current === 'all', () => set('all')),
      rungItem('Highlights only', current === 'highlights', () => set('highlights')),
      rungItem('Nothing', current === 'nothing', () => set('nothing')),
      rungItem('Muted', current === 'muted', () => set('muted')),
    ];
  }

  // ---- DM: 3 rungs (buffer mute rule only, no notify_always) ----------------
  function dmItems(networkId: number, target: string): ContextMenuItem[] {
    const levels = ignores.bufferMuteRule(networkId, target)?.levels ?? [];
    const current: Rung = rungFromLevels(levels, 'all');
    const set = (rung: Rung) =>
      reconcileRule(networkId, ignores.bufferMuteRule(networkId, target), levelsForRung(rung), [
        target.toLowerCase(),
      ]);
    return [
      { heading: 'Notifications' },
      rungItem('All messages', current === 'all', () => set('all')),
      rungItem('Nothing', current === 'nothing', () => set('nothing')),
      rungItem('Muted', current === 'muted', () => set('muted')),
    ];
  }

  // ---- Network: 3 rungs (network-wide mute rule) ----------------------------
  function networkItems(networkId: number): ContextMenuItem[] {
    const levels = ignores.networkMuteRule(networkId)?.levels ?? [];
    const current: Rung = rungFromLevels(levels, 'highlights');
    const set = (rung: Rung) =>
      reconcileRule(networkId, ignores.networkMuteRule(networkId), levelsForRung(rung), null);
    return [
      { heading: 'Notifications' },
      rungItem('Highlights only', current === 'highlights', () => set('highlights')),
      rungItem('Nothing', current === 'nothing', () => set('nothing')),
      rungItem('Muted', current === 'muted', () => set('muted')),
    ];
  }

  return { channelItems, dmItems, networkItems };
}
